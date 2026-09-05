import { randomUUID } from "node:crypto";
import { lookupPlace } from "../vision.mjs";
import { unchanged } from "../policy.mjs";
import { ToolRegistry } from "./registry.mjs";
import { redactVisible, visibleContent } from "./session.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANALYSIS_STATUSES = ["pending", "running", "retry", "failed", "analyzed"];

function json(sql, value) {
  return typeof sql.json === "function" ? sql.json(value) : value;
}

function id(value, label = "asset") {
  if (typeof value !== "string" || !UUID.test(value)) throw Error(`Invalid ${label} ID`);
  return value;
}

function ownerOf(context) {
  if (!context?.owner?.id || !UUID.test(context.owner.id)) throw Error("Keeper operation is not owner-scoped");
  return context.owner;
}

function boundedText(value, max, label) {
  if (typeof value !== "string" || value.length > max) throw Error(`Invalid ${label}`);
  return value;
}

function safeSource(row, asset) {
  const source = row?.provenance && typeof row.provenance === "object" ? row.provenance : {};
  return redactVisible({
    checksum: row?.checksum,
    filename: source.filename || asset?.originalFileName,
    group: source.group,
    verified: source.verified === true,
    captureDate: source.captureDate,
    originalExif: source.originalExif,
  });
}

function safeExif(exif) {
  if (!exif || typeof exif !== "object") return {};
  return redactVisible({
    description: exif.description ?? "",
    dateTimeOriginal: exif.dateTimeOriginal ?? null,
    latitude: exif.latitude ?? null,
    longitude: exif.longitude ?? null,
    timeZone: exif.timeZone ?? null,
    make: exif.make ?? null,
    model: exif.model ?? null,
  });
}

function publicAsset(row, asset) {
  return {
    id: asset.id,
    filename: asset.originalFileName || row?.snapshot?.originalFileName || null,
    type: asset.type || null,
    checksum: row?.checksum || asset.checksum || null,
    exif: safeExif(asset.exifInfo),
    status: row?.status || null,
    revision: row?.revision == null ? null : Number(row.revision),
  };
}

async function cachedAsset(sql, engine, owner, assetId) {
  const [row] = await sql`
    SELECT id,checksum,snapshot,provenance,facts,locks,result,proposal,status,revision,updated_at
    FROM assets WHERE owner=${owner.id} AND id=${assetId}`;
  if (!row) throw Error("Asset has not been inventoried yet");
  const asset = await engine.asset(owner, assetId);
  return { row, asset };
}

function resultSummary(row) {
  if (!row?.result) return null;
  return redactVisible({
    caption: row.result.caption,
    objects: row.result.objects,
    activities: row.result.activities,
    ocr: row.result.ocr,
    tags: row.result.tags,
    category: row.result.category,
    date: row.result.date,
    location: row.result.location,
    evidence: row.result.evidence,
    webSources: row.result.webSources,
    model: row.result.model,
    promptVersion: row.result.promptVersion,
  });
}

async function searchPhotos(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  const query = boundedText(String(input.query ?? input.q ?? ""), 200, "search query");
  const status = input.status ?? "";
  if (status && !ANALYSIS_STATUSES.includes(status)) throw Error("Invalid analysis status");
  const offset = input.offset == null ? 0 : Number(input.offset);
  const limit = input.limit == null ? 25 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw Error("Invalid search pagination");
  }
  const pattern = `%${query}%`;
  const rows = await sql`
    SELECT id,checksum,snapshot,provenance,facts,locks,result,proposal,status,revision,updated_at
    FROM assets WHERE owner=${owner.id}
      AND (${status}='' OR status=${status})
      AND (snapshot->>'originalFileName' ILIKE ${pattern} OR result::text ILIKE ${pattern})
    ORDER BY updated_at DESC,id LIMIT ${limit} OFFSET ${offset}`;
  const results = [];
  for (const row of rows) {
    try {
      const asset = await engine.asset(owner, row.id);
      results.push({
        ...publicAsset(row, asset),
        result: resultSummary(row),
        proposal: redactVisible(row.proposal),
        facts: redactVisible(row.facts),
        source: safeSource(row, asset),
      });
    } catch {
      // Re-check visibility against Immich before exposing cached evidence.
    }
  }
  return { results, offset, limit, hasMore: rows.length === limit };
}

