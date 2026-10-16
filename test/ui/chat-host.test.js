import assert from "node:assert/strict";
import test from "node:test";
import { React, act, browserGlobals, loadChatUi, renderToStaticMarkup } from "./dom.js";
import { parseHTML } from "linkedom";

const ui = await loadChatUi();
const AT = "2026-10-09T10:00:00.000Z";

function turn(turnId, over = {}) {
  return { version: "agent-turn-projection-v1", accountId: "acct", turnId, sessionId: "thread_1", status: "completed", phase: "done",
    progress: { label: "How it worked", items: [] }, waiting: null, finalAnswer: "Answer.", errorCode: null,
    createdAt: AT, updatedAt: AT, completedAt: AT, input: `Question ${turnId}`, parentTurnId: null, ...over };
}

/** A ChatClient over in-memory threads and turns that records every call. */
function fakeClient({ threads = [], turns = {}, pages = {} } = {}) {
  const calls = [];
  const state = { threads: [...threads], turns: { ...turns }, failTurns: false, selected: null, refresh: null };
  const client = {
    calls, state,
    listThreads: async ({ limit }) => { calls.push(["listThreads", limit]); return state.threads; },
    createThread: async ({ idempotencyKey }) => {
      calls.push(["createThread", idempotencyKey]);
      const thread = { threadId: `thread_${state.threads.length + 1}`, title: null, createdAt: AT, updatedAt: AT, latestTurnStatus: null };
      state.threads = [thread, ...state.threads];
      return thread;
    },
    deleteThread: async (threadId) => { calls.push(["deleteThread", threadId]); state.threads = state.threads.filter((item) => item.threadId !== threadId); },
    listTurns: async (threadId, { limit, before }) => {
      calls.push(["listTurns", threadId, before ?? null]);
      if (state.failTurns) throw new Error("NETWORK_ERROR");
      if (before) return pages[before];
      return { items: state.turns[threadId] || [], nextBefore: pages.first?.[threadId] ?? null };
    },
    submitTurn: async (input) => {
      calls.push(["submitTurn", input]);
      const running = (state.turns[input.threadId] || []).some((item) => item.status === "running");
      const queued = turn(`turn_${calls.length}`, { status: "queued", finalAnswer: null, completedAt: null, input: input.text });
      if (!running) state.turns[input.threadId] = [...(state.turns[input.threadId] || []), queued];
      return queued;
    },
    stopTurn: async (turnId) => { calls.push(["stopTurn", turnId]); return turn(turnId, { status: "cancelled", finalAnswer: null, errorCode: "TURN_CANCELLED" }); },
    retryTurn: async (turnId, key) => { calls.push(["retryTurn", turnId, key]); return turn(turnId, { status: "queued", finalAnswer: null, completedAt: null }); },
    subscribe(refresh) { state.refresh = refresh; void refresh(); return () => { state.refresh = null; }; },
    loadSelectedThread: async () => state.selected,
    saveSelectedThread: async (threadId) => { state.selected = threadId; }
  };
  return client;
}

