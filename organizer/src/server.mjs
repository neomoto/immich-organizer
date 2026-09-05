import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { connect, secretBox, claimRun, completeRun, scheduleCatchup } from "./store.mjs";
import { DEFAULTS, unchanged, validDay } from "./policy.mjs";
import { Engine } from "./engine.mjs";
import { createProvider } from "./keeper/provider.mjs";
import { KeeperHarness, recoverKeeperLeases } from "./keeper/harness.mjs";
import { ToolRegistry } from "./keeper/registry.mjs";
import {
  createSession,
  enqueueMessage,
  getRun,
  getSession,
  getSessionMessages,
  getRunEvents,
  listRuns,
  listSessions,
  requestStop,
  resumeRun,
} from "./keeper/session.mjs";
import { getSchedule, KeeperScheduler, setSchedule } from "./keeper/scheduler.mjs";

const secret = process.env.ORGANIZER_SECRET;
const box = secretBox(secret);
const sql = await connect(process.env.ORGANIZER_DATABASE_URL);
const engine = new Engine(sql, box, {
  immich: process.env.IMMICH_URL || "http://immich-server:2283",
  timeZone: process.env.TZ || "UTC",
  vision: {
    base: process.env.VISION_BASE_URL || "https://api.z.ai/api/paas/v4",
    model: process.env.VISION_MODEL || "glm-5v-turbo",
    key: process.env.VISION_API_KEY,
  },
});
// Keeper receives an explicit registry.  The optional tools module is loaded
// only when present so the backend remains useful for chat/scheduling while a
// deployment rolls out a matching tools image. No general shell/filesystem
// fallback exists.
let keeperRegistry = new ToolRegistry();
try {
  const toolModule = await import("./keeper/tools.mjs");
  const candidate = typeof toolModule.createKeeperTools === "function"
    ? await toolModule.createKeeperTools({ sql, engine, box })
    : typeof toolModule.createToolRegistry === "function"
      ? await toolModule.createToolRegistry({ sql, engine, box })
      : toolModule.registry;
  if (candidate?.execute && candidate?.list) keeperRegistry = candidate;
  else if (candidate) keeperRegistry = new ToolRegistry(candidate);
} catch {
  // The optional module is not a permission bypass: an empty registry simply
  // means that the model can hold a persistent conversation until tools are
  // installed.
}
const keeper = new KeeperHarness({
  sql,
  registry: keeperRegistry,
  provider: (owner) => createProvider({ sql, owner, config: engine.config.vision, timeZone: engine.config.timeZone }),
  ownerResolver: (id) => engine.owner(id),
  imageHydrator: async (owner, refs, signal) => {
    const images = [];
    const seen = new Set();
    for (const ref of refs.slice(0, 4)) {
      signal?.throwIfAborted();
      if (seen.has(ref.assetId)) continue;
      seen.add(ref.assetId);
      const asset = await engine.asset(owner, ref.assetId);
      const [image] = await engine.images(owner, asset);
      if (image?.url) images.push({ assetId: ref.assetId, url: image.url });
    }
    return images.slice(0, 4);
  },
  config: { timeZone: engine.config.timeZone },
});
const keeperScheduler = new KeeperScheduler({ sql, harness: keeper, timeZone: engine.config.timeZone });
void recoverKeeperLeases(sql).catch(() => {});
const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const booleanSettings = [
  "enabled",
  "continuous",
  "automatic",
  "geolocation",
  "approximatePins",
  "webLookup",
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function request(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2e6) throw new RequestError("Request too large", 413);
    chunks.push(chunk);
  }
  let body;
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
  catch { throw new RequestError('Invalid JSON'); }
  if (!object(body)) throw new RequestError('Expected a JSON object');
  return body;
}
async function handle(req) {
  const auth = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
    return [401, { error: "Unauthorized" }];
  const owner = req.headers["x-organizer-owner"];
  if (!uuid(owner)) return [400, { error: "Invalid owner" }];
  const url = new URL(req.url, "http://worker");
  const path = url.pathname;
  const keeperMethods = path === '/keeper/sessions' ? ['GET', 'POST']
    : /^\/keeper\/sessions\/[\da-f-]+$/i.test(path) ? ['GET']
      : /^\/keeper\/sessions\/[\da-f-]+\/messages$/i.test(path) ? ['GET', 'POST']
        : /^\/keeper\/sessions\/[\da-f-]+\/runs$/i.test(path) ? ['GET']
          : /^\/keeper\/runs\/[\da-f-]+$/i.test(path) ? ['GET']
            : /^\/keeper\/runs\/[\da-f-]+\/events$/i.test(path) ? ['GET']
              : /^\/keeper\/runs\/[\da-f-]+\/(stop|resume)$/i.test(path) ? ['POST']
                : path === '/keeper/schedule' ? ['GET', 'PUT'] : [];
  const methods = keeperMethods.length ? keeperMethods
    : path === '/connect' || path === '/runs' || path === '/event' || path === '/manifest' || /^\/undo\/[\da-f-]+\/(prepare|complete)$/i.test(path)
    ? ['POST'] : path === '/settings' ? ['PUT'] : /^\/assets\/[\da-f-]+$/i.test(path) ? ['GET','PUT']
      : ['/status','/assets','/events','/history'].includes(path) ? ['GET'] : [];
  if (!methods.length) return [404,{error:'Not found'}];
  if (!methods.includes(req.method)) return [405,{error:'Method not allowed'}];
  const body = await request(req);
  if (keeperMethods.length) {
    const [keeperOwner] = await sql`SELECT id FROM owners WHERE id=${owner}`;
    if (!keeperOwner) return [409, { error: 'Connect Organize first' }];
    const sessionId = path.startsWith('/keeper/sessions/') ? path.split('/')[3] : null;
    const runId = path.startsWith('/keeper/runs/') ? path.split('/')[3] : null;
    const offset = url.searchParams.get('cursor') || url.searchParams.get('after') || '0';
    try {
      if (path === '/keeper/sessions' && req.method === 'GET') {
        return [200, await listSessions(sql, owner, { cursor: offset, limit: url.searchParams.get('limit') || 50 })];
      }
      if (path === '/keeper/sessions' && req.method === 'POST') {
        if (Object.keys(body).some((key) => key !== 'title')) return [400, { error: 'Invalid keeper session' }];
        if ('title' in body && (typeof body.title !== 'string' || body.title.length > 200)) return [400, { error: 'Invalid keeper session title' }];
        return [201, await createSession(sql, owner, { title: body.title })];
      }
      if (sessionId && !uuid(sessionId)) return [400, { error: 'Invalid keeper session' }];
      if (runId && !uuid(runId)) return [400, { error: 'Invalid keeper run' }];
      if (path.startsWith('/keeper/sessions/') && path.endsWith('/messages')) {
        if (req.method === 'GET') {
          return [200, await getSessionMessages(sql, owner, sessionId, { cursor: offset, limit: url.searchParams.get('limit') || 100 })];
        }
        if (Object.keys(body).some((key) => !['content', 'text', 'assetIds', 'options'].includes(key))) return [400, { error: 'Invalid keeper message' }];
        const content = body.content ?? body.text ?? body.message;
        if (typeof content !== 'string' || !content.trim() || content.length > 32_000) return [400, { error: 'Invalid keeper message' }];
        const assetIds = body.assetIds ?? [];
        if (!Array.isArray(assetIds) || assetIds.length > 1000 || !assetIds.every(uuid)) return [400, { error: 'Invalid keeper assets' }];
        if (body.options !== undefined && (body.options === null || typeof body.options !== 'object' || Array.isArray(body.options))) return [400, { error: 'Invalid keeper options' }];
        const queued = await enqueueMessage(sql, owner, sessionId, content, { assetIds, options: body.options || {} });
        if (!queued) return [404, { error: 'Keeper session not found' }];
        return [202, queued];
      }
      if (sessionId && path === `/keeper/sessions/${sessionId}`) {
        const session = await getSession(sql, owner, sessionId);
        return session ? [200, session] : [404, { error: 'Keeper session not found' }];
      }
      if (sessionId && path.endsWith('/runs')) {
        const session = await getSession(sql, owner, sessionId);
        if (!session) return [404, { error: 'Keeper session not found' }];
        return [200, await listRuns(sql, owner, { sessionId, cursor: offset, limit: url.searchParams.get('limit') || 50 })];
      }
      if (runId && path.endsWith('/events')) {
        const run = await getRun(sql, owner, runId);
        if (!run) return [404, { error: 'Keeper run not found' }];
        return [200, await getRunEvents(sql, owner, runId, { cursor: offset, limit: url.searchParams.get('limit') || 100 })];
      }
      if (runId && path.endsWith('/stop')) {
        const stopped = await requestStop(sql, owner, runId);
        if (!stopped) return [404, { error: 'Keeper run not found' }];
        await keeper.stop(owner, runId);
        return [200, stopped];
      }
      if (runId && path.endsWith('/resume')) {
        const resumed = await resumeRun(sql, owner, runId);
        if (!resumed) return [404, { error: 'Keeper run not found' }];
        if (resumed.conflict) return [409, { error: 'Keeper run is not resumable' }];
        return [202, resumed];
      }
      if (runId && path === `/keeper/runs/${runId}`) {
        const run = await getRun(sql, owner, runId);
        return run ? [200, run] : [404, { error: 'Keeper run not found' }];
      }
      if (path === '/keeper/schedule' && req.method === 'GET') {
        const schedule = await getSchedule(sql, owner, engine.config.timeZone);
        return [200, schedule];
      }
      if (path === '/keeper/schedule' && req.method === 'PUT') {
        if (Object.keys(body).some((key) => !['enabled', 'hour', 'timeZone', 'time_zone', 'timezone'].includes(key))) return [400, { error: 'Invalid keeper schedule' }];
        const schedule = await setSchedule(sql, owner, body, engine.config.timeZone);
        return [200, schedule];
      }
    } catch (error) {
      if (error?.status) return [error.status, { error: error.message }];
      if (error instanceof TypeError) return [400, { error: error.message }];
      throw error;
    }
  }
  if (path === "/connect" && req.method === "POST") {
    if (typeof body.key !== "string" || body.key.length < 16)
      return [400, { error: "Invalid credential" }];
    if (!uuid(body.connectionId)) return [400, { error: 'Invalid connection ID' }];
    await sql`INSERT INTO owners(id,credential,settings,connection_id) VALUES(${owner},${box.seal(body.key)},${sql.json(DEFAULTS)},${body.connectionId})
      ON CONFLICT(id) DO NOTHING`;
    const [connected] = await sql`SELECT connection_id FROM owners WHERE id=${owner}`;
    return [200, { connected: true, connectionId: connected.connection_id }];
  }
  const existing = await sql`SELECT id FROM owners WHERE id=${owner}`;
  if (!existing.length) return path === '/status' ? [200, { connected: false }] : [409, {error:'Connect Organize first'}];
  const o = await engine.owner(owner);
  const visible = async id => {
    try { await engine.asset(o,id); return true; } catch { return false; }
  };
  if (path === "/status") {
    const counts =
      await sql`SELECT status,count(*)::int count FROM assets WHERE owner=${owner} GROUP BY status`;
    const usage =
      await sql`SELECT day,calls FROM usage WHERE owner=${owner} ORDER BY day DESC LIMIT 7`;
    return [
      200,
      {
        connected: true,
        connectionId: o.connection_id,
        settings: o.settings,
        counts,
        usage,
        runs: await sql`SELECT id,status,count,error,created_at FROM runs WHERE owner=${owner} ORDER BY created_at DESC LIMIT 10`,
        provider: {
          model: engine.config.vision.model,
          configured: !!engine.config.vision.key,
        },
      },
    ];
  }
  if (path === "/settings" && req.method === "PUT") {
    if (Object.keys(body).some(k => ![...booleanSettings,'dailyLimit','language'].includes(k))) return [400,{error:'Unknown setting'}];
    const settings = { ...o.settings };
    for (const k of booleanSettings)
      if (k in body) {
        if (typeof body[k] !== "boolean")
          return [400, { error: `Invalid ${k}` }];
        settings[k] = body[k];
      }
    if ("dailyLimit" in body) {
      if (
        !Number.isInteger(body.dailyLimit) ||
        body.dailyLimit < 1 ||
        body.dailyLimit > 100000
      )
        return [400, { error: "Invalid daily limit" }];
      settings.dailyLimit = body.dailyLimit;
    }
    if ('language' in body) {
      if (typeof body.language !== 'string' || !body.language.trim() || body.language.length > 80) return [400,{error:'Invalid language'}];
      settings.language = body.language.trim();
    }
    await sql`UPDATE owners SET settings=${sql.json(settings)} WHERE id=${owner}`;
    return [200, { settings }];
  }
  if (path === "/runs" && req.method === "POST") {
    if (
      'assetIds' in body &&
      (!Array.isArray(body.assetIds) ||
        body.assetIds.length === 0 || body.assetIds.length > 1000 ||
        !body.assetIds.every(uuid))
    )
      return [400, { error: "Invalid assets" }];
    if ('limit' in body && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100000)) return [400,{error:'Invalid limit'}];
    if ('reanalyze' in body && typeof body.reanalyze !== 'boolean') return [400,{error:'Invalid reanalyze'}];
    const limit = Math.min(o.settings.continuous ? 100000 : 200, body.limit ?? body.assetIds?.length ?? 200);
    if('albumId' in body && !uuid(body.albumId))return [400,{error:'Invalid album'}];
    if(body.albumId && body.assetIds)return [400,{error:'Choose assets or an album'}];
    const id=randomUUID();
    await sql`INSERT INTO runs(id,owner,options) VALUES(${id},${owner},${sql.json({assetIds:body.assetIds,albumId:body.albumId,limit,reanalyze:body.reanalyze===true})})`;
    return [202,{runId:id,requested:limit}];
  }
  if (path === "/event" && req.method === "POST") {
    if (!uuid(body.assetId)) return [400,{error:'Invalid asset'}];
    if (uuid(body.assetId) && o.settings.enabled && o.settings.continuous)
      await engine.inventory(o, { assetIds: [body.assetId], limit: 1 });
    return [200, { accepted: true }];
  }
  if (path === "/assets") {
    const search = url.searchParams.get('q') || '';
    const offsetString = url.searchParams.get('offset') || '0';
    const filter = url.searchParams.get('status') || '';
    const category = url.searchParams.get('category') || '';
    const datePrecision = url.searchParams.get('datePrecision') || '';
    const locationPrecision = url.searchParams.get('locationPrecision') || '';
    if (!['','photo','screenshot','document','scan','illustration','meme','video','unknown'].includes(category) ||
      !['','day','month','year','range'].includes(datePrecision) ||
      !['','country','region','city','venue','camera'].includes(locationPrecision)) return [400,{error:'Invalid analysis filter'}];
    if (search.length>200 || !/^\d+$/.test(offsetString) || Number(offsetString)>10000000 ||
      !['','pending','running','retry','failed','analyzed'].includes(filter)) return [400,{error:'Invalid pagination or filter'}];
    const query = `%${search}%`;
    const offset = Number(offsetString);
    const rows = await sql`SELECT id,snapshot->>'originalFileName' filename,status,result,proposal,error,locks,facts,provenance
      FROM assets WHERE owner=${owner} AND (${filter}='' OR status=${filter}) AND (snapshot->>'originalFileName' ILIKE ${query} OR result::text ILIKE ${query})
      AND (${category}='' OR result->>'category'=${category})
      AND (${datePrecision}='' OR result->'date'->>'precision'=${datePrecision})
      AND (${locationPrecision}='' OR coalesce(proposal->'estimatedLocation'->>'precision',result->'location'->>'precision')=${locationPrecision})
      ORDER BY updated_at DESC,id LIMIT 50 OFFSET ${offset}`;
    const allowed = await Promise.all(rows.map(row=>visible(row.id)));
    return [200, rows.filter((row,index)=>allowed[index])];
  }
  const assetId = path.split("/")[2];
  if (path.startsWith("/assets/") && uuid(assetId)) {
    if (!await visible(assetId)) return [404,{error:'Asset not available'}];
    if (req.method === "PUT") {
      if (('locks' in body && !object(body.locks)) || ('facts' in body && !object(body.facts)) || Object.keys(body).some(k=>!['facts','locks'].includes(k))) return [400,{error:'Invalid asset corrections'}];
      const locks = body.locks || {},
        facts = body.facts || {};
      if (!object(locks) || !object(facts)) return [400,{error:'Facts and locks must be objects'}];
      if(('captureDay' in facts && facts.captureDay !== null && !validDay(facts.captureDay)) ||
        ('note' in facts && (typeof facts.note!=='string'||facts.note.length>3000)) ||
        ['suspectDate','suspectLocation'].some(k=>k in facts && typeof facts[k]!=='boolean')) return [400,{error:'Invalid facts'}];
      if (
        Object.keys(locks).some(
          (k) =>
            !["date", "location", "description", "suppressed"].includes(k) ||
            typeof locks[k] !== "boolean",
        )
      )
        return [400, { error: "Invalid locks" }];
      if (
        Object.keys(facts).some(
          (k) =>
            !["captureDay", "suspectDate", "suspectLocation", "note"].includes(
              k,
            ),
        )
      )
        return [400, { error: "Invalid facts" }];
      await sql`UPDATE assets SET locks=locks || ${sql.json(locks)},facts=jsonb_strip_nulls(facts || ${sql.json(facts)}),
        status='pending',result=NULL,proposal=NULL,attempts=0,next_at=now(),updated_at=now(),revision=revision+1,lease_until=NULL,lease_token=NULL WHERE owner=${owner} AND id=${assetId}`;
    }
    const [a] =
      await sql`SELECT id,status,result,proposal,error,locks,facts,provenance FROM assets WHERE owner=${owner} AND id=${assetId}`;
    return [200, a || null];
  }
  if (path === "/manifest" && req.method === "POST") {
    if (!Array.isArray(body.entries) || body.entries.length > 1000)
      return [400, { error: "Maximum 1000 manifest entries" }];
    for (const entry of body.entries) {
      if (!object(entry) || typeof entry.checksum !== "string" || !entry.checksum.length || entry.checksum.length>200 || !Array.isArray(entry.paths) || entry.paths.length>1000 || !entry.paths.every(p=>typeof p==='string' && p.length>0 && p.length<=8192 && !p.includes('\0')))
        return [400, { error: "Invalid manifest" }];
    }
    await sql.begin(async tx => {
      for (const entry of body.entries) {
      await tx`INSERT INTO source_manifests(owner,checksum,provenance) VALUES(${owner},${entry.checksum},${tx.json(entry)})
        ON CONFLICT(owner,checksum) DO UPDATE SET provenance=excluded.provenance`;
      await tx`UPDATE assets SET provenance=${tx.json(entry)},updated_at=now(),revision=revision+1,
        status='pending',result=NULL,proposal=NULL,attempts=0,next_at=now(),lease_until=NULL,lease_token=NULL WHERE owner=${owner} AND checksum=${entry.checksum}
        AND provenance IS DISTINCT FROM ${tx.json(entry)}`;
      }
    });
    return [200, { received: body.entries.length }];
  }
  if (path === "/events") {
    const rows=await sql`SELECT * FROM events WHERE owner=${owner} ORDER BY title LIMIT 200`;
    const allowed=await Promise.all(rows.map(async event=>{
      const candidates = Array.isArray(event.data?.assetIds) ? event.data.assetIds : [];
      for (const assetId of candidates) {
        try {
          if (await visible(assetId) && await engine.albumContains(o, event.album, assetId)) return true;
        } catch {}
      }
      return false;
    }));
    return [200,rows.filter((row,index)=>allowed[index])];
  }
  if (path === "/history") {
    const offset = url.searchParams.get('offset') || '0';
    if (!/^\d+$/.test(offset) || Number(offset)>10000000) return [400,{error:'Invalid pagination'}];
    const rows=await sql`SELECT * FROM changes WHERE owner=${owner} ORDER BY created_at DESC,id LIMIT 200 OFFSET ${Number(offset)}`;
    const allowed = new Map(await Promise.all([...new Set(rows.map(row=>row.asset))].map(async id=>[id,await visible(id)])));
    return [200,rows.filter(row=>allowed.get(row.asset))];
  }
  const changeId = path.split("/")[2];
  if (path.startsWith("/undo/") && uuid(changeId)) {
    const [c] =
      await sql`SELECT * FROM changes WHERE owner=${owner} AND id=${changeId}`;
    if (!c) return [404, { error: "Change not found" }];
    if (req.method === "POST" && path.endsWith('/complete')) {
      if(!['undoing','undone'].includes(c.status))return [409,{error:'Undo has not been prepared'}];
      if (c.kind === 'metadata' && !unchanged(await engine.asset(o,c.asset), c.before_value)) return [409,{error:'Restored metadata changed before acknowledgment'}];
      if (c.kind === 'tag' && (await engine.asset(o,c.asset)).tags?.some(tag=>tag.id===c.before_value.tagId)) return [409,{error:'Tag membership changed before acknowledgment'}];
      if (c.kind === 'album' && await engine.albumContains(o, c.before_value.albumId, c.asset)) return [409,{error:'Album membership changed before acknowledgment'}];
      await sql`UPDATE changes SET status='undone',updated_at=now() WHERE owner=${owner} AND id=${changeId}`;
      await sql`UPDATE assets SET locks=locks || '{"suppressed":true}'::jsonb WHERE owner=${owner} AND id=${c.asset}`;
      return [200, { undone: true }];
    }
    return sql.begin(async tx=>{
      // Match the engine's apply lock before checking live state. A queued
      // native write must settle before undo decides what it is restoring.
      await tx`SELECT id FROM assets WHERE owner=${owner} AND id=${c.asset} FOR UPDATE`;
      const [current]=await tx`SELECT * FROM changes WHERE owner=${owner} AND id=${changeId} FOR UPDATE`;
      if (current.status === 'undone') return [200,current];
      const a = await engine.asset(o, current.asset);
      if (!['applied','undoing'].includes(current.status) ||
        (current.kind === 'metadata' && !unchanged(a,current.after_value) && !(current.status==='undoing'&&unchanged(a,current.before_value))))
        return [409,{error:'A newer edit prevents undo'}];
      await tx`UPDATE changes SET status='undoing',updated_at=now() WHERE owner=${owner} AND id=${changeId} AND status IN ('applied','undoing')`;
      await tx`UPDATE assets SET locks=locks || '{"suppressed":true}'::jsonb,revision=revision+1,lease_token=NULL WHERE owner=${owner} AND id=${c.asset}`;
      return [200,current];
    });
  }
  return [404, { error: "Not found" }];
}
const server = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.end("ok");
    return;
  }
  try {
    const [status, data] = await handle(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(error instanceof RequestError ? error.status : 500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: error instanceof RequestError ? error.message : "Organizer operation failed; inspect worker health and settings",
      }),
    );
  }
});
server.listen(Number(process.env.PORT) || 8091, "0.0.0.0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function loop() {
  while (!engine.stopping) {
    try {
      if (!(await engine.work())) await sleep(2000);
    } catch {
      console.error("Queue unavailable; retrying");
      await sleep(10000);
    }
  }
}
const workers = [loop(), loop()];
async function scanLoop() {
  while(!engine.stopping) {
    try {
      const run=await claimRun(sql);
      if(!run){await sleep(2000);continue;}
      try {
        const result=await engine.inventory(await engine.owner(run.owner),run.options);
        if (result.paused) await sql`UPDATE runs SET status='queued',count=${result.queued},lease_until=NULL,lease_token=NULL WHERE id=${run.id} AND lease_token=${run.lease_token}`;
        else await completeRun(sql,run,result.queued);
      }catch {await completeRun(sql,run,run.count,'Inventory failed; check Immich access');}
    }catch{await sleep(10000);}
  }
}
workers.push(scanLoop());
const catchup = setInterval(async () => {
  try { await scheduleCatchup(sql); }
  catch { console.error("Inventory catch-up failed"); }
}, 600000);
keeperScheduler.start();
async function keeperLoop() {
  while (!keeper.stopping) {
    try {
      if (!(await keeper.work())) await sleep(1000);
    } catch {
      await sleep(5000);
    }
  }
}
const keeperWorker = keeperLoop();
process.on("SIGTERM", async () => {
  engine.stopping = true;
  keeper.stopping = true;
  keeperScheduler.stop();
  clearInterval(catchup);
  server.close();
  await Promise.all([...workers, keeperWorker]);
  await sql.end();
});
