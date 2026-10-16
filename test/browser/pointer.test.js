import { test } from "node:test";
import assert from "node:assert/strict";
import { boxCenter, HIT_TEST, hitTest, nodeClickPoint, obscuredMessage, settledHitTest } from "../../src/browser/index.js";
import { fakeSend } from "./fake-cdp.js";

const hitFunction = new Function(`return ${HIT_TEST}`)();

/** A document whose elementFromPoint returns `top`, and a target in it. */
function page(/** @type {(target: any) => any} */ topFor, { framed = false } = {}) {
  const win = /** @type {any} */ ({ frameElement: null });
  win.top = framed ? {} : win;
  win.parent = win.top;
  const doc = { defaultView: win, elementFromPoint: () => topFor(target), querySelectorAll: () => [] };
  const target = /** @type {any} */ ({ isConnected: true, ownerDocument: doc, parentNode: null, getRootNode: () => doc,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }) });
  return target;
}
const banner = { tagName: "DIV", parentNode: null, getAttribute: (/** @type {string} */ name) => name === "aria-label" ? "Accept cookies" : null,
  closest: () => null };

test("the hit test accepts the target and names what covers it", () => {
  assert.equal(hitFunction.call(page(target => target), 10, 10, false, false, false), true);
  const covered = hitFunction.call(page(() => banner), 10, 10, false, false, false);
  assert.deepEqual(covered, { covering: { tag: "div", role: null, name: "Accept cookies" } });
  assert.match(obscuredMessage({ hit: false, ...covered }), /covered by <div> "Accept cookies"/);
});

test("in a frame whose embedder cannot be read, the target's own center is tested instead of root coordinates", () => {
  /** @type {number[][]} */
  const points = [];
  const target = page(t => t, { framed: true });
  target.ownerDocument.elementFromPoint = (/** @type {number} */ x, /** @type {number} */ y) => { points.push([x, y]); return target; };
  assert.equal(hitFunction.call(target, 500, 400, false, false, false), true);
  assert.deepEqual(points, [[10, 10]]);
  // A cross-process iframe's own session gives local points: used as they are.
  points.length = 0;
  assert.equal(hitFunction.call(target, 5, 6, false, false, true), true);
  assert.deepEqual(points, [[5, 6]]);
});

test("hitTest resolves the node in the frame's session and releases it", async () => {
  const { send, sent } = fakeSend({
    "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: { covering: { tag: "div", role: "dialog", name: "Sign in" } } } }),
  });
  const result = await hitTest(send, 5, { x: 1, y: 2 }, { sessionId: "s1" });
  assert.equal(result.hit, false);
  assert.deepEqual(sent.map(item => [item.method, item.sessionId]), [["DOM.resolveNode", "s1"], ["Runtime.callFunctionOn", "s1"], ["Runtime.releaseObject", "s1"]]);
  // A session means local coordinates.
  assert.equal(sent[1].params.arguments[4].value, true);
});

test("click point: the scrolled-into-view border box center; an unrendered box is refused", async () => {
  const { send, sent } = fakeSend({ "DOM.getBoxModel": () => ({ model: { border: [0, 0, 10, 0, 10, 20, 0, 20], content: [1, 1, 9, 1, 9, 19, 1, 19] } }) });
  assert.deepEqual(await nodeClickPoint(send, 3), { x: 5, y: 10 });
  // Nothing moved: no wait for frames.
  assert.ok(!sent.some(item => item.method === "Runtime.evaluate"));

  // The scroll moved the node: wait for frames, then measure where it is now.
  let y = 900;
  const scrolled = fakeSend({
    "DOM.getBoxModel": () => ({ model: { border: [0, y, 10, y, 10, y + 20, 0, y + 20] } }),
    "DOM.scrollIntoViewIfNeeded": () => { y = 100; return {}; },
    "Runtime.evaluate": () => { y = 120; return { result: { value: true } }; },
  });
  assert.deepEqual(await nodeClickPoint(scrolled.send, 3), { x: 5, y: 130 });
  assert.deepEqual(scrolled.sent.map(item => item.method), ["DOM.getBoxModel", "DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel", "Runtime.evaluate", "DOM.getBoxModel"]);
  assert.throws(() => boxCenter({ content: [0, 0, 0, 0, 0, 0, 0, 0] }), { code: "TARGET_NOT_VISIBLE" });
});