async function mount(client, options = {}, html) {
  const env = browserGlobals(html ?? `<html><body><button id="trigger">Chats</button><div id="menu"></div><main></main></body></html>`);
  const { document } = env;
  let chat;
  await act(async () => {
    chat = ui.mountChat(document.querySelector("main"), { client: () => client,
      menu: { trigger: document.getElementById("trigger"), root: document.getElementById("menu") }, ...options });
    chat.setAccount({ accountId: "acct" });
  });
  await settle();
  const click = (element) => act(async () => { element.dispatchEvent(new env.window.Event("click", { bubbles: true })); });
  const send = async (text) => {
    await act(async () => chat.compose(text));
    await settle();
    await act(async () => { document.querySelector("form").dispatchEvent(new env.window.Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
  };
  const button = (label) => [...document.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  return { env, document, chat, click, send, button, async close() { await act(async () => chat.unmount()); env.restore(); } };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

test("a first visit creates a chat; a saved listed thread is restored instead", async () => {
  const empty = fakeClient();
  const first = await mount(empty);
  try {
    assert.equal(empty.calls.filter(([name]) => name === "createThread").length, 1);
    assert.equal(empty.state.selected, "thread_1");
    assert.match(first.document.querySelector(".chat-messages").textContent, /Ask a question/);
  } finally { await first.close(); }

  const threads = [{ threadId: "a", title: "A", createdAt: AT }, { threadId: "b", title: "B", createdAt: AT }, { threadId: "hidden", title: "H", createdAt: AT }];
  const saved = fakeClient({ threads, turns: { b: [turn("t1", { sessionId: "b" })] } });
  saved.state.selected = "hidden";
  const second = await mount(saved, { slots: { listed: (thread) => thread.threadId !== "hidden" } });
  try {
    // The saved thread is not listed by the product, so the first listed one opens.
    assert.equal(saved.state.selected, "a");
    assert.equal(saved.calls.some(([name]) => name === "createThread"), false);
  } finally { await second.close(); }
});

test("turns show the user's text, the Markdown answer, progress and a failure with its code and Retry", async () => {
  const turns = { thread_1: [
    turn("t1", { finalAnswer: "**Bold** and [a link](https://example.com) and [bad](javascript:alert(1))",
      progress: { label: "How it worked", items: [{ id: "p1", label: "Read the page", at: AT, tool: "browser" }] } }),
    turn("t2", { status: "failed", finalAnswer: null, completedAt: null, errorCode: "MODEL_HTTP_429" })
  ] };
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT }], turns });
  client.state.selected = "thread_1";
  const view = await mount(client, { slots: { wording: { assistant: "Pi", failure: (item) => `Failed (${item.status})` } } });
  try {
    const messages = view.document.querySelector(".chat-messages");
    assert.match(messages.textContent, /Question t1/);
    assert.equal(messages.querySelector("strong").textContent, "Bold");
    assert.deepEqual([...messages.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["https://example.com/"]);
    assert.match(messages.textContent, /Read the page · browser/);
    assert.match(messages.textContent, /Pi/);
    assert.match(messages.textContent, /Failed \(failed\)/);
    assert.equal(messages.querySelector(".chat-turn-error-code").textContent, "MODEL_HTTP_429");
    await view.click(view.button("Retry"));
    await settle();
    const [, turnId, key] = client.calls.find(([name]) => name === "retryTurn");
    assert.equal(turnId, "t2");
    assert.match(key, /^retry:t2:/);
  } finally { await view.close(); }
});

test("a message sent while a turn runs steers it; Stop cancels the newest active turn", async () => {
  const running = turn("t1", { status: "running", finalAnswer: null, completedAt: null, partialText: "So far I read",
    progress: { label: "Reading the page", items: [{ id: "p1", label: "Reading the page", at: AT }] } });
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT, latestTurnStatus: "running" }], turns: { thread_1: [running] } });
  client.state.selected = "thread_1";
  const view = await mount(client);
  try {
    // The answer so far is shown while the turn runs, with its progress label.
    assert.match(view.document.querySelector(".chat-messages").textContent, /So far I read/);
    assert.match(view.document.querySelector("[role=status]").textContent, /Reading the page/);
    await view.send("Also check the second page");
    const submitted = client.calls.find(([name]) => name === "submitTurn")[1];
    assert.equal(submitted.whileRunning, "steer");
    assert.equal(submitted.text, "Also check the second page");
    assert.equal(submitted.threadId, "thread_1");
    assert.match(submitted.idempotencyKey, /^chat:thread_1:/);
    // Stop cancels the newest active turn: here the steer, still queued behind the running turn.
    await view.click(view.button("Stop"));
    await settle();
    assert.deepEqual(client.calls.find(([name]) => name === "stopTurn"), ["stopTurn", "turn_4"]);
    await view.click(view.button("Stop"));
    await settle();
    assert.deepEqual(client.calls.filter(([name]) => name === "stopTurn").at(-1), ["stopTurn", "t1"]);
  } finally { await view.close(); }
});

