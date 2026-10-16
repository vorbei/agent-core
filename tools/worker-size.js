// Checks a built Worker's upload size against a budget, so a regression in what a Worker bundles
// fails the build gate. Usage: node worker-size.js <dir> --max-gzip-kib <n>
// <dir> is Wrangler's `--outdir` or a Build Output Worker bundle; every module file counts except
// source maps, the metafile and the README Wrangler writes, each gzip-compressed on its own.
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

/** Raw and gzip bytes of the modules in `directory`, largest (gzip) first. */
async function measureUpload(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { await visit(child); continue; }
      const name = relative(directory, child);
      if (/\.map$/.test(name) || name === "README.md" || name === "bundle-meta.json") continue;
      const bytes = await readFile(child);
      files.push({ name, bytes: bytes.length, gzip: gzipSync(bytes).length });
    }
  }
  await visit(directory);
  files.sort((a, b) => b.gzip - a.gzip);
  return { bytes: files.reduce((n, file) => n + file.bytes, 0), gzip: files.reduce((n, file) => n + file.gzip, 0), files };
}

const [directory] = process.argv.slice(2);
const flag = process.argv.indexOf("--max-gzip-kib");
const budget = Number(process.argv[flag + 1]);
if (!directory || flag < 0 || !(budget > 0)) {
  console.error("usage: node worker-size.js <dir> --max-gzip-kib <n>");
  process.exit(2);
}
const { bytes, gzip, files } = await measureUpload(directory);
const kib = n => (n / 1024).toFixed(1);
for (const file of files.slice(0, 5)) console.log(`  ${kib(file.gzip).padStart(8)} KiB gzip  ${kib(file.bytes).padStart(8)} KiB  ${file.name}`);
const line = `Worker upload ${kib(bytes)} KiB / gzip ${kib(gzip)} KiB (budget ${budget} KiB gzip)`;
if (gzip > budget * 1024) {
  console.error(`FAIL: ${line}`);
  process.exit(1);
}
console.log(`ok: ${line}`);
