import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { connect, secretBox } from "./store.mjs";
import { DEFAULTS, unchanged } from "./policy.mjs";
import { Engine } from "./engine.mjs";

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
const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
const booleanSettings = [
  "enabled",
  "continuous",
  "automatic",
  "geolocation",
  "approximatePins",
  "webLookup",
];

async function request(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2e6) throw Error("Request too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
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
  const body = await request(req);
  if (path === "/connect" && req.method === "POST") {
    if (typeof body.key !== "string" || body.key.length < 16)
      return [400, { error: "Invalid credential" }];
    await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},${box.seal(body.key)},${sql.json(DEFAULTS)})
      ON CONFLICT(id) DO NOTHING`;
    return [200, { connected: true }];
  }
  const existing = await sql`SELECT id FROM owners WHERE id=${owner}`;
  if (!existing.length) return [200, { connected: false }];
  const o = await engine.owner(owner);
  if (path === "/status") {
    const counts =
      await sql`SELECT status,count(*)::int count FROM assets WHERE owner=${owner} GROUP BY status`;
    const usage =
      await sql`SELECT day,calls FROM usage WHERE owner=${owner} ORDER BY day DESC LIMIT 7`;
    return [
      200,
      {
        connected: true,
        settings: o.settings,
        counts,
        usage,
        provider: {
          model: engine.config.vision.model,
          configured: !!engine.config.vision.key,
        },
      },
    ];
  }
  if (path === "/settings" && req.method === "PUT") {
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
    await sql`UPDATE owners SET settings=${sql.json(settings)} WHERE id=${owner}`;
    return [200, { settings }];
  }
  if (path === "/runs" && req.method === "POST") {
    if (
      body.assetIds &&
      (!Array.isArray(body.assetIds) ||
        body.assetIds.length > 1000 ||
        !body.assetIds.every(uuid))
    )
      return [400, { error: "Invalid assets" }];
    const limit = Math.min(100000, Math.max(1, Number(body.limit) || 200));
    return [
      200,
      await engine.inventory(o, {
        assetIds: body.assetIds,
        limit,
        reanalyze: body.reanalyze === true,
      }),
    ];
  }
  if (path === "/event" && req.method === "POST") {
    if (uuid(body.assetId) && o.settings.enabled && o.settings.continuous)
      await engine.inventory(o, { assetIds: [body.assetId], limit: 1 });
    return [200, { accepted: true }];
  }
  if (path === "/assets") {
    const query = `%${(url.searchParams.get("q") || "").slice(0, 200)}%`;
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    return [
      200,
      await sql`SELECT id,snapshot->>'originalFileName' filename,status,result,proposal,error,locks,facts,provenance
      FROM assets WHERE owner=${owner} AND (snapshot->>'originalFileName' ILIKE ${query} OR result::text ILIKE ${query})
      ORDER BY updated_at DESC LIMIT 50 OFFSET ${offset}`,
    ];
  }
  const assetId = path.split("/")[2];
  if (path.startsWith("/assets/") && uuid(assetId)) {
    await engine.asset(o, assetId);
    if (req.method === "PUT") {
      const locks = body.locks || {},
        facts = body.facts || {};
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
      await sql`UPDATE assets SET locks=locks || ${sql.json(locks)},facts=facts || ${sql.json(facts)},
        status='pending',result=NULL,attempts=0,next_at=now(),updated_at=now() WHERE owner=${owner} AND id=${assetId}`;
    }
    const [a] =
      await sql`SELECT id,status,result,proposal,error,locks,facts,provenance FROM assets WHERE owner=${owner} AND id=${assetId}`;
    return [200, a || null];
  }
  if (path === "/manifest" && req.method === "POST") {
    if (!Array.isArray(body.entries) || body.entries.length > 1000)
      return [400, { error: "Maximum 1000 manifest entries" }];
    for (const entry of body.entries) {
      if (typeof entry.checksum !== "string" || !Array.isArray(entry.paths))
        return [400, { error: "Invalid manifest" }];
      await sql`UPDATE assets SET provenance=${sql.json(entry)},updated_at=now() WHERE owner=${owner} AND checksum=${entry.checksum}`;
    }
    return [200, { received: body.entries.length }];
  }
  if (path === "/events")
    return [
      200,
      await sql`SELECT * FROM events WHERE owner=${owner} ORDER BY title LIMIT 200`,
    ];
  if (path === "/history")
    return [
      200,
      await sql`SELECT * FROM changes WHERE owner=${owner} ORDER BY created_at DESC LIMIT 200`,
    ];
  const changeId = path.split("/")[2];
  if (path.startsWith("/undo/") && uuid(changeId)) {
    const [c] =
      await sql`SELECT * FROM changes WHERE owner=${owner} AND id=${changeId}`;
    if (!c) return [404, { error: "Change not found" }];
    if (req.method === "POST") {
      await sql`UPDATE changes SET status='undone',updated_at=now() WHERE owner=${owner} AND id=${changeId}`;
      await sql`UPDATE assets SET locks=locks || '{"suppressed":true}'::jsonb WHERE owner=${owner} AND id=${c.asset}`;
      return [200, { undone: true }];
    }
    const a = await engine.asset(o, c.asset);
    if (
      c.status !== "applied" ||
      (c.kind === "metadata" && !unchanged(a, c.after_value))
    )
      return [409, { error: "A newer edit prevents undo" }];
    return [200, c];
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
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Organizer operation failed; inspect worker health and settings",
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
const catchup = setInterval(async () => {
  for (const o of await sql`SELECT id FROM owners WHERE (settings->>'enabled')::boolean=true AND (settings->>'continuous')::boolean=true`) {
    try {
      await engine.inventory(await engine.owner(o.id), { limit: 100000 });
    } catch {
      console.error("Inventory catch-up failed");
    }
  }
}, 600000);
process.on("SIGTERM", async () => {
  engine.stopping = true;
  clearInterval(catchup);
  server.close();
  await Promise.all(workers);
  await sql.end();
});
