import { randomUUID } from "node:crypto";

/**
 * Persistent keeper records.  This module intentionally knows nothing about
 * Immich or a model provider.  It is the small durable boundary shared by the
 * HTTP adapter, the worker loop, and the scheduler.
 */

export const MAX_SESSION_TITLE = 200;
export const MAX_MESSAGE_LENGTH = 32_000;
export const MAX_EVENT_TEXT = 32_000;
export const DEFAULT_PAGE_SIZE = 50;

export function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function text(value, max = MAX_EVENT_TEXT) {
  if (typeof value !== "string") {
    throw new TypeError("Expected text");
  }
  // Keep control characters that are useful in normal prose, but do not put
  // terminal control sequences or NULs in an event stream.
  return value
    .replaceAll("\0", "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, max);
}

/** Remove media bytes and obvious credentials before data reaches the model
 * transcript, database event stream, or browser.  Tool implementations may
 * return rich internal objects; only their visible, bounded representation is
 * persisted here. */
export function redactVisible(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return "[omitted]";
  if (typeof value === "string") {
    return text(value)
      .replace(/data:[^;\s]+;base64,[a-z0-9+/=_-]+/gi, "[image omitted]")
      .replace(/\b(?:sk|zai|glm)-[a-z0-9._-]{16,}\b/gi, "[secret omitted]")
      .replace(/\b(?:api[_ -]?key|authorization|bearer|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return "[omitted]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactVisible(item, depth + 1, seen));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (/^(?:image|images|image_url|imageUrl|base64|bytes|buffer|credential|secret|password|token|apiKey|authorization)$/i.test(key)) {
      result[key] = "[omitted]";
      continue;
    }
    result[key] = redactVisible(item, depth + 1, seen);
  }
  return result;
}

export function visibleContent(value, max = MAX_MESSAGE_LENGTH) {
  return text(String(value ?? ""), max)
    .replace(/data:[^;\s]+;base64,[a-z0-9+/=_-]+/gi, "[image omitted]")
    .replace(/\b(?:sk|zai|glm)-[a-z0-9._-]{16,}\b/gi, "[secret omitted]")
    .replace(/\b(?:api[_ -]?key|authorization|bearer|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function page(value, fallback = DEFAULT_PAGE_SIZE, maximum = 200) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) throw new TypeError("Invalid page size");
  return parsed;
}

function cursor(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("Invalid cursor");
  return parsed;
}

function json(sql, value) {
  return typeof sql.json === "function" ? sql.json(value) : value;
}

export async function createSession(sql, owner, { title = "Keeper" } = {}) {
  if (!isUuid(owner)) throw new TypeError("Invalid owner");
  const cleanTitle = visibleContent(title, MAX_SESSION_TITLE).trim() || "Keeper";
  const id = randomUUID();
  const [row] = await sql`
    INSERT INTO keeper_sessions(id,owner,title)
    VALUES(${id},${owner},${cleanTitle})
    RETURNING id,owner,title,summary,summary_seq,created_at,updated_at`;
  return row;
}

export async function getSession(sql, owner, id) {
  if (!isUuid(owner) || !isUuid(id)) return null;
  const [row] = await sql`
    SELECT id,owner,title,summary,summary_seq,created_at,updated_at
    FROM keeper_sessions WHERE owner=${owner} AND id=${id}`;
  return row || null;
}

export async function listSessions(sql, owner, { cursor: after = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (!isUuid(owner)) throw new TypeError("Invalid owner");
  const offset = cursor(after);
  const size = page(limit);
  const rows = await sql`
    SELECT id,owner,title,summary,summary_seq,created_at,updated_at
    FROM keeper_sessions WHERE owner=${owner}
    ORDER BY updated_at DESC,id DESC
    LIMIT ${size + 1} OFFSET ${offset}`;
  const sessions = rows.slice(0, size);
  return { sessions, nextCursor: rows.length > size ? String(offset + size) : null };
}

export async function listRuns(sql, owner, { sessionId, cursor: after = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (!isUuid(owner)) throw new TypeError("Invalid owner");
  if (sessionId !== undefined && !isUuid(sessionId)) throw new TypeError("Invalid session");
  const offset = cursor(after);
  const size = page(limit);
  const rows = await sql`
    SELECT id,owner,session,source,status,prompt,asset_ids,options,lease_until,next_at,
      stop_requested,slice_turns,slice_tool_calls,slice_mutations,total_turns,
      total_tool_calls,total_mutations,checkpoint,blocked_reason,error,created_at,ended_at
    FROM keeper_runs
    WHERE owner=${owner} AND (${sessionId ?? null}::uuid IS NULL OR session=${sessionId ?? null}::uuid)
    ORDER BY created_at DESC,id DESC
    LIMIT ${size + 1} OFFSET ${offset}`;
  const runs = rows.slice(0, size);
  return { runs, nextCursor: rows.length > size ? String(offset + size) : null };
}

/** Create one durable run and its user/system message atomically. */
export async function enqueueMessage(sql, owner, sessionId, content, {
  source = "chat",
  assetIds = [],
  options = {},
  role = "user",
} = {}) {
  if (!isUuid(owner) || !isUuid(sessionId)) throw new TypeError("Invalid owner or session");
  if (!Array.isArray(assetIds) || assetIds.length > 1000 || !assetIds.every(isUuid)) throw new TypeError("Invalid assets");
  if (!content || typeof content !== "string" || !content.trim() || content.length > MAX_MESSAGE_LENGTH) {
    throw new TypeError("Invalid message");
  }
  if (!['user', 'system'].includes(role)) throw new TypeError("Invalid message role");
  const clean = visibleContent(content);
  const cleanOptions = redactVisible(options);
  const runId = randomUUID();
  return sql.begin(async (tx) => {
    const [session] = await tx`
      SELECT id,owner,title,summary,summary_seq,created_at,updated_at
      FROM keeper_sessions WHERE owner=${owner} AND id=${sessionId} FOR UPDATE`;
    if (!session) return null;
    const [run] = await tx`
      INSERT INTO keeper_runs(id,owner,session,source,prompt,asset_ids,options)
      VALUES(${runId},${owner},${sessionId},${source},${clean},${json(tx, assetIds)},${json(tx, cleanOptions)})
      RETURNING id,owner,session,source,status,prompt,asset_ids,options,next_at,created_at`;
    const [message] = await tx`
      INSERT INTO keeper_messages(id,owner,session,run,role,content,message)
      VALUES(${randomUUID()},${owner},${sessionId},${runId},${role},${clean},${json(tx, { role, content: clean })})
      RETURNING seq,id,owner,session,run,role,content,message,created_at`;
    await tx`UPDATE keeper_sessions SET updated_at=now() WHERE owner=${owner} AND id=${sessionId}`;
    return { run, message };
  });
}

/** Create an autonomous run.  Its prompt is also retained as a visible system
 * message so a scheduled report has the same persistent history as chat. */
export async function enqueueScheduledRun(sql, owner, sessionId, prompt, options = {}) {
  return enqueueMessage(sql, owner, sessionId, prompt, { source: "schedule", options, role: "system" });
}

export async function appendMessage(sql, owner, sessionId, runId, role, content, message = {}) {
  if (!isUuid(owner) || !isUuid(sessionId) || !isUuid(runId)) throw new TypeError("Invalid keeper record");
  if (!['assistant', 'tool', 'system', 'user'].includes(role)) throw new TypeError("Invalid message role");
  const clean = visibleContent(content);
  const safeMessage = redactVisible({ ...message, role, content: clean });
  const [row] = await sql`
    INSERT INTO keeper_messages(id,owner,session,run,role,content,message)
    SELECT ${randomUUID()},${owner},${sessionId},${runId},${role},${clean},${json(sql, safeMessage)}
    WHERE EXISTS(SELECT 1 FROM keeper_sessions WHERE id=${sessionId} AND owner=${owner})
      AND EXISTS(SELECT 1 FROM keeper_runs WHERE id=${runId} AND owner=${owner} AND session=${sessionId})
    RETURNING seq,id,owner,session,run,role,content,message,created_at`;
  if (!row) throw new Error("Keeper session or run not found");
  await sql`UPDATE keeper_sessions SET updated_at=now() WHERE owner=${owner} AND id=${sessionId}`;
  return row;
}

export async function appendEvent(sql, owner, runId, type, data = {}) {
  if (!isUuid(owner) || !isUuid(runId)) throw new TypeError("Invalid keeper record");
  if (typeof type !== "string" || !/^[a-z][a-z0-9_.:-]{0,80}$/i.test(type)) throw new TypeError("Invalid event type");
  const [row] = await sql`
    INSERT INTO keeper_events(owner,run,type,data)
    SELECT ${owner},${runId},${type},${json(sql, redactVisible(data))}
    WHERE EXISTS(SELECT 1 FROM keeper_runs WHERE id=${runId} AND owner=${owner})
    RETURNING seq,owner,run,type,data,created_at`;
  if (!row) throw new Error("Keeper run not found");
  return row;
}

export async function getRun(sql, owner, runId) {
  if (!isUuid(owner) || !isUuid(runId)) return null;
  const [row] = await sql`
    SELECT id,owner,session,source,status,prompt,asset_ids,options,lease_until,next_at,
      stop_requested,slice_turns,slice_tool_calls,slice_mutations,total_turns,total_tool_calls,
      total_mutations,checkpoint,blocked_reason,error,created_at,ended_at
    FROM keeper_runs WHERE owner=${owner} AND id=${runId}`;
  return row || null;
}

export async function getSessionMessages(sql, owner, sessionId, { cursor: after = 0, limit = 100 } = {}) {
  if (!isUuid(owner) || !isUuid(sessionId)) throw new TypeError("Invalid keeper session");
  const from = cursor(after);
  const size = page(limit, 100, 200);
  const rows = await sql`
    SELECT seq,id,owner,session,run,role,content,message,created_at
    FROM keeper_messages WHERE owner=${owner} AND session=${sessionId} AND seq>${from}
    ORDER BY seq ASC LIMIT ${size + 1}`;
  return { messages: rows.slice(0, size), nextCursor: rows.length > size ? String(rows[size - 1].seq) : null };
}

export async function getRunEvents(sql, owner, runId, { cursor: after = 0, limit = 100 } = {}) {
  if (!isUuid(owner) || !isUuid(runId)) throw new TypeError("Invalid keeper run");
  const from = cursor(after);
  const size = page(limit, 100, 200);
  const rows = await sql`
    SELECT seq,owner,run,type,data,created_at
    FROM keeper_events WHERE owner=${owner} AND run=${runId} AND seq>${from}
    ORDER BY seq ASC LIMIT ${size + 1}`;
  return { events: rows.slice(0, size), nextCursor: rows.length > size ? String(rows[size - 1].seq) : null };
}

export async function requestStop(sql, owner, runId) {
  if (!isUuid(owner) || !isUuid(runId)) return null;
  return sql.begin(async (tx) => {
    const [run] = await tx`
      SELECT * FROM keeper_runs WHERE owner=${owner} AND id=${runId} FOR UPDATE`;
    if (!run) return null;
    let status = run.status;
    if (['queued', 'waiting'].includes(status)) status = 'stopped';
    const [updated] = await tx`
      UPDATE keeper_runs SET stop_requested=true,status=${status},
        ended_at=CASE WHEN ${status}='stopped' THEN now() ELSE ended_at END,
        updated_at=now()
      WHERE owner=${owner} AND id=${runId}
      RETURNING id,owner,session,source,status,prompt,asset_ids,options,next_at,stop_requested,
        slice_turns,slice_tool_calls,slice_mutations,total_turns,total_tool_calls,total_mutations,
        checkpoint,blocked_reason,error,created_at,ended_at`;
    await tx`INSERT INTO keeper_events(owner,run,type,data)
      VALUES(${owner},${runId},'run.stop_requested',${json(tx, { status })})`;
    return updated;
  });
}

export async function resumeRun(sql, owner, runId) {
  if (!isUuid(owner) || !isUuid(runId)) return null;
  return sql.begin(async (tx) => {
    const [run] = await tx`SELECT * FROM keeper_runs WHERE owner=${owner} AND id=${runId} FOR UPDATE`;
    if (!run) return null;
    if (!['stopped', 'failed', 'waiting'].includes(run.status)) return { conflict: true, run };
    const [updated] = await tx`
      UPDATE keeper_runs SET status='queued',stop_requested=false,blocked_reason=NULL,error=NULL,
        lease_token=NULL,lease_until=NULL,next_at=now(),ended_at=NULL,updated_at=now()
      WHERE owner=${owner} AND id=${runId}
      RETURNING id,owner,session,source,status,prompt,asset_ids,options,next_at,stop_requested,
        slice_turns,slice_tool_calls,slice_mutations,total_turns,total_tool_calls,total_mutations,
        checkpoint,blocked_reason,error,created_at,ended_at`;
    await tx`INSERT INTO keeper_events(owner,run,type,data)
      VALUES(${owner},${runId},'run.resumed',${json(tx, { from: run.status })})`;
    return updated;
  });
}

export async function recordMutation(sql, owner, runId, assetId, kind = "asset") {
  if (!isUuid(owner) || !isUuid(runId) || !isUuid(assetId)) throw new TypeError("Invalid mutation");
  const [row] = await sql`
    INSERT INTO keeper_mutations(run,asset,kind)
    SELECT ${runId},${assetId},${visibleContent(kind, 80)}
    WHERE EXISTS(SELECT 1 FROM keeper_runs WHERE id=${runId} AND owner=${owner})
    ON CONFLICT(run,asset) DO NOTHING RETURNING run,asset,kind,created_at`;
  return row || null;
}

export async function saveCheckpoint(sql, owner, runId, leaseToken, checkpoint) {
  if (!isUuid(owner) || !isUuid(runId) || !isUuid(leaseToken)) return null;
  const [row] = await sql`
    UPDATE keeper_runs SET checkpoint=${json(sql, redactVisible(checkpoint))},updated_at=now()
    WHERE owner=${owner} AND id=${runId} AND lease_token=${leaseToken}
    RETURNING id,checkpoint`;
  return row || null;
}

export async function compactSession(sql, owner, sessionId, summary, summarySeq) {
  if (!isUuid(owner) || !isUuid(sessionId)) return null;
  if (!Number.isSafeInteger(Number(summarySeq)) || Number(summarySeq) < 0) throw new TypeError("Invalid summary cursor");
  const [row] = await sql`
    UPDATE keeper_sessions SET summary=${visibleContent(summary, 16_000)},summary_seq=GREATEST(summary_seq,${Number(summarySeq)}),updated_at=now()
    WHERE owner=${owner} AND id=${sessionId} AND summary_seq<=${Number(summarySeq)}
    RETURNING id,owner,title,summary,summary_seq,created_at,updated_at`;
  return row || null;
}

export function sessionError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}
