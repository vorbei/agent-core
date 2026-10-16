// Runs one code request inside a dedicated Worker of the sandboxed page: it first removes the
// Worker's network, storage, messaging and extension globals, then runs JavaScript as the body of
// an async function, or a bash script in the product's in-memory shell (a just-bash `Bash`), and
// posts its capped console lines as they happen and one result. The page terminates the Worker at
// the deadline; the code never shares a Worker with another run.
import { CODE_RUN_LIMITS } from "./code-run.js";

/**
 * Globals the code may not reach: network (also refused by the page's CSP), storage, nested
 * Workers and channels, the extension API, and the Worker's own postMessage (only the runtime
 * answers the page).
 */
export const CODE_WORKER_BLOCKED_GLOBALS = Object.freeze([
  "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts",
  "Worker", "SharedWorker", "BroadcastChannel", "MessageChannel", "indexedDB", "caches", "cookieStore", "chrome", "browser",
]);

// Where a bash run starts and where relative file paths land.
const HOME = "/home/user";

/**
 * Serves one run on `port` (the Worker's own global, or a test's message port): receives
 * `{ type: "run", request }`, posts `{ type: "log", line }` per kept console line and then
 * `{ type: "result", result }`.
 * @param {typeof globalThis} scope
 * @param {{ Bash?: import("./index.js").ShellConstructor, port?: import("./index.js").CodeMessagePort }} [options]
 */
export function serveCodeRun(scope, { Bash, port = /** @type {any} */ (scope) } = {}) {
  const post = port.postMessage.bind(port);
  let started = false;
  port.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    if (started || event.data?.type !== "run") return;
    started = true;
    void runRequest(event.data.request, Bash, line => post({ type: "log", line }))
      .then(result => post({ type: "result", result }));
  });
  port.start?.();
  lockDown(scope, port === /** @type {any} */ (scope) ? [...CODE_WORKER_BLOCKED_GLOBALS, "postMessage"] : CODE_WORKER_BLOCKED_GLOBALS);
}

/**
 * Removes each name from the scope and its prototypes; one that cannot be removed is set to undefined.
 * @param {object} scope @param {readonly string[]} names
 */
function lockDown(scope, names) {
  for (const name of names) {
    for (let target = scope; target; target = Object.getPrototypeOf(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (!descriptor) continue;
      try {
        if (descriptor.configurable) delete /** @type {any} */ (target)[name];
        else Object.defineProperty(target, name, { value: undefined });
      } catch { /* a frozen binding stays; the CSP still refuses the network */ }
    }
  }
}

/**
 * @param {import("./index.js").CodeRunRequest} request
 * @param {import("./index.js").ShellConstructor | undefined} Bash
 * @param {(line: string) => void} onLog
 * @returns {Promise<import("./index.js").CodeRunResult>}
 */
async function runRequest(request, Bash, onLog) {
  if (request.language === "bash") return runShell(request, Bash);
  const L = CODE_RUN_LIMITS;
  /** @type {string[]} */
  const logs = [];
  let dropped = 0;
  const log = (/** @type {unknown[]} */ ...args) => {
    if (logs.length >= L.logLines) { dropped++; return; }
    const line = args.map(text).join(" ");
    const kept = line.length > L.logLineChars ? `${line.slice(0, L.logLineChars - 1)}…` : line;
    logs.push(kept);
    onLog(kept);
  };
  const allLogs = () => dropped ? [...logs, `[${dropped} more log lines dropped]`] : logs;
  const capture = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
  try {
    // The code is the body of an async function; only this Worker, inside the sandboxed page, evaluates it.
    const AsyncFunction = /** @type {FunctionConstructor} */ (Object.getPrototypeOf(async function () {}).constructor);
    const run = new AsyncFunction("console", "files", request.code);
    const output = text(await run(capture, Object.freeze({ ...request.files })));
    return { ok: true, value: output.slice(0, request.maxOutputChars), logs: allLogs(), truncated: output.length > request.maxOutputChars };
  } catch (error) {
    const name = error instanceof Error && error.name !== "Error" ? error.name : undefined;
    const message = (error instanceof Error ? error.message : text(error)).slice(0, L.errorChars);
    return { ok: false, error: { code: "CODE_ERROR", message, ...(name ? { name } : {}) }, logs: allLogs(), truncated: false };
  }
}

/**
 * A bash script in a fresh in-memory shell: the request's files, no network (the shell gets no
 * network or fetch option, so curl does not exist), its own limits under the run's deadline.
 * @param {import("./index.js").CodeRunRequest} request
 * @param {import("./index.js").ShellConstructor | undefined} Bash
 * @returns {Promise<import("./index.js").CodeRunResult>}
 */
async function runShell(request, Bash) {
  const L = CODE_RUN_LIMITS;
  if (!Bash) return { ok: false, error: { code: "CODE_LANGUAGE_UNAVAILABLE", message: "bash is not available in this sandbox" }, logs: [], truncated: false };
  try {
    const files = Object.fromEntries(Object.entries(request.files).map(([path, content]) => [path.startsWith("/") ? path : `${HOME}/${path}`, content]));
    const shell = new Bash({ files, cwd: HOME, executionLimitProfile: "hardened",
      executionLimits: { maxExecutionTimeMs: request.timeoutMs, maxFileSystemBytes: L.shellFileSystemBytes, maxOutputSize: L.shellOutputBytes } });
    const { stdout, stderr, exitCode } = await shell.exec(request.code, { rawScript: true });
    const truncated = stdout.length > request.maxOutputChars || stderr.length > L.stderrChars;
    const output = { stdout: stdout.slice(0, request.maxOutputChars), stderr: stderr.slice(0, L.stderrChars), exitCode, logs: [], truncated };
    return exitCode === 0 ? { ok: true, ...output } : { ok: false, error: { code: "EXIT_STATUS", message: `exit status ${exitCode}` }, ...output };
  } catch (error) {
    const message = (error instanceof Error ? error.message : text(error)).slice(0, L.errorChars);
    return { ok: false, error: { code: "CODE_ERROR", message }, logs: [], truncated: false };
  }
}

/** @param {unknown} value */
function text(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { const json = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item); return json === undefined ? String(value) : json; }
  catch { return String(value); }
}
