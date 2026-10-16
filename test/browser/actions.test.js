import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentTab, describeOpenedTabs, isPdfViewer, prepareInput, sameDocument, scrollPage, selectOptions, SELECT_OPTIONS, watchOpenedTabs,
} from "../../src/browser/index.js";
import { eventSource, fakeSend } from "./fake-cdp.js";

const noSleep = async () => {};

test("scroll: the document moves by script; an inner scroller or the PDF viewer gets a wheel", async () => {
  const moved = fakeSend({ "Runtime.evaluate": () => ({ result: { value: { deltaX: 0, deltaY: 480, scrollX: 0, scrollY: 480, scrollHeight: 2000, viewportHeight: 600 } } }) });
  assert.equal((await scrollPage(moved.send, { dy: 480, sleep: noSleep })).method, "script");
  assert.ok(!moved.sent.some(item => item.method === "Input.dispatchMouseEvent"));
  // A dialog's list that moved instead of the document is named, with its own position and size.
  const dialog = fakeSend({ "Runtime.evaluate": () => ({ result: { value: { deltaX: 0, deltaY: 520, scrollX: 0, scrollY: 520, scrollHeight: 2800, viewportHeight: 650, scroller: 'div in dialog "List members"' } } }) });
  assert.deepEqual(await scrollPage(dialog.send, { dy: 900, screen: 0.8, sleep: noSleep }),
    { method: "script", scrollX: 0, scrollY: 520, deltaY: 520, scrollHeight: 2800, viewportHeight: 650, scroller: 'div in dialog "List members"' });

  let y = 0;
  const stuck = fakeSend({
    "Runtime.evaluate": params => params.awaitPromise ? { result: { value: { deltaX: 0, deltaY: 0 } } } : { result: { value: [0, y, 2000, 600] } },
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }),
    "Input.dispatchMouseEvent": () => { y = 300; return {}; },
  });
  const wheel = await scrollPage(stuck.send, { dy: 480, sleep: noSleep });
  assert.deepEqual([wheel.method, wheel.deltaY], ["wheel", 300]);
  assert.deepEqual(stuck.sent.find(item => item.method === "Input.dispatchMouseEvent")?.params, { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 480 });

  const pdf = fakeSend({ "Page.getLayoutMetrics": () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }),
    "Runtime.evaluate": () => ({ result: { value: [0, 0, 0, 0] } }) });
  await scrollPage(pdf.send, { dy: 100, wheel: true, sleep: noSleep });
  assert.ok(!pdf.sent.some(item => item.params?.awaitPromise));
});

test("select: matches by value or text, fires input then change; a non-select and a missing option are refused", async () => {
  /** @type {string[]} */
  const events = [];
  const options = [{ value: "de", textContent: " Germany ", selected: false }, { value: "fr", textContent: "France", selected: false }];
  const select = { options, dispatchEvent: (/** @type {Event} */ event) => events.push(event.type) };
  const run = new Function(`return ${SELECT_OPTIONS}`)();
  assert.deepEqual(run.call(select, ["Germany"]), { matched: 1, chosen: ["Germany"] });
  assert.deepEqual(events, ["input", "change"]);
  assert.match(run.call(select, ["Spain"]).error, /Available options: de \("Germany"\), fr \("France"\)/);

  const notSelect = fakeSend({ "DOM.resolveNode": () => ({ object: { objectId: "o" } }), "Runtime.callFunctionOn": () => ({ result: { value: false } }) });
  await assert.rejects(selectOptions(notSelect.send, 1, ["x"]), { code: "TARGET_NOT_SELECT" });
  let call = 0;
  const missing = fakeSend({ "DOM.resolveNode": () => ({ object: { objectId: "o" } }),
    "Runtime.callFunctionOn": () => (++call === 1 ? { result: { value: true } } : { result: { value: { error: "No option matched" } } }) });
  await assert.rejects(selectOptions(missing.send, 1, ["x"]), { code: "OPTION_NOT_FOUND" });
  assert.equal(missing.sent.filter(item => item.method === "Runtime.releaseObject").length, 1);
});

function tabsApi() {
  /** @type {Record<string, unknown>} */
  const session = {};
  const created = [];
  /** @type {any[]} */
  const groups = [];
  let nextTab = 10, nextWindow = 100;
  const api = /** @type {any} */ ({
    storage: { session: { get: async (/** @type {string} */ key) => ({ [key]: session[key] }), set: async (/** @type {any} */ values) => Object.assign(session, values) } },
    windows: {
      create: async (/** @type {any} */ options) => { const id = nextWindow++; created.push({ window: id, ...options }); return { id, type: "normal", tabs: [{ id: nextTab++, windowId: id, url: options.url }] }; },
      get: async (/** @type {number} */ id) => { if (!created.some(item => item.window === id)) throw new Error("no window"); return { id, type: "normal" }; },
    },
    tabs: {
      onCreated: eventSource(),
      create: async (/** @type {any} */ options) => { const tab = { id: nextTab++, ...options }; created.push(tab); return tab; },
      group: async (/** @type {any} */ options) => { if (options.groupId) return options.groupId; groups.push({ id: 1, windowId: options.createProperties.windowId, title: "" }); return 1; },
      get: async (/** @type {number} */ id) => ({ id, status: "complete", title: "New", url: "https://n.example/" }),
    },
    tabGroups: {
      query: async (/** @type {any} */ filter) => groups.filter(group => filter.windowId === undefined || group.windowId === filter.windowId),
      update: async (/** @type {number} */ id, /** @type {any} */ values) => Object.assign(groups.find(group => group.id === id), values),
    },
  });
  return { api, created, groups, session };
}