async function inspectPhoto(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  const assetId = id(input.assetId ?? input.id);
  const { row, asset } = await cachedAsset(sql, engine, owner, assetId);
  return {
    asset: publicAsset(row, asset),
    // These are stable references, never image bytes or local paths. The next
    // model turn can request the same owner-scoped asset by ID.
    imageRefs: {
      preview: { assetId, kind: "preview" },
      original: { assetId, kind: "original" },
    },
    originalEvidence: safeSource(row, asset),
    currentMetadata: safeExif(asset.exifInfo),
    facts: redactVisible(row.facts),
    locks: redactVisible(row.locks),
    result: resultSummary(row),
    proposal: redactVisible(row.proposal),
  };
}

async function relatedPhotos(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  const assetId = id(input.assetId ?? input.id);
  const { row, asset } = await cachedAsset(sql, engine, owner, assetId);
  const related = await engine.context(owner, row, asset);
  return {
    assetId,
    neighbors: (related.neighbors || []).slice(0, 6).map((neighbor) => ({
      id: neighbor.id,
      source: redactVisible({
        checksum: neighbor.source?.checksum,
        filename: neighbor.source?.filename,
        group: neighbor.source?.group,
        verified: neighbor.source?.verified,
        captureDate: neighbor.source?.captureDate,
      }),
    })),
    knownPeople: Array.isArray(related.knownPeople) ? related.knownPeople.slice(0, 50).map((name) => visibleContent(String(name), 200)) : [],
  };
}

async function lookupControlledPlace(input, context) {
  ownerOf(context);
  const name = boundedText(input.name ?? input.query, 160, "place").trim();
  if (!name) throw Error("Place is required");
  const sources = await lookupPlace(name);
  return {
    query: name,
    sources: sources.slice(0, 3).map((source) => redactVisible({
      title: source.title,
      url: source.url,
      excerpt: source.excerpt,
      coordinates: source.coordinates,
    })),
  };
}

async function queueAnalysis(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  const assetIds = input.assetIds == null ? [] : input.assetIds;
  if (!Array.isArray(assetIds) || assetIds.length > 1000 || !assetIds.every((value) => UUID.test(value))) throw Error("Invalid analysis assets");
  const albumId = input.albumId == null ? null : id(input.albumId, "album");
  if (albumId && assetIds.length) throw Error("Choose assets or an album");
  const requestedLimit = input.limit == null ? (assetIds.length || 200) : Number(input.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100_000) throw Error("Invalid analysis limit");
  const limit = Math.min(owner.settings?.continuous ? 100_000 : 200, requestedLimit);
  if (assetIds.length) {
    for (const assetId of assetIds.slice(0, limit)) await engine.asset(owner, assetId);
  }
  if (albumId) await engine.api(owner, `/albums/${albumId}`);
  const runId = randomUUID();
  const options = { assetIds, albumId, limit, reanalyze: input.reanalyze === true, source: "keeper" };
  await sql`
    INSERT INTO runs(id,owner,options,status,count)
    VALUES(${runId},${owner.id},${json(sql, options)},'queued',0)`;
  await context.emit?.("analysis.queued", { runId, requested: limit, scope: albumId ? { albumId } : { assetIds: assetIds.slice(0, limit) } });
  return {
    runId,
    requested: limit,
    phase: "inventory_queued",
    inventoryComplete: false,
    analysisComplete: false,
  };
}

async function analysisStatus(input, context, { sql }) {
  const owner = ownerOf(context);
  const runId = input.runId == null ? null : id(input.runId, "analysis run");
  let run = null;
  let assetIds = Array.isArray(input.assetIds) ? input.assetIds : null;
  if (assetIds && (assetIds.length > 1000 || !assetIds.every((value) => UUID.test(value)))) throw Error("Invalid analysis assets");
  if (runId) {
    [run] = await sql`SELECT id,status,count,error,options,created_at FROM runs WHERE owner=${owner.id} AND id=${runId}`;
    if (!run) throw Error("Analysis run not found");
    if (!assetIds && Array.isArray(run.options?.assetIds)) assetIds = run.options.assetIds;
  }
  const rows = await sql`
    SELECT id,status FROM assets WHERE owner=${owner.id} ORDER BY id LIMIT 10000`;
  const selected = assetIds ? new Set(assetIds) : null;
  const counts = Object.fromEntries(ANALYSIS_STATUSES.map((status) => [status, 0]));
  for (const row of rows) if (!selected || selected.has(row.id)) counts[row.status] = (counts[row.status] || 0) + 1;
  const inventoryComplete = !!run && run.status === "complete";
  const analysisComplete = inventoryComplete && counts.pending === 0 && counts.running === 0 && counts.retry === 0;
  const phase = run?.status === "failed" ? "inventory_failed" : analysisComplete ? "complete" : inventoryComplete ? "analysis" : "inventory";
  return {
    runId: run?.id || null,
    inventoryStatus: run?.status || null,
    inventoryQueued: run?.count ?? null,
    inventoryComplete,
    analysisComplete,
    analysisCounts: counts,
    phase,
    error: run?.error || null,
  };
}

