import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { redactVisible, visibleContent } from "./session.mjs";

const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_REQUEST_TIMEOUT = 120_000;

function localDay(timeZone, date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
  }
}

function combinedSignal(first, second) {
  if (first && second) return AbortSignal.any([first, second]);
  return first || second;
}

function safeMessageContent(content) {
  if (typeof content === "string") return visibleContent(content, 32_000);
  if (!Array.isArray(content)) return visibleContent(String(content ?? ""), 32_000);
  return content.slice(0, 8).map((part) => {
    if (!part || typeof part !== "object") return { type: "text", text: visibleContent(String(part ?? ""), 4_000) };
    if (part.type === "text") return { type: "text", text: visibleContent(String(part.text ?? ""), 8_000) };
    if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string" &&
      /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+$/i.test(part.image_url.url) && part.image_url.url.length <= 16 * 1024 * 1024) {
      // Image bytes are intentionally retained only in this in-memory request
      // body. They never pass through the keeper DB/event stream.
      return { type: "image_url", image_url: { url: part.image_url.url } };
    }
    return { type: "text", text: "[unsupported visual input omitted]" };
  });
}

/** Validate the OpenAI tool-call pairing before any request is sent. */
export function validateToolTranscript(messages, { allowPending = false } = {}) {
  const pending = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const callId = call?.id;
        const name = call?.function?.name;
        if (typeof callId !== "string" || !callId || typeof name !== "string" || !name || pending.has(callId)) {
          throw Error("Invalid keeper tool-call transcript");
        }
        pending.set(callId, true);
      }
    } else if (message?.role === "tool") {
      const callId = message.tool_call_id;
      if (typeof callId !== "string" || !pending.has(callId)) throw Error("Invalid keeper tool result transcript");
      pending.delete(callId);
    }
  }
  if (!allowPending && pending.size) throw Error("Keeper tool-call transcript has no matching results");
  return true;
}

/**
 * Acquire one of the two shared model leases and atomically charge the
 * owner's daily quota.  The quota day is evaluated after each wait, so a call
 * crossing midnight in the NAS timezone is charged to the day on which it
 * actually starts.  The callback receives a signal which is aborted if the
 * lease is lost or the caller cancels the operation.
 *
 * `charge: false` is retained for callers that already reserved a request
 * (legacy Engine.reserve/tests). New model calls should leave it enabled.
 */
