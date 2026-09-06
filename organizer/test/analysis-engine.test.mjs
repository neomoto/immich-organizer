import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { connect } from "../src/store.mjs";
const row = { owner:"owner", id:"asset", revision:4, lease_token:"lease", attempts:2, provenance:{},facts:{},locks:{},result:null };
function harness(respond) {
  const queries=[];
  const sql=async (strings,...values)=>{const query=strings.join("?");queries.push({query,values});return respond(query,values);};
  sql.json=x=>x;
  sql.begin=fn=>fn(sql);
  return {sql,queries};
}
test("missing previews remain retryable beyond the normal attempt limit",async()=>{
  const {sql,queries}=harness(q=>q.includes("RETURNING *")?[{...row}]:[]);
  const engine=new Engine(sql,{}, {vision:{key:"fake"}});
  engine.owner=async()=>({id:"owner",settings:{}});
  engine.asset=async()=>({id:"asset"});
  engine.context=async()=>({neighbors:[]});
  engine.images=async()=>{throw Error("Immich /assets/asset/thumbnail HTTP 404");};
  assert.equal(await engine.work(),true);
  const retry=queries.find(q=>q.query.includes("attempts="));
  assert.equal(retry.values[0],"retry");
  assert.equal(retry.values[1],2);
  assert.ok(retry.query.includes("lease_token="));
});
test("storage probe failures pause processing before any writes",async()=>{
  const {sql,queries}=harness(q=>q.includes("SELECT a.id")?[{id:"asset"}]:[]);
  const engine=new Engine(sql,{}, {});
  const calls=[];
  engine.api=async(_,path)=>{calls.push(path);throw Error("storage offline");};
  await assert.rejects(()=>engine.apply({id:"owner"},{id:"asset"},row,{}, {patch:{description:"AI"},tags:[]}),/paused/);
  assert.deepEqual(calls,["/organizer/storage/asset"]);
  assert.ok(queries.some(q=>q.query.includes("UPDATE owners")));
});
test("superseded analysis does not even probe storage or apply metadata",async()=>{
  const {sql}=harness(()=>[]);
  const engine=new Engine(sql,{},{});
  engine.api=async()=>assert.fail("stale application reached Immich");
  await assert.rejects(()=>engine.apply({id:"owner"},{id:"asset"},row,{}, {patch:{},tags:[]}),/superseded/);
});
test("neighbor context omits newly hidden assets before sharing source metadata",async()=>{
  const {sql}=harness(()=>[{id:"visible",provenance:{filename:"one"}},{id:"locked",provenance:{filename:"private"}}]);
  const engine=new Engine(sql,{},{});
  engine.asset=async(_,id)=>{if(id==="locked")throw Error("ineligible");return {id};};
  const context=await engine.context({id:"owner"},{provenance:{group:"g",filename:"target"},facts:{}},{id:"target"});
  assert.deepEqual(context.neighbors.map(n=>n.id),["visible"]);
});
test("hidden assets stop before provider or media access", async () => {
  const hidden = {
    ...row,
    owner: "owner",
    id: "asset",
    snapshot: { id: "asset", ownerId: "owner", visibility: "hidden", type: "VIDEO" },
  };
  const { sql, queries } = harness((query) => query.includes("RETURNING *") ? [hidden] : []);
  const engine = new Engine(sql, {}, { aiProvider: "direct", vision: { key: "synthetic" } });
  engine.owner = async () => ({ id: "owner", settings: { enabled: true } });
  let providerCalls = 0;
  let mediaCalls = 0;
  engine.modelCall = async () => { providerCalls++; };
  engine.images = async () => { mediaCalls++; };
  engine.api = async (_owner, path) => {
    if (path === "/assets/asset") return { ...hidden.snapshot };
    if (path.includes("thumbnail") || path.endsWith("/original")) mediaCalls++;
    return {};
  };

  assert.equal(await engine.work(), true);
  assert.equal(providerCalls, 0);
  assert.equal(mediaCalls, 0);
  assert.ok(queries.some(({ query }) => query.includes("attempts=")), "the queued row is retried without analysis");
});
test("oversize original response is cancelled before downloading bytes",async t=>{
  let cancelled=false;
  t.mock.method(globalThis,"fetch",async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-length":String(33*1024*1024)}}));
  const engine=new Engine({}, {open:()=>"synthetic"}, {immich:"http://localhost"});
  await assert.rejects(()=>engine.api({credential:"sealed"},"/assets/fixture/original",null,"GET",true),/32 MiB/);
  assert.equal(cancelled,true);
});
test("daily quota exhaustion never submits a model request",async()=>{
  const {sql}=harness(()=>[]);
  const engine=new Engine(sql,{}, {timeZone:"UTC"});
  await assert.rejects(()=>engine.reserve({id:"owner",settings:{dailyLimit:5000}}),e=>e.quota === true);
});
test("photo conversion produces a bounded target and two labelled detail crops",async()=>{
  const run=promisify(execFile);
  const {stdout}=await run("ffmpeg",["-v","error","-f","lavfi","-i","color=c=blue:s=320x240","-frames:v","1","-f","image2pipe","-vcodec","mjpeg","pipe:1"],{encoding:"buffer"});
  const engine=new Engine({}, {}, {});
  engine.api=async()=>({bytes:stdout});
  const images=await engine.images({},{id:"fixture",type:"IMAGE"});
  assert.equal(images.length,3);
  assert.deepEqual(images.map(i=>i.label.role),["target","target-detail","target-detail"]);
  assert.ok(images.every(i=>i.url.startsWith("data:image/jpeg;base64,")));
  assert.ok(images.slice(1).every(i=>i.label.resolutionSource === "original"));
  engine.api=async(_,path)=>{if(path.endsWith("/original"))throw Error("unavailable");return {bytes:stdout};};
  const fallback=await engine.images({},{id:"fixture",type:"IMAGE"});
  assert.ok(fallback.slice(1).every(i=>i.label.resolutionSource === "preview-fallback"));
});
test("application holds an asset row lock while independent journal commits remain durable", {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const sql=await connect(process.env.TEST_DATABASE_URL);
  const owner=randomUUID(),id=randomUUID(),change=randomUUID();
  try {
    await sql`INSERT INTO owners(id,credential) VALUES(${owner},'synthetic')`;
    await sql`INSERT INTO assets(owner,id,checksum,snapshot) VALUES(${owner},${id},'fixture','{}')`;
    const engine=new Engine(sql,{},{});
    engine.applyLocked=async()=>{
      await sql`INSERT INTO changes(id,owner,asset,before_value,after_value) VALUES(${change},${owner},${id},'{}','{}')`;
      await assert.rejects(()=>sql.begin(async tx=>{
        await tx`SET LOCAL lock_timeout='100ms'`;
        await tx`UPDATE assets SET revision=revision+1 WHERE owner=${owner} AND id=${id}`;
      }),e=>e.code==="55P03");
      throw Error("simulate application disconnect");
    };
    await assert.rejects(()=>engine.apply({id:owner},{id}, {},{},{}),/disconnect/);
    assert.equal((await sql`SELECT status FROM changes WHERE id=${change}`)[0].status,"pending");
    await sql`UPDATE assets SET revision=revision+1 WHERE owner=${owner} AND id=${id}`;
  } finally {
    await sql`DELETE FROM changes WHERE owner=${owner}`;
    await sql`DELETE FROM assets WHERE owner=${owner}`;
    await sql`DELETE FROM owners WHERE id=${owner}`;
    await sql.end();
  }
});
