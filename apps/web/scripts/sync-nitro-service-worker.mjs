import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const serverEntryPath = resolve(".output/server/index.mjs");
const serviceWorkerPath = resolve(".output/public/sw.js");
const [serverEntry, serviceWorker, serviceWorkerStat] = await Promise.all([
  readFile(serverEntryPath, "utf8"),
  readFile(serviceWorkerPath),
  stat(serviceWorkerPath),
]);

const etag = `"${serviceWorker.length.toString(16)}-${createHash("sha1")
  .update(serviceWorker)
  .digest("base64")
  .slice(0, 27)}"`;
const replacement = [
  '"/sw.js": {',
  '\t\t"type": "text/javascript; charset=utf-8",',
  `\t\t"etag": ${JSON.stringify(etag)},`,
  `\t\t"mtime": ${JSON.stringify(serviceWorkerStat.mtime.toJSON())},`,
  `\t\t"size": ${serviceWorker.length},`,
  '\t\t"path": "../public/sw.js"',
  "\t},",
].join("\n");

const serviceWorkerEntry =
  /"\/sw\.js": \{\n\s+"type": "text\/javascript; charset=utf-8",\n\s+"etag": [^\n]+,\n\s+"mtime": [^\n]+,\n\s+"size": \d+,\n\s+"path": "\.\.\/public\/sw\.js"\n\s+\},/;
if (!serviceWorkerEntry.test(serverEntry)) {
  throw new Error("Nitro server asset manifest does not contain the /sw.js entry.");
}

await writeFile(serverEntryPath, serverEntry.replace(serviceWorkerEntry, replacement));
console.log(`synced Nitro /sw.js metadata (${serviceWorker.length} bytes, ${etag})`);
