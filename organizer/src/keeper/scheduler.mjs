import { randomUUID } from "node:crypto";
export const DEFAULT_SCHEDULE_HOUR = 3;
export const DEFAULT_SCHEDULE_PROMPT =
  "Perform one bounded housekeeping slice for my photo library. Review safe, owner-scoped evidence and report what you checked, what you changed, and what needs my confirmation. Preserve originals, sharing, and uncertain facts.";

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}

function addDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Convert a local wall-clock hour to a UTC Date without a heavyweight TZ
 * dependency. Iterating the formatter offset handles normal DST transitions
 * and keeps scheduling tied to the NAS timezone. */
export function nextLocalHour(hour = DEFAULT_SCHEDULE_HOUR, timeZone = "UTC", now = new Date()) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new TypeError("Invalid schedule hour");
  let day = localParts(now, timeZone);
  const target = { year: day.year, month: day.month, day: day.day, hour, minute: 0, second: 0 };
  let candidate = Date.UTC(target.year, target.month - 1, target.day, target.hour);
  for (let index = 0; index < 4; index++) {
    const seen = localParts(new Date(candidate), timeZone);
    const expected = Date.UTC(target.year, target.month - 1, target.day, target.hour);
    const actual = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    candidate += expected - actual;
  }
  if (candidate <= now.getTime()) {
    day = addDay(day.year, day.month, day.day);
    const nextTarget = { ...target, ...day };
    candidate = Date.UTC(nextTarget.year, nextTarget.month - 1, nextTarget.day, nextTarget.hour);
    for (let index = 0; index < 4; index++) {
      const seen = localParts(new Date(candidate), timeZone);
      const expected = Date.UTC(nextTarget.year, nextTarget.month - 1, nextTarget.day, nextTarget.hour);
      const actual = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
      candidate += expected - actual;
    }
  }
  return new Date(candidate);
}

function json(sql, value) {
  return typeof sql.json === "function" ? sql.json(value) : value;
}

function validTimeZone(value) {
  if (typeof value !== "string" || value.length > 100) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(); return true; } catch { return false; }
}

export function validateSchedule(input, fallbackTimeZone = "UTC") {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid schedule");
  if ("enabled" in input && typeof input.enabled !== "boolean") throw new TypeError("Invalid schedule enabled value");
  if ("hour" in input && (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23)) throw new TypeError("Invalid schedule hour");
  const timeZone = input.timeZone ?? input.time_zone ?? input.timezone ?? fallbackTimeZone;
  if (!validTimeZone(timeZone)) throw new TypeError("Invalid schedule timezone");
  return {
    enabled: input.enabled ?? false,
    hour: input.hour ?? DEFAULT_SCHEDULE_HOUR,
    timeZone,
  };
}

export async function getSchedule(sql, owner, fallbackTimeZone = "UTC") {
  const [row] = await sql`
    INSERT INTO keeper_schedule(owner,enabled,hour,time_zone,next_at)
    VALUES(${owner},false,${DEFAULT_SCHEDULE_HOUR},${fallbackTimeZone},NULL)
    ON CONFLICT(owner) DO NOTHING
    RETURNING owner,enabled,hour,time_zone,next_at,last_run_at,last_run_id,last_error,updated_at`;
  if (row) return row;
  const [existing] = await sql`
    SELECT owner,enabled,hour,time_zone,next_at,last_run_at,last_run_id,last_error,updated_at
    FROM keeper_schedule WHERE owner=${owner}`;
  return existing || null;
}

export async function setSchedule(sql, owner, input, fallbackTimeZone = "UTC", now = new Date()) {
  const current = await getSchedule(sql, owner, fallbackTimeZone);
  const values = validateSchedule({
    enabled: input?.enabled ?? current?.enabled ?? false,
    hour: input?.hour ?? current?.hour ?? DEFAULT_SCHEDULE_HOUR,
    timeZone: input?.timeZone ?? input?.time_zone ?? input?.timezone ?? current?.time_zone ?? fallbackTimeZone,
  }, fallbackTimeZone);
  const next = values.enabled ? nextLocalHour(values.hour, values.timeZone, now) : null;
  const [row] = await sql`
    INSERT INTO keeper_schedule(owner,enabled,hour,time_zone,next_at,updated_at)
    VALUES(${owner},${values.enabled},${values.hour},${values.timeZone},${next},now())
    ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled,hour=excluded.hour,
      time_zone=excluded.time_zone,next_at=excluded.next_at,updated_at=now(),last_error=NULL
    RETURNING owner,enabled,hour,time_zone,next_at,last_run_at,last_run_id,last_error,updated_at`;
  return row;
}

