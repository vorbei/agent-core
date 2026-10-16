// Elements of one frame that act like controls without an ARIA control role (custom dropdowns,
// cards): found by default in the page's own world, so handlers assigned by script count, and
// returned by backend node id in document order, with whether discovery failed.
import { DESCRIBE_CLICKABLES, DISCOVER_CLICKABLES } from "./page-scripts.js";
import { frameDocumentObject } from "./frames.js";

/** @typedef {import("./index.js").Send} Send */
/** @typedef {import("./index.js").FrameDoc} FrameDoc */
/** @typedef {import("./index.js").Clickable} Clickable */
/** @typedef {import("./index.js").ClickableDiscovery} ClickableDiscovery */

export const MAX_CLICKABLES = 100;
let groups = 0;

/**
 * The frame's clickable non-ARIA elements, at most `max` (a missing, non-finite or non-positive
 * `max` is MAX_CLICKABLES). `worldName` runs discovery in that isolated world of the frame instead
 * of the page's world (the page's scripts cannot interfere; a script-assigned `onclick` property is
 * then not seen). A frame that is gone or navigates mid-read has none and no error; a discovery that
 * fails (the page script throws, a CDP call fails) returns what was found with `discoveryError`
 * set, so the caller can say that cursor-only controls may be missing. Every remote object is
 * created in one object group, released at the end in one call.
 * @param {Send} send @param {FrameDoc} frame @param {{ max?: number, worldName?: string }} [options]
 * @returns {Promise<ClickableDiscovery>}
 */
export async function findClickables(send, frame, { max, worldName } = {}) {
  const limit = typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_CLICKABLES;
  const session = frame.sessionId;
  const objectGroup = `agent-core-clickables-${++groups}`;
  /** @type {Clickable[]} */
  const clickables = [];
  try {
    const documentId = await frameDocumentObject(send, frame, { worldName, objectGroup });
    if (!documentId) return { clickables, discoveryError: null };
    const list = await send("Runtime.callFunctionOn", { objectId: documentId, functionDeclaration: DISCOVER_CLICKABLES,
      arguments: [{ value: limit }], returnByValue: false, objectGroup }, session);
    if (list?.exceptionDetails) return { clickables, discoveryError: "CLICKABLE_DISCOVERY_FAILED" };
    const listId = list?.result?.objectId;
    if (!listId) return { clickables, discoveryError: "CLICKABLE_DISCOVERY_FAILED" };
    const described = await send("Runtime.callFunctionOn", { objectId: listId, functionDeclaration: DESCRIBE_CLICKABLES, returnByValue: true, objectGroup }, session);
    const infos = described?.result?.value ?? [];
    // Property values join the list's object group.
    const { result } = await send("Runtime.getProperties", { objectId: listId, ownProperties: true }, session);
    const found = [];
    for (const property of result) {
      const index = Number(property.name);
      if (!Number.isInteger(index) || !property.value?.objectId || !infos[index]) continue;
      // An element removed since discovery has no node; it is skipped, not an error.
      const node = await send("DOM.describeNode", { objectId: property.value.objectId }, session).catch(() => null);
      if (node) found.push({ ...infos[index], backendNodeId: node.node.backendNodeId, index });
    }
    for (const { index: _index, ...item } of found.sort((a, b) => a.index - b.index)) clickables.push(item);
    return { clickables, discoveryError: null };
  } catch {
    return { clickables, discoveryError: "CLICKABLE_DISCOVERY_FAILED" };
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup }, session).catch(() => {});
  }
}
