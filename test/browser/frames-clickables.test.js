import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCOVER_CLICKABLES, findClickables, frameDocuments, MAX_CLICKABLES } from "../../src/browser/index.js";
import { fakeSend } from "./fake-cdp.js";

const MAIN_TREE = { frameTree: { frame: { id: "main", url: "https://a.example/", loaderId: "L0" },
  childFrames: [{ frame: { id: "same", url: "https://a.example/inner", loaderId: "L1" } }] } };

test("frame documents: main first, same-process children, then each cross-process iframe owned by its session", async () => {
  const { send } = fakeSend({
    "Page.getFrameTree@": () => MAIN_TREE,
    "Page.getFrameTree@s1": () => ({ frameTree: { frame: { id: "oop", url: "https://b.example/w", loaderId: "L2" },
      childFrames: [{ frame: { id: "nested", url: "https://b.example/n", loaderId: "L3" } }] } }),
  }, ["s1"]);
  const docs = await frameDocuments(send);
  assert.deepEqual(docs.map(doc => [doc.frameId, doc.sessionId, doc.targetRoot, doc.parentId]), [
    ["main", undefined, true, undefined], ["same", undefined, false, "main"], ["oop", "s1", true, undefined], ["nested", "s1", false, "oop"],
  ]);
});

/**
 * A main-world document and the CDP answers findClickables needs. `world` records where
 * discovery ran: a frame's own (main) world is what makes script-assigned onclick visible.
 */
function clickableFrame(/** @type {Record<string, (params: any) => any>} */ overrides = {}) {
  /** @type {string[]} */
  const worlds = [];
  const { send, sent } = fakeSend({
    "Page.createIsolatedWorld": () => ({ executionContextId: 7 }),
    "Runtime.evaluate": params => { worlds.push(params.contextId ? "isolated" : "main"); return { result: { objectId: "doc-main" } }; },
    "DOM.getFrameOwner": () => ({ backendNodeId: 40 }),
    "DOM.describeNode": params => params.backendNodeId === 40 ? { node: { contentDocument: { backendNodeId: 41 } } }
      : { node: { backendNodeId: params.objectId === "el0" ? 100 : 101 } },
    "DOM.resolveNode": params => { worlds.push(params.executionContextId ? "isolated" : "main"); return { object: { objectId: "doc-child" } }; },
    "Runtime.callFunctionOn": params => params.functionDeclaration.includes("querySelectorAll('*')") ? { result: { objectId: "list" } }
      : { result: { value: [{ text: "Pick a country", label: "Pick a country", tagName: "div", hasOnClick: true }, { text: "Card", label: "Card", tagName: "div" }] } },
    "Runtime.getProperties": () => ({ result: [{ name: "1", value: { objectId: "el1" } }, { name: "0", value: { objectId: "el0" } }, { name: "length", value: {} }] }),
    ...overrides,
  });
  return { send, sent, worlds };
}

test("clickables are found in the frame's own world, in document order, for main and same-process frames", async () => {
  const main = clickableFrame();
  const found = await findClickables(main.send, { frameId: "main", loaderId: "L0", url: "", targetRoot: true });
  assert.deepEqual(found.clickables.map(item => [item.backendNodeId, item.label]), [[100, "Pick a country"], [101, "Card"]]);
  assert.equal(found.discoveryError, null);
  const child = clickableFrame();
  await findClickables(child.send, { frameId: "same", loaderId: "L1", url: "", parentId: "main" });
  // The same-process iframe's document comes from its owner element, resolved in the default world.
  assert.ok(child.sent.some(item => item.method === "DOM.getFrameOwner"));
  assert.deepEqual([...main.worlds, ...child.worlds], ["main", "main"]);
  assert.ok(!child.sent.some(item => item.method === "Page.createIsolatedWorld"));
  // Every remote object joins one group, released in one call; no per-element release.
  const groups = new Set(child.sent.filter(item => item.params?.objectGroup).map(item => item.params.objectGroup));
  assert.equal(groups.size, 1);
  assert.equal(child.sent.filter(item => item.method === "Runtime.releaseObject").length, 0);
  assert.deepEqual(child.sent.filter(item => item.method === "Runtime.releaseObjectGroup").map(item => item.params.objectGroup), [...groups]);
  // The default bound applies when the caller passes none or an unbounded one.
  const unbounded = clickableFrame();
  await findClickables(unbounded.send, { frameId: "main", loaderId: "L0", url: "", targetRoot: true }, { max: Infinity });
  assert.deepEqual(unbounded.sent.find(item => item.params?.functionDeclaration?.includes("querySelectorAll('*')"))?.params.arguments, [{ value: MAX_CLICKABLES }]);
});