test("a message the running turn took is marked as delivered to it and shown before the answer that replied to it", async () => {
  // Live 2026-10-10: the steer showed below the running turn's answer with no reply of its own.
  const LATER = "2026-10-09T10:01:00.000Z";
  const turns = { thread_1: [
    turn("t1", { finalAnswer: "Removed the two accounts.", completedAt: "2026-10-09T10:09:00.000Z" }),
    turn("steer", { input: "Remove the unreliable ones on X too", finalAnswer: "", createdAt: LATER, completedAt: LATER, mergedIntoTurnId: "t1" }),
    turn("t2", { status: "failed", finalAnswer: null, completedAt: null, errorCode: "MODEL_HTTP_429" }),
    turn("steer2", { input: "And the spam ones", finalAnswer: "", mergedIntoTurnId: "t2" }),
  ] };
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT }], turns });
  client.state.selected = "thread_1";
  const view = await mount(client, { slots: { wording: { steered: "Sent to the running task" } } });
  try {
    const messages = view.document.querySelector(".chat-messages");
    const text = messages.textContent;
    assert.ok(text.indexOf("Question t1") < text.indexOf("Remove the unreliable ones on X too"));
    assert.ok(text.indexOf("Remove the unreliable ones on X too") < text.indexOf("Removed the two accounts."), "the answer follows the message it replied to");
    assert.ok(text.indexOf("Removed the two accounts.") < text.indexOf("Question t2"));
    assert.equal(messages.querySelectorAll(".chat-steer-note").length, 2);
    assert.match(messages.querySelector(".chat-steer-note").textContent, /Sent to the running task/);
    // Only the turns' own messages are editable; the latest turn, failed, is retried, not the steer it took.
    assert.equal(messages.querySelectorAll(".chat-message-edit").length, 2);
    await view.click(view.button("Retry"));
    await settle();
    assert.equal(client.calls.find(([name]) => name === "retryTurn")?.[1], "t2");
  } finally { await view.close(); }
});

test("a failed refresh says the chat may be out of date, and clears once a refresh succeeds", async () => {
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT }], turns: { thread_1: [turn("t1")] } });
  client.state.selected = "thread_1";
  const view = await mount(client, { slots: { wording: { syncFailed: "Out of date." } } });
  try {
    client.state.failTurns = true;
    await act(async () => client.state.refresh());
    assert.match(view.document.querySelector(".chat-state.is-error").textContent, /Out of date/);
    assert.match(view.document.querySelector(".chat-messages").textContent, /Question t1/, "what was shown stays");
    client.state.failTurns = false;
    await act(async () => client.state.refresh());
    assert.equal(view.document.querySelector(".chat-state.is-error"), null);
  } finally { await view.close(); }
});

test("earlier turns load a page at a time above the newest page", async () => {
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT }], turns: { thread_1: [turn("t3")] },
    pages: { first: { thread_1: "t3" }, t3: { items: [turn("t1"), turn("t2")], nextBefore: null } } });
  client.state.selected = "thread_1";
  const view = await mount(client);
  try {
    await view.click(view.button("Load earlier messages"));
    await settle();
    assert.deepEqual(client.calls.filter(([name, , before]) => name === "listTurns" && before), [["listTurns", "thread_1", "t3"]]);
    const text = view.document.querySelector(".chat-messages").textContent;
    assert.ok(text.indexOf("Question t1") < text.indexOf("Question t3"));
    assert.equal(view.button("Load earlier messages"), undefined);
  } finally { await view.close(); }
});

