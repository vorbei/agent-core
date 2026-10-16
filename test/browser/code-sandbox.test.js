import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  CODE_RUN_LIMITS, CODE_SANDBOX_CSP, CODE_WORKER_BLOCKED_GLOBALS, codeRunRequest, createCodeSandbox, loadPinnedSource, runInWorker, serveCodeRun,
  serveCodeSandboxPage,
} from "../../src/browser/index.js";

// The sandboxed page's Worker, as a Node worker thread running the same runtime. `terminated`
// counts the Workers the page ended, and `exited` resolves when a thread really stopped. A Worker
// started from the source text "SHELL" has the scripted shell, as a downloaded shell Worker would.
function nodeSpawn({ shell } = {}) {
  const stats = { started: 0, terminated: 0, exits: [] };
  const spawn = source => {
    stats.started++;
    const thread = new Worker(new URL("./code-worker-node.js", import.meta.url), { workerData: { shell: source === "SHELL" ? "fake" : shell } });
    stats.exits.push(new Promise(resolve => thread.once("exit", resolve)));
    return {
      postMessage: message => thread.postMessage(message),
      addEventListener: (type, listener) => thread.on(type, type === "message" ? data => listener({ data }) : error => listener({ message: error.message })),
      terminate: () => { stats.terminated++; void thread.terminate(); },
    };
  };
  return { spawn, stats };
}

const run = (input, options) => { const { spawn } = nodeSpawn(options); return runInWorker(input, "", spawn); };

test("js runs as an async function body: the returned value as text, console lines, the request's files", async () => {
  assert.deepEqual(await run({ code: "console.log('n', 3); return [1, 2, 3].reduce((a, b) => a + b, 0) * 7;" }),
    { ok: true, value: "42", logs: ["n 3"], truncated: false });
  assert.equal((await run({ code: "return { a: [1, { b: null }], big: 10n ** 20n };" })).value, '{"a":[1,{"b":null}],"big":"100000000000000000000"}');
  assert.equal((await run({ code: "return files['data/rows.csv'].split('\\n').length;", files: { "data/rows.csv": "a\nb\nc" } })).value, "3");
  assert.equal((await run({ code: "await new Promise(resolve => setTimeout(resolve, 5)); return undefined;" })).value, "undefined");
});

test("a throw and a syntax error are failed results, with the logs before them", async () => {
  assert.deepEqual(await run({ code: "console.log('before'); throw new RangeError('bad input');" }),
    { ok: false, error: { code: "CODE_ERROR", message: "bad input", name: "RangeError" }, logs: ["before"], truncated: false });
  const syntax = await run({ code: "return (;" });
  assert.equal(syntax.error.code, "CODE_ERROR");
  assert.equal(syntax.error.name, "SyntaxError");
});

test("code that never yields is stopped at the deadline by terminating its Worker, keeping the logs it wrote", async () => {
  const { spawn, stats } = nodeSpawn();
  const started = Date.now();
  const result = await runInWorker({ code: "console.log('spinning'); while (true) {}", timeoutMs: 300 }, "", spawn);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EXEC_TIMEOUT");
  assert.deepEqual(result.logs, ["spinning"]);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(stats.terminated, 1);
  await stats.exits[0];
  // A run that never settles is stopped the same way.
  assert.equal((await run({ code: "await new Promise(() => {});", timeoutMs: 150 })).error.code, "EXEC_TIMEOUT");
});

test("the value, the console and the shell's output are capped, and say so", async () => {
  const big = await run({ code: "return 'x'.repeat(50_000);", maxOutputChars: 2_000 });
  assert.equal(big.value.length, 2_000);
  assert.equal(big.truncated, true);
  const chatty = await run({ code: "for (let i = 0; i < 100; i++) console.log('y'.repeat(900)); return 1;" });
  assert.equal(chatty.logs.length, CODE_RUN_LIMITS.logLines + 1);
  assert.equal(chatty.logs[0].length, CODE_RUN_LIMITS.logLineChars);
  assert.equal(chatty.logs.at(-1), "[60 more log lines dropped]");
  const loud = await run({ language: "bash", code: "loud", maxOutputChars: 1_000 }, { shell: "fake" });
  assert.equal(loud.stdout.length, 1_000);
  assert.equal(loud.stderr.length, CODE_RUN_LIMITS.stderrChars);
  assert.equal(loud.truncated, true);
});

