import { readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const [root, output] = process.argv.slice(2);
if (!root || !output)
  throw Error("Usage: npm run manifest -- SOURCE OUTPUT.json");
const entries = [];
async function walk(path) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const p = join(path, item.name);
    if (item.isDirectory()) await walk(p);
    else if (item.isFile()) {
      const s = await stat(p);
      if (!s.size) continue;
      const h = createHash("sha1");
      for await (const b of createReadStream(p)) h.update(b);
      const { stdout } = await exec(
        "exiftool",
        [
          "-json",
          "-DateTimeOriginal",
          "-OffsetTimeOriginal",
          "-Make",
          "-Model",
          p,
        ],
        { maxBuffer: 1e6 },
      );
      const meta = JSON.parse(stdout)[0];
      const captureDate = meta.DateTimeOriginal?.replace(
        /^(\d{4}):(\d{2}):(\d{2}) /,
        "$1-$2-$3T",
      );
      entries.push({
        checksum: h.digest("base64"),
        paths: [p],
        filename: item.name,
        group: dirname(p),
        fileModifiedAt: s.mtime.toISOString(),
        captureDate: captureDate || null,
        camera: [meta.Make, meta.Model].filter(Boolean).join(" "),
        verified: !meta.Error,
      });
    }
  }
}
await walk(root);
await writeFile(output, JSON.stringify({ entries }), { mode: 0o600 });
console.log(`Wrote ${entries.length} private source records`);
