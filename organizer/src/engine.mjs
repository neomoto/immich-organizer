import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULTS,
  eligible,
  propose,
  patchBefore,
  unchanged,
  eventKey,
  digest,
  corroboratedDay,
} from "./policy.mjs";
import { analyze, lookupPlace, PROMPT_VERSION } from "./vision.mjs";
const exec = promisify(execFile);

export class Engine {
  constructor(sql, box, config) {
    this.sql = sql;
    this.box = box;
    this.config = config;
    this.stopping = false;
  }
  async owner(id) {
    const [o] = await this.sql`SELECT * FROM owners WHERE id=${id}`;
    if (!o) throw Error("Enable Organize first");
    return { ...o, settings: { ...DEFAULTS, ...o.settings } };
  }
  async api(o, path, body, method = body ? "POST" : "GET", binary = false) {
    const r = await fetch(`${this.config.immich}/api${path}`, {
      method,
      headers: {
        "x-api-key": this.box.open(o.credential),
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(binary ? 180000 : 30000),
    });
    if (!r.ok) throw Error(`Immich ${path.split("?")[0]} HTTP ${r.status}`);
    if (binary)
      return {
        bytes: Buffer.from(await r.arrayBuffer()),
        type: r.headers.get("content-type"),
      };
    return r.status === 204 ? null : r.json();
  }
  async asset(o, id) {
    const a = await this.api(o, `/assets/${id}`);
    if (a.ownerId !== o.id || !eligible(a))
      throw Error("Asset is outside the enabled library");
    return a;
  }
  async inventory(o, { assetIds = [], limit = 200, reanalyze = false } = {}) {
    let count = 0;
    const add = async (a) => {
      if (a.ownerId !== o.id || !eligible(a) || count >= limit) return;
      await this
        .sql`INSERT INTO assets(owner,id,checksum,snapshot) VALUES(${o.id},${a.id},${a.checksum},${this.sql.json(a)})
        ON CONFLICT(owner,id) DO UPDATE SET snapshot=excluded.snapshot,
        status=CASE WHEN assets.checksum <> excluded.checksum OR ${reanalyze} THEN 'pending' ELSE assets.status END,
        result=CASE WHEN assets.checksum <> excluded.checksum OR ${reanalyze} THEN NULL ELSE assets.result END,
        checksum=excluded.checksum, next_at=now(), updated_at=now()`;
      count++;
    };
    if (assetIds.length) {
      for (const id of assetIds) await add(await this.asset(o, id));
    } else
      for (let page = 1; count < limit; page++) {
        const r = await this.api(o, "/search/metadata", {
          page,
          size: Math.min(100, limit - count),
          withExif: true,
        });
        for (const a of r.assets.items) await add(a);
        if (!r.assets.nextPage || !r.assets.items.length) break;
      }
    return { queued: count };
  }
  async reserve(o) {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.config.timeZone,
    }).format(new Date());
    const rows = await this
      .sql`INSERT INTO usage(owner,day,calls) VALUES(${o.id},${day},1)
      ON CONFLICT(owner,day) DO UPDATE SET calls=usage.calls+1 WHERE usage.calls < ${o.settings.dailyLimit} RETURNING calls`;
    if (!rows.length) {
      const e = Error("Daily model request limit reached");
      e.quota = true;
      throw e;
    }
  }
  async images(o, a) {
    const directory = await mkdtemp(join(tmpdir(), "organizer-"));
    try {
      if (a.type !== "VIDEO" || a.livePhotoVideoId) {
        const preview = await this.api(
          o,
          `/assets/${a.id}/thumbnail?size=preview`,
          null,
          "GET",
          true,
        );
        const input = join(directory, "input");
        await writeFile(input, preview.bytes);
        const output = join(directory, "image.jpg");
        await exec(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            input,
            "-vf",
            "scale='min(1536,iw)':'min(1536,ih)':force_original_aspect_ratio=decrease",
            "-frames:v",
            "1",
            output,
          ],
          { timeout: 60000 },
        );
        return [
          "data:image/jpeg;base64," +
            (await readFile(output)).toString("base64"),
        ];
      }
      // Only one video extractor runs at a time per worker process.
      const previous = this.videoLock || Promise.resolve();
      let release;
      this.videoLock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const key = this.box.open(o.credential);
        // Header credentials are passed to ffmpeg only inside the private worker container.
        const url = `${this.config.immich}/api/assets/${a.id}/original`;
        const duration = String(a.duration || "0:00:01")
          .split(":")
          .reduce((v, n) => v * 60 + Number(n), 0);
        await exec(
          "ffmpeg",
          [
            "-v",
            "error",
            "-headers",
            `x-api-key: ${key}\r\n`,
            "-i",
            url,
            "-vf",
            `fps=1/${Math.max(1, duration / 8)},scale=1024:-2`,
            "-frames:v",
            "8",
            join(directory, "frame-%02d.jpg"),
          ],
          { timeout: 180000 },
        );
        const names = (await readdir(directory))
          .filter((n) => n.startsWith("frame-"))
          .sort();
        if (!names.length) throw Error("No usable video frames");
        return await Promise.all(
          names.map(
            async (n) =>
              "data:image/jpeg;base64," +
              (await readFile(join(directory, n))).toString("base64"),
          ),
        );
      } finally {
        release();
      }
    } catch (e) {
      if (e.cmd) throw Error("Media conversion failed");
      throw e;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async context(o, row, a) {
    const group = row.provenance.group;
    const peers = group
      ? await this
          .sql`SELECT id,provenance FROM assets WHERE owner=${o.id} AND id<>${a.id}
      AND provenance->>'group'=${group} LIMIT 20`
      : [];
    return {
      filename: a.originalFileName,
      currentMetadata: a.exifInfo,
      source: row.provenance,
      manualFacts: row.facts,
      neighbors: peers.map((p) => ({ id: p.id, source: p.provenance })),
      knownPeople: (a.people || []).filter((p) => p.name).map((p) => p.name),
      videoDuration: a.duration,
    };
  }
  async work() {
    const [row] = await this
      .sql`UPDATE assets SET status='running', lease_until=now()+interval '15 minutes'
      WHERE (owner,id) IN (SELECT a.owner,a.id FROM assets a JOIN owners o ON o.id=a.owner
      WHERE coalesce((o.settings->>'enabled')::boolean,false) AND
        ((a.status IN ('pending','retry') AND a.next_at<=now()) OR (a.status='running' AND a.lease_until<now()))
      ORDER BY a.next_at FOR UPDATE OF a SKIP LOCKED LIMIT 1) RETURNING *`;
    if (!row) return false;
    try {
      const o = await this.owner(row.owner),
        a = await this.asset(o, row.id);
      let result = row.result;
      const context = await this.context(o, row, a);
      if (!result) {
        if (!this.config.vision.key)
          throw Error("Configure VISION_API_KEY before analysis");
        const images = await this.images(o, a);
        await this.reserve(o);
        result = await analyze(images, context, this.config.vision);
        if (o.settings.webLookup && result.location?.name) {
          const sources = await lookupPlace(result.location.name).catch(
            () => [],
          );
          if (sources.length) {
            await this.reserve(o);
            result = await analyze(
              images,
              { ...context, preliminary: result, webEvidence: sources },
              this.config.vision,
            );
            result.webSources = sources;
          }
        }
        result.model = this.config.vision.model;
        result.promptVersion = PROMPT_VERSION;
        result.contextHash = digest(context);
      }
      const facts = { ...row.facts };
      const inferredDay = corroboratedDay(
        row.provenance,
        context.neighbors.map((n) => n.source),
        result.date,
      );
      if (inferredDay && !facts.captureDay) {
        facts.captureDay = inferredDay;
        facts.suspectDate =
          row.provenance.verified &&
          !row.provenance.captureDate &&
          row.provenance.fileModifiedAt?.slice(0, 10) ===
            (a.exifInfo?.dateTimeOriginal || a.fileCreatedAt || "").slice(
              0,
              10,
            );
      }
      const p = propose(a, result, {
        original: row.provenance,
        facts,
        locks: row.locks,
        settings: o.settings,
      });
      await this
        .sql`UPDATE assets SET result=${this.sql.json(result)},proposal=${this.sql.json(p)},updated_at=now()
        WHERE owner=${o.id} AND id=${a.id}`;
      if (o.settings.automatic && !row.locks.suppressed)
        await this.apply(o, a, row, result, p);
      await this
        .sql`UPDATE assets SET status='analyzed',error=NULL,lease_until=NULL WHERE owner=${o.id} AND id=${a.id}`;
    } catch (e) {
      const previewMissing = /thumbnail.*HTTP 404/.test(e.message);
      const attempts = row.attempts + 1;
      await this
        .sql`UPDATE assets SET status=${e.quota || previewMissing || attempts < 3 ? "retry" : "failed"},attempts=${e.quota || previewMissing ? row.attempts : attempts},
        error=${e.cmd ? "Media conversion failed" : String(e.message).slice(0, 300)},lease_until=NULL,
        next_at=now()+${(e.quota ? 3600 : Math.min(3600, 30 * 2 ** attempts)) + " seconds"}::interval
        WHERE owner=${row.owner} AND id=${row.id}`;
    }
    return true;
  }
  async apply(o, a, row, result, proposal) {
    const health = await this.api(o, `/organizer/storage/${a.id}`);
    if (!health.writable) {
      await this.sql`UPDATE owners SET settings=settings || '{"enabled":false}'::jsonb WHERE id=${o.id}`;
      throw Error('Storage is read-only; Organize has been paused');
    }
    // Write-ahead journal: reconcile after an API timeout before submitting again.
    const pending = await this
      .sql`SELECT * FROM changes WHERE owner=${o.id} AND asset=${a.id} AND status='pending' ORDER BY created_at`;
    for (const change of pending) {
      if (change.kind === "tag" || change.kind === "album") {
        const path =
          change.kind === "tag"
            ? `/tags/${change.after_value.tagId}/assets`
            : `/albums/${change.after_value.albumId}/assets`;
        await this.api(o, path, { ids: [a.id] }, "PUT");
        await this
          .sql`UPDATE changes SET status='applied',updated_at=now() WHERE id=${change.id}`;
        continue;
      }
      const current = await this.asset(o, a.id);
      if (unchanged(current, change.after_value))
        await this
          .sql`UPDATE changes SET status='applied',updated_at=now() WHERE id=${change.id}`;
      else if (unchanged(current, change.before_value)) {
        await this.api(o, `/assets/${a.id}`, change.after_value, "PUT");
        await this
          .sql`UPDATE changes SET status='applied',updated_at=now() WHERE id=${change.id}`;
      } else throw Error("Manual edit conflicts with interrupted change");
    }
    const patch = proposal.patch;
    if (Object.keys(patch).length) {
      const current = await this.asset(o, a.id),
        before = patchBefore(a, patch);
      if (!unchanged(current, before))
        throw Error("Asset changed while being analyzed");
      if (!unchanged(current, patch)) {
        const id = randomUUID();
        await this
          .sql`INSERT INTO changes(id,owner,asset,before_value,after_value)
          VALUES(${id},${o.id},${a.id},${this.sql.json(before)},${this.sql.json(patch)})`;
        await this.api(o, `/assets/${a.id}`, patch, "PUT");
        await this
          .sql`UPDATE changes SET status='applied',updated_at=now() WHERE id=${id}`;
      }
    }
    await this.api(
      o,
      `/assets/${a.id}/metadata`,
      {
        items: [
          {
            key: "organizer.v1",
            value: {
              ...proposal,
              caption: result.caption,
              model: result.model,
            },
          },
        ],
      },
      "PUT",
    );
    if (proposal.tags.length) {
      const tags = await this.api(o, "/tags", { tags: proposal.tags }, "PUT");
      const current = await this.asset(o, a.id);
      for (const tag of tags)
        if (!(current.tags || []).some((t) => t.id === tag.id)) {
          const id = randomUUID();
          await this
            .sql`INSERT INTO changes(id,owner,asset,kind,before_value,after_value)
          VALUES(${id},${o.id},${a.id},'tag',${this.sql.json({ tagId: tag.id, member: false })},${this.sql.json({ tagId: tag.id, member: true })})`;
          await this.api(o, `/tags/${tag.id}/assets`, { ids: [a.id] }, "PUT");
          await this
            .sql`UPDATE changes SET status='applied',updated_at=now() WHERE id=${id}`;
        }
    }
    const key = eventKey(o.id, result, row.provenance);
    if (key) {
      // Advisory lock avoids creating the same album from parallel asset jobs.
      const event = await this.sql.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
        let [event] =
          await sql`SELECT * FROM events WHERE owner=${o.id} AND id=${key}`;
        if (!event) {
          const title = `AI · ${result.event} · ${result.date.start}`;
          const albums = await this.api(o, "/albums");
          const album =
            albums.find(
              (x) =>
                x.albumName === title && x.description === `organizer:${key}`,
            ) ||
            (await this.api(o, "/albums", {
              albumName: title,
              description: `organizer:${key}`,
            }));
          [event] =
            await sql`INSERT INTO events(owner,id,title,album,data) VALUES(${o.id},${key},${title},${album.id},${sql.json({ date: result.date, location: result.location })}) RETURNING *`;
        }
        return event;
      });
      const album = await this.api(o, `/albums/${event.album}`);
      if (!(album.assets || []).some((x) => x.id === a.id)) {
        const id = randomUUID();
        await this
          .sql`INSERT INTO changes(id,owner,asset,kind,before_value,after_value)
            VALUES(${id},${o.id},${a.id},'album',${this.sql.json({ albumId: event.album, member: false })},${this.sql.json({ albumId: event.album, member: true })})`;
        await this.api(
          o,
          `/albums/${event.album}/assets`,
          { ids: [a.id] },
          "PUT",
        );
        await this
          .sql`UPDATE changes SET status='applied',updated_at=now() WHERE id=${id}`;
      }
    }
  }
}