test("box center: a zero-area box is refused in border and content mode, never replaced by the other box", () => {
  const border = [0, 0, 10, 0, 10, 20, 0, 20];
  assert.deepEqual(boxCenter({ border, content: [2, 2, 8, 2, 8, 12, 2, 12] }, true), { x: 5, y: 7 });
  assert.throws(() => boxCenter({ border, content: [5, 5, 5, 5, 5, 5, 5, 5] }, true), { code: "TARGET_NOT_VISIBLE" });
  assert.throws(() => boxCenter({ border, content: [2, 5, 8, 5, 8, 5, 2, 5] }, true), { code: "TARGET_NOT_VISIBLE" });
  assert.throws(() => boxCenter({ border: [3, 3, 3, 3, 3, 9, 3, 9] }), { code: "TARGET_NOT_VISIBLE" });
});

test("the post-scroll wait is one frame or 50 ms, and none on a hidden page", async () => {
  let y = 900;
  const scrolled = fakeSend({
    "DOM.getBoxModel": () => ({ model: { border: [0, y, 10, y, 10, y + 20, 0, y + 20] } }),
    "DOM.scrollIntoViewIfNeeded": () => { y = 100; return {}; },
  });
  await nodeClickPoint(scrolled.send, 3);
  const expression = scrolled.sent.find(item => item.method === "Runtime.evaluate")?.params.expression;
  const run = (/** @type {string} */ visibilityState, /** @type {(fn: () => void) => void} */ raf, /** @type {number[]} */ timers) =>
    new Function("document", "requestAnimationFrame", "setTimeout", `return ${expression}`)({ visibilityState }, raf,
      (/** @type {() => void} */ fn, /** @type {number} */ ms) => { timers.push(ms); if (ms <= 50) setImmediate(fn); });
  /** @type {number[]} */
  const timers = [];
  assert.equal(await run("hidden", () => assert.fail("no frame wait on a hidden page"), timers), false);
  assert.deepEqual(timers, []);
  assert.equal(await run("visible", fn => fn(), timers), true);
  assert.equal(await run("visible", () => {}, timers), true, "a frame that never comes ends at the timer");
  assert.ok(timers.every(ms => ms <= 50));
});

/** An element with a computed position, a box, and a parent chain; `closest` finds a layer by flag. */
function element(/** @type {Record<string, any>} */ props = {}) {
  /** @type {any} */
  const el = { nodeType: 1, tagName: "DIV", parentNode: null, parentElement: null, position: "static", layer: false,
    rect: { x: 0, y: 0, width: 600, height: 53 }, ...props,
    getAttribute: (/** @type {string} */ name) => name === "aria-label" ? el.label ?? null : name === "role" ? el.role ?? null : null,
    getBoundingClientRect: () => el.rect,
    contains: (/** @type {any} */ other) => { for (let node = other; node; node = node.parentNode) if (node === el) return true; return false; },
    matches: () => el.layer,
    closest: () => { for (let node = el; node; node = node.parentNode) if (node.layer) return node; return null; } };
  return el;
}
const adopt = (/** @type {any} */ parent, /** @type {any} */ child) => { child.parentNode = parent; child.parentElement = parent; return child; };

/** A target inside a dialog's scroll list, and a document whose elementFromPoint returns `at.top`. */
function dialogPage() {
  const dialog = element({ layer: true, role: "dialog", label: "List members", rect: { x: 0, y: 0, width: 600, height: 650 } });
  const timeline = adopt(dialog, element({ label: "Timeline: List members", rect: { x: 0, y: 53, width: 600, height: 3000 } }));
  const target = adopt(adopt(timeline, element()), element({ tagName: "BUTTON", isConnected: true }));
  const at = { top: target };
  const win = /** @type {any} */ ({ frameElement: null, innerHeight: 1400, getComputedStyle: (/** @type {any} */ el) => ({ position: el.position }) });
  win.top = win; win.parent = win;
  const doc = { defaultView: win, elementFromPoint: () => at.top, querySelectorAll: () => [] };
  for (const el of [dialog, timeline, target, target.parentNode]) { el.ownerDocument = doc; el.getRootNode = () => doc; }
  return { dialog, timeline, target, at };
}

