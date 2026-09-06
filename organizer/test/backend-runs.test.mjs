import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { claimRun, completeRun, connect, reconcileHiddenAssets, scheduleCatchup } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

test('PostgreSQL run leases survive restart, exclude paused owners and reject stale acknowledgments', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const sql=await connect(process.env.TEST_DATABASE_URL), owner=randomUUID(), other=randomUUID();
  try {
    await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{"enabled":false,"continuous":false}'),(${other},'test','{"enabled":false,"continuous":true}')`;
    const ids=[randomUUID(),randomUUID()];
    for(const id of ids)await sql`INSERT INTO runs(id,owner,options) VALUES(${id},${owner},'{"limit":200}')`;
    assert.equal(await claimRun(sql,owner),undefined);
    await sql`UPDATE owners SET settings='{"enabled":true,"continuous":false}' WHERE id=${owner}`;
    const leases=await Promise.all([claimRun(sql,owner),claimRun(sql,owner),claimRun(sql,owner)]);
    assert.equal(leases.filter(Boolean).length,2);
    assert.equal(new Set(leases.filter(Boolean).map(r=>r.id)).size,2);
    const old=leases.find(Boolean);
    await sql`UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=${old.id}`;
    const recovered=await claimRun(sql,owner);
    assert.equal(recovered.id,old.id);
    assert.notEqual(recovered.lease_token,old.lease_token);
    assert.equal((await completeRun(sql,old,999)).length,0);
    assert.equal((await completeRun(sql,recovered,200)).length,1);
    await Promise.all([scheduleCatchup(sql),scheduleCatchup(sql)]);
    assert.equal((await sql`SELECT * FROM runs WHERE owner=${other}`).length,0);
    await sql`UPDATE owners SET settings='{"enabled":true,"continuous":true}' WHERE id=${other}`;
    await Promise.all([scheduleCatchup(sql),scheduleCatchup(sql)]);
    assert.equal((await sql`SELECT * FROM runs WHERE owner=${other}`).length,1);
    assert.equal((await sql`SELECT * FROM runs WHERE owner=${owner}`).length,2,'pilot never schedules full-library catchup');
  } finally {
    await sql`DELETE FROM runs WHERE owner IN (${owner},${other})`;
    await sql`DELETE FROM owners WHERE id IN (${owner},${other})`;
    await sql.end();
  }
});

test('PostgreSQL inventory enforces a lifetime pilot boundary and imports earlier source manifests', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const sql=await connect(process.env.TEST_DATABASE_URL), owner=randomUUID();
  const engine=new Engine(sql,null,{});
  const assets=Array.from({length:220},(_,i)=>({id:randomUUID(),ownerId:owner,checksum:`hash-${i}`,originalFileName:`sample-${i}`}));
  engine.asset=async(o,id)=>assets.find(a=>a.id===id);
  try {
    await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{"enabled":true,"continuous":false}')`;
    await sql`INSERT INTO source_manifests(owner,checksum,provenance) VALUES(${owner},'hash-0','{"paths":["архив/фото.jpg"],"verified":true}')`;
    await engine.inventory(await engine.owner(owner),{assetIds:assets.map(a=>a.id),limit:1000});
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner}`)[0].count,200);
    assert.deepEqual((await sql`SELECT provenance FROM assets WHERE owner=${owner} AND checksum='hash-0'`)[0].provenance.paths,['архив/фото.jpg']);
    await engine.inventory(await engine.owner(owner),{assetIds:assets.slice(200).map(a=>a.id),limit:200});
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner}`)[0].count,200,'second run cannot expand a pilot');
    await sql`UPDATE owners SET settings=settings || '{"enabled":false}' WHERE id=${owner}`;
    const paused=await engine.inventory(await engine.owner(owner),{assetIds:[assets[0].id],limit:1});
    assert.equal(paused.queued,0);
    assert.equal(paused.paused,true);
  } finally {
    await sql`DELETE FROM assets WHERE owner=${owner}`;
    await sql`DELETE FROM source_manifests WHERE owner=${owner}`;
    await sql`DELETE FROM owners WHERE id=${owner}`;
    await sql.end();
  }
});