test("a selected frame's discovery can run in the consumer's isolated world", async () => {
  const frame = clickableFrame();
  const found = await findClickables(frame.send, { frameId: "same", loaderId: "L1", url: "", parentId: "main" }, { worldName: "consumer-world", max: 300 });
  assert.equal(found.clickables.length, 2);
  assert.deepEqual(frame.sent.find(item => item.method === "Page.createIsolatedWorld")?.params, { frameId: "same", worldName: "consumer-world" });
  assert.deepEqual(frame.worlds, ["isolated"]);
  assert.ok(!frame.sent.some(item => item.method === "DOM.getFrameOwner"));
});

test("a failed discovery is reported, not swallowed; a frame that is gone is not an error", async () => {
  const throwing = clickableFrame({ "Runtime.callFunctionOn": () => ({ exceptionDetails: { text: "boom" } }) });
  assert.deepEqual(await findClickables(throwing.send, { frameId: "main", loaderId: "L0", url: "", targetRoot: true }),
    { clickables: [], discoveryError: "CLICKABLE_DISCOVERY_FAILED" });
  assert.ok(throwing.sent.some(item => item.method === "Runtime.releaseObjectGroup"));
  const failing = clickableFrame({ "Runtime.getProperties": () => new Error("Cannot find context with specified id") });
  assert.equal((await findClickables(failing.send, { frameId: "main", loaderId: "L0", url: "", targetRoot: true })).discoveryError, "CLICKABLE_DISCOVERY_FAILED");
  const gone = clickableFrame({ "DOM.getFrameOwner": () => new Error("Frame with the given id was not found") });
  assert.deepEqual(await findClickables(gone.send, { frameId: "same", loaderId: "L1", url: "", parentId: "main" }), { clickables: [], discoveryError: null });
});

// A minimal DOM for the page script itself.
function element(/** @type {any} */ props) {
  return { tagName: "DIV", attributes: {}, onclick: null, parentElement: null, cursor: "auto", width: 10,
    getAttribute(/** @type {string} */ name) { return this.attributes[name] ?? null; },
    hasAttribute(/** @type {string} */ name) { return name in this.attributes; },
    closest: () => null, getBoundingClientRect() { return { width: this.width, height: 10 }; }, ...props };
}

test("discovery counts an onclick assigned by script, tabindex and own cursor:pointer, and skips inherited pointers and real controls", () => {
  const parent = element({ cursor: "pointer" });
  const elements = [
    element({ onclick: () => {} }),
    element({ attributes: { tabindex: "0" } }),
    element({ cursor: "pointer", parentElement: parent }),
    element({ cursor: "pointer" }),
    element({ tagName: "BUTTON", onclick: () => {} }),
    element({ attributes: { role: "button" }, onclick: () => {} }),
    element({ onclick: () => {}, width: 0 }),
    element({ attributes: { tabindex: "-1" } }),
  ];
  const doc = { body: { querySelectorAll: () => elements }, defaultView: { getComputedStyle: (/** @type {any} */ el) => ({ cursor: el.cursor }) } };
  const discover = new Function(`return ${DISCOVER_CLICKABLES}`)();
  assert.deepEqual(discover.call(doc, 100).map((/** @type {any} */ el) => elements.indexOf(el)), [0, 1, 3]);
  assert.equal(discover.call(doc, 2).length, 2);
});
