// OJ-028 bundle budget: run after `npm run build:web`.
// The initial page must not statically load the 3D renderer or its vendors,
// and every emitted JavaScript chunk must stay within an explicit budget.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "dist/web");
const ENTRY_BUDGET = 500 * 1024;
const CHUNK_BUDGET = 760 * 1024;
const LAZY_ONLY = /^(WaveField|three-vendor|r3f-vendor)-/;
const failures = [];

const html = await readFile(path.join(dir, "index.html"), "utf8");
const initial = [
  ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/assets\/([^"]+\.js)"/g),
].map((m) => m[1]);
if (!initial.length) failures.push("index.html references no entry script");

// Follow static imports from the initial scripts; dynamic import() is allowed.
const seen = new Set();
const queue = [...initial];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = await readFile(path.join(dir, "assets", file), "utf8");
  for (const m of source.matchAll(
    /(?:^|[;}\s])(?:import|export)\s*(?:[\w*{}\s,$]*from\s*)?"\.\/([^"]+\.js)"/g,
  ))
    queue.push(m[1]);
}
for (const file of seen)
  if (LAZY_ONLY.test(file))
    failures.push(`initial page statically loads lazy 3D chunk ${file}`);

let entryBytes = 0;
for (const file of seen)
  entryBytes += (await stat(path.join(dir, "assets", file))).size;
if (entryBytes > ENTRY_BUDGET)
  failures.push(`initial JavaScript ${entryBytes} B exceeds ${ENTRY_BUDGET} B`);

for (const file of await readdir(path.join(dir, "assets"))) {
  if (!file.endsWith(".js")) continue;
  const size = (await stat(path.join(dir, "assets", file))).size;
  if (size > CHUNK_BUDGET)
    failures.push(`${file} ${size} B exceeds chunk budget ${CHUNK_BUDGET} B`);
}

if (failures.length) {
  console.error("Bundle budget FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log(
  `Bundle budget PASS: initial ${[...seen].join(", ")} = ${entryBytes} B; 3D renderer lazy-only.`,
);
