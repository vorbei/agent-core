import assert from "node:assert/strict";
import test from "node:test";
import { act, browserGlobals, loadChatUi } from "./dom.js";

const ui = await loadChatUi();
const AT = "2026-10-09T10:00:00.000Z";
const MORE = { label: "More", items: [{ view: "settings", label: "Settings" }, { view: "logs", label: "Logs <local>" }], note: "Product 1.0" };

function shell(options) {
  const env = browserGlobals("<html><body><aside class=\"chat-panel\"></aside></body></html>");
  const panel = env.document.querySelector("aside");
  panel.innerHTML = `${ui.panelHeaderMarkup(options)}<main class="chat-panel-main"><div class="chat-panel-view" id="chat"></div><div class="chat-panel-view" id="settings" hidden></div></main>`;
  return { ...env, panel, header: panel.querySelector(".chat-panel-header") };
}
const click = (env, element) => element.dispatchEvent(new env.window.Event("click", { bubbles: true }));

test("without an account header the Chat control leads the header and the … menu ends it with the product's views", () => {
  const env = shell({ status: "<span id=\"status\">Ready</span>", chat: { triggerId: "chats", menuId: "chat-menu" }, more: MORE });
  try {
    const [first, last] = [...env.header.children];
    assert.equal(env.header.children.length, 2);
    // The thread list's trigger is the first control, its menu opens beside it, the status follows.
    assert.equal(first.querySelector("button").id, "chats");
    assert.equal(first.querySelector("button").getAttribute("aria-haspopup"), "menu");
    assert.equal(first.querySelector("#chat-menu").parentElement.contains(first.querySelector("#chats")), true);
    assert.equal(first.lastElementChild.id, "status");
    assert.equal(last.tagName, "DETAILS");
    assert.deepEqual([...last.querySelectorAll("[data-view]")].map(item => [item.dataset.view, item.textContent]),
      [["settings", "Settings"], ["logs", "Logs <local>"]]);
    assert.equal(last.querySelector("summary").getAttribute("aria-label"), "More");
    assert.match(last.textContent, /Product 1\.0$/);
  } finally { env.restore(); }
});

test("with an account header the header reads account, Chat, then the … menu", () => {
  const env = shell({ lead: "<div id=\"account\">@me</div>", chat: { label: "Chat", triggerId: "chats", menuId: "chat-menu" }, more: MORE });
  try {
    assert.deepEqual([...env.header.children].map(child => child.id || child.className), ["account", "chat-panel-chat", "chat-panel-more"]);
  } finally { env.restore(); }
});

test("the header switches views, marks the shown one and keeps one menu open, closed outside or on Escape", () => {
  const env = shell({ chat: { triggerId: "chats", menuId: "chat-menu" }, more: MORE });
  try {
    const more = env.header.querySelector("details");
    const extra = env.document.createElement("details");
    env.header.append(extra);
    const views = [];
    const unbind = ui.bindPanelHeader(env.header, { onView: view => { views.push(view); ui.markPanelView(env.header, view); } });
    more.setAttribute("open", "");
    more.dispatchEvent(new env.window.Event("toggle"));
    click(env, env.header.querySelector("[data-view=settings] span"));
    assert.deepEqual(views, ["settings"]);
    assert.equal(more.hasAttribute("open"), false);
    assert.equal(env.header.querySelector("[data-view=settings]").getAttribute("aria-selected"), "true");
    assert.equal(env.header.querySelector("#chats").getAttribute("aria-selected"), "false");
    assert.equal(env.header.querySelector("[data-more-trigger]").classList.contains("is-active"), true);
    click(env, env.header.querySelector("#chats"));
    assert.deepEqual(views, ["settings", "chat"]);
    assert.equal(env.header.querySelector("[data-more-trigger]").classList.contains("is-active"), false);

    // Opening one menu closes the other; a pointer outside or Escape closes the open one.
    more.setAttribute("open", "");
    more.dispatchEvent(new env.window.Event("toggle"));
    extra.setAttribute("open", "");
    extra.dispatchEvent(new env.window.Event("toggle"));
    assert.equal(more.hasAttribute("open"), false);
    env.document.body.dispatchEvent(new env.window.Event("pointerdown", { bubbles: true }));
    assert.equal(extra.hasAttribute("open"), false);
    more.setAttribute("open", "");
    const escape = new env.window.Event("keydown");
    escape.key = "Escape";
    env.document.dispatchEvent(escape);
    assert.equal(more.hasAttribute("open"), false);
    unbind();
    click(env, env.header.querySelector("#chats"));
    assert.equal(views.length, 2);
  } finally { env.restore(); }
});

test("in the shell the conversation is the view's scroll container and the composer is its last part", async () => {
  const env = shell({ chat: { triggerId: "chats", menuId: "chat-menu" }, more: MORE });
  const turn = { version: "agent-turn-projection-v1", accountId: "acct", turnId: "turn_1", sessionId: "thread_1", status: "completed", phase: "done",
    progress: { label: "How it worked", items: [] }, waiting: null, finalAnswer: "Answer.", errorCode: null, createdAt: AT, updatedAt: AT, completedAt: AT, input: "Question", parentTurnId: null };
  const thread = { threadId: "thread_1", title: "Question", createdAt: AT, updatedAt: AT, latestTurnStatus: "completed" };
  const client = {
    listThreads: async () => [thread], createThread: async () => thread, listTurns: async () => ({ items: [turn], nextBefore: null }),
    submitTurn: async () => turn, stopTurn: async () => turn, retryTurn: async () => turn, subscribe(refresh) { void refresh(); return () => {}; }
  };
  try {
    let chat;
    await act(async () => {
      chat = ui.mountChat(env.panel.querySelector("#chat"), { client: () => client,
        menu: { trigger: env.panel.querySelector("#chats"), root: env.panel.querySelector("#chat-menu") } });
      chat.setAccount({ accountId: "acct" });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    // The panel is the header row, then the main area holding the views.
    assert.deepEqual([...env.panel.children].map(child => child.className), ["chat-panel-header is-chat-first", "chat-panel-main"]);
    const view = env.panel.querySelector("#chat > .chat-view");
    assert.ok(view);
    assert.equal(view.firstElementChild.className, "chat-messages");
    assert.match(view.firstElementChild.textContent, /Question[\s\S]*Answer\./);
    assert.equal(view.lastElementChild.tagName, "FORM");
    assert.equal(view.lastElementChild.className, "chat-composer");
    // The header's Chat control opens the thread list in the header's menu element.
    await act(async () => { click(env, env.panel.querySelector("#chats")); });
    assert.ok(env.panel.querySelector("#chat-menu .chat-thread-menu"));
    await act(async () => { chat.unmount(); });
  } finally { env.restore(); }
});