test("agent tabs: one unfocused window, reused, grouped under the configured title", async () => {
  const { api, created, groups, session } = tabsApi();
  const config = { storageKey: "agentWindow", groupTitle: "Agent", groupColor: /** @type {const} */ ("green") };
  const first = await createAgentTab(api, { url: "https://a.example/" }, config);
  const second = await createAgentTab(api, { url: "https://b.example/" }, config);
  assert.equal(created.filter(item => item.focused === false).length, 1);
  assert.equal(second.windowId, first.windowId);
  assert.equal(session.agentWindow, first.windowId);
  assert.deepEqual(groups.map(group => [group.title, group.color]), [["Agent", "green"]]);
});

test("agent tabs: with a user window, the tab opens there after its active tab, no agent window, no group, no focus", async () => {
  const { api, created, groups, session } = tabsApi();
  api.tabs.query = async (/** @type {any} */ filter) => filter.windowId === 7 && filter.active ? [{ id: 3, index: 2, windowId: 7, active: true }] : [];
  const tab = await createAgentTab(api, { url: "https://a.example/", active: false, windowId: 7 }, { storageKey: "w", groupTitle: "Agent" });
  assert.deepEqual(created, [{ id: tab.id, windowId: 7, url: "https://a.example/", active: false, index: 3, openerTabId: 3 }]);
  assert.equal(created.some(item => "focused" in item), false);
  assert.deepEqual([groups.length, session.w], [0, undefined]);
});

test("agent tabs: without a remembered window, a window holding the agent's legacy group is adopted and retitled", async () => {
  const { api, created, groups, session } = tabsApi();
  created.push({ window: 55 });
  groups.push({ id: 9, windowId: 55, title: "Old" });
  await createAgentTab(api, { url: "https://a.example/" }, { storageKey: "w", groupTitle: "New", legacyGroupTitles: ["Old"] });
  assert.equal(session.w, 55);
  assert.equal(groups[0].title, "New");
});

test("opened tabs: any tab born during the action is reported once loaded", async () => {
  const { api } = tabsApi();
  const watch = watchOpenedTabs(api, noSleep);
  api.tabs.onCreated.emit({ id: 77, incognito: false });
  api.tabs.onCreated.emit({ id: 78, incognito: true });
  const tabs = await watch.stop();
  assert.deepEqual(tabs.map(tab => tab.id), [77]);
  assert.match(describeOpenedTabs(tabs), /Opened new tab tabId=77 "New" https:\/\/n\.example\//);
  assert.equal(api.tabs.onCreated.size, 0);
});

test("PDF viewer and same-document arrival", async () => {
  assert.equal(await isPdfViewer(fakeSend({ "Page.getFrameTree": () => ({ frameTree: { frame: { mimeType: "application/pdf" } } }) }).send), true);
  assert.equal(sameDocument("https://a.example/x.pdf#page=2", "https://a.example/x.pdf"), true);
  assert.equal(sameDocument("https://a.example/y.pdf", "https://a.example/x.pdf"), false);
});

test("input preparation: activates a background tab, emulates focus once, and reports what the page said", async () => {
  /** @type {any[]} */
  const updates = [];
  const api = /** @type {any} */ ({ tabs: { update: async (/** @type {number} */ id, /** @type {any} */ props) => { updates.push([id, props]); } } });
  const states = ["hidden", "hidden", "visible"];
  const waking = fakeSend({ "Runtime.evaluate": () => ({ result: { value: states.shift() } }) });
  assert.deepEqual(await prepareInput(api, /** @type {any} */ ({ id: 4, active: false }), waking.send, noSleep), { visibility: "visible", focusEmulation: true });
  assert.deepEqual(updates, [[4, { active: true }]]);

  // Focus already emulated on this attachment; the page stays hidden past the bound and says so.
  const hidden = fakeSend({ "Runtime.evaluate": () => ({ result: { value: "hidden" } }) });
  assert.deepEqual(await prepareInput(api, /** @type {any} */ ({ id: 4, active: true }), hidden.send, noSleep, { emulateFocus: false, settleMs: 100 }),
    { visibility: "hidden", focusEmulation: false });
  assert.ok(!hidden.sent.some(item => item.method === "Emulation.setFocusEmulationEnabled"));
  assert.equal(hidden.sent.length, 3);

  // A probe that never answers is unknown, not hidden.
  const stalled = fakeSend({ "Runtime.evaluate": () => new Promise(() => {}), "Emulation.setFocusEmulationEnabled": () => new Error("no") });
  assert.deepEqual(await prepareInput(api, /** @type {any} */ ({ id: 4, active: true }), stalled.send, noSleep, { probeMs: 5 }), { visibility: null, focusEmulation: false });
});
