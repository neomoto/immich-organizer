import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "../src/store.mjs";
import {
  createSession,
  enqueueMessage,
  getRun,
  getRunEvents,
  getSessionMessages,
  listSessions,
  requestStop,
  resumeRun,
} from "../src/keeper/session.mjs";
import { KeeperHarness } from "../src/keeper/harness.mjs";
import { withProviderCall } from "../src/keeper/provider.mjs";
import { validateToolTranscript } from "../src/keeper/provider.mjs";
import { ToolRegistry } from "../src/keeper/registry.mjs";
import { createKeeperTools } from "../src/keeper/tools.mjs";
import { nextLocalHour, scheduleHousekeeping, setSchedule } from "../src/keeper/scheduler.mjs";

const database = process.env.TEST_DATABASE_URL;

async function fixture() {
  const sql = await connect(database);
  const owner = randomUUID();
  const other = randomUUID();
  await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{"enabled":true}'),(${other},'test','{"enabled":true}')`;
  return { sql, owner, other };
}

async function cleanup({ sql, owner, other }) {
  await sql`DELETE FROM keeper_events WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM keeper_messages WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM keeper_mutations USING keeper_runs WHERE keeper_mutations.run=keeper_runs.id AND keeper_runs.owner IN (${owner},${other})`;
  await sql`DELETE FROM keeper_runs WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM keeper_sessions WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM keeper_schedule WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM changes WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM events WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM usage WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM runs WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM source_manifests WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM assets WHERE owner IN (${owner},${other})`;
  await sql`DELETE FROM owners WHERE id IN (${owner},${other})`;
  await sql.end();
}

test("keeper sessions are persistent, owner-scoped, and transcript-safe", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner, other } = fixture_;
    const session = await createSession(sql, owner, { title: "Archive keeper" });
    const queued = await enqueueMessage(sql, owner, session.id, "Show data:image/png;base64,AAAA apiKey=top-secret");
    assert.equal((await listSessions(sql, other)).sessions.length, 0);
    assert.equal((await getSessionMessages(sql, other, session.id)).messages.length, 0);
    const visible = (await getSessionMessages(sql, owner, session.id)).messages[0];
    assert.ok(!visible.content.includes("AAAA"));
    assert.ok(!visible.content.includes("top-secret"));
    assert.equal((await getRun(sql, other, queued.run.id)), null);
    assert.equal((await getRunEvents(sql, other, queued.run.id)).events.length, 0);
  } finally {
    await cleanup(fixture_);
  }
});

test("keeper execution checkpoints slices and resumes after restart", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner } = fixture_;
    const session = await createSession(sql, owner);
    const queued = await enqueueMessage(sql, owner, session.id, "Review the selected photos");
    const asset = randomUUID();
    let calls = 0;
    const registry = new ToolRegistry([{
      name: "record_photo_note",
      description: "Record an owner-approved photo note",
      parameters: { type: "object", properties: {} },
      mutating: true,
      execute: async (_input, context) => {
        await context.recordMutation(asset, "note");
        return { text: "Recorded one bounded note." };
      },
    }]);
    const provider = {
      complete: async () => calls++ === 0
        ? { text: "I will record one note.", toolCalls: [{ id: "call-1", name: "record_photo_note", arguments: {} }] }
        : { text: "The bounded keeper task is complete." },
    };
    const harness = new KeeperHarness({ sql, provider, registry, config: { turns: 1, continuationDelaySeconds: 1 } });
    assert.equal(await harness.work(owner), true);
    let run = await getRun(sql, owner, queued.run.id);
    assert.equal(run.status, "queued", run.error || JSON.stringify(run));
    assert.equal(run.total_mutations, 1);
    assert.equal(run.checkpoint.messageSeq > 0, true);
    await sql`UPDATE keeper_runs SET next_at=now() WHERE id=${queued.run.id}`;
    assert.equal(await harness.work(owner), true);
    run = await getRun(sql, owner, queued.run.id);
    assert.equal(run.status, "complete");
    assert.equal(run.total_tool_calls, 1);
    const events = (await getRunEvents(sql, owner, queued.run.id)).events;
    assert.ok(events.some((event) => event.type === "run.checkpoint"));
    assert.ok(events.some((event) => event.type === "run.completed"));
  } finally {
    await cleanup(fixture_);
  }
});

