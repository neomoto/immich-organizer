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
      e.id.length > 100 || typeof e.text !== "string" || e.text.length > 4000 ||
      !["visual", "text", "metadata", "context", "web"].includes(e.kind)
    )
      throw Error("Invalid evidence item");
  }
  if (new Set(o.evidence.map(e => e.id)).size !== o.evidence.length)
    throw Error("Duplicate evidence IDs");
  for (const e of o.evidence) {
    if (e.kind === "web" && (typeof e.url !== "string" || !/^https:\/\//.test(e.url)))
      throw Error("Web evidence requires a citation URL");
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
    if (o.date.precision === "month") {
      const end = new Date(Date.UTC(Number(o.date.start.slice(0,4)), Number(o.date.start.slice(5,7)), 0)).toISOString().slice(0,10);
      if (!o.date.start.endsWith("-01") || o.date.end !== end) throw Error("Month range mismatch");
    }
    if (o.date.precision === "year" && (!o.date.start.endsWith("-01-01") || o.date.end !== o.date.start.slice(0,4) + "-12-31"))
      throw Error("Year range mismatch");
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
    (original.verified === true && validDay(originalDay) && importDay === currentDay && originalDay !== currentDay && !exif.dateTimeOriginal) ||
    (!original.captureDate &&
      original.verified === true &&
      importDay === currentDay &&
      facts.suspectDate === true);
  const d = observation.date;
  // A literal date in a picture can describe the subject, rather than its capture.
  // Context/model confidence never suffices to assign an exact day on its own.
  const groundedDay =
    facts.captureDay || (original.verified === true && validDay(originalDay) ? originalDay : null);
  const captureMedia = ["photo", "video"].includes(observation.category);
  if (
    !locks.date &&
    captureMedia &&
    suspectDate &&
    d?.kind === "capture" &&
    d.precision === "day" &&
    d.confidence === "high" &&
    groundedDay === d.start
  ) {
    patch.dateTimeOriginal = `${d.start}T12:00:00.000Z`;
  }
  const inferredLocation = observation.location;
  const originalGPS = original.originalExif || {};
  const cameraAnchored = original.verified === true &&
    Number.isFinite(originalGPS.GPSLatitude) && Number.isFinite(originalGPS.GPSLongitude) &&
    Math.abs(originalGPS.GPSLatitude - inferredLocation?.latitude) < 0.00001 &&
    Math.abs(originalGPS.GPSLongitude - inferredLocation?.longitude) < 0.00001;
  // A model's coordinate decimals do not establish exact camera precision.
  const l = inferredLocation?.precision === "camera" && !cameraAnchored
    ? { ...inferredLocation, precision: "venue" } : inferredLocation;
  const missingGPS = exif.latitude == null || exif.longitude == null;
  if (
    !locks.location &&
    captureMedia &&
    settings.geolocation &&
    l?.kind === "capture" &&
    l.confidence !== "low" &&
    (missingGPS || (facts.suspectLocation === true && original.verified === true && original.originalExif?.GPSLatitude == null)) &&
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
    locationApproximate: l ? l.precision !== "camera" : null,
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
      e[k] ?? null,
    ]),
  );
}
export function unchanged(asset, expected) {
  return Object.entries(expected).every(
    ([k, v]) => {
      const current = patchBefore(asset, { [k]: true })[k];
      return current === v || (k === "dateTimeOriginal" && current != null && v != null && Number.isFinite(Date.parse(current)) && Date.parse(current) === Date.parse(v));
    },
  );
}
export function eventKey(owner, observation, provenance) {
  if (!observation.event || observation.date?.kind !== "capture") return null;
  const d = observation.date;
  if (!d || d.confidence === "low") return null;
  // Preserve separate source groups; a label like "birthday" is not a global event ID.
  const sourceDay = provenance.verified && validDay(String(provenance.captureDate || "").slice(0,10)) ? provenance.captureDate.slice(0,10) : null;
  if (!provenance.group) return null;
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const location = observation.location?.kind === "capture" && observation.location.confidence !== "low"
    ? observation.location : null;
  // Scene and place must agree as well as date. Conservatively split distinct
  // labels instead of merging unrelated same-day scenes in an archive folder.
  const scene = normalize(observation.event);
  const place = location ? [normalize(location.name), location.precision,
    Number(location.latitude.toFixed(2)), Number(location.longitude.toFixed(2))] : null;
  return digest([
    owner,
    provenance.group || "",
    sourceDay || d.start,
    sourceDay || d.end,
    scene,
    place,
  ]);
}

export function corroboratedDay(provenance, neighbors, inference) {
  if (inference?.kind !== "capture" || inference.precision !== "day")
    return null;
  const candidates = neighbors.filter(
    (p) =>
      p.verified &&
      validDay(p.captureDate?.slice(0, 10)) &&
      p.group === provenance.group &&
      p.camera &&
      p.camera === provenance.camera,
  );
  const name = provenance.filename;
  const before = candidates.filter(p => p.filename < name).sort((a,b) => b.filename.localeCompare(a.filename))[0];
  const after = candidates.filter(p => p.filename > name).sort((a,b) => a.filename.localeCompare(b.filename))[0];
  if (
    !name ||
    !before || !after || before.captureDate.slice(0,10) !== inference.start ||
    after.captureDate.slice(0,10) !== inference.start ||
    (before.checksum && before.checksum === after.checksum)
  )
    return null;
  return inference.start;
}