async function applyStoredProposal(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  if (!owner.settings?.enabled || !owner.settings?.automatic) throw Error("Enable Organize automatic changes before applying a stored proposal");
  const assetId = id(input.assetId ?? input.id);
  const expectedRevision = input.revision == null ? null : Number(input.revision);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw Error("Invalid proposal revision");
  if (typeof context.mutationBudget === "function" && context.mutationBudget() < 1) throw Error("Keeper mutation slice budget is exhausted");
  const leaseToken = randomUUID();
  const [row] = await sql`
    UPDATE assets SET status='running',lease_token=${leaseToken},lease_until=now()+interval '15 minutes',updated_at=now()
    WHERE owner=${owner.id} AND id=${assetId} AND status='analyzed' AND proposal IS NOT NULL
      AND NOT coalesce((locks->>'suppressed')::boolean,false)
      AND (${expectedRevision}::bigint IS NULL OR revision=${expectedRevision})
    RETURNING *`;
  if (!row) throw Error("Stored proposal is missing, stale, or already being applied");
  if (!row.result || typeof row.result !== "object" || !row.proposal || typeof row.proposal !== "object") {
    await sql`UPDATE assets SET status='failed',error='Stored proposal is invalid',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE owner=${owner.id} AND id=${assetId} AND lease_token=${leaseToken}`;
    throw Error("Stored proposal is invalid");
  }
  try {
    const asset = await engine.asset(owner, assetId);
    await engine.apply(owner, asset, row, row.result, row.proposal);
    await sql`
      UPDATE assets SET status='analyzed',error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE owner=${owner.id} AND id=${assetId} AND revision=${row.revision} AND lease_token=${leaseToken}`;
    await context.recordMutation?.(assetId, "metadata");
    await context.emit?.("proposal.applied", { assetId, revision: row.revision });
    return { text: "Applied the validated stored proposal with its existing CAS and journal guards.", assetId, revision: row.revision, mutations: [assetId] };
  } catch (error) {
    await sql`
      UPDATE assets SET status='retry',error=${String(error.message || "Proposal failed").slice(0, 300)},lease_token=NULL,lease_until=NULL,next_at=now()+interval '60 seconds',updated_at=now()
      WHERE owner=${owner.id} AND id=${assetId} AND lease_token=${leaseToken}`;
    throw error;
  }
}

