import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { claimRun, completeRun, connect, scheduleCatchup } from '../src/store.mjs';
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