test("the code reaches no network, storage, nested Worker or extension API", async () => {
  const names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "BroadcastChannel", "indexedDB", "caches", "chrome"];
  const seen = await run({ code: `return { ${names.map(name => `${name}: typeof ${name}`).join(", ")} };` });
  assert.deepEqual(JSON.parse(seen.value), Object.fromEntries(names.map(name => [name, "undefined"])));
  const call = await run({ code: "await fetch('http://127.0.0.1:9/'); return 'reached';" });
  assert.equal(call.error.code, "CODE_ERROR");
  assert.equal(call.error.name, "ReferenceError");
  assert.ok(names.every(name => CODE_WORKER_BLOCKED_GLOBALS.includes(name)));
});

test("in a Worker's own scope the runtime also takes postMessage away from the code, and still answers", async () => {
  const posted = [];
  class Scope extends EventTarget {}
  Object.assign(Scope.prototype, { fetch() {}, importScripts() {}, postMessage(message) { posted.push(message); } });
  const scope = new Scope();
  scope.WebSocket = class {};
  serveCodeRun(scope);
  assert.equal(scope.fetch, undefined);
  assert.equal(scope.importScripts, undefined);
  assert.equal(scope.WebSocket, undefined);
  assert.equal(scope.postMessage, undefined);
  scope.dispatchEvent(Object.assign(new Event("message"), { data: { type: "run", request: codeRunRequest({ code: "console.log('hi'); return typeof postMessage;" }) } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(posted, [{ type: "log", line: "hi" }, { type: "result", result: { ok: true, value: "undefined", logs: ["hi"], truncated: false } }]);
});

test("bash runs in the product's shell with the request's files, its limits and no network option", async () => {
  const made = await run({ language: "bash", code: "options", files: { "words.txt": "a", "/data/x.json": "{}" }, timeoutMs: 4_000 }, { shell: "fake" });
  assert.equal(made.ok, true);
  assert.equal(made.exitCode, 0);
  const options = JSON.parse(made.stdout);
  assert.deepEqual(options.files, { "/home/user/words.txt": "a", "/data/x.json": "{}" });
  assert.equal(options.cwd, "/home/user");
  assert.deepEqual(options.executionLimits, { maxExecutionTimeMs: 4_000, maxFileSystemBytes: CODE_RUN_LIMITS.shellFileSystemBytes, maxOutputSize: CODE_RUN_LIMITS.shellOutputBytes });
  assert.deepEqual(Object.keys(options).sort(), ["cwd", "executionLimitProfile", "executionLimits", "files"]);
  assert.deepEqual(await run({ language: "bash", code: "fail" }, { shell: "fake" }),
    { ok: false, error: { code: "EXIT_STATUS", message: "exit status 2" }, stdout: "partial\n", stderr: "boom\n", exitCode: 2, logs: [], truncated: false });
  assert.equal((await run({ language: "bash", code: "echo hi" })).error.code, "CODE_LANGUAGE_UNAVAILABLE");
});

test("a request is validated and its limits clamped; an invalid one fails with its code", () => {
  const request = codeRunRequest({ code: "return 1", timeoutMs: 10 ** 9, maxOutputChars: 1 });
  assert.deepEqual(request, { language: "js", code: "return 1", files: {}, timeoutMs: CODE_RUN_LIMITS.maxTimeoutMs, maxOutputChars: CODE_RUN_LIMITS.minOutputChars });
  const code = input => { try { codeRunRequest(input); return "valid"; } catch (error) { return error.code; } };
  assert.equal(code({ code: " " }), "CODE_REQUIRED");
  assert.equal(code({ code: "x".repeat(CODE_RUN_LIMITS.maxCodeChars + 1) }), "CODE_TOO_LARGE");
  assert.equal(code({ code: "ls", language: "python" }), "CODE_LANGUAGE_INVALID");
  for (const files of [[], { "../etc/passwd": "x" }, { "a/../../b": "x" }, { "a b": "x" }, { ok: 1 }, { big: "x".repeat(CODE_RUN_LIMITS.maxFilesChars + 1) }]) {
    assert.equal(code({ code: "ls", language: "bash", files }), "CODE_FILES_INVALID", JSON.stringify(files).slice(0, 60));
  }
  assert.equal(code({ code: "ls", language: "bash", files: { "data/rows.csv": "", "/tmp/a.txt": "" } }), "valid");
  // An invalid request that reaches the page anyway is a failed result, not a Worker.
  return runInWorker({ code: "" }, "", () => { throw new Error("no Worker for an invalid request"); })
    .then(result => assert.equal(result.error.code, "CODE_REQUIRED"));
});

test("the sandbox's policy refuses every network path and allows evaluation only in its own page", () => {
  const directives = Object.fromEntries(CODE_SANDBOX_CSP.split(";").map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.sandbox, ["allow-scripts"]);
  assert.deepEqual(directives["connect-src"], ["'none'"]);
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.deepEqual(directives["worker-src"], ["blob:"]);
  assert.ok(!directives["script-src"].some(source => /^(https?:|\*|data:|blob:)/.test(source)));
});

// The extension page and the sandboxed page as two windows that message each other, the sandboxed
// page serving runs with Node worker threads.
function pages({ serve = true } = {}) {
  const message = (target, data, source) => target.dispatchEvent(Object.assign(new Event("message"), { data, source }));
  const parent = new EventTarget();
  const frames = [];
  const { spawn, stats } = nodeSpawn();
  const document = {
    defaultView: parent,
    body: {
      append(frame) {
        const window = new EventTarget();
        window.parent = parent;
        window.postMessage = data => queueMicrotask(() => message(window, data, parent));
        parent.postMessage = data => queueMicrotask(() => message(parent, data, window));
        frame.contentWindow = window;
        frames.push(frame);
        if (serve) serveCodeSandboxPage(window, { workerSource: "", spawn });
      },
    },
    createElement: () => ({ style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, remove() { this.removed = true; } }),
  };
  return { document, frames, stats, message, parent };
}

test("the extension page embeds one sandboxed page lazily and gets each run's result from it", async () => {
  const { document, frames, stats, message, parent } = pages();
  const sandbox = createCodeSandbox({ document, url: "chrome-extension://id/code-sandbox.html" });
  assert.equal(frames.length, 0);
  assert.equal((await sandbox.run({ code: "return 6 * 7;" })).value, "42");
  assert.equal((await sandbox.run({ code: "return 'again';" })).value, "again");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, "chrome-extension://id/code-sandbox.html");
  assert.equal(frames[0].attributes.sandbox, "allow-scripts");
  assert.equal(stats.started, 2);
  // A message from another window is not a result.
  const pending = sandbox.run({ code: "await new Promise(resolve => setTimeout(resolve, 50)); return 'real';" });
  message(parent, { type: "result", id: 3, result: { ok: true, value: "forged", logs: [], truncated: false } }, new EventTarget());
  assert.equal((await pending).value, "real");
  await assert.rejects(sandbox.run({ code: "" }), error => error.code === "CODE_REQUIRED");
});

test("a sandboxed page that never answers is replaced after the run's deadline", async () => {
  const { document, frames } = pages({ serve: false });
  const sandbox = createCodeSandbox({ document, url: "chrome-extension://id/code-sandbox.html", readyMs: 50 });
  assert.equal((await sandbox.run({ code: "return 1;" })).error.code, "SANDBOX_UNAVAILABLE");
  assert.equal(frames[0].removed, true);
  // A page that loads but drops runs: the run fails at its timeout plus the grace, and the page goes.
  const silent = pages({ serve: false });
  const late = createCodeSandbox({ document: silent.document, url: "u", graceMs: 50 });
  const result = late.run({ code: "return 1;", timeoutMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 0));
  silent.message(silent.parent, { type: "ready" }, silent.frames[0].contentWindow);
  assert.equal((await result).error.code, "EXEC_TIMEOUT");
  assert.equal(silent.frames[0].removed, true);
});

test("bash takes its Worker from the product's shell source, loaded once; a JavaScript run never loads it", async () => {
  const { document, stats } = pages();
  let loads = 0;
  const sandbox = createCodeSandbox({ document, url: "u", shellSource: async () => { loads++; return "SHELL"; } });
  assert.equal((await sandbox.run({ code: "return 1 + 1;" })).value, "2");
  assert.equal(loads, 0);
  const made = await sandbox.run({ language: "bash", code: "options" });
  assert.equal(made.ok, true);
  assert.equal(JSON.parse(made.stdout).cwd, "/home/user");
  assert.equal((await sandbox.run({ language: "bash", code: "fail" })).exitCode, 2);
  assert.equal(loads, 1);
  assert.equal(stats.started, 3);
  // A source that cannot be had fails the bash run with its code, starts no Worker, and is tried again next time.
  let attempts = 0;
  const offline = createCodeSandbox({ document: pages().document, url: "u",
    shellSource: async () => { attempts++; throw Object.assign(new Error("SANDBOX_SOURCE_MISMATCH: wrong bytes"), { code: "SANDBOX_SOURCE_MISMATCH" }); } });
  assert.deepEqual((await offline.run({ language: "bash", code: "ls" })).error, { code: "SANDBOX_SOURCE_MISMATCH", message: "SANDBOX_SOURCE_MISMATCH: wrong bytes" });
  await offline.run({ language: "bash", code: "ls" });
  assert.equal(attempts, 2);
});

// A Cache API stand-in (one cache) and a fetch that counts its requests.
function sourceWorld(served) {
  const store = new Map();
  const cache = {
    match: async key => store.has(key) ? new Response(store.get(key)) : undefined,
    put: async (key, response) => { store.set(key, new Uint8Array(await response.arrayBuffer())); },
    delete: async key => store.delete(key),
  };
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, init }); return typeof served === "number" ? new Response("", { status: served }) : new Response(served); };
  return { store, requests, fetch, caches: { open: async () => cache } };
}

