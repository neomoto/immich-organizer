import { createHash } from "node:crypto";

export const VERSION = 1;
export const DEFAULTS = Object.freeze({
  enabled: false,
  continuous: false,
  automatic: false,
  geolocation: true,
  approximatePins: true,
  webLookup: true,
  dailyLimit: 5000,
  language: "English",
});
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const eligible = (a) =>
  !a.isTrashed && !a.isOffline && a.visibility !== "locked" && !a.deletedAt;
export function validDay(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().startsWith(value)
  );
}
export function validateObservation(o) {
  if (
    !o ||
    typeof o !== "object" ||
    typeof o.caption !== "string" ||
    o.caption.length > 4000
  )
    throw Error("Invalid caption");
  for (const key of ["objects", "activities", "tags", "ocr"]) {
    if (
      !Array.isArray(o[key]) ||
      o[key].length > 100 ||
      o[key].some((x) => typeof x !== "string" || x.length > 1000)
    )
      throw Error(`Invalid ${key}`);
  }
  if (
    ![
      "photo",
      "screenshot",
      "document",
      "scan",
      "illustration",
      "meme",
      "video",
      "unknown",
    ].includes(o.category)
  )
    throw Error("Invalid category");
  if (!Array.isArray(o.evidence) || o.evidence.length > 50)
    throw Error("Invalid evidence");
  for (const e of o.evidence) {
    if (
      !e ||
      typeof e.id !== "string" ||
      typeof e.text !== "string" ||
      !["visual", "text", "metadata", "context", "web"].includes(e.kind)
    )
      throw Error("Invalid evidence item");
  }
  for (const field of ["date", "location"]) {
    const v = o[field];
    if (v === null) continue;
    if (
      !v ||
      !["low", "medium", "high"].includes(v.confidence) ||
      !Array.isArray(v.evidenceIds) ||
      !v.evidenceIds.length ||
      v.evidenceIds.some((id) => !o.evidence.some((e) => e.id === id))
    )
      throw Error(`Invalid ${field} provenance`);
  }
  if (o.date) {
    if (
      !["day", "month", "year", "range"].includes(o.date.precision) ||
      !validDay(o.date.start) ||
      !validDay(o.date.end) ||
      o.date.end < o.date.start
    )
      throw Error("Invalid date range");
    if (o.date.precision === "day" && o.date.start !== o.date.end)
      throw Error("Day range mismatch");
    if (!["capture", "depicted", "unknown"].includes(o.date.kind))
      throw Error("Invalid date meaning");
  }
  if (o.location) {
    const l = o.location;
    if (
      typeof l.name !== "string" ||
      !Number.isFinite(l.latitude) ||
      !Number.isFinite(l.longitude) ||
      Math.abs(l.latitude) > 90 ||
      Math.abs(l.longitude) > 180 ||
      !["country", "region", "city", "venue", "camera"].includes(l.precision) ||
      !["capture", "depicted", "unknown"].includes(l.kind)
    )
      throw Error("Invalid location");
  }
  if (o.event !== null && (typeof o.event !== "string" || o.event.length > 200))
    throw Error("Invalid event");
  return o;
}

// Only independently supplied, original capture metadata is an anchor. The model
// cannot grant itself permission to replace existing metadata by declaring it bad.
export function propose(
  asset,
  observation,
  { original = {}, facts = {}, locks = {}, settings = DEFAULTS } = {},
) {
  const exif = asset.exifInfo || {};
  const patch = {};
  if (!locks.description && !exif.description?.trim())
    patch.description = observation.caption;
  const currentDay = (exif.dateTimeOriginal || asset.fileCreatedAt || "").slice(
    0,
    10,
  );
  const originalDay = String(original.captureDate || "")
    .slice(0, 10)
    .replaceAll(":", "-");
  const importDay = String(original.fileModifiedAt || "").slice(0, 10);
  const suspectDate =
    !currentDay ||
    /^000[01]-|^1970-01-01/.test(currentDay) ||
    (!original.captureDate &&
      original.verified === true &&
      importDay === currentDay &&
      facts.suspectDate === true);
  const d = observation.date;
  // A literal date in a picture can describe the subject, rather than its capture.
  // Context/model confidence never suffices to assign an exact day on its own.
  const groundedDay =
    facts.captureDay || (validDay(originalDay) ? originalDay : null);
  if (
    !locks.date &&
    suspectDate &&
    d?.kind === "capture" &&
    d.precision === "day" &&
    d.confidence === "high" &&
    groundedDay === d.start
  ) {
    patch.dateTimeOriginal = `${d.start}T12:00:00.000Z`;
  }
  const l = observation.location;
  const missingGPS = exif.latitude == null || exif.longitude == null;
  if (
    !locks.location &&
    settings.geolocation &&
    l?.kind === "capture" &&
    l.confidence !== "low" &&
    (missingGPS || facts.suspectLocation === true) &&
    (settings.approximatePins || l.precision === "camera")
  ) {
    patch.latitude = l.latitude;
    patch.longitude = l.longitude;
  }
  return {
    version: VERSION,
    patch,
    estimatedDate: d,
    estimatedLocation: l,
    tags: [...new Set(observation.tags)]
      .slice(0, 15)
      .map((t) => `AI/${t.trim().slice(0, 100)}`)
      .filter((t) => t !== "AI/"),
    evidence: observation.evidence,
  };
}

export function patchBefore(asset, patch) {
  const e = asset.exifInfo || {};
  return Object.fromEntries(
    Object.keys(patch).map((k) => [
      k,
      k === "dateTimeOriginal" ? e[k] || asset.fileCreatedAt : (e[k] ?? null),
    ]),
  );
}
export function unchanged(asset, expected) {
  return Object.entries(expected).every(
    ([k, v]) => patchBefore(asset, { [k]: true })[k] === v,
  );
}
export function eventKey(owner, observation, provenance) {
  if (!observation.event || observation.date?.kind !== "capture") return null;
  const d = observation.date;
  if (!d || d.confidence === "low") return null;
  // Preserve separate source groups; a label like "birthday" is not a global event ID.
  return digest([
    owner,
    provenance.group || "",
    observation.event.toLowerCase(),
    d.start,
    d.end,
    observation.location?.name || "",
  ]);
}

export function corroboratedDay(provenance, neighbors, inference) {
  if (inference?.kind !== "capture" || inference.precision !== "day")
    return null;
  const matches = neighbors.filter(
    (p) =>
      p.verified &&
      p.captureDate?.slice(0, 10) === inference.start &&
      p.group === provenance.group &&
      p.camera &&
      p.camera === provenance.camera,
  );
  const name = provenance.filename;
  if (
    !name ||
    !matches.some((p) => p.filename < name) ||
    !matches.some((p) => p.filename > name)
  )
    return null;
  return inference.start;
}
