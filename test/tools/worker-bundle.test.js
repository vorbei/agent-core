import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { PI_RESOURCES, stagePi, stubSource, workerAliases } from "agent-core/worker-bundle";

const tools = join(dirname(fileURLToPath(import.meta.url)), "../../tools");

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// A stub use is recorded for worker-stubs.js's exit check; a test that uses one on purpose clears it.
function expectStubError(use, where) {
  assert.throws(use, error => error.code === "PI_WORKER_STUB" && error.message.includes(where));
  assert.ok(globalThis.__piWorkerStubCalls.includes(where));
  delete globalThis.__piWorkerStubCalls;
}

test("a stub binds every export of the original and throws a coded error on any use", async t => {
  const directory = mkdtempSync(join(tmpdir(), "worker-stub-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "stub.mjs"), stubSource("pkg/lib.js", ["Client", "default", "module.exports", "Client"]));
  const stub = await import(pathToFileURL(join(directory, "stub.mjs")).href);
  assert.deepEqual(Object.keys(stub).sort(), ["Client", "default"]);
  assert.equal(typeof stub.Client, "function");
  expectStubError(() => stub.Client(), "pkg/lib.js#Client");
  expectStubError(() => new stub.Client(), "pkg/lib.js#Client");
  expectStubError(() => stub.default.parse, "pkg/lib.js#default");
  expectStubError(() => ({ ...stub.default }), "pkg/lib.js#default");
  expectStubError(() => class extends stub.Client {}, "pkg/lib.js#Client");
});

test("staging Pi stubs the modules a Worker never runs, drops their files and maps module URLs", async t => {
  const root = mkdtempSync(join(tmpdir(), "worker-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pi = "node_modules/@earendil-works/pi-coding-agent";
  for (const resource of PI_RESOURCES) write(root, `${pi}/${resource}`, "{}");
  write(root, `${pi}/dist/index.js`, `export { main } from "./main.js";\nexport const here = import.meta.url;\n`);
  write(root, `${pi}/dist/main.js`, `export function main() { return "cli"; }\nexport const VERSION = 1;\n`);
  write(root, `${pi}/node_modules/jiti/lib/jiti-static.mjs`, `export function createJiti() {}\nexport default createJiti;\n`);
  write(root, `${pi}/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`, "wasm");
  write(root, `${pi}/examples/extensions/game.wasm`, "wasm");

  const result = await stagePi({ root, transform, entries: { worker: "../../src/index.js" } });
  assert.deepEqual(result, { moduleUrls: 1, stubs: 2, removed: 2, resources: PI_RESOURCES.length });
  const staged = join(root, ".wrangler/pi", pi);
  const main = await import(pathToFileURL(join(staged, "dist/main.js")).href);
  assert.deepEqual(Object.keys(main).sort(), ["VERSION", "main"]);
  expectStubError(() => main.main(), "@earendil-works/pi-coding-agent/dist/main.js#main");
  const jiti = await import(pathToFileURL(join(staged, "node_modules/jiti/lib/jiti-static.mjs")).href);
  expectStubError(() => jiti.createJiti(), "jiti/lib/jiti-static.mjs#createJiti");
  assert.equal(existsSync(join(staged, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm")), false);
  assert.equal(existsSync(join(staged, "examples")), false);
  assert.match(readFileSync(join(staged, "dist/index.js"), "utf8"), /file:\/\/\/bundle\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/index\.js/);
  assert.match(readFileSync(join(root, ".wrangler/pi/worker.mjs"), "utf8"), /export \* from "\.\.\/\.\.\/src\/index\.js"/);
  // The installed package is untouched.
  assert.match(readFileSync(join(root, pi, "dist/main.js"), "utf8"), /return "cli"/);
  assert.equal(existsSync(join(root, pi, "examples/extensions/game.wasm")), true);
});

test("the Worker aliases resolve Pi, pi-ai and TypeBox settings inside the staged copy", () => {
  const aliases = workerAliases("./.wrangler/pi");
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-ai/api/openai-completions", "typebox/system"]) {
    assert.ok(aliases[name].startsWith("./.wrangler/pi/node_modules/@earendil-works/pi-coding-agent/"), name);
  }
});

test("the size check fails a Worker over its gzip budget and ignores source maps", t => {
  const directory = mkdtempSync(join(tmpdir(), "worker-size-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const random = randomBytes(64 * 1024);
  writeFileSync(join(directory, "worker.js"), random);
  writeFileSync(join(directory, "worker.js.map"), Buffer.alloc(4 * 1024 * 1024, 97));
  const check = budget => execFileSync(process.execPath, [join(tools, "worker-size.js"), directory, "--max-gzip-kib", String(budget)], { encoding: "utf8", stdio: "pipe" });
  assert.match(check(100), /^ok: Worker upload 64\.0 KiB/m);
  assert.throws(() => check(1), error => error.status === 1 && /FAIL: Worker upload/.test(error.stderr));
});
