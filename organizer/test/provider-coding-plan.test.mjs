import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../src/store.mjs";
import { loadConfig, MCP_MODEL_LABEL } from "../src/config.mjs";
import { OpenAICompatibleProvider, withProviderCall } from "../src/keeper/provider.mjs";
import { ZaiVisionMcpProvider } from "../src/keeper/mcp.mjs";
import { Engine } from "../src/engine.mjs";

const database = process.env.TEST_DATABASE_URL;
const mcpCwd = dirname(fileURLToPath(import.meta.url));
const mcpFixture = join(mcpCwd, "mcp-stdio.mjs");

test("Coding Plan configuration uses one shared admin key and separate text/vision defaults", () => {
  const config = loadConfig({ AI_PROVIDER: "zai-coding-plan", Z_AI_API_KEY: "admin-key", TZ: "America/New_York" });
  assert.equal(config.mode, "zai-coding-plan");
  assert.equal(config.keeper.base, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(config.keeper.model, "glm-5.3");
  assert.equal(config.vision.transport, "mcp");
  assert.equal(config.visionMcp.command, "zai-mcp-server");
  assert.equal(config.vision.model, MCP_MODEL_LABEL);
  assert.equal(config.status().keySource, "Z_AI_API_KEY");
  assert.equal(JSON.stringify(config.status()).includes("admin-key"), false);
  const alias = loadConfig({ AI_PROVIDER: "zai-coding-plan", VISION_API_KEY: "legacy-key" });
  assert.equal(alias.keeper.keySource, "VISION_API_KEY_ALIAS");
  const direct = loadConfig({ VISION_BASE_URL: "http://direct.test/v1", VISION_MODEL: "direct-model", VISION_API_KEY: "direct-key" });
  assert.equal(direct.mode, "direct");
  assert.equal(direct.keeper.base, "http://direct.test/v1");
  assert.equal(direct.keeper.model, "direct-model");
  assert.equal(direct.vision.transport, "http");
});

test("non-absolute bundled MCP command receives a safe runtime PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "organizer-mcp-path-"));
  const filePath = join(root, "input.jpg");
  await writeFile(filePath, Buffer.from("synthetic-image"), { mode: 0o600 });
  let params;
  const client = {
    connect: async () => {},
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ success: true, data: JSON.stringify({ caption: "ok", objects: [], activities: [], tags: [], ocr: [], category: "photo", evidence: [{ id: "x", kind: "visual", text: "x" }], date: null, location: null, event: null }) }) }] }),
    close: async () => {},
  };
  try {
    const provider = new ZaiVisionMcpProvider({
      command: "zai-mcp-server",
      key: "admin-key",
      transportFactory: (value) => { params = value; return { close: async () => {} }; },
      clientFactory: () => client,
    });
    await provider.analyze(filePath, "x", { tempRoot: root });
    assert.equal(params.command, "zai-mcp-server");
    assert.match(params.env.PATH, /^\/app\/node_modules\/\.bin:/);
    assert.equal(params.env.Z_AI_API_KEY, "admin-key");
    assert.equal(params.env.VISION_API_KEY, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Coding Plan text provider sends text-only glm-5.3 requests", { skip: !database }, async () => {
  const sql = await connect(database);
  const owner = randomUUID();
  await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{}')`;
  let request;
  try {
    const provider = new OpenAICompatibleProvider({
      sql,
      owner: { id: owner },
      timeZone: "UTC",
      config: { mode: "zai-coding-plan", base: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.3", key: "admin-key" },
      fetcher: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ model: "glm-5.3", choices: [{ message: { content: "text response" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const result = await provider.complete([{ role: "user", content: [{ type: "text", text: "Hello" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] }]);
    assert.equal(result.text, "text response");
    assert.equal(request.url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
    assert.equal(request.body.model, "glm-5.3");
    assert.equal(request.body.messages.every((message) => typeof message.content === "string"), true);
    assert.equal(JSON.stringify(request.body).includes("data:image"), false);
    assert.equal(request.options.headers.Authorization, "Bearer admin-key");
  } finally {
    await sql`DELETE FROM owners WHERE id=${owner}`;
    await sql.end();
  }
});

test("Vision MCP invokes analyze_image with a bounded private path and parses structured output", async () => {
  const root = await mkdtemp(join(tmpdir(), "organizer-mcp-provider-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "organizer-mcp-outside-"));
  const filePath = join(root, "input.jpg");
  await writeFile(filePath, Buffer.from("synthetic-image"), { mode: 0o600 });
  try {
    const provider = new ZaiVisionMcpProvider({ command: process.execPath, args: [mcpFixture], cwd: mcpCwd, key: "admin-key", timeoutMs: 5_000 });
    const result = await provider.analyze(filePath, "Return observation JSON", { tempRoot: root });
    assert.equal(result.caption, "Synthetic MCP observation");
    await assert.rejects(provider.analyze(filePath, "bad", { tempRoot: otherRoot }), /outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("Vision MCP failures and timeout are bounded and retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "organizer-mcp-provider-"));
  const filePath = join(root, "input.jpg");
  await writeFile(filePath, Buffer.from("synthetic-image"), { mode: 0o600 });
  const args = [mcpFixture];
  try {
    const failed = new ZaiVisionMcpProvider({ command: process.execPath, args, cwd: mcpCwd, key: "admin-key", timeoutMs: 5_000, extraEnv: { MCP_TEST_MODE: "failure" } });
    await assert.rejects(failed.analyze(filePath, "x", { tempRoot: root }), /analysis error/);
    const timeout = new ZaiVisionMcpProvider({ command: process.execPath, args, cwd: mcpCwd, key: "admin-key", timeoutMs: 50, extraEnv: { MCP_TEST_MODE: "timeout" } });
    await assert.rejects(timeout.analyze(filePath, "x", { tempRoot: root }), (error) => error.retryable === true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Engine Coding Plan media temp directories are cleaned on MCP success and failure", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "organizer-mcp-engine-"));
  const image = Buffer.from("synthetic-preview");
  const engine = new Engine({}, {}, {
    aiProvider: "zai-coding-plan",
    tempRoot,
    vision: { model: "glm-5.3" },
    visionMcpProvider: { key: "admin-key", analyze: async (filePath) => { await writeFile(`${filePath}.seen`, "seen"); return { caption: "ok" }; } },
  });
  engine.api = async () => ({ bytes: image, type: "image/jpeg" });
  engine.modelCall = async (_owner, send) => send(new AbortController().signal);
  try {
    const owner = { id: randomUUID() };
    const asset = { id: randomUUID(), type: "IMAGE" };
    assert.equal((await engine.visionMcpCall(owner, asset, {})).caption, "ok");
    assert.deepEqual(await readdir(tempRoot), []);
    engine.config.visionMcpProvider.analyze = async () => { throw Error("synthetic failure"); };
    await assert.rejects(engine.visionMcpCall(owner, asset, {}), /synthetic failure/);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("shared provider call quota and slot wrapper remains atomic", { skip: !database }, async () => {
  const sql = await connect(database);
  const owner = randomUUID();
  await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},'test','{"dailyLimit":1}')`;
  try {
    const first = await withProviderCall(sql, { id: owner }, "UTC", async () => "ok");
    assert.equal(first, "ok");
    await assert.rejects(withProviderCall(sql, { id: owner }, "UTC", async () => "not called"), (error) => error.quota === true);
  } finally {
    await sql`DELETE FROM usage WHERE owner=${owner}`;
    await sql`DELETE FROM owners WHERE id=${owner}`;
    await sql.end();
  }
});
