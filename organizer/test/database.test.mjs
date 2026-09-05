import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, secretBox } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { DEFAULTS } from "../src/policy.mjs";

test(
  "durable queue: isolation, atomic quotas, crash reconciliation, and manual conflicts",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = await connect(process.env.TEST_DATABASE_URL),
      owner = randomUUID(),
      other = randomUUID(),
      id = randomUUID();
    const box = secretBox("integration-test-secret-not-production");
    const engine = new Engine(sql, box, {
      immich: "http://unused.test",
      timeZone: "UTC",
      vision: { model: "test" },
    });
    try {
      await sql`INSERT INTO owners(id,credential,settings) VALUES(${owner},${box.seal("fake")},${sql.json({ ...DEFAULTS, enabled: true, automatic: true, dailyLimit: 2 })}),
    (${other},${box.seal("other")},${sql.json(DEFAULTS)})`;
      const o = await engine.owner(owner);
      const reservations = await Promise.allSettled([
        engine.reserve(o),
        engine.reserve(o),
        engine.reserve(o),
      ]);
      assert.equal(
        reservations.filter((x) => x.status === "fulfilled").length,
        2,
      );
      await sql`INSERT INTO assets(owner,id,checksum,snapshot,status) VALUES(${owner},${id},'hash','{}','running')`;
      const lease = randomUUID();
      const [row] = await sql`UPDATE assets SET lease_token=${lease},lease_until=now()+interval '15 minutes' WHERE owner=${owner} AND id=${id} RETURNING *`;
      const change = randomUUID();
      await sql`INSERT INTO changes(id,owner,asset,before_value,after_value) VALUES(${change},${owner},${id},'{"description":null}','{"description":"caption"}')`;
      let writes = 0;
      engine.asset = async () => ({
        id,
        ownerId: owner,
        exifInfo: { description: "caption" },
      });
      engine.api = async (o, p, b) => {
        if (p === `/organizer/metadata/${id}`) writes++;
      return {writable: true};
      };
      await engine.apply(
        o,
        { id, exifInfo: {} },
        row,
        { event: null },
        { patch: {}, tags: [] },
      );
      assert.equal(
        writes,
        0,
        "an acknowledged write is not repeated after restart",
      );
      assert.equal(
        (await sql`SELECT status FROM changes WHERE id=${change}`)[0].status,
        "applied",
      );
      assert.equal(
        (await sql`SELECT * FROM changes WHERE owner=${other}`).length,
        0,
      );
      await sql`UPDATE changes SET status='pending' WHERE id=${change}`;
      engine.asset = async () => ({
        id,
        ownerId: owner,
        exifInfo: { description: "manually edited" },
      });
      await assert.rejects(
        () =>
          engine.apply(
            o,
            { id, exifInfo: {} },
            row,
            { event: null },
            { patch: {}, tags: [] },
          ),
        /Manual edit conflicts/,
      );
      await sql`UPDATE assets SET status='pending' WHERE owner=${owner}`;
      await sql`UPDATE owners SET settings=${sql.json({ ...DEFAULTS, enabled: false })} WHERE id=${owner}`;
      assert.equal(
        await engine.work(owner),
        false,
        "paused users do not acquire work",
      );
    } finally {
      await sql`DELETE FROM changes WHERE owner=${owner}`;
      await sql`DELETE FROM assets WHERE owner=${owner}`;
      await sql`DELETE FROM usage WHERE owner=${owner}`;
      await sql`DELETE FROM owners WHERE id IN (${owner},${other})`;
      await sql.end();
    }
  },
);
