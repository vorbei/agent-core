// Runs model-written JavaScript in a fresh Worker Loader isolate with no network and no bindings
// other than the ones the product passes (none by default): `globalOutbound: null` refuses fetch,
// connect and WebSocket on the platform, `limits.cpuMs` bounds CPU, a wall-clock timeout bounds
// waiting, and the returned value and console lines are capped. A loaded isolate may run on its
// caller's thread, so while its code computes the caller (a Durable Object) handles nothing else:
// the CPU bound is short (CODE_EXEC_LIMITS.cpuMs) whatever the wall-clock timeout. The answer is one structured
// result; only invalid input throws. From X Gardener src/cf/code-exec.js (js_exec); the nested
// tools it lets code call, and their binding, are the product's.

/** Bounds of one run. A product's requested timeout and output cap are clamped into them. */
export const CODE_EXEC_LIMITS = Object.freeze({
  maxCodeChars: 20_000,
  timeoutMs: 30_000, minTimeoutMs: 100, maxTimeoutMs: 120_000,
  outputChars: 12_000, minOutputChars: 1_000, maxOutputChars: 24_000,
  logLines: 40, logLineChars: 500, errorChars: 2_000, nestedCalls: 20,
  // CPU per run. The wall-clock timeout covers waiting on nested tools; computing is held to this,
  // because the caller's thread waits for it (a 120 s chess search kept an account's Durable Object
  // from answering any read for 87 s and 143 s, 2026-10-11).
  cpuMs: 5_000,
});

/** The Workers compatibility date the isolate runs on, unless the product passes its own. */
export const CODE_EXEC_COMPATIBILITY_DATE = "2026-08-24";

// The host's own deadline after the isolate's: an isolate that never answers is abandoned.
const HOST_GRACE_MS = 1_000;

/** @param {string} code */
const inputError = (code) => Object.assign(new Error(code), { code });

/**
 * @param {import("./index.js").CodeExecRequest} request
 * @returns {Promise<import("./index.js").CodeExecResult>}
 */
export async function runSandboxedCode({ loader, code, timeoutMs, maxOutputChars, tools, compatibilityDate = CODE_EXEC_COMPATIBILITY_DATE }) {
  if (!loader?.load) throw inputError("CODE_MODE_UNAVAILABLE");
  if (typeof code !== "string" || !code.trim()) throw inputError("CODE_REQUIRED");
  if (code.length > CODE_EXEC_LIMITS.maxCodeChars) throw inputError("CODE_TOO_LARGE");
  const L = CODE_EXEC_LIMITS;
  const timeout = clampInteger(timeoutMs, L.timeoutMs, L.minTimeoutMs, L.maxTimeoutMs);
  const outputLimit = clampInteger(maxOutputChars, L.outputChars, L.minOutputChars, L.maxOutputChars);
  const worker = loader.load({
    compatibilityDate,
    mainModule: "index.js",
    modules: { "index.js": { js: sandboxModuleSource(code, tools) } },
    env: tools ? { [tools.bindingName]: tools.binding } : {},
    // Platform-level egress denial: fetch(), connect() and WebSocket all throw inside the sandbox.
    globalOutbound: null,
    // Enforced by the platform in production (the isolate throws at once); wrangler dev does not enforce it.
    limits: { cpuMs: Math.min(timeout, L.cpuMs) },
  });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const run = worker.getEntrypoint().run({ timeoutMs: timeout, maxOutputChars: outputLimit, maxLogLines: L.logLines,
      maxLogLineChars: L.logLineChars, maxErrorChars: L.errorChars, maxNestedCalls: tools?.maxCalls ?? L.nestedCalls });
    const abandoned = new Promise((resolve) => {
      timer = setTimeout(() => resolve(failure("EXEC_TIMEOUT", "EXEC_TIMEOUT")), timeout + HOST_GRACE_MS);
    });
    return /** @type {import("./index.js").CodeExecResult} */ (await Promise.race([run, abandoned]));
  } catch (error) {
    // The isolate itself failed: the module did not compile, or the platform stopped it.
    const failed = /** @type {{ message?: unknown, name?: unknown }} */ (error ?? {});
    const message = String(typeof failed.message === "string" ? failed.message : error).slice(0, L.errorChars);
    return failure(/exceeded CPU|CPU time limit/i.test(message) ? "EXEC_CPU_LIMIT" : "CODE_ERROR", message,
      typeof failed.name === "string" ? failed.name : undefined);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} code @param {string} message @param {string} [name] */
function failure(code, message, name) {
  return { ok: false, error: { code, message, ...(name && name !== "Error" ? { name } : {}) }, logs: [], truncated: false, calls: 0 };
}

/**
 * The isolate's module: the code is the body of an async function outside the entrypoint class,
 * with a capturing `console` and, only when the product passes tools, a `tools` proxy over its
 * binding that refuses names outside its list. Shipped as source text (never Function.toString,
 * which a bundler minifies).
 * @param {string} code
 * @param {import("./index.js").CodeExecTools} [tools]
 */
export function sandboxModuleSource(code, tools) {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";

const allowed = new Set(${JSON.stringify(tools ? [...tools.names] : [])});
const bindingName = ${JSON.stringify(tools?.bindingName ?? null)};

function text(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; }
  catch { return String(value); }
}

export default class extends WorkerEntrypoint {
  async run(options) {
    const logs = [];
    let dropped = 0;
    const log = (...args) => {
      if (logs.length >= options.maxLogLines) { dropped++; return; }
      const line = args.map(text).join(" ");
      logs.push(line.length > options.maxLogLineChars ? line.slice(0, options.maxLogLineChars - 1) + "…" : line);
    };
    const allLogs = () => dropped ? [...logs, "[" + dropped + " more log lines dropped]"] : logs;
    const capture = { log, info: log, warn: log, error: log, debug: log };
    let calls = 0;
    const env = this.env;
    const tools = new Proxy(Object.create(null), {
      get(_target, name) {
        if (name === "then") return undefined;
        return async (input = {}) => {
          if (!bindingName || !allowed.has(String(name))) throw new Error("TOOL_NOT_ALLOWED: " + String(name));
          if (++calls > options.maxNestedCalls) throw new Error("NESTED_TOOL_LIMIT");
          return env[bindingName].call(String(name), input);
        };
      }
    });
    let timer;
    try {
      const value = await Promise.race([
        execute(tools, capture),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("EXEC_TIMEOUT"), { code: "EXEC_TIMEOUT" })), options.timeoutMs); })
      ]);
      const output = text(value);
      return { ok: true, value: output.slice(0, options.maxOutputChars), logs: allLogs(), truncated: output.length > options.maxOutputChars, calls };
    } catch (error) {
      const timedOut = error?.code === "EXEC_TIMEOUT";
      const name = error instanceof Error && error.name !== "Error" ? error.name : undefined;
      const message = (error instanceof Error ? error.message : text(error)).slice(0, options.maxErrorChars);
      return { ok: false, error: { code: timedOut ? "EXEC_TIMEOUT" : "CODE_ERROR", message, ...(name ? { name } : {}) }, logs: allLogs(), truncated: false, calls };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function execute(tools, console) {
${code}
}
`;
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInteger(value, fallback, min, max) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}