async function privateAlbum(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  let albumId = input.albumId == null ? null : id(input.albumId, "album");
  const assetIds = input.assetIds;
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 100) throw Error("Provide 1-100 assets");
  if (!assetIds.every((value) => UUID.test(value))) throw Error("Invalid album assets");
  if (!albumId) {
    const title = boundedText(input.title, 160, "album title").trim();
    if (!title) throw Error("Album title is required");
    const album = await engine.api(owner, "/albums", { albumName: title, description: "organizer:keeper" }, "POST");
    albumId = id(album.id, "album");
  }
  const album = await engine.api(owner, `/albums/${albumId}`);
  if (album.shared === true || album.hasSharedLink === true || (album.description || "").startsWith("organizer:") === false) {
    throw Error("Keeper can change only a private managed album");
  }
  const albumOwner = album.albumUsers?.[0]?.user?.id;
  if (albumOwner && albumOwner !== owner.id) throw Error("Album is owned by another user");
  const changed = [];
  for (const assetId of assetIds) {
    if (typeof context.mutationBudget === "function" && context.mutationBudget() < 1) throw Error("Keeper mutation slice budget is exhausted");
    const { asset } = await cachedAsset(sql, engine, owner, assetId);
    if (await engine.albumContains(owner, albumId, asset.id)) continue;
    const [pending] = await sql`
      SELECT id FROM changes WHERE owner=${owner.id} AND asset=${assetId} AND kind='album' AND status='pending'
        AND after_value->>'albumId'=${albumId} ORDER BY created_at LIMIT 1`;
    const changeId = pending?.id || randomUUID();
    if (!pending) {
      await sql`
        INSERT INTO changes(id,owner,asset,kind,before_value,after_value,status)
        VALUES(${changeId},${owner.id},${assetId},'album',${json(sql, { albumId, member: false })},${json(sql, { albumId, member: true })},'pending')`;
    }
    try {
      await engine.api(owner, `/albums/${albumId}/assets`, { ids: [assetId] }, "PUT");
      await sql`UPDATE changes SET status='applied',error=NULL,updated_at=now() WHERE owner=${owner.id} AND id=${changeId}`;
      await context.recordMutation?.(assetId, "album");
      changed.push(assetId);
    } catch (error) {
      const retry = Error(`Album membership could not be updated: ${error.message || "request failed"}`);
      retry.retryable = true;
      throw retry;
    }
  }
  await context.emit?.("album.updated", { albumId, assetIds: changed });
  return { text: changed.length ? `Added ${changed.length} asset(s) to the private managed album.` : "All requested assets were already members of the private managed album.", albumId, mutations: changed };
}

