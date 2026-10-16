// A tab's documents: the main frame and every iframe, same-process or cross-process (OOPIF), each
// with the CDP session that reaches it; which frame an iframe element shows; and page script run
// inside one of them.

/** @typedef {import("./index.js").Send} Send */
/** @typedef {import("./index.js").FrameDoc} FrameDoc */
/** @typedef {import("./index.js").FrameTree} FrameTree */

export const MAX_FRAMES = 40;

/**
 * The main frame first, then iframes in frame-tree order. A frame in a child session is owned by
 * that session; `targetRoot` marks the root frame of each CDP target (the page, each OOPIF).
 * @param {Send} send @returns {Promise<FrameDoc[]>}
 */
export async function frameDocuments(send) {
  /** @type {Map<string, FrameDoc>} */
  const docs = new Map();
  /** @param {FrameTree} tree @param {string | undefined} sessionId @param {string} [parentId] @param {boolean} [targetRoot] */
  const add = (tree, sessionId, parentId, targetRoot = false) => {
    if (docs.size >= MAX_FRAMES && !docs.has(tree.frame.id)) return;
    const previous = docs.get(tree.frame.id);
    docs.set(tree.frame.id, { frameId: tree.frame.id, loaderId: tree.frame.loaderId, url: tree.frame.url, mimeType: tree.frame.mimeType,
      parentId: parentId ?? tree.frame.parentId ?? previous?.parentId, sessionId: sessionId ?? previous?.sessionId,
      targetRoot: targetRoot || Boolean(previous?.targetRoot) });
    for (const child of tree.childFrames ?? []) add(child, sessionId, tree.frame.id);
  };
  add((await send("Page.getFrameTree")).frameTree, undefined, undefined, true);
  for (const sessionId of await send.iframeSessions()) {
    const tree = await send("Page.getFrameTree", {}, sessionId).catch(() => null);
    if (tree) add(tree.frameTree, sessionId, undefined, true);
  }
  return [...docs.values()];
}

/**
 * The frame an iframe element (by backend node id, in the document reached by `sessionId`) shows,
 * or null when it shows none yet.
 * @param {Send} send @param {number} backendNodeId @param {string} [sessionId] @returns {Promise<string | null>}
 */
export async function childFrameId(send, backendNodeId, sessionId) {
  const described = await send("DOM.describeNode", { backendNodeId }, sessionId).catch(() => null);
  return described?.node?.frameId ?? described?.node?.contentDocument?.frameId ?? null;
}

/**
 * A remote object for the frame's `document` in the page's own (main) world, so script sees what
 * the page's scripts assigned (an `onclick` property, for example) — or, with `worldName`, in that
 * isolated world of the frame, where the page's scripts cannot see or change what runs. The object
 * joins `objectGroup` when one is given. Null when the frame is gone.
 * @param {Send} send @param {FrameDoc} frame @param {{ worldName?: string, objectGroup?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function frameDocumentObject(send, frame, { worldName, objectGroup } = {}) {
  const group = objectGroup ? { objectGroup } : {};
  if (worldName || frame.targetRoot) {
    /** @type {number | undefined} */
    let contextId;
    if (worldName) {
      const world = await send("Page.createIsolatedWorld", { frameId: frame.frameId, worldName }, frame.sessionId).catch(() => null);
      if (!world?.executionContextId) return null;
      contextId = world.executionContextId;
    }
    const result = await send("Runtime.evaluate", { expression: "document", returnByValue: false, ...group, ...(contextId ? { contextId } : {}) }, frame.sessionId).catch(() => null);
    return !result || result.exceptionDetails ? null : result.result?.objectId ?? null;
  }
  // A same-process iframe: its owner element's content document, resolved in the default world.
  const owner = await send("DOM.getFrameOwner", { frameId: frame.frameId }, frame.sessionId).catch(() => null);
  if (!owner?.backendNodeId) return null;
  const described = await send("DOM.describeNode", { backendNodeId: owner.backendNodeId, depth: 1 }, frame.sessionId).catch(() => null);
  const documentNode = described?.node?.contentDocument?.backendNodeId;
  if (!documentNode) return null;
  const resolved = await send("DOM.resolveNode", { backendNodeId: documentNode, ...group }, frame.sessionId).catch(() => null);
  return resolved?.object?.objectId ?? null;
}

/**
 * Evaluates an expression in a frame: the main frame's page world, or an isolated world of an
 * iframe (the page's own scripts cannot see or change it). Returns null when the frame is gone.
 * @template T
 * @param {Send} send @param {FrameDoc} frame @param {boolean} isMain @param {string} expression @param {string} [worldName]
 * @returns {Promise<T | null>}
 */
export async function evaluateInFrame(send, frame, isMain, expression, worldName = "browser-core-read") {
  /** @type {number | undefined} */
  let contextId;
  if (!isMain) {
    const world = await send("Page.createIsolatedWorld", { frameId: frame.frameId, worldName }, frame.sessionId).catch(() => null);
    if (!world) return null;
    contextId = world.executionContextId;
  }
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, ...(contextId ? { contextId } : {}) }, frame.sessionId).catch(() => null);
  return !result || result.exceptionDetails ? null : result.result?.value ?? null;
}
