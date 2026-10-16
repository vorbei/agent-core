// The code sandbox's request and result shapes and their bounds, shared by the extension page that
// asks for a run (code-sandbox.js), the sandboxed page that hosts it (code-sandbox-page.js) and the
// Worker that runs it (code-worker.js): a request is validated and clamped here once, and every
// failure is one result shape.

/** Bounds of one run. A product's requested timeout and output cap are clamped into them. */
export const CODE_RUN_LIMITS = Object.freeze({
  maxCodeChars: 20_000,
  maxFiles: 20, maxFilesChars: 100_000, maxPathChars: 200,
  timeoutMs: 10_000, minTimeoutMs: 100, maxTimeoutMs: 60_000,
  outputChars: 8_000, minOutputChars: 1_000, maxOutputChars: 24_000,
  logLines: 40, logLineChars: 500, errorChars: 2_000, stderrChars: 2_000,
  // The shell's own ceilings (just-bash's execution limits): its virtual filesystem and its output.
  shellFileSystemBytes: 32 * 1024 * 1024, shellOutputBytes: 4 * 1024 * 1024,
});

/** The languages a run may be written in: JavaScript (an async function body) or a bash script. */
export const CODE_LANGUAGES = Object.freeze(["js", "bash"]);

/** The sandboxed page a product lists in its manifest's `sandbox.pages`, beside the bundle it loads. */
export const CODE_SANDBOX_PAGE = "code-sandbox.html";

/**
 * The product's manifest `content_security_policy.sandbox`. The page is sandboxed (an opaque
 * origin, so no extension API, cookies or storage of the extension), it loads only the extension's
 * own script, may evaluate code (the model's code is the feature) and start Workers from a blob
 * URL, and reaches no network: fetch, XHR, WebSocket and EventSource are `connect-src`, a Worker's
 * importScripts is `script-src`, and a Worker started from a blob inherits this policy.
 */
export const CODE_SANDBOX_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'";

// A file the run starts with: a relative path (under the shell's home) or an absolute one, no "..".
const FILE_PATH = /^\/?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

/** @param {string} code */
const inputError = (code, detail = code) => Object.assign(new Error(`${code}: ${detail}`), { code });

/**
 * Validates a run request and clamps its limits. Throws `CODE_REQUIRED`, `CODE_TOO_LARGE`,
 * `CODE_LANGUAGE_INVALID` or `CODE_FILES_INVALID` (each error's `code`); everything else is a result.
 * @param {unknown} input
 * @returns {import("./index.js").CodeRunRequest}
 */
export function codeRunRequest(input) {
  const raw = /** @type {Record<string, unknown>} */ (input && typeof input === "object" ? input : {});
  const language = raw.language ?? "js";
  if (typeof language !== "string" || !CODE_LANGUAGES.includes(language)) throw inputError("CODE_LANGUAGE_INVALID", `language must be one of ${CODE_LANGUAGES.join(", ")}`);
  if (typeof raw.code !== "string" || !raw.code.trim()) throw inputError("CODE_REQUIRED", "code must be a non-empty string");
  const L = CODE_RUN_LIMITS;
  if (raw.code.length > L.maxCodeChars) throw inputError("CODE_TOO_LARGE", `code must be at most ${L.maxCodeChars} characters`);
  /** @type {Record<string, string>} */
  const files = {};
  if (raw.files !== undefined) {
    if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) throw inputError("CODE_FILES_INVALID", "files must map paths to text");
    const entries = Object.entries(raw.files);
    if (entries.length > L.maxFiles) throw inputError("CODE_FILES_INVALID", `at most ${L.maxFiles} files`);
    let total = 0;
    for (const [path, text] of entries) {
      if (path.length > L.maxPathChars || !FILE_PATH.test(path) || path.split("/").includes("..")) throw inputError("CODE_FILES_INVALID", `invalid file path ${JSON.stringify(path.slice(0, 80))}`);
      if (typeof text !== "string") throw inputError("CODE_FILES_INVALID", `file ${path} must be text`);
      total += text.length;
      files[path] = text;
    }
    if (total > L.maxFilesChars) throw inputError("CODE_FILES_INVALID", `files must total at most ${L.maxFilesChars} characters`);
  }
  return {
    language: /** @type {"js" | "bash"} */ (language),
    code: raw.code,
    files,
    timeoutMs: clampInteger(raw.timeoutMs, L.timeoutMs, L.minTimeoutMs, L.maxTimeoutMs),
    maxOutputChars: clampInteger(raw.maxOutputChars, L.outputChars, L.minOutputChars, L.maxOutputChars),
  };
}

/**
 * A run that did not produce its own result: it timed out, its Worker failed, or the sandbox was unavailable.
 * @param {string} code @param {string} message @param {string[]} [logs]
 * @returns {import("./index.js").CodeRunResult}
 */
export function codeRunFailure(code, message, logs = []) {
  return { ok: false, error: { code, message: message.slice(0, CODE_RUN_LIMITS.errorChars) }, logs, truncated: false };
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInteger(value, fallback, min, max) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}