async function undoChange(input, context, { sql, engine }) {
  const owner = ownerOf(context);
  const changeId = id(input.changeId ?? input.id, "change");
  const [change] = await sql`SELECT * FROM changes WHERE owner=${owner.id} AND id=${changeId}`;
  if (!change) throw Error("Change not found");
  if (change.status === "undone") return { text: "Change was already undone.", changeId };
  const assetId = id(change.asset, "asset");
  if (!['metadata', 'tag', 'album'].includes(change.kind)) throw Error("Unsupported change type");
  if (typeof context.mutationBudget === "function" && context.mutationBudget() < 1) throw Error("Keeper mutation slice budget is exhausted");
  let asset;
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM assets WHERE owner=${owner.id} AND id=${assetId} FOR UPDATE`;
    const [current] = await tx`SELECT * FROM changes WHERE owner=${owner.id} AND id=${changeId} FOR UPDATE`;
    if (!current || current.status === "undone") return;
    if (!['applied', 'undoing'].includes(current.status)) throw Error("Change is not resumable");
    // Re-read after taking the database lock. A manual edit can arrive after
    // the initial journal lookup and must not be compared against stale data.
    asset = await engine.asset(owner, assetId);
    if (current.kind === "metadata" && !unchanged(asset, current.after_value) && !(current.status === "undoing" && unchanged(asset, current.before_value))) {
      throw Error("A newer edit prevents undo");
    }
    await tx`UPDATE changes SET status='undoing',updated_at=now() WHERE owner=${owner.id} AND id=${changeId}`;
    await tx`UPDATE assets SET locks=locks || '{"suppressed":true}'::jsonb,revision=revision+1,lease_token=NULL,lease_until=NULL WHERE owner=${owner.id} AND id=${assetId}`;
  });
  if (!asset) return { text: "Change was already undone.", changeId };
  try {
    if (change.kind === "metadata") {
      await engine.api(owner, `/organizer/metadata/${assetId}`, { before: change.after_value, after: change.before_value }, "PUT");
    } else if (change.kind === "tag") {
      const tagId = id(change.before_value?.tagId, "tag");
      await engine.api(owner, `/tags/${tagId}/assets`, { ids: [assetId] }, "DELETE");
    } else if (change.kind === "album") {
      const albumId = id(change.before_value?.albumId, "album");
      await engine.api(owner, `/albums/${albumId}/assets`, { ids: [assetId] }, "DELETE");
    } else {
      throw Error("Unsupported change type");
    }
    const after = await engine.asset(owner, assetId);
    const restored = change.kind === "metadata"
      ? unchanged(after, change.before_value)
      : change.kind === "tag"
        ? !(after.tags || []).some((tag) => tag.id === change.before_value?.tagId)
        : !(await engine.albumContains(owner, change.before_value?.albumId, assetId));
    if (!restored) throw Error("Undo acknowledgment did not match the stored before value");
    await sql`UPDATE changes SET status='undone',error=NULL,updated_at=now() WHERE owner=${owner.id} AND id=${changeId}`;
    await sql`UPDATE assets SET locks=locks || '{"suppressed":true}'::jsonb WHERE owner=${owner.id} AND id=${assetId}`;
    await context.recordMutation?.(assetId, "undo");
    await context.emit?.("undo.completed", { changeId, assetId, kind: change.kind });
    return { text: "Undid the managed change and suppressed automatic reapplication.", changeId, assetId, mutations: [assetId] };
  } catch (error) {
    const retry = Error(error.message || "Undo failed");
    retry.retryable = true;
    await sql`UPDATE changes SET error=${String(retry.message).slice(0, 500)},updated_at=now() WHERE owner=${owner.id} AND id=${changeId}`;
    throw retry;
  }
}

export function createKeeperTools({ sql, engine } = {}) {
  if (!sql || !engine) throw Error("Keeper tools require the organizer database and engine");
  return new ToolRegistry([
    {
      name: "search_photos",
      description: "Search the owner's inventoried photo evidence and return bounded asset references.",
      parameters: { type: "object", properties: { query: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" }, status: { type: "string" } } },
      execute: (input, context) => searchPhotos(input, context, { sql, engine }),
    },
    {
      name: "inspect_photo",
      description: "Inspect one owner-visible photo's current metadata, original evidence, stored analysis, and stable image references.",
      parameters: { type: "object", required: ["assetId"], properties: { assetId: { type: "string" } } },
      execute: (input, context) => inspectPhoto(input, context, { sql, engine }),
    },
    {
      name: "related_photos",
      description: "Inspect bounded neighboring source evidence for one owner-visible photo.",
      parameters: { type: "object", required: ["assetId"], properties: { assetId: { type: "string" } } },
      execute: (input, context) => relatedPhotos(input, context, { sql, engine }),
    },
    {
      name: "lookup_place",
      description: "Look up one bounded public place name through the fixed Wikipedia endpoint.",
      parameters: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      execute: (input, context) => lookupControlledPlace(input, context),
    },
    {
      name: "queue_analysis",
      description: "Queue owner-scoped Organizer inventory for selected assets, an album, or the bounded pilot.",
      parameters: { type: "object", properties: { assetIds: { type: "array", items: { type: "string" } }, albumId: { type: "string" }, limit: { type: "integer" }, reanalyze: { type: "boolean" } } },
      execute: (input, context) => queueAnalysis(input, context, { sql, engine }),
    },
    {
      name: "analysis_status",
      description: "Check inventory completion separately from per-asset analysis completion and failures.",
      parameters: { type: "object", properties: { runId: { type: "string" }, assetIds: { type: "array", items: { type: "string" } } } },
      execute: (input, context) => analysisStatus(input, context, { sql }),
    },
    {
      name: "apply_stored_proposal",
      description: "Apply an already validated stored Organizer proposal using its native CAS and change journal.",
      parameters: { type: "object", required: ["assetId"], properties: { assetId: { type: "string" }, revision: { type: "integer" } } },
      execute: (input, context) => applyStoredProposal(input, context, { sql, engine }),
      mutating: true,
    },
    {
      name: "add_to_private_album",
      description: "Add owner-visible assets to a private Organizer-managed album without sharing or deleting media.",
      parameters: { type: "object", required: ["assetIds"], properties: { albumId: { type: "string" }, title: { type: "string" }, assetIds: { type: "array", items: { type: "string" } } } },
      execute: (input, context) => privateAlbum(input, context, { sql, engine }),
      mutating: true,
    },
    {
      name: "undo_change",
      description: "Undo one existing Organizer journal entry with owner, visibility, CAS, and acknowledgment checks.",
      parameters: { type: "object", required: ["changeId"], properties: { changeId: { type: "string" } } },
      execute: (input, context) => undoChange(input, context, { sql, engine }),
      mutating: true,
    },
  ]);
}

export const TOOL_NAMES = Object.freeze([
  "search_photos", "inspect_photo", "related_photos", "lookup_place", "queue_analysis", "analysis_status",
  "apply_stored_proposal", "add_to_private_album", "undo_change",
]);