test("keeper stop/resume is durable and does not cross owners", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner, other } = fixture_;
    const session = await createSession(sql, owner);
    const queued = await enqueueMessage(sql, owner, session.id, "wait");
    assert.equal((await requestStop(sql, other, queued.run.id)), null);
    const stopped = await requestStop(sql, owner, queued.run.id);
    assert.equal(stopped.status, "stopped");
    const resumed = await resumeRun(sql, owner, queued.run.id);
    assert.equal(resumed.status, "queued");
    assert.equal((await resumeRun(sql, owner, queued.run.id)).conflict, true);
  } finally {
    await cleanup(fixture_);
  }
});

test("daily schedule uses NAS-local time and coalesces missed runs", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner } = fixture_;
    const now = new Date("2026-09-05T10:00:00Z");
    const expected = nextLocalHour(3, "America/New_York", now);
    assert.equal(expected.toISOString(), "2026-09-06T07:00:00.000Z");
    const schedule = await setSchedule(sql, owner, { enabled: true, hour: 3, timeZone: "America/New_York" }, "UTC", now);
    assert.equal(schedule.next_at.toISOString(), expected.toISOString());
    await sql`UPDATE keeper_schedule SET next_at=now()-interval '1 second' WHERE owner=${owner}`;
    assert.equal(await scheduleHousekeeping(sql, { ownerId: owner }), 1);
    assert.equal(await scheduleHousekeeping(sql, { ownerId: owner }), 0);
  } finally {
    await cleanup(fixture_);
  }
});

test("keeper registry rejects general execution and authority promotion", async () => {
  assert.throws(() => new ToolRegistry([{ name: "shell.exec", execute: async () => {} }]), /safe name/);
  const registry = new ToolRegistry();
  registry.register({ name: "promote_fact", execute: async () => ({ text: "ok" }) });
  assert.rejects(registry.execute("promote_fact", {}, {}), /owner-scoped/);
});

test("native transcripts preserve assistant calls and reject unpaired tool output", () => {
  const valid = [
    { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "search_photos", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call-1", name: "search_photos", content: "[]" },
  ];
  assert.equal(validateToolTranscript(valid), true);
  assert.throws(() => validateToolTranscript([{ role: "tool", tool_call_id: "orphan", content: "x" }]), /tool result transcript/);
  assert.throws(() => validateToolTranscript([{ role: "assistant", tool_calls: [{ id: "dangling", function: { name: "search_photos", arguments: "{}" } }] }]), /no matching results/);
});

test("registered photo tools expose references, queue durable analysis, and never accept model facts", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner } = fixture_;
    const session = await createSession(sql, owner);
    const queued = await enqueueMessage(sql, owner, session.id, "Inspect my photo");
    const assetId = randomUUID();
    await sql`INSERT INTO assets(owner,id,checksum,snapshot,provenance,facts,locks,result,proposal,status)
      VALUES(${owner},${assetId},'checksum','{"originalFileName":"photo.jpg"}','{"filename":"photo.jpg","verified":true,"paths":["/private/photo.jpg"]}','{}','{}',${sql.json({ caption: "Stored", evidence: [] })},${sql.json({ patch: {}, tags: [] })},'analyzed')`;
    const fakeEngine = {
      asset: async (o, id) => ({ id, ownerId: o.id, originalFileName: "photo.jpg", type: "IMAGE", exifInfo: { description: "", latitude: null, longitude: null } }),
      context: async () => ({ neighbors: [{ id: assetId, source: { filename: "photo.jpg", checksum: "checksum" } }], knownPeople: [] }),
      api: async (_o, path) => path === "/albums" ? [] : path.startsWith("/albums/") ? { id: path.split("/").at(-1), shared: false, hasSharedLink: false, description: "organizer:keeper", albumUsers: [] } : [],
      albumContains: async () => false,
      apply: async () => {},
    };
    const registry = createKeeperTools({ sql, engine: fakeEngine });
    const context = { owner: { id: owner, settings: { enabled: true, automatic: true } }, run: { id: queued.run.id, owner } };
    const inspected = await registry.execute("inspect_photo", { assetId }, context);
    assert.deepEqual(inspected.imageRefs.original, { assetId, kind: "original" });
    assert.equal(JSON.stringify(inspected).includes("data:image"), false);
    assert.equal(JSON.stringify(inspected).includes("/private/photo.jpg"), false);
    const related = await registry.execute("related_photos", { assetId }, context);
    assert.equal(related.neighbors[0].id, assetId);
    const analysis = await registry.execute("queue_analysis", { assetIds: [assetId], limit: 1 }, { ...context, emit: async () => {} });
    assert.equal(analysis.phase, "inventory_queued");
    const [run] = await sql`SELECT options,status FROM runs WHERE id=${analysis.runId} AND owner=${owner}`;
    assert.equal(run.status, "queued");
    assert.equal(run.options.assetIds[0], assetId);
    await assert.rejects(registry.execute("apply_stored_proposal", { assetId, revision: 99 }, context), /missing|stale/);
  } finally {
    await cleanup(fixture_);
  }
});

