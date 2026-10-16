// The sandboxed extension page (CODE_SANDBOX_PAGE, an opaque origin under CODE_SANDBOX_CSP): it
// takes run requests only from the page that embeds it, runs each in a fresh Worker started from
// the product's bundled Worker source (or the source a request carries: the embedding extension
// page's verified shell Worker), terminates that Worker at the run's deadline, and answers with
// the run's result.
import { codeRunFailure, codeRunRequest } from "./code-run.js";

/**
 * Starts a Worker from source text (in the sandboxed page, a blob URL: the page's opaque origin
 * cannot start one from the extension's files). Tests pass their own.
 * @param {string} source
 * @returns {import("./index.js").CodeWorker}
 */
function blobWorker(source) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try { return /** @type {import("./index.js").CodeWorker} */ (/** @type {unknown} */ (new Worker(url))); }
  finally { URL.revokeObjectURL(url); }
}

/**
 * Serves runs in `page` (the sandboxed page's window): `{ type: "run", id, request }` from its
 * parent is answered with `{ type: "result", id, result }`; `{ type: "ready" }` says it listens.
 * @param {Window} page
 * @param {{ workerSource: string, spawn?: (source: string) => import("./index.js").CodeWorker }} options
 */
export function serveCodeSandboxPage(page, { workerSource, spawn = blobWorker }) {
  const parent = page.parent;
  page.addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "run") return;
    const { id } = event.data;
    const source = typeof event.data.workerSource === "string" ? event.data.workerSource : workerSource;
    void runInWorker(event.data.request, source, spawn)
      .then(result => parent.postMessage({ type: "result", id, result }, "*"));
  });
  parent.postMessage({ type: "ready" }, "*");
}

/**
 * One run in its own Worker, ended by its result, a Worker error or the deadline.
 * @param {unknown} input @param {string} workerSource @param {(source: string) => import("./index.js").CodeWorker} spawn
 * @returns {Promise<import("./index.js").CodeRunResult>}
 */
export function runInWorker(input, workerSource, spawn) {
  /** @type {import("./index.js").CodeRunRequest} */
  let request;
  try { request = codeRunRequest(input); }
  catch (error) { return Promise.resolve(codeRunFailure(/** @type {{ code?: string }} */ (error).code ?? "CODE_INVALID", String(/** @type {Error} */ (error).message))); }
  return new Promise(resolve => {
    /** @type {string[]} */
    const logs = [];
    /** @type {import("./index.js").CodeWorker} */
    let worker;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const finish = (/** @type {import("./index.js").CodeRunResult} */ result) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(result);
    };
    try { worker = spawn(workerSource); }
    catch (error) { finish(codeRunFailure("SANDBOX_FAILED", `the code Worker did not start: ${String(/** @type {Error} */ (error)?.message ?? error)}`)); return; }
    worker.addEventListener("message", (/** @type {MessageEvent} */ event) => {
      if (event.data?.type === "log" && typeof event.data.line === "string") logs.push(event.data.line);
      if (event.data?.type === "result") finish(event.data.result);
    });
    worker.addEventListener("error", (/** @type {ErrorEvent} */ event) => {
      event.preventDefault?.();
      finish(codeRunFailure("SANDBOX_FAILED", `the code Worker failed: ${event.message || "unknown error"}`, logs));
    });
    // Terminating the Worker is what stops code that never yields (a busy loop) or never settles.
    timer = setTimeout(() => finish(codeRunFailure("EXEC_TIMEOUT", `the run did not finish in ${request.timeoutMs} ms`, logs)), request.timeoutMs);
    worker.postMessage({ type: "run", request });
  });
}
