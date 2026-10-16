// Where a click on a control lands, and whether that point hits the control or something on top
// of it (a cookie banner, an open menu's backdrop) — checked before any input is sent, so an
// occluded click is reported instead of landing on the overlay.
import { BrowserCoreError } from "./errors.js";
import { HIT_TEST } from "./page-scripts.js";

/** @typedef {import("./index.js").Send} Send */
/** @typedef {import("./index.js").HitResult} HitResult */

/**
 * The center of a box-model quad: the middle of the border quad's bounding box, or (`content`) the
 * mean of the content quad's corners (agent-browser's box_model_center for refs). A box with zero
 * area is refused in both modes (TARGET_NOT_VISIBLE), never replaced by another box: a content
 * box with no area means nothing of the control's content is rendered there, and a point taken
 * from a different box than the one the caller asked for would be a guess.
 * @param {{ content?: number[], border?: number[] } | undefined} model @param {boolean} [content]
 */
export function boxCenter(model, content = false) {
  const quad = content ? model?.content : model?.border || model?.content;
  if (!Array.isArray(quad) || quad.length !== 8 || quad.some(value => !Number.isFinite(value))) {
    throw new BrowserCoreError("TARGET_NOT_VISIBLE", "The control has no usable box (it is not rendered)");
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  if (right <= left || bottom <= top) throw new BrowserCoreError("TARGET_NOT_VISIBLE", "The control has zero area");
  if (content) return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/**
 * Scrolls the node into view and returns its center (of the border box, or of the content box),
 * in the coordinates of the session's viewport.
 * @param {Send} send @param {number} backendNodeId @param {string} [sessionId] @param {{ content?: boolean }} [options]
 */
export async function nodeClickPoint(send, backendNodeId, sessionId, { content = false } = {}) {
  const before = await send("DOM.getBoxModel", { backendNodeId }, sessionId).catch(() => null);
  await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
  const box = await send("DOM.getBoxModel", { backendNodeId }, sessionId);
  const point = boxCenter(box?.model, content);
  let prior = null;
  try { prior = before?.model ? boxCenter(before.model, content) : null; } catch { /* it had no box before the scroll */ }
  if (prior && samePoint(prior, point)) return point;
  // The page scrolled. Input is routed by the compositor, which can lag the scroll the page
  // already reports: measured in Chrome, a click sent at once can land at the pre-scroll spot.
  // Wait for one frame or 50 ms, whichever comes first, then measure again. A hidden page (a
  // background or occluded window) does not wait at all: its frames and timers are throttled to
  // about a second, and nothing is being composited there anyway.
  await send("Runtime.evaluate", { expression: FRAME_SETTLED, awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
  return boxCenter((await send("DOM.getBoxModel", { backendNodeId }, sessionId))?.model, content);
}

const FRAME_SETTLED = "new Promise(resolve => { if (document.visibilityState !== 'visible') return resolve(false); const done = () => resolve(true); setTimeout(done, 50); requestAnimationFrame(done); })";
const samePoint = (/** @type {{ x: number, y: number }} */ a, /** @type {{ x: number, y: number }} */ b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/**
 * Whether input at `point` reaches the node. `local`: the point is in a cross-process iframe's
 * own viewport (its session). `crossOrigin`: the embedding chain cannot be read from the page.
 * @param {Send} send @param {number} backendNodeId @param {{ x: number, y: number }} point
 * @param {{ sessionId?: string, crossOrigin?: boolean, content?: boolean, local?: boolean }} [options]
 * @returns {Promise<HitResult>}
 */
export async function hitTest(send, backendNodeId, point, { sessionId, crossOrigin = false, content = false, local = Boolean(sessionId) } = {}) {
  const resolved = await send("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new BrowserCoreError("TARGET_STALE", "The click target is no longer available");
  try {
    const hit = await send("Runtime.callFunctionOn", { objectId, functionDeclaration: HIT_TEST, returnByValue: true,
      arguments: [{ value: point.x }, { value: point.y }, { value: crossOrigin }, { value: content }, { value: local }] }, sessionId);
    if (!hit.exceptionDetails && hit.result?.value === true) return { hit: true };
    const value = hit.result?.value;
    return { hit: false, covering: value?.covering ?? null, ...(value?.popup ? { popup: value.popup } : {}), ...(value?.retry ? { retry: true } : {}) };
  } finally { await send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {}); }
}

/**
 * The hit test, with one recovery from what scrolling the target into view does to the page. A
 * miss the page script marks `retry` (the point reaches an ancestor of the target, or a sticky or
 * fixed bar of the target's own layer) re-centres the target in its scroll containers once, then
 * measures and tests again every 50 ms until it hits or `timeoutMs` of waiting passes. Live 2026-10-10 on X's List
 * members dialog: X sets pointer-events:none on the list's cells for about 150 ms after every
 * scroll, so a click right after the executor scrolled a row into view hit the timeline behind
 * it. Input is never sent on a miss: the result is the last test's, with the point it was taken
 * at, and the caller dispatches there or reports what still covers the target.
 * @param {Send} send @param {number} backendNodeId @param {{ x: number, y: number }} point
 * @param {{ sessionId?: string, crossOrigin?: boolean, content?: boolean, local?: boolean, timeoutMs?: number,
 *   measure?: () => Promise<{ x: number, y: number }>, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<HitResult & { point: { x: number, y: number } }>}
 */
export async function settledHitTest(send, backendNodeId, point, options = {}) {
  const { sessionId, content = false, timeoutMs = 800, sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  const measure = options.measure || (async () => boxCenter((await send("DOM.getBoxModel", { backendNodeId }, sessionId))?.model, content));
  let hit = await hitTest(send, backendNodeId, point, options);
  // Without the embedding chain the page script tests the target's own center, not this point.
  if (hit.hit || !hit.retry || options.crossOrigin) return { ...hit, point };
  const resolved = await send("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw new BrowserCoreError("TARGET_STALE", "The click target is no longer available");
  try {
    await send("Runtime.callFunctionOn", { objectId, returnByValue: true,
      functionDeclaration: "function() { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }" }, sessionId);
  } finally { await send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {}); }
  for (let waited = 0; waited < timeoutMs && (waited === 0 || (!hit.hit && hit.retry)); waited += 50) {
    await sleep(50);
    point = await measure();
    hit = await hitTest(send, backendNodeId, point, options);
  }
  return { ...hit, point };
}

/**
 * The model-facing sentence for a click point that does not hit its target.
 * @param {HitResult} result
 */
export function obscuredMessage(result) {
  const { covering, popup } = result;
  const by = covering ? ` It is covered by <${covering.tag}${covering.role ? ` role=${covering.role}` : ""}>${covering.name ? ` "${covering.name}"` : ""}: close an open menu or dialog, or target a visible part of the element.` : "";
  const open = popup ? ` An open ${popup.role}${popup.name ? ` "${popup.name}"` : ""} is over the page; act inside it or close it first.` : "";
  return `The click point no longer hits the observed target; inspect the overlay or refresh the target.${by}${open}`;
}