export async function withProviderCall(sql, owner, timeZone, send, signal, options = {}) {
  if (!sql || typeof sql.begin !== "function") throw Error("Provider database unavailable");
  if (!owner?.id) throw Error("Provider owner unavailable");
  const token = randomUUID();
  const leaseSeconds = Number.isInteger(options.leaseSeconds) && options.leaseSeconds > 0
    ? options.leaseSeconds : DEFAULT_LEASE_SECONDS;
  const charge = options.charge !== false;
  let slot;
  while (!slot) {
    signal?.throwIfAborted();
    slot = await sql.begin(async (tx) => {
      const [candidate] = await tx`
        SELECT id FROM provider_slots
        WHERE token IS NULL OR lease_until < now()
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!candidate) return null;
      if (charge) {
        const [settings] = await tx`SELECT settings FROM owners WHERE id=${owner.id} FOR SHARE`;
        if (!settings) throw Error("Owner unavailable");
        const dailyLimit = Number(settings.settings?.dailyLimit ?? settings.settings?.daily_limit ?? 5000);
        const limit = Number.isInteger(dailyLimit) && dailyLimit > 0 ? dailyLimit : 5000;
        const quota = await tx`
          INSERT INTO usage(owner,day,calls)
          VALUES(${owner.id},${localDay(timeZone)},1)
          ON CONFLICT(owner,day) DO UPDATE SET calls=usage.calls+1
            WHERE usage.calls < ${limit}
          RETURNING calls`;
        if (!quota.length) {
          const error = Error("Daily model request limit reached");
          error.quota = true;
          throw error;
        }
      }
      await tx`
        UPDATE provider_slots SET token=${token},owner=${owner.id},
          lease_until=now()+${leaseSeconds + " seconds"}::interval
        WHERE id=${candidate.id}`;
      return candidate;
    });
    if (!slot) {
      // Do not burn model quota while waiting for one of the two actual
      // in-flight slots. The caller can abort this wait during shutdown/stop.
      await delay(Math.min(500, options.pollMs || 100), undefined, { signal });
    }
  }

  const leaseAbort = new AbortController();
  const callSignal = combinedSignal(signal, leaseAbort.signal);
  let renewing = false;
  const heartbeat = setInterval(async () => {
    if (renewing || leaseAbort.signal.aborted) return;
    renewing = true;
    try {
      const rows = await sql`
        UPDATE provider_slots SET lease_until=now()+${leaseSeconds + " seconds"}::interval
        WHERE token=${token} RETURNING id`;
      if (!rows.length) leaseAbort.abort(Error("Provider lease lost"));
    } catch {
      leaseAbort.abort(Error("Provider lease unavailable"));
    } finally {
      renewing = false;
    }
  }, Math.max(1000, Math.min(10_000, Math.floor((leaseSeconds * 1000) / 3))));
  try {
    callSignal?.throwIfAborted();
    return await send(callSignal);
  } finally {
    clearInterval(heartbeat);
    await sql`
      UPDATE provider_slots SET token=NULL,owner=NULL,lease_until=NULL WHERE token=${token}`;
  }
}

function responseText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
  }
  return "";
}

function responseToolCalls(body) {
  const calls = body?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.slice(0, 20).map((call) => ({
    id: typeof call?.id === "string" ? call.id.slice(0, 120) : randomUUID(),
    name: typeof call?.function?.name === "string" ? call.function.name : "",
    arguments: typeof call?.function?.arguments === "string"
      ? call.function.arguments.slice(0, 32_000)
      : JSON.stringify(redactVisible(call?.function?.arguments ?? {})),
  })).filter((call) => call.name);
}

/** A deliberately small OpenAI-compatible adapter used by Keeper. */
export class OpenAICompatibleProvider {
  constructor({ sql, owner, config = {}, timeZone = "UTC", fetcher = fetch } = {}) {
    this.sql = sql;
    this.owner = owner;
    this.config = config;
    this.timeZone = timeZone;
    this.fetcher = fetcher;
  }

  async complete(messages, { tools = [], signal, maxTokens = 2000, temperature = 0.1 } = {}) {
    const base = String(this.config.base || this.config.baseUrl || "").replace(/\/$/, "");
    const key = this.config.key || this.config.apiKey;
    if (!base || !key) {
      const error = Error("Keeper model provider is not configured");
      error.configuration = true;
      throw error;
    }
    const safeMessages = (Array.isArray(messages) ? messages : []).slice(-80).map((message) => {
      const role = ["system", "user", "assistant", "tool"].includes(message?.role) ? message.role : "user";
      const result = {
        role,
        content: safeMessageContent(message?.content ?? ""),
        ...(message?.name ? { name: visibleContent(String(message.name), 120) } : {}),
        ...(message?.tool_call_id ? { tool_call_id: visibleContent(String(message.tool_call_id), 120) } : {}),
      };
      if (role === "assistant" && Array.isArray(message?.tool_calls)) {
        result.tool_calls = message.tool_calls.slice(0, 20).map((call) => ({
          id: visibleContent(String(call?.id || ""), 120),
          type: "function",
          function: {
            name: visibleContent(String(call?.function?.name || ""), 120),
            arguments: visibleContent(String(call?.function?.arguments || "{}"), 32_000),
          },
        })).filter((call) => call.id && call.function.name);
      }
      return result;
    });
    validateToolTranscript(safeMessages);
    const body = {
      model: this.config.model || "glm-5v-turbo",
      max_tokens: Math.max(1, Math.min(8_000, Number(maxTokens) || 2_000)),
      temperature: Number.isFinite(temperature) ? temperature : 0.1,
      messages: safeMessages,
    };
    if (Array.isArray(tools) && tools.length) body.tools = redactVisible(tools).slice(0, 64);
    const timeout = AbortSignal.timeout(Number(this.config.timeoutMs) > 0 ? Number(this.config.timeoutMs) : DEFAULT_REQUEST_TIMEOUT);
    const requestSignal = combinedSignal(signal, timeout);
    let response;
    try {
      response = await withProviderCall(
        this.sql,
        this.owner,
        this.timeZone,
        (leaseSignal) => this.fetcher(`${base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: combinedSignal(requestSignal, leaseSignal),
        }),
        signal,
      );
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") error.retryable = true;
      throw error;
    }
    if (!response.ok) {
      const error = Error(`Keeper model provider HTTP ${response.status}`);
      error.retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      error.quota = response.status === 429;
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw Error("Keeper model provider returned invalid JSON");
    }
    const content = responseText(payload);
    if (!content && !responseToolCalls(payload).length) throw Error("Keeper model provider returned no text");
    return {
      text: visibleContent(content, 32_000),
      toolCalls: responseToolCalls(payload),
      model: payload.model || body.model,
      usage: payload.usage && redactVisible(payload.usage),
    };
  }

  chat(messages, options) {
    return this.complete(messages, options);
  }
}

export function createProvider(options) {
  return new OpenAICompatibleProvider(options);
}
