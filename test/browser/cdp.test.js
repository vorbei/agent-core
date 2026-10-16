import { test } from "node:test";
import assert from "node:assert/strict";
import { withTab, BrowserCoreError } from "../../src/browser/index.js";
import { eventSource } from "./fake-cdp.js";

function fakeChrome({ fail } = /** @type {{ fail?: (method: string, target: any) => Error | null }} */ ({})) {
  const onEvent = eventSource(), onDetach = eventSource(), onRemoved = eventSource();
  /** @type {{ target: any, method: string, params: any }[]} */
  const sent = [];
  let attaches = 0, detaches = 0;
  const api = {
    debugger: {
      onEvent, onDetach,
      attach: async () => { attaches++; },
      detach: async () => { detaches++; },
      sendCommand: async (/** @type {any} */ target, /** @type {string} */ method, /** @type {any} */ params) => {
        sent.push({ target, method, params });
        const error = fail?.(method, target);
        if (error) throw error;
        if (method === "Target.setAutoAttach" && !target.sessionId) {
          onEvent.emit({ tabId: target.tabId }, "Target.attachedToTarget", { sessionId: "s1", targetInfo: { type: "iframe" } });
        }
        if (method === "Target.setAutoAttach" && target.sessionId === "s1") {
          onEvent.emit({ tabId: target.tabId }, "Target.attachedToTarget", { sessionId: "s2", targetInfo: { type: "iframe" } });
        }
        return { ok: method };
      },
    },
    tabs: { onRemoved },
  };
  return { api: /** @type {any} */ (api), sent, counts: () => ({ attaches, detaches }), onDetach };
}

test("a tab is attached once and its commands reach the root or a child session", async () => {
  const chrome = fakeChrome();
  await withTab(chrome.api, 7, async send => {
    assert.deepEqual(await send("Page.getFrameTree"), { ok: "Page.getFrameTree" });
    // Nested cross-process iframes attach through their parent's session.
    assert.deepEqual((await send.iframeSessions()).sort(), ["s1", "s2"]);
    await send("Accessibility.getFullAXTree", {}, "s2");
  });
  await withTab(chrome.api, 7, async send => send("DOM.enable"));
  assert.equal(chrome.counts().attaches, 1);
  assert.deepEqual(chrome.sent.find(item => item.method === "Accessibility.getFullAXTree")?.target, { tabId: 7, sessionId: "s2" });
});

test("calls on one tab never interleave", async () => {
  const chrome = fakeChrome();
  /** @type {string[]} */
  const order = [];
  await Promise.all([
    withTab(chrome.api, 1, async () => { order.push("a1"); await new Promise(resolve => setTimeout(resolve, 20)); order.push("a2"); }),
    withTab(chrome.api, 1, async () => { order.push("b1"); }),
  ]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
});

test("a method outside the allowlist is refused before it is sent", async () => {
  const chrome = fakeChrome();
  await assert.rejects(withTab(chrome.api, 1, send => send("Network.getCookies"), { allowedMethods: new Set(["Page.enable"]) }),
    (/** @type {BrowserCoreError} */ error) => error.code === "CDP_METHOD_BLOCKED");
  assert.equal(chrome.sent.length, 0);
});

test("a detached debugger and a vanished iframe session are reported with stable codes, never replayed", async () => {
  const chrome = fakeChrome({ fail: (method, target) => method === "Page.navigate" ? new Error("Debugger is not attached to the tab with id: 3.")
    : target.sessionId === "gone" ? new Error("No session with given id") : null });
  await assert.rejects(withTab(chrome.api, 3, send => send("Page.navigate", { url: "https://a.example/" })), { code: "BROWSER_DETACHED" });
  await assert.rejects(withTab(chrome.api, 3, send => send("DOM.enable", {}, "gone")), { code: "FRAME_GONE" });
  assert.equal(chrome.sent.filter(item => item.method === "Page.navigate").length, 1);
  // The detached connection was dropped: the next call attaches again.
  assert.equal(chrome.counts().attaches, 2);
});

test("a command that never answers times out", async () => {
  const chrome = fakeChrome();
  chrome.api.debugger.sendCommand = () => new Promise(() => {});
  await assert.rejects(withTab(chrome.api, 4, send => send("Runtime.evaluate"), { commandTimeoutMs: 20 }), { code: "BROWSER_CDP_TIMEOUT" });
});
