import postgres from "postgres";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  randomUUID,
} from "node:crypto";

export function secretBox(secret) {
  if (!secret || secret.length < 32)
    throw Error("ORGANIZER_SECRET must contain at least 32 characters");
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(value) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    open(value) {
      const b = Buffer.from(value, "base64");
      const c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      c.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(
        "utf8",
      );
    },
  };
}
export async function connect(url, migrationAttempt = 0) {
  if (!url) throw Error('ORGANIZER_DATABASE_URL is required');
  const sql = postgres(url, { max: 12, onnotice: () => {} });
  try {
  await sql.begin(async sql => {
  await sql`SELECT pg_advisory_xact_lock(719682341)`;
  await sql`CREATE TABLE IF NOT EXISTS organizer_schema (version int PRIMARY KEY)`;
  if (!(await sql`SELECT version FROM organizer_schema WHERE version=2`).length) {
  await sql`CREATE TABLE IF NOT EXISTS owners (id uuid PRIMARY KEY, credential text NOT NULL, settings jsonb NOT NULL DEFAULT '{}', cursor timestamptz)`;
  await sql`CREATE TABLE IF NOT EXISTS runs (id uuid PRIMARY KEY, owner uuid NOT NULL REFERENCES owners(id),
    options jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', count int NOT NULL DEFAULT 0,
    lease_until timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS assets (owner uuid NOT NULL REFERENCES owners(id), id uuid NOT NULL,
    checksum text NOT NULL, snapshot jsonb NOT NULL, provenance jsonb NOT NULL DEFAULT '{}', facts jsonb NOT NULL DEFAULT '{}',
    locks jsonb NOT NULL DEFAULT '{}', result jsonb, proposal jsonb, status text NOT NULL DEFAULT 'pending',
    attempts int NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
    error text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,id))`;
  await sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS lease_token uuid`;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_token uuid`;
  await sql`ALTER TABLE owners ADD COLUMN IF NOT EXISTS connection_id uuid`;
  await sql`CREATE TABLE IF NOT EXISTS source_manifests (owner uuid NOT NULL REFERENCES owners(id),checksum text NOT NULL,provenance jsonb NOT NULL,PRIMARY KEY(owner,checksum))`;
  await sql`CREATE TABLE IF NOT EXISTS changes (id uuid PRIMARY KEY, owner uuid NOT NULL, asset uuid NOT NULL,
    kind text NOT NULL DEFAULT 'metadata',
    before_value jsonb NOT NULL, after_value jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`ALTER TABLE changes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'metadata'`;
  await sql`ALTER TABLE changes ADD COLUMN IF NOT EXISTS before_locks jsonb`;
  await sql`ALTER TABLE changes ADD COLUMN IF NOT EXISTS after_locks jsonb`;
  await sql`CREATE TABLE IF NOT EXISTS events (owner uuid NOT NULL, id text NOT NULL, title text NOT NULL,
    album uuid, data jsonb NOT NULL, PRIMARY KEY(owner,id))`;
  await sql`CREATE TABLE IF NOT EXISTS usage (owner uuid NOT NULL, day text NOT NULL, calls int NOT NULL DEFAULT 0,
    PRIMARY KEY(owner,day))`;
  await sql`CREATE INDEX IF NOT EXISTS assets_work_idx ON assets(status,next_at)`;
  await sql`CREATE INDEX IF NOT EXISTS changes_owner_idx ON changes(owner,created_at)`;
  await sql`INSERT INTO organizer_schema(version) VALUES(2) ON CONFLICT DO NOTHING`;
  }
  const keeperMigrationNeeded = !(await sql`SELECT version FROM organizer_schema WHERE version=4`).length;
  if (keeperMigrationNeeded) {
  // Keeper was added after the original worker schema. Keep every statement
  // idempotent: a worker can be killed between any two DDL statements and the
  // next process must be able to finish the migration. Version 4 marks the
  // additive columns as complete, so normal worker connections do not repeat
  // relation-locking DDL while another process is processing jobs.
  await sql`CREATE TABLE IF NOT EXISTS provider_slots (
    id int PRIMARY KEY CHECK(id IN (1,2)), token uuid, owner uuid,
    lease_until timestamptz
  )`;
  await sql`INSERT INTO provider_slots(id) VALUES(1),(2) ON CONFLICT(id) DO NOTHING`;
  await sql`CREATE TABLE IF NOT EXISTS keeper_sessions (
    id uuid PRIMARY KEY,
    owner uuid NOT NULL REFERENCES owners(id),
    title text NOT NULL,
    summary text NOT NULL DEFAULT '',
    summary_seq bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS keeper_runs (
    id uuid PRIMARY KEY,
    owner uuid NOT NULL REFERENCES owners(id),
    session uuid NOT NULL REFERENCES keeper_sessions(id),
    source text NOT NULL DEFAULT 'chat',
    status text NOT NULL DEFAULT 'queued',
    prompt text NOT NULL,
    asset_ids jsonb NOT NULL DEFAULT '[]',
    options jsonb NOT NULL DEFAULT '{}',
    lease_token uuid,
    lease_until timestamptz,
    next_at timestamptz NOT NULL DEFAULT now(),
    stop_requested boolean NOT NULL DEFAULT false,
    slice_turns int NOT NULL DEFAULT 0,
    slice_tool_calls int NOT NULL DEFAULT 0,
    slice_mutations int NOT NULL DEFAULT 0,
    total_turns int NOT NULL DEFAULT 0,
    total_tool_calls int NOT NULL DEFAULT 0,
    total_mutations int NOT NULL DEFAULT 0,
    checkpoint jsonb NOT NULL DEFAULT '{}',
    blocked_reason text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
  )`;
  await sql`CREATE TABLE IF NOT EXISTS keeper_messages (
    seq bigserial PRIMARY KEY,
    id uuid NOT NULL,
    owner uuid NOT NULL,
    session uuid NOT NULL REFERENCES keeper_sessions(id),
    run uuid NOT NULL REFERENCES keeper_runs(id),
    role text NOT NULL,
    content text NOT NULL,
    message jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS keeper_events (
    seq bigserial PRIMARY KEY,
    owner uuid NOT NULL,
    run uuid NOT NULL REFERENCES keeper_runs(id),
    type text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS keeper_schedule (
    owner uuid PRIMARY KEY REFERENCES owners(id),
    enabled boolean NOT NULL DEFAULT false,
    hour int NOT NULL DEFAULT 3 CHECK(hour BETWEEN 0 AND 23),
    time_zone text NOT NULL DEFAULT 'UTC',
    next_at timestamptz,
    last_run_at timestamptz,
    last_run_id uuid,
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS keeper_mutations (
    run uuid NOT NULL REFERENCES keeper_runs(id),
    asset uuid NOT NULL,
    kind text NOT NULL DEFAULT 'asset',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(run,asset)
  )`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS next_at timestamptz NOT NULL DEFAULT now()`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS stop_requested boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS slice_turns int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS slice_tool_calls int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS slice_mutations int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS total_turns int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS total_tool_calls int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS total_mutations int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS checkpoint jsonb NOT NULL DEFAULT '{}'`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS blocked_reason text`;
  await sql`ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
  await sql`ALTER TABLE keeper_schedule ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'UTC'`;
  await sql`ALTER TABLE keeper_schedule ADD COLUMN IF NOT EXISTS last_run_id uuid`;
  await sql`ALTER TABLE keeper_schedule ADD COLUMN IF NOT EXISTS last_error text`;
  await sql`ALTER TABLE keeper_schedule ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
  await sql`ALTER TABLE keeper_mutations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'asset'`;
  await sql`ALTER TABLE keeper_mutations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
  await sql`CREATE INDEX IF NOT EXISTS keeper_runs_claim_idx ON keeper_runs(status,next_at,created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS keeper_runs_owner_idx ON keeper_runs(owner,created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS keeper_events_run_idx ON keeper_events(owner,run,seq)`;
  await sql`CREATE INDEX IF NOT EXISTS keeper_messages_session_idx ON keeper_messages(owner,session,seq)`;
  await sql`INSERT INTO organizer_schema(version) VALUES(3),(4) ON CONFLICT DO NOTHING`;
  }
  });
  } catch (error) {
    await sql.end();
    // DDL is serialized with an advisory lock, but a concurrent test or
    // rolling deployment can still hold a relation lock while PostgreSQL
    // detects a deadlock. Retry the complete idempotent migration a few times
    // instead of failing a worker startup permanently.
    if (error?.code === '40P01' && migrationAttempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 100 * (migrationAttempt + 1)));
      return connect(url, migrationAttempt + 1);
    }
    throw error;
  }
  return sql;
}

// Hidden Immich assets can appear in the derived queue after an upgrade from a
// worker that did not yet enforce the visibility policy. Remove only those
// derived rows. Their source media and every other Organizer relation remain
// untouched, and the query returns only an aggregate count for safe logging.
export async function reconcileHiddenAssets(sql) {
  const [result] = await sql`WITH removed AS (
    DELETE FROM assets
    WHERE snapshot->>'visibility' = 'hidden'
    RETURNING 1
  )
  SELECT count(*)::int AS count FROM removed`;
  return Number(result?.count || 0);
}

export async function claimRun(sql, ownerId = null) {
  const leaseToken = randomUUID();
  const [run] = await sql`WITH candidate AS (
      SELECT r.id FROM runs r JOIN owners o ON o.id=r.owner
      WHERE coalesce((o.settings->>'enabled')::boolean,false)
        AND (${ownerId}::uuid IS NULL OR r.owner=${ownerId}::uuid)
        AND (r.status='queued' OR (r.status='running' AND r.lease_until<now()))
      ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1
    )
    UPDATE runs AS target SET status='running',lease_until=now()+interval '30 minutes',lease_token=${leaseToken}
    FROM candidate WHERE target.id=candidate.id RETURNING target.*`;
  return run;
}

export async function completeRun(sql, run, count, error = null) {
  return sql`UPDATE runs SET status=${error ? 'failed' : 'complete'},count=${count},error=${error},lease_until=NULL,lease_token=NULL
    WHERE id=${run.id} AND owner=${run.owner} AND lease_token=${run.lease_token} RETURNING id`;
}

export async function scheduleCatchup(sql) {
  // Serialize the check and insert across worker replicas.
  return sql.begin(async tx => {
    const owners = await tx`SELECT id FROM owners WHERE (settings->>'enabled')::boolean=true
      AND (settings->>'continuous')::boolean=true FOR UPDATE SKIP LOCKED`;
    let count = 0;
    for (const o of owners) {
      const busy = await tx`SELECT id FROM runs WHERE owner=${o.id} AND status IN ('queued','running') LIMIT 1`;
      if (!busy.length) {
        await tx`INSERT INTO runs(id,owner,options) VALUES(${randomUUID()},${o.id},'{"limit":100000}')`;
        count++;
      }
    }
    return count;
  });
}
