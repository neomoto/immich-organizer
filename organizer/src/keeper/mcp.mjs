import { chmod, realpath, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateObservation } from "../policy.mjs";
import { visibleContent } from "./session.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Error("Vision MCP request cancelled");
}

function parseJsonText(value) {
  const clean = String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try { return JSON.parse(clean); } catch { return null; }
}

function parseObservation(value) {
  const texts = Array.isArray(value?.content)
    ? value.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text)
    : [];
  if (value?.isError) throw Error("Vision MCP returned an analysis error");
  let parsed = parseJsonText(texts.join("\n"));
  // @z_ai/mcp-server wraps tool output in {success,data}; data is commonly a
  // second JSON string from the upstream vision completion.
  if (parsed?.success === true && parsed.data !== undefined) {
    parsed = typeof parsed.data === "string" ? parseJsonText(parsed.data) : parsed.data;
  }
  if (!parsed || typeof parsed !== "object") throw Error("Vision MCP returned no structured observation");
  return parsed;
}

async function assertPrivateFile(filePath, tempRoot, maxBytes) {
  if (typeof filePath !== "string" || typeof tempRoot !== "string") throw Error("Vision MCP media path unavailable");
  const root = await realpath(tempRoot);
  const path = await realpath(filePath);
  if (path !== root && !path.startsWith(`${root}/`)) throw Error("Vision MCP media path is outside its private temp directory");
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw Error("Vision MCP media file exceeds its bound");
  await chmod(path, 0o600);
  return path;
}

export class ZaiVisionMcpProvider {
  constructor({ command = "zai-mcp-server", args = [], cwd, key, timeoutMs = DEFAULT_TIMEOUT_MS, mode = "ZAI", extraEnv = {}, clientFactory, transportFactory, status } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.mode = mode;
    this.extraEnv = extraEnv;
    this.clientFactory = clientFactory || (() => new Client({ name: "immich-organizer", version: "0.1.0-alpha.3" }));
    this.transportFactory = transportFactory || ((params) => new StdioClientTransport(params));
    this.status = status;
  }

  async analyze(filePath, prompt, { tempRoot, video = false, signal, webEvidence = [] } = {}) {
    if (!this.key) {
      const error = Error("Vision MCP key is missing");
      error.configuration = true;
      this.status && (this.status.visionFailure = "Vision MCP key is missing");
      throw error;
    }
    const path = await assertPrivateFile(filePath, tempRoot, video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES);
    const toolName = video ? "analyze_video" : "analyze_image";
    const arguments_ = video
      ? { video_source: path, prompt: visibleContent(prompt, 32_000) }
      : { image_source: path, prompt: visibleContent(prompt, 32_000) };
    const transport = this.transportFactory({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      // The key is supplied only to this child environment. stderr is ignored
      // so the MCP package cannot log prompts, paths, or provider responses.
      env: {
        // PATH is the only inherited process setting needed to resolve the
        // image-bundled `zai-mcp-server` command. Do not pass process.env,
        // which could contain unrelated credentials.
        PATH: `/app/node_modules/.bin:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
        ...this.extraEnv,
        Z_AI_API_KEY: this.key,
        Z_AI_MODE: this.mode,
      },
      stderr: "ignore",
    });
    const client = this.clientFactory();
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(Error("Vision MCP request timed out")), this.timeoutMs).unref();
    const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    try {
      const connectPromise = client.connect(transport);
      await Promise.race([
        connectPromise,
        new Promise((_, reject) => combined.addEventListener("abort", () => reject(abortError(combined)), { once: true })),
      ]);
      combined.throwIfAborted();
      const result = await client.callTool({ name: toolName, arguments: arguments_ }, undefined, {
        signal: combined,
        timeout: this.timeoutMs,
      });
      const observation = parseObservation(result);
      validateObservation(observation);
      const allowed = new Set((webEvidence || []).map((source) => source.url));
      if (observation.evidence.some((evidence) => evidence.kind === "web" && !allowed.has(evidence.url))) {
        throw Error("Vision MCP returned an unverified web citation");
      }
      this.status && (this.status.visionFailure = null);
      return observation;
    } catch (error) {
      if (!error?.configuration) this.status && (this.status.visionFailure = "Vision MCP analysis failed");
      if (error?.name === "AbortError" || combined.aborted) {
        const timeoutError = Error(combined.reason?.message || "Vision MCP request cancelled");
        timeoutError.retryable = true;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await Promise.resolve(client.close?.()).catch(() => {});
    }
  }
}

export function createVisionMcpProvider(options) {
  return new ZaiVisionMcpProvider(options);
}

export const MCP_LIMITS = Object.freeze({ maxImageBytes: MAX_IMAGE_BYTES, maxVideoBytes: MAX_VIDEO_BYTES });