test("a miss that scrolling caused is marked for retry; an overlay, a menu or a mask is not", () => {
  const { dialog, timeline, target, at } = dialogPage();
  // X's list cells take no pointer events while they scroll: the point reaches the timeline, an ancestor.
  at.top = timeline;
  assert.equal(hitFunction.call(target, 10, 10, false, false, false).retry, true);
  // The dialog's sticky header over a row at the top edge of its list.
  at.top = adopt(dialog, element({ position: "sticky", label: "List members" }));
  assert.equal(hitFunction.call(target, 10, 10, false, false, false).retry, true);
  // A full-page mask or a menu on top is what it is: no retry.
  at.top = element({ position: "fixed", rect: { x: 0, y: 0, width: 1400, height: 1400 } });
  assert.equal(hitFunction.call(target, 10, 10, false, false, false).retry, undefined);
  at.top = element({ position: "fixed", layer: true, role: "menu", rect: { x: 0, y: 0, width: 200, height: 200 } });
  assert.equal(hitFunction.call(target, 10, 10, false, false, false).retry, undefined);
  // Another row on top (a popover in the list) is not scrolling's doing either.
  at.top = adopt(timeline, element());
  assert.equal(hitFunction.call(target, 10, 10, false, false, false).retry, undefined);
});

test("a retryable miss is re-centred once and tested until it hits; no input is sent, the new point is returned", async () => {
  let tests = 0;
  const { send, sent } = fakeSend({
    "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
    "Runtime.callFunctionOn": params => params.functionDeclaration.includes("scrollIntoView") ? {}
      : { result: { value: ++tests < 3 ? { covering: { tag: "div", role: null, name: "Timeline: List members" }, retry: true } : true } },
    "DOM.getBoxModel": () => ({ model: { border: [0, 300, 10, 300, 10, 320, 0, 320] } }),
  });
  /** @type {number[]} */
  const waits = [];
  const result = await settledHitTest(send, 7, { x: 5, y: 40 }, { sleep: async ms => { waits.push(ms); } });
  assert.deepEqual([result.hit, result.point], [true, { x: 5, y: 310 }]);
  assert.equal(sent.filter(item => item.params?.functionDeclaration?.includes("scrollIntoView")).length, 1);
  assert.deepEqual(waits, [50, 50]);
  assert.ok(!sent.some(item => item.method.startsWith("Input.")));
});

test("a miss with nothing to wait for is reported at once; a retry that never hits ends in the honest miss", async () => {
  const covered = fakeSend({
    "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: { covering: { tag: "div", role: "dialog", name: "Sign in" } } } }),
  });
  const once = await settledHitTest(covered.send, 7, { x: 5, y: 40 }, { sleep: async () => assert.fail("no wait") });
  assert.deepEqual([once.hit, once.point, once.covering?.name], [false, { x: 5, y: 40 }, "Sign in"]);
  assert.equal(covered.sent.filter(item => item.method === "Runtime.callFunctionOn").length, 1);

  const stuck = fakeSend({
    "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
    "Runtime.callFunctionOn": params => params.functionDeclaration.includes("scrollIntoView") ? {}
      : { result: { value: { covering: { tag: "div", role: null, name: "List members" }, retry: true } } },
    "DOM.getBoxModel": () => ({ model: { border: [0, 0, 10, 0, 10, 20, 0, 20] } }),
  });
  let waited = 0;
  const last = await settledHitTest(stuck.send, 7, { x: 5, y: 40 }, { timeoutMs: 300, sleep: async ms => { waited += ms; } });
  assert.equal(last.hit, false);
  assert.match(obscuredMessage(last), /covered by <div> "List members"/);
  assert.equal(waited, 300);
});