test("the thread menu creates, selects and deletes threads; without deleteThread it offers no delete", async () => {
  const threads = [{ threadId: "a", title: "First", createdAt: AT }, { threadId: "b", title: "Second", createdAt: AT }];
  const client = fakeClient({ threads, turns: { a: [turn("ta", { input: "In A" })], b: [turn("tb", { input: "In B" })] } });
  client.state.selected = "a";
  const view = await mount(client);
  try {
    await view.click(view.document.getElementById("trigger"));
    const menu = view.document.getElementById("menu");
    assert.deepEqual([...menu.querySelectorAll(".chat-thread-label strong")].map((node) => node.textContent), ["First", "Second"]);
    await view.click([...menu.querySelectorAll("button")].find((item) => item.textContent.includes("Second")));
    await settle();
    assert.equal(client.state.selected, "b");
    assert.match(view.document.querySelector(".chat-messages").textContent, /In B/);
    await view.click(view.document.getElementById("trigger"));
    await view.click(view.button("Delete Second"));
    await settle();
    assert.deepEqual(client.calls.find(([name]) => name === "deleteThread"), ["deleteThread", "b"]);
    assert.equal(view.env.confirmations.length, 1);
    assert.equal(client.state.selected, "a", "deleting the open thread opens the next listed one");
    await view.click(view.document.getElementById("trigger"));
    await view.click(view.document.querySelector(".chat-thread-new"));
    await settle();
    assert.equal(client.state.selected, "thread_2");
  } finally { await view.close(); }

  const { deleteThread, ...noDelete } = fakeClient({ threads });
  noDelete.state.selected = "a";
  const single = await mount(noDelete);
  try {
    await single.click(single.document.getElementById("trigger"));
    assert.equal(single.document.querySelector(".chat-thread-delete"), null);
  } finally { await single.close(); }
});

test("a product's thread label titles and marks its row; other rows keep their own title", async () => {
  const threads = [{ threadId: "a", title: "First", createdAt: AT }, { threadId: "child", title: null, parent: "a", createdAt: AT }];
  const client = fakeClient({ threads });
  client.state.selected = "a";
  const slots = { threadLabel: ({ thread, threads: all }) => thread.parent
    ? { title: `${all.find((item) => item.threadId === thread.parent).title} again`, mark: React.createElement("em", { className: "mark" }, "Child") } : null };
  const view = await mount(client, { slots });
  try {
    await view.click(view.document.getElementById("trigger"));
    const rows = [...view.document.querySelectorAll("#menu .chat-thread-item")];
    assert.deepEqual(rows.map((row) => row.querySelector(".chat-thread-title strong").textContent), ["First", "First again"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".mark")?.textContent ?? null), [null, "Child"]);
    assert.ok(view.button("Delete First again"), "the delete control names the row by the same title");
  } finally { await view.close(); }
});

test("a product's read-only thread has its banner and notice and no composer; slots render above it", async () => {
  const threads = [{ threadId: "def", title: "Definition", createdAt: AT, readOnly: true }];
  const client = fakeClient({ threads });
  client.state.selected = "def";
  const slots = {
    threadView: ({ thread }) => thread.readOnly ? { readOnly: true, banner: React.createElement("p", { id: "banner" }, "Not a chat"),
      notice: React.createElement("p", { id: "notice" }, "No conversation here") } : null,
    tray: ({ readOnly }) => React.createElement("aside", { id: "tray" }, readOnly ? "read-only" : "open"),
    settings: () => React.createElement("label", { id: "setting" }, "A setting")
  };
  const view = await mount(client, { slots });
  try {
    assert.equal(view.document.querySelector(".chat-banner #banner").textContent, "Not a chat");
    assert.equal(view.document.querySelector("#notice").textContent, "No conversation here");
    assert.equal(view.document.querySelector("form"), null);
    assert.equal(view.document.querySelector("#tray").textContent, "read-only");
    assert.equal(view.document.querySelector("#setting"), null, "no composer, so no settings");
  } finally { await view.close(); }
});

// Image attachments: the browser's encoding (canvas) is replaced by a fake `prepare`; a dispatched
// paste or drop carries File objects the way Chrome's clipboard and drag data do.
const IMAGE_SLOT = { max: 2, prepare: async (file) => {
  if (file.name === "broken.png") throw new Error("IMAGE_UNREADABLE");
  return { mimeType: file.type === "image/webp" ? "image/jpeg" : file.type, data: `data-of-${file.name}`, src: `data:${file.type};base64,${file.name}` };
} };
const image = (name, type = "image/png") => new File(["bytes"], name, { type });