async function housekeepingSession(tx, owner) {
  const [existing] = await tx`
    SELECT id,owner,title,summary,summary_seq,created_at,updated_at
    FROM keeper_sessions WHERE owner=${owner} AND title='Housekeeping' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`;
  if (existing) return existing;
  const id = randomUUID();
  const [row] = await tx`
    INSERT INTO keeper_sessions(id,owner,title) VALUES(${id},${owner},'Housekeeping')
    RETURNING id,owner,title,summary,summary_seq,created_at,updated_at`;
  return row;
}

/**
 * Queue at most one autonomous run for every due owner. The schedule row is
 * locked while the run is created, so multiple worker replicas coalesce a
 * missed day and cannot enqueue duplicates.
 */
export async function scheduleHousekeeping(sql, {
  timeZone = "UTC",
  prompt = DEFAULT_SCHEDULE_PROMPT,
  now = new Date(),
  ownerId = null,
} = {}) {
  return sql.begin(async (tx) => {
    const due = await tx`
      SELECT s.owner,s.enabled,s.hour,s.time_zone,s.next_at
      FROM keeper_schedule s
      JOIN owners o ON o.id=s.owner
      WHERE s.enabled=true AND s.next_at IS NOT NULL AND s.next_at<=${now}
        AND (${ownerId}::uuid IS NULL OR s.owner=${ownerId}::uuid)
      ORDER BY s.next_at,s.owner FOR UPDATE OF s SKIP LOCKED`;
    let queued = 0;
    for (const schedule of due) {
      const [busy] = await tx`
        SELECT id FROM keeper_runs
        WHERE owner=${schedule.owner} AND source='schedule' AND status IN ('queued','waiting','running')
        LIMIT 1`;
      let next = nextLocalHour(schedule.hour, schedule.time_zone || timeZone, now);
      // Advance through every missed occurrence, but enqueue one report only.
      while (next <= now) next = nextLocalHour(schedule.hour, schedule.time_zone || timeZone, new Date(next.getTime() + 1000));
      if (busy) {
        await tx`UPDATE keeper_schedule SET next_at=${next},updated_at=now() WHERE owner=${schedule.owner}`;
        continue;
      }
      const session = await housekeepingSession(tx, schedule.owner);
      const runId = randomUUID();
      const [run] = await tx`
        INSERT INTO keeper_runs(id,owner,session,source,prompt,asset_ids,options,next_at)
        VALUES(${runId},${schedule.owner},${session.id},'schedule',${prompt},'[]',${json(tx, { sliceTurns: 10, sliceMutations: 100 })},now())
        RETURNING id,owner,session,source,status,prompt,asset_ids,options,next_at,created_at`;
      const [message] = await tx`
        INSERT INTO keeper_messages(id,owner,session,run,role,content,message)
        VALUES(${randomUUID()},${schedule.owner},${session.id},${runId},'system',${prompt},${json(tx, { role: "system", content: prompt })})
        RETURNING seq,id,owner,session,run,role,content,message,created_at`;
      await tx`UPDATE keeper_sessions SET updated_at=now() WHERE owner=${schedule.owner} AND id=${session.id}`;
      await tx`
        UPDATE keeper_schedule SET next_at=${next},last_run_at=now(),last_run_id=${runId},last_error=NULL,updated_at=now()
        WHERE owner=${schedule.owner}`;
      await tx`INSERT INTO keeper_events(owner,run,type,data)
        VALUES(${schedule.owner},${runId},'run.scheduled',${json(tx, { messageSeq: message.seq, scheduledAt: now.toISOString(), nextAt: next.toISOString() })})`;
      queued++;
      // Keep the value available to callers without exposing credentials.
      void run;
    }
    return queued;
  });
}

export class KeeperScheduler {
  constructor({ sql, harness, timeZone = process.env.TZ || "UTC", intervalMs = 60_000, prompt = DEFAULT_SCHEDULE_PROMPT } = {}) {
    this.sql = sql;
    this.harness = harness;
    this.timeZone = timeZone;
    this.intervalMs = Math.max(5_000, intervalMs);
    this.prompt = prompt;
    this.timer = null;
    this.stopping = false;
  }

  async tick() {
    return scheduleHousekeeping(this.sql, { timeZone: this.timeZone, prompt: this.prompt });
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    const loop = async () => {
      if (this.stopping) return;
      try { await this.tick(); } catch { /* next tick retries after a database restart */ }
    };
    void loop();
    this.timer = setInterval(() => void loop(), this.intervalMs);
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