test("a pinned script is used only when its SHA-256 matches, then served from the cache without the network", async () => {
  const text = "serveCodeRun(self, { Bash });";
  const sha256 = createHash("sha256").update(text).digest("hex");
  const world = sourceWorld(text);
  const url = "https://worker.example/sandbox/shell.js";
  assert.equal(await loadPinnedSource({ sha256, url, fetch: world.fetch, caches: world.caches }), text);
  assert.equal(world.requests.length, 1);
  assert.equal(world.requests[0].init.credentials, "omit");
  assert.equal(await loadPinnedSource({ sha256, url, fetch: world.fetch, caches: world.caches }), text);
  assert.equal(world.requests.length, 1, "the second load is a cache hit");
  // A cached entry whose bytes changed is dropped and fetched again.
  for (const key of world.store.keys()) world.store.set(key, new TextEncoder().encode("tampered"));
  assert.equal(await loadPinnedSource({ sha256, url, fetch: world.fetch, caches: world.caches }), text);
  assert.equal(world.requests.length, 2);
});

test("served bytes that are not the pinned build are refused and never cached; an unreachable script is unavailable", async () => {
  const pinned = createHash("sha256").update("the build this extension pins").digest("hex");
  const other = sourceWorld("fetch('https://evil.example/')");
  await assert.rejects(loadPinnedSource({ sha256: pinned, url: "https://w/s.js", fetch: other.fetch, caches: other.caches }),
    error => error.code === "SANDBOX_SOURCE_MISMATCH" && error.message.includes(pinned));
  assert.equal(other.store.size, 0);
  const missing = sourceWorld(404);
  await assert.rejects(loadPinnedSource({ sha256: pinned, url: "https://w/s.js", fetch: missing.fetch, caches: missing.caches }),
    error => error.code === "SANDBOX_SOURCE_UNAVAILABLE" && /HTTP 404/.test(error.message));
  await assert.rejects(loadPinnedSource({ sha256: pinned, url: "https://w/s.js", fetch: async () => { throw new TypeError("Failed to fetch"); } }),
    error => error.code === "SANDBOX_SOURCE_UNAVAILABLE");
  await assert.rejects(loadPinnedSource({ sha256: "abc", url: "https://w/s.js", fetch: other.fetch }), error => error.code === "SANDBOX_SOURCE_MISMATCH");
});
