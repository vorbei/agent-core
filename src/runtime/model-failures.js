// What a failed model request is called, and whether the turn may retry it. Stored turn errors are
// fixed turn codes or MODEL_<...>. From X Gardener src/pi/turn-runtime.js, with pi-do's reading
// of an HTTP status or a timeout from a provider's error message.

// An HTTP status a provider reports: "HTTP 503", "HTTP/1.1 503", "status: 503", "status code 502",
// or a leading "429 Too Many Requests" / "503: ..." / "500 {...}". A bare number elsewhere ("500
// tokens") is not a status.
const STATUS_FORMS = [
  /\bHTTP(?:\/\d(?:\.\d)?)?\s*[:=]?\s*([1-5]\d\d)\b/i,
  /\bstatus(?:[ _]?code)?["']?\s*[:=]?\s*([1-5]\d\d)\b/i,
  /^([45]\d\d)(?=\s*[:{(\-–]|\s+(?:too many|rate|bad|internal|service|gateway|request|not found|unauthori[sz]ed|forbidden|overloaded|error|upstream|payment|conflict|unprocessable|unavailable|timeout|precondition)\b)/i,
];
const TIMEOUT = /model exceeded \d+ms|timed? ?out|\btimeout\b/i;

/**
 * The stored code for a model failure: an explicit `code` on the error first, then what the
 * message says (a known MODEL_ code, an overflow, a 4xx/5xx HTTP status, a timeout), else
 * MODEL_FAILED. Only the model request's own failures are read for a status or a timeout: pass
 * `{ origin: "other" }` for an error raised elsewhere in the turn (storage, a tool, the consumer's
 * own code), so a message that happens to say "timeout" or "503" is not taken for a retryable
 * model failure; such an error keeps an explicit code it carries, else it is MODEL_FAILED.
 * @param {unknown} error an Error, an object with `code`/`message`, or the message itself
 * @param {{ origin?: "model" | "other" }} [options]
 * @returns {string}
 */
export function modelFailureCode(error, { origin = "model" } = {}) {
  const explicit = typeof error === "object" && error ? /** @type {any} */ (error).code || /** @type {any} */ (error).name : null;
  if (explicit && explicit !== "Error") {
    const code = String(explicit).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (code === "CONTEXT_OVERFLOW") return code;
    return code.startsWith("MODEL_") ? code.slice(0, 46) : `MODEL_${code.slice(0, 40)}`;
  }
  if (origin !== "model") return "MODEL_FAILED";
  const message = String(/** @type {any} */ (error)?.message || error || "");
  if (/\bCONTEXT_OVERFLOW\b|^Context overflow recovery failed\b|maximum context length|context_length_exceeded/i.test(message)) return "CONTEXT_OVERFLOW";
  const known = message.match(/\b(MODEL_(?:HTTP_\d{3}|TIMEOUT|OUTPUT_EMPTY|OUTPUT_LIMIT|API_KEY_MISSING|UNAVAILABLE))\b/i)?.[1];
  if (known) return known.toUpperCase();
  if (/no text or tool call|no final answer/i.test(message)) return "MODEL_OUTPUT_EMPTY";
  // A success status (2xx/3xx) is not the failure: "HTTP status 200 but stream timed out" timed out.
  const status = STATUS_FORMS.map(form => form.exec(message)?.[1]).find(found => found && Number(found) >= 400);
  if (status) return `MODEL_HTTP_${status}`;
  if (TIMEOUT.test(message)) return "MODEL_TIMEOUT";
  return "MODEL_FAILED";
}

/**
 * Whether a failure with this code is worth another request (overflow never is). MODEL_OUTPUT_LIMIT
 * (the response reached its output cap with no answer and no tool call, typically all reasoning)
 * is retried as the turn driver's output recovery: tools off, a larger output budget, less reasoning.
 * @param {string} code
 */
export function isRetryableModelFailure(code) {
  if (code === "CONTEXT_OVERFLOW") return false;
  if (["MODEL_TIMEOUT", "MODEL_OUTPUT_EMPTY", "MODEL_OUTPUT_LIMIT", "MODEL_UNAVAILABLE"].includes(code)) return true;
  const status = Number(code.match(/^MODEL_HTTP_(\d{3})$/)?.[1]);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