test("keeper text examples never invoke a registered tool", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner } = fixture_;
    const session = await createSession(sql, owner);
    const queued = await enqueueMessage(sql, owner, session.id, "Explain <tool_call>{\\\"name\\\":\\\"record_photo_note\\\"}</tool_call>");
    let executed = false;
    const registry = new ToolRegistry([{
      name: "record_photo_note",
      execute: async () => { executed = true; return { text: "changed" }; },
    }]);
    const harness = new KeeperHarness({
      sql,
      registry,
      provider: { complete: async () => ({ text: "Here is an example: <tool_call>{\\\"name\\\":\\\"record_photo_note\\\"}</tool_call>" }) },
    });
    await harness.work(owner);
    assert.equal(executed, false);
    assert.equal((await getRun(sql, owner, queued.run.id)).status, "complete");
  } finally {
    await cleanup(fixture_);
  }
});

test("keeper hydrates bounded image references only in memory and preserves native tool protocol", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner } = fixture_;
    const session = await createSession(sql, owner);
    const queued = await enqueueMessage(sql, owner, session.id, "Inspect this photo");
    const assetId = randomUUID();
    const registry = new ToolRegistry([{
      name: "inspect_photo",
      execute: async () => ({ imageRefs: { preview: { assetId, kind: "preview" } }, text: "Preview reference returned." }),
    }]);
    const providerMessages = [];
    let calls = 0;
    const provider = {
      complete: async (messages) => {
        providerMessages.push(messages);
        return calls++ === 0
          ? { text: "Inspecting the current preview.", toolCalls: [{ id: "inspect-1", name: "inspect_photo", arguments: {} }] }
          : { text: "The preview was inspected." };
      },
    };
    const harness = new KeeperHarness({
      sql,
      provider,
      registry,
      imageHydrator: async () => [{ assetId, url: "data:image/jpeg;base64,AAAA" }],
    });
    await harness.work(owner);
    assert.equal((await getRun(sql, owner, queued.run.id)).status, "complete");
    const imageMessage = providerMessages[1]?.find((message) => Array.isArray(message?.content));
    assert.ok(imageMessage);
    assert.ok(JSON.stringify(imageMessage).includes("data:image/jpeg;base64,AAAA"));
    const persisted = JSON.stringify(await getSessionMessages(sql, owner, session.id));
    const events = JSON.stringify(await getRunEvents(sql, owner, queued.run.id));
    assert.equal(persisted.includes("data:image/jpeg;base64,AAAA"), false);
    assert.equal(events.includes("data:image/jpeg;base64,AAAA"), false);
    assert.equal(persisted.includes("imageRefs"), true);
  } finally {
    await cleanup(fixture_);
  }
});

test("analysis and Keeper share two provider slots and one daily quota", { skip: !database }, async () => {
  const fixture_ = await fixture();
  try {
    const { sql, owner } = fixture_;
    await sql`UPDATE owners SET settings='{"dailyLimit":2}' WHERE id=${owner}`;
    let active = 0;
    let maximum = 0;
    const call = () => withProviderCall(sql, { id: owner }, "UTC", async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      active--;
      return "ok";
    });
    const results = await Promise.allSettled([call(), call(), call()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(maximum, 2);
    assert.ok(results.some((result) => result.status === "rejected" && result.reason.quota));
  } finally {
    await cleanup(fixture_);
  }
});
