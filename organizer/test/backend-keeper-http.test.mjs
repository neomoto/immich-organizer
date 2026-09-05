import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { connect, secretBox } from "../src/store.mjs";

test("keeper HTTP sessions, cursored events, stop/resume, and schedule are owner-scoped", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const administration = await connect(process.env.TEST_DATABASE_URL);
  const schema = `keeper_http_${randomUUID().replaceAll("-", "")}`;
  await administration`CREATE SCHEMA ${administration(schema)}`;
  const database = new URL(process.env.TEST_DATABASE_URL);
  database.searchParams.set("options", `-c search_path=${schema}`);
  const sql = await connect(database.toString());
  const owner = randomUUID();
  const other = randomUUID();
  const secret = "synthetic-keeper-http-secret-32-characters";
  const mock = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: randomUUID(), ownerId: owner, visibility: "timeline", exifInfo: {} }));
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      ORGANIZER_DATABASE_URL: database.toString(),
      ORGANIZER_SECRET: secret,
      IMMICH_URL: `http://127.0.0.1:${mock.address().port}`,
      VISION_API_KEY: "",
    },
    stdio: "ignore",
  });
  const call = (path, method = "GET", body, who = owner) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "x-organizer-owner": who, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try {
        if ((await call("/status")).ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{}'),(${other},'test','{}')`;
    const session = await (await call("/keeper/sessions", "POST", { title: "Keeper HTTP" }, owner)).json();
    assert.match(session.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual((await (await call("/keeper/sessions", "GET", undefined, other)).json()).sessions, []);
    const queued = await (await call(`/keeper/sessions/${session.id}/messages`, "POST", { content: "hello" })).json();
    assert.match(queued.run.id, /^[0-9a-f-]{36}$/i);
    await sql`UPDATE keeper_runs SET next_at=now()+interval '1 hour' WHERE id=${queued.run.id}`;
    assert.equal((await call(`/keeper/runs/${queued.run.id}/events`, "GET", undefined, other)).status, 404);
    const stopped = await (await call(`/keeper/runs/${queued.run.id}/stop`, "POST", {})).json();
    assert.equal(stopped.status, "stopped");
    const resumed = await (await call(`/keeper/runs/${queued.run.id}/resume`, "POST", {})).json();
    assert.equal(resumed.status, "queued");
    const events = await (await call(`/keeper/runs/${queued.run.id}/events`)).json();
    assert.ok(Array.isArray(events.events));
    assert.equal(JSON.stringify(events).includes("lease_token"), false);
    const schedule = await (await call("/keeper/schedule")).json();
    assert.equal(schedule.enabled, false);
    const scheduled = await (await call("/keeper/schedule", "PUT", { enabled: true, hour: 3, timeZone: "UTC" })).json();
    assert.equal(scheduled.enabled, true);
    assert.equal((await call("/keeper/schedule", "PUT", { hour: 25 })).status, 400);
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
    await new Promise((resolve) => mock.close(resolve));
    await sql`DELETE FROM keeper_events WHERE owner IN (${owner},${other})`;
    await sql`DELETE FROM keeper_messages WHERE owner IN (${owner},${other})`;
    await sql`DELETE FROM keeper_mutations USING keeper_runs WHERE keeper_mutations.run=keeper_runs.id AND keeper_runs.owner IN (${owner},${other})`;
    await sql`DELETE FROM keeper_runs WHERE owner IN (${owner},${other})`;
    await sql`DELETE FROM keeper_sessions WHERE owner IN (${owner},${other})`;
    await sql`DELETE FROM keeper_schedule WHERE owner IN (${owner},${other})`;
    await sql`DELETE FROM owners WHERE id IN (${owner},${other})`;
    await sql.end();
    await administration`DROP SCHEMA ${administration(schema)} CASCADE`;
    await administration.end();
  }
});