test('startup reconciliation removes hidden derived rows and preserves the visible pilot cap', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const sql=await connect(process.env.TEST_DATABASE_URL), owner=randomUUID();
  const hidden=Array.from({length:26},(_,i)=>({
    id:randomUUID(),
    ownerId:owner,
    checksum:`hidden-${i}`,
    originalFileName:`live-photo-${i}.mp4`,
    type:'VIDEO',
    visibility:'hidden',
  }));
  const hiddenStatuses=['pending','retry','running','analyzed'];
  const visible=Array.from({length:174},(_,i)=>({
    id:randomUUID(),
    ownerId:owner,
    checksum:`visible-${i}`,
    originalFileName:`photo-${i}.jpg`,
    type:'IMAGE',
    visibility:i%2?'archive':'timeline',
  }));
  const replacements=Array.from({length:30},(_,i)=>({
    id:randomUUID(),
    ownerId:owner,
    checksum:`replacement-${i}`,
    originalFileName:`replacement-${i}.jpg`,
    type:'IMAGE',
    visibility:'timeline',
  }));
  const hiddenById=new Map(hidden.map(asset=>[asset.id,asset]));
  const replacementById=new Map(replacements.map(asset=>[asset.id,asset]));
  try {
    await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{"enabled":true,"continuous":false}')`;
    for(const [index,asset] of hidden.entries())
      await sql`INSERT INTO assets(owner,id,checksum,snapshot,status) VALUES(${owner},${asset.id},${asset.checksum},${sql.json(asset)},${hiddenStatuses[index%hiddenStatuses.length]})`;
    for(const asset of visible)
      await sql`INSERT INTO assets(owner,id,checksum,snapshot,status) VALUES(${owner},${asset.id},${asset.checksum},${sql.json(asset)},'analyzed')`;
    const hiddenChange=randomUUID(), visibleChange=randomUUID();
    await sql`INSERT INTO changes(id,owner,asset,before_value,after_value) VALUES
      (${hiddenChange},${owner},${hidden[0].id},'{}','{"description":"hidden"}'),
      (${visibleChange},${owner},${visible[0].id},'{}','{"description":"visible"}')`;
    await sql`INSERT INTO events(owner,id,title,album,data) VALUES(${owner},${randomUUID()},'Live Photo event',NULL,${sql.json({assetIds:[hidden[0].id,visible[0].id]})})`;
    await sql`INSERT INTO source_manifests(owner,checksum,provenance) VALUES(${owner},${hidden[0].checksum},'{"paths":["private/live-photo.mp4"]}')`;

    assert.equal(await reconcileHiddenAssets(sql),26);
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner}`)[0].count,174);
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner} AND snapshot->>'visibility'='hidden'`)[0].count,0);
    assert.equal((await sql`SELECT count(*)::int count FROM changes WHERE owner=${owner}`)[0].count,2);
    assert.equal((await sql`SELECT count(*)::int count FROM events WHERE owner=${owner}`)[0].count,1);
    assert.equal((await sql`SELECT count(*)::int count FROM source_manifests WHERE owner=${owner}`)[0].count,1);

    const engine=new Engine(sql,null,{});
    engine.api=async(_owner,path)=>{
      const id=path.split('/')[2];
      return hiddenById.get(id) || replacementById.get(id) || {};
    };
    const result=await engine.inventory(await engine.owner(owner),{assetIds:replacements.map(asset=>asset.id),limit:1000});
    assert.equal(result.queued,26);
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner}`)[0].count,200);
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner} AND snapshot->>'visibility'='hidden'`)[0].count,0);
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner} AND checksum LIKE 'replacement-%'`)[0].count,26);

    const extra={id:randomUUID(),ownerId:owner,checksum:'replacement-extra',originalFileName:'replacement-extra.jpg',type:'IMAGE',visibility:'timeline'};
    replacementById.set(extra.id,extra);
    assert.equal((await engine.inventory(await engine.owner(owner),{assetIds:[extra.id],limit:1})).queued,0);
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner}`)[0].count,200,'pilot cap remains exact after reconciliation');
    engine.api=async(_owner,path)=>{
      if(path==='/search/metadata') return {assets:{items:[hidden[0],extra],nextPage:null}};
      return {};
    };
    assert.equal((await engine.inventory(await engine.owner(owner),{limit:1})).queued,0,'hidden assets are not re-enrolled');
    assert.equal((await sql`SELECT count(*)::int count FROM assets WHERE owner=${owner} AND id=${hidden[0].id}`)[0].count,0);
  } finally {
    await sql`DELETE FROM changes WHERE owner=${owner}`;
    await sql`DELETE FROM events WHERE owner=${owner}`;
    await sql`DELETE FROM source_manifests WHERE owner=${owner}`;
    await sql`DELETE FROM assets WHERE owner=${owner}`;
    await sql`DELETE FROM owners WHERE id=${owner}`;
    await sql.end();
  }
});
