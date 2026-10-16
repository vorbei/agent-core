// The extension page's handle on the code sandbox: it embeds the sandboxed page (CODE_SANDBOX_PAGE)
// in a hidden iframe on the first run, sends it each validated request and waits for its result,
// with a deadline of its own past the run's: a page that stops answering is replaced. A bash run
// takes its Worker script from the product's `shellSource` (loaded once, on the first bash run);
// a JavaScript run never asks for it.
import { codeRunFailure, codeRunRequest } from "./code-run.js";

// The sandboxed page answers within the run's timeout; this much longer, it is replaced.
const PAGE_GRACE_MS = 2_000;
// How long the sandboxed page may take to load and say it is ready.
const PAGE_READY_MS = 10_000;

/**
 * @param {{ document: Document, url: string, shellSource?: () => Promise<string>, graceMs?: number, readyMs?: number }} options
 *   `url`: the sandboxed page's extension URL (chrome.runtime.getURL(CODE_SANDBOX_PAGE)).
 *   `shellSource`: the Worker script that serves bash runs (for example loadPinnedSource); without
 *   it the page's own Worker runs bash, if it has a shell.
 * @returns {import("./index.js").CodeSandbox}
 */
export function createCodeSandbox({ document, url, shellSource, graceMs = PAGE_GRACE_MS, readyMs = PAGE_READY_MS }) {
  const window = /** @type {Window} */ (document.defaultView);
  /** @type {{ frame: HTMLIFrameElement, ready: Promise<boolean> } | null} */
  let page = null;
  let nextId = 0;
  /** @type {Map<number, (result: import("./index.js").CodeRunResult) => void>} */
  const waiting = new Map();
  /** @type {(() => void) | null} */
  let markReady = null;
  /** @type {Promise<string> | null} */
  let shell = null;
  // One load at a time; a failed load is tried again by the next bash run.
  const loadShell = () => {
    shell ??= /** @type {() => Promise<string>} */ (shellSource)().catch(error => { shell = null; throw error; });
    return shell;
  };

  window.addEventListener("message", event => {
    if (!page || event.source !== page.frame.contentWindow) return;
    if (event.data?.type === "ready") markReady?.();
    if (event.data?.type === "result") {
      const answer = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      answer?.(event.data.result);
    }
  });

  function open() {
    if (page) return page;
    const frame = document.createElement("iframe");
    // The manifest already sandboxes the page; the attribute keeps it sandboxed wherever it is embedded.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.display = "none";
    const ready = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), readyMs);
      markReady = () => { clearTimeout(timer); markReady = null; resolve(true); };
    });
    frame.src = url;
    document.body.append(frame);
    page = { frame, ready: /** @type {Promise<boolean>} */ (ready) };
    return page;
  }

  function close() {
    page?.frame.remove();
    page = null;
    markReady = null;
  }

  return {
    async run(input) {
      const request = codeRunRequest(input);
      /** @type {string | undefined} */
      let workerSource;
      if (request.language === "bash" && shellSource) {
        try { workerSource = await loadShell(); }
        catch (error) {
          const failed = /** @type {{ code?: string, message?: string }} */ (error);
          return codeRunFailure(failed?.code ?? "SANDBOX_SOURCE_UNAVAILABLE", String(failed?.message ?? error));
        }
      }
      const current = open();
      if (!await current.ready) {
        if (page === current) close();
        return codeRunFailure("SANDBOX_UNAVAILABLE", "the code sandbox page did not load");
      }
      const id = ++nextId;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          // A page that does not answer past the run's own deadline is replaced for the next run.
          if (page === current) close();
          resolve(codeRunFailure("EXEC_TIMEOUT", `the run did not finish in ${request.timeoutMs} ms`));
        }, request.timeoutMs + graceMs);
        waiting.set(id, result => { clearTimeout(timer); resolve(result); });
        current.frame.contentWindow?.postMessage({ type: "run", id, request, ...(workerSource ? { workerSource } : {}) }, "*");
      });
    },
    dispose: close,
  };
}
