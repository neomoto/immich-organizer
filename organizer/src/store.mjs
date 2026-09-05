import postgres from "postgres";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
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
export async function connect(url) {
  const sql = postgres(url, { max: 6, onnotice: () => {} });
  await sql`CREATE TABLE IF NOT EXISTS owners (id uuid PRIMARY KEY, credential text NOT NULL, settings jsonb NOT NULL DEFAULT '{}', cursor timestamptz)`;
  await sql`CREATE TABLE IF NOT EXISTS assets (owner uuid NOT NULL REFERENCES owners(id), id uuid NOT NULL,
    checksum text NOT NULL, snapshot jsonb NOT NULL, provenance jsonb NOT NULL DEFAULT '{}', facts jsonb NOT NULL DEFAULT '{}',
    locks jsonb NOT NULL DEFAULT '{}', result jsonb, proposal jsonb, status text NOT NULL DEFAULT 'pending',
    attempts int NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
    error text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,id))`;
  await sql`CREATE TABLE IF NOT EXISTS changes (id uuid PRIMARY KEY, owner uuid NOT NULL, asset uuid NOT NULL,
    kind text NOT NULL DEFAULT 'metadata',
    before_value jsonb NOT NULL, after_value jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`ALTER TABLE changes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'metadata'`;
  await sql`CREATE TABLE IF NOT EXISTS events (owner uuid NOT NULL, id text NOT NULL, title text NOT NULL,
    album uuid, data jsonb NOT NULL, PRIMARY KEY(owner,id))`;
  await sql`CREATE TABLE IF NOT EXISTS usage (owner uuid NOT NULL, day text NOT NULL, calls int NOT NULL DEFAULT 0,
    PRIMARY KEY(owner,day))`;
  await sql`CREATE INDEX IF NOT EXISTS assets_work_idx ON assets(status,next_at)`;
  await sql`CREATE INDEX IF NOT EXISTS changes_owner_idx ON changes(owner,created_at)`;
  return sql;
}
