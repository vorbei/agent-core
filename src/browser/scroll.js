// Scrolling the page: what a person's wheel would move scrolls by script (the document, or the
// open dialog's list when the document is scroll-locked) and the settled position is read back;
// a page where nothing could be moved by script, or Chrome's PDF viewer, gets a mouse wheel at the
// viewport's center instead.
import { observeScroll } from "./page-scripts.js";

/** @typedef {import("./index.js").Send} Send */

/**
 * @param {Send} send
 * @param {{ dy: number, dx?: number, screen?: number, wheel?: boolean, sleep?: (ms: number) => Promise<void> }} options
 *   `screen`: an element that scrolls instead of the document moves this fraction of its own size
 *   (observeScroll). `wheel`: skip the script scroll (the PDF viewer). `sleep` waits after a wheel event.
 * @returns {Promise<{ method: "script" | "wheel", scrollX: number, scrollY: number, deltaY: number, scrollHeight: number, viewportHeight: number, scroller?: string }>}
 *   With `scroller`, the position and sizes are that element's, not the document's.
 */
export async function scrollPage(send, { dy, dx = 0, screen = 0, wheel = false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!wheel) {
    const result = await send("Runtime.evaluate", { expression: `(${observeScroll}).call(window, ${Number(dx)}, ${Number(dy)}, ${Number(screen)})`,
      returnByValue: true, awaitPromise: true });
    const value = result.exceptionDetails ? null : result.result?.value;
    if (value && (value.deltaY !== 0 || value.deltaX !== 0)) {
      return { method: "script", scrollX: Math.round(value.scrollX), scrollY: Math.round(value.scrollY), deltaY: Math.round(value.deltaY),
        scrollHeight: value.scrollHeight, viewportHeight: value.viewportHeight, ...(value.scroller ? { scroller: String(value.scroller) } : {}) };
    }
  }
  const metrics = await send("Page.getLayoutMetrics");
  const { clientWidth: width, clientHeight: height } = metrics.cssVisualViewport;
  const before = await position(send);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: dx, deltaY: dy });
  await sleep(300);
  const after = await position(send);
  return { method: "wheel", scrollX: after[0], scrollY: after[1], deltaY: after[1] - before[1], scrollHeight: after[2], viewportHeight: after[3] };
}

/** @param {Send} send @returns {Promise<number[]>} */
async function position(send) {
  const result = await send("Runtime.evaluate", { expression: "[Math.round(scrollX), Math.round(scrollY), document.documentElement.scrollHeight, innerHeight]", returnByValue: true });
  return result.result?.value ?? [0, 0, 0, 0];
}
