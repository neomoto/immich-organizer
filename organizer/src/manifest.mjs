import { readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export async function readOriginalExif(path) {
  const { stdout } = await exec("exiftool", ["-json", "-n", "-charset", "filename=UTF8", "-EXIF:all", "-QuickTime:all", "-FileType", path], { maxBuffer: 4e6, timeout: 30000 });
  return JSON.parse(stdout)[0];
}
export function captureTimestamp(meta) {
  const value = meta.DateTimeOriginal;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)
    ? normalized + (/Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? "" : meta.OffsetTimeOriginal || "") : null;
}
// Keep every source match: identical bytes can occur in multiple event folders.
export async function buildManifest(root, { metadata = readOriginalExif } = {}) {
  const matches = new Map(), errors = [];
  async function walk(path) {
    let items;
    try { items = await readdir(path, { withFileTypes: true }); }
    catch { errors.push({ path, error: "Directory unreadable" }); return; }
    for (const item of items.sort((a,b) => a.name.localeCompare(b.name))) {
      const p = join(path, item.name);
      if (item.isDirectory()) { await walk(p); continue; }
      if (!item.isFile()) continue;
      try {
        const s = await stat(p);
        if (!s.size) continue;
        const hash = createHash("sha1");
        for await (const bytes of createReadStream(p)) hash.update(bytes);
        const checksum = hash.digest("base64");
        let meta = {}, metadataError = null;
        try { meta = await metadata(p); if (meta.Error) metadataError = "Unsupported or invalid metadata"; }
        catch { metadataError = "Metadata unavailable"; }
        const source = { path: p, filename: item.name, group: dirname(p), fileModifiedAt: s.mtime.toISOString(), captureDate: metadataError ? null : captureTimestamp(meta), camera: [meta.Make, meta.Model].filter(Boolean).join(" "), originalExif: meta, verified: !metadataError, metadataError };
        const entry = matches.get(checksum);
        if (entry) { entry.paths.push(p); entry.sourceMatches.push(source); }
        else matches.set(checksum, { checksum, paths: [p], ...source, sourceMatches: [source], origin: "source-file" });
      } catch { errors.push({ path: p, error: "File unreadable" }); }
    }
  }
  await walk(resolve(root));
  return { version: 2, entries: [...matches.values()], errors };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, output] = process.argv.slice(2);
  if (!root || !output) throw Error("Usage: npm run manifest -- SOURCE OUTPUT.json");
  const manifest = await buildManifest(root);
  await writeFile(output, JSON.stringify(manifest), { mode: 0o600 });
  console.log(`Wrote ${manifest.entries.length} private source records; ${manifest.errors.length} unreadable paths`);
}