async function mountWithImages(slots = { images: IMAGE_SLOT }) {
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT }], turns: { thread_1: [] } });
  client.state.selected = "thread_1";
  const view = await mount(client, { slots });
  const fire = async (target, type, init) => {
    const event = new view.env.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, init);
    await act(async () => { target.dispatchEvent(event); });
    await settle();
    return event;
  };
  const paste = (files, text = "") => fire(view.document.querySelector("textarea"), "paste", { clipboardData: {
    items: [...files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), ...(text ? [{ kind: "string", type: "text/plain", getAsFile: () => null }] : [])],
    files, getData: () => text } });
  const drag = (type, files) => fire(view.document.querySelector("form"), type, { dataTransfer: { types: ["Files"], files, items: [] } });
  const thumbnails = () => [...view.document.querySelectorAll(".chat-composer-images img")].map((img) => img.getAttribute("src"));
  const notice = () => view.document.querySelector(".chat-edit-notice")?.textContent ?? "";
  return { ...view, client, paste, drag, thumbnails, notice };
}

test("a pasted image is attached with a thumbnail; pasted text is left to the box", async () => {
  const view = await mountWithImages();
  try {
    const pasted = await view.paste([image("shot.png")]);
    assert.equal(pasted.defaultPrevented, true);
    assert.deepEqual(view.thumbnails(), ["data:image/png;base64,shot.png"]);
    assert.equal(view.document.querySelector(".chat-composer-images img").getAttribute("alt"), "Image 1");
    const text = await view.paste([], "some words");
    assert.equal(text.defaultPrevented, false, "a text paste goes to the textarea as usual");
    assert.equal(view.thumbnails().length, 1);
  } finally { await view.close(); }
});

test("a dropped image is attached; the composer is outlined while files are dragged over it", async () => {
  const view = await mountWithImages();
  try {
    const entered = await view.drag("dragenter", [image("photo.webp", "image/webp")]);
    assert.equal(entered.defaultPrevented, true);
    assert.match(view.document.querySelector("form").className, /is-dragging/);
    const dropped = await view.drag("drop", [image("photo.webp", "image/webp")]);
    assert.equal(dropped.defaultPrevented, true, "the browser does not open the dropped file");
    assert.doesNotMatch(view.document.querySelector("form").className, /is-dragging/);
    assert.deepEqual(view.thumbnails(), ["data:image/webp;base64,photo.webp"]);
  } finally { await view.close(); }
});

test("other files, GIFs, unreadable images and images past the limit are refused with a notice", async () => {
  const view = await mountWithImages();
  try {
    await view.drag("drop", [new File(["%PDF"], "paper.pdf", { type: "application/pdf" })]);
    assert.deepEqual(view.thumbnails(), []);
    assert.match(view.notice(), /Only PNG, JPEG or WebP/);
    await view.paste([image("loop.gif", "image/gif")]);
    assert.deepEqual(view.thumbnails(), []);
    assert.match(view.notice(), /Only PNG, JPEG or WebP/);
    await view.paste([image("broken.png")]);
    assert.match(view.notice(), /could not be read/);
    await view.click(view.button("Dismiss"));
    assert.equal(view.notice(), "");
    await view.paste([image("a.png"), image("b.png"), image("c.png")]);
    assert.equal(view.thumbnails().length, 2);
    assert.match(view.notice(), /Up to 2 images per message/);
  } finally { await view.close(); }
});

test("an attached image is removed with its button, which is a keyboard-reachable control", async () => {
  const view = await mountWithImages();
  try {
    await view.paste([image("a.png"), image("b.png")]);
    const remove = view.button("Remove image 1");
    assert.equal(remove.tagName, "BUTTON");
    assert.equal(remove.getAttribute("type"), "button");
    let focused = false;
    view.document.querySelector("textarea").focus = () => { focused = true; };
    await view.click(remove);
    assert.deepEqual(view.thumbnails(), ["data:image/png;base64,b.png"]);
    assert.equal(focused, true, "focus returns to the message box");
  } finally { await view.close(); }
});

