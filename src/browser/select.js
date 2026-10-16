// Choosing options of a native <select>; a custom dropdown is opened and chosen with clicks instead.
import { BrowserCoreError } from "./errors.js";
import { SELECT_OPTIONS } from "./page-scripts.js";

/** @typedef {import("./index.js").Send} Send */

/**
 * Selects the options whose value or visible text is in `values` and fires input and change.
 * @param {Send} send @param {number} backendNodeId @param {string[]} values @param {string} [sessionId]
 * @returns {Promise<{ matched: number, chosen: string[] }>}
 */
export async function selectOptions(send, backendNodeId, values, sessionId) {
  const { object } = await send("DOM.resolveNode", { backendNodeId }, sessionId);
  try {
    const kind = await send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
      functionDeclaration: "function() { return this.tagName === 'SELECT'; }" }, sessionId);
    if (kind.result?.value !== true) throw new BrowserCoreError("TARGET_NOT_SELECT", "The control is not a native select; open it with a click and click the option");
    const outcome = await send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true, functionDeclaration: SELECT_OPTIONS,
      arguments: [{ value: values }] }, sessionId);
    const value = outcome.result?.value;
    if (outcome.exceptionDetails || !value) throw new BrowserCoreError("PAGE_SCRIPT_FAILED", "The select could not be changed");
    if (value.error) throw new BrowserCoreError("OPTION_NOT_FOUND", String(value.error).slice(0, 2_000));
    return { matched: value.matched, chosen: value.chosen ?? [] };
  } finally { await send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => {}); }
}