test("keeper HTTP runs execute only registered native tool calls", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const administration = await connect(process.env.TEST_DATABASE_URL);
  const schema = `keeper_tool_http_${randomUUID().replaceAll("-", "")}`;
  await administration`CREATE SCHEMA ${administration(schema)}`;
  const database = new URL(process.env.TEST_DATABASE_URL);
  database.searchParams.set("options", `-c search_path=${schema}`);
  const sql = await connect(database.toString());
  const owner = randomUUID();
  const assetId = randomUUID();
  const secret = "synthetic-keeper-tool-http-secret-32-characters";
  const box = secretBox(secret);
  const immich = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === `/api/assets/${assetId}`) {
      res.end(JSON.stringify({ id: assetId, ownerId: owner, originalFileName: "fixture.jpg", type: "IMAGE", visibility: "timeline", exifInfo: {} }));
      return;
    }
    res.end(JSON.stringify({ assets: { items: [], nextPage: null } }));
  });
  immich.listen(0, "127.0.0.1");
  await once(immich, "listening");
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    for await (const _chunk of req) {}
    const message = providerCalls++ === 0
      ? { role: "assistant", content: "I will search the inventoried photos.", tool_calls: [{ id: "search-1", type: "function", function: { name: "search_photos", arguments: JSON.stringify({ query: "fixture" }) } }] }
      : { role: "assistant", content: "The search completed with a bounded owner-scoped result." };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "glm-5v-test", choices: [{ message }] }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},${box.seal("synthetic-immich-key")},'{"enabled":true,"automatic":false}')`;
  await sql`INSERT INTO assets(owner,id,checksum,snapshot,provenance,status) VALUES(${owner},${assetId},'fixture','{"originalFileName":"fixture.jpg"}','{}','analyzed')`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      ORGANIZER_DATABASE_URL: database.toString(),
      ORGANIZER_SECRET: secret,
      IMMICH_URL: `http://127.0.0.1:${immich.address().port}`,
      VISION_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
      VISION_MODEL: "glm-5v-test",
      VISION_API_KEY: "synthetic-provider-key",
    },
    stdio: "ignore",
  });
  const call = (path, method = "GET", body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "x-organizer-owner": owner, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try {
        if ((await call("/status")).ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const session = await (await call("/keeper/sessions", "POST", { title: "Tool run" })).json();
    const queued = await (await call(`/keeper/sessions/${session.id}/messages`, "POST", { content: "Search fixture photos" })).json();
    let run;
    for (let index = 0; index < 100; index++) {
      run = await (await call(`/keeper/runs/${queued.run.id}`)).json();
      if (["complete", "failed", "stopped"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(run.status, "complete");
    assert.equal(providerCalls, 2);
    const events = await (await call(`/keeper/runs/${queued.run.id}/events`)).json();
    assert.ok(events.events.some((event) => event.type === "tool.started" && event.data.name === "search_photos"));
    assert.ok(events.events.some((event) => event.type === "tool.completed" && event.data.name === "search_photos"));
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
    await new Promise((resolve) => immich.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
    await sql`DELETE FROM keeper_events WHERE owner=${owner}`;
    await sql`DELETE FROM keeper_messages WHERE owner=${owner}`;
    await sql`DELETE FROM keeper_mutations USING keeper_runs WHERE keeper_mutations.run=keeper_runs.id AND keeper_runs.owner=${owner}`;
    await sql`DELETE FROM keeper_runs WHERE owner=${owner}`;
    await sql`DELETE FROM keeper_sessions WHERE owner=${owner}`;
    await sql`DELETE FROM keeper_schedule WHERE owner=${owner}`;
    await sql`DELETE FROM changes WHERE owner=${owner}`;
    await sql`DELETE FROM events WHERE owner=${owner}`;
    await sql`DELETE FROM usage WHERE owner=${owner}`;
    await sql`DELETE FROM runs WHERE owner=${owner}`;
    await sql`DELETE FROM source_manifests WHERE owner=${owner}`;
    await sql`DELETE FROM assets WHERE owner=${owner}`;
    await sql`DELETE FROM owners WHERE id=${owner}`;
    await sql.end();
    await administration`DROP SCHEMA ${administration(schema)} CASCADE`;
    await administration.end();
  }
});