test("sending carries the images (text optional) and the sent bubble shows them; a failed send keeps them", async () => {
  const view = await mountWithImages();
  try {
    await view.paste([image("a.png")]);
    const send = view.document.querySelector("button[type=submit]");
    assert.equal(send.disabled, false, "images alone can be sent");
    await act(async () => { view.document.querySelector("form").dispatchEvent(new view.env.window.Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    const submitted = view.client.calls.find(([name]) => name === "submitTurn")[1];
    assert.equal(submitted.text, "");
    assert.deepEqual(submitted.images, [{ mimeType: "image/png", data: "data-of-a.png" }]);
    assert.deepEqual(view.thumbnails(), [], "the composer is empty after sending");
    const bubble = view.document.querySelector(".chat-message.is-user .chat-message-images a");
    assert.equal(bubble.getAttribute("href"), "data:image/png;base64,a.png");
    assert.equal(bubble.getAttribute("target"), "_blank");

    view.client.submitTurn = async () => { throw new Error("MODEL_IMAGE_INPUT_UNSUPPORTED"); };
    await view.paste([image("b.png")]);
    await view.send("What is this?");
    assert.deepEqual(view.thumbnails(), ["data:image/png;base64,b.png"], "the image waits in the composer again");
    assert.equal(view.document.querySelector("textarea").value, "What is this?");
    assert.match(view.document.querySelector(".chat-messages").textContent, /MODEL_IMAGE_INPUT_UNSUPPORTED/);
  } finally { await view.close(); }
});

test("a listed turn's images show in its bubble; one not loaded is shown by its label", async () => {
  const client = fakeClient({ threads: [{ threadId: "thread_1", title: "T", createdAt: AT }], turns: { thread_1: [
    turn("t1", { input: "", images: [{ mimeType: "image/png", src: "blob:panel/1" }, { mimeType: "image/jpeg" }] })] } });
  client.state.selected = "thread_1";
  const view = await mount(client);
  try {
    const items = [...view.document.querySelectorAll(".chat-message.is-user .chat-message-images li")];
    assert.equal(items[0].querySelector("img").getAttribute("src"), "blob:panel/1");
    assert.equal(items[1].textContent, "Image 2");
  } finally { await view.close(); }
});

test("without an images slot the composer attaches nothing and leaves paste and drop to the browser", async () => {
  const view = await mountWithImages({});
  try {
    const pasted = await view.paste([image("shot.png")]);
    const dropped = await view.drag("drop", [image("shot.png")]);
    assert.equal(pasted.defaultPrevented, false);
    assert.equal(dropped.defaultPrevented, false);
    assert.equal(view.document.querySelector(".chat-composer-images"), null);
  } finally { await view.close(); }
});

test("each turn status renders its own state", () => {
  const html = (item) => parseHTML(`<div>${renderToStaticMarkup(React.createElement(ui.Turn, { turn: item, retryTurnId: item.turnId, onRetry() {}, onCancel() {}, onContinue() {} }))}</div>`).document;
  const queued = html(turn("q", { status: "queued", finalAnswer: null, completedAt: null, progress: { label: "", items: [] } }));
  assert.equal(queued.querySelector("[role=status]").textContent, "Waiting to run");
  const running = html(turn("r", { status: "running", finalAnswer: null, progress: { label: "Opening the page", items: [] } }));
  assert.equal(running.querySelector("details").hasAttribute("open"), true);
  assert.equal(running.querySelector("[role=status]").textContent, "Opening the page");
  const completed = html(turn("c"));
  assert.match(completed.querySelector(".chat-message.is-assistant").textContent, /Answer\./);
  assert.equal(completed.querySelector(".chat-state"), null);
  const handoff = html(turn("h", { handoff: { reason: "login" } }));
  assert.deepEqual([...handoff.querySelectorAll(".chat-state button")].map((item) => item.textContent), ["Done, carry on", "Cancel task"]);
  for (const status of ["failed", "cancelled"]) {
    const failed = html(turn("f", { status, finalAnswer: null, errorCode: "TURN_CANCELLED" }));
    assert.equal(failed.querySelector(".chat-state.is-error button").textContent, "Retry");
  }
  const merged = html(turn("m", { finalAnswer: "", mergedIntoTurnId: "c" }));
  assert.equal(merged.querySelector(".chat-message.is-assistant"), null, "a merged steer shows only what the user sent");
});
