import assert from "node:assert/strict";
import test from "node:test";
import { createRoutineView } from "../../src/ui/routines.js";
import { browserGlobals } from "./dom.js";

const AT = "2026-10-09T10:00:00.000Z";
const SCHEDULE = { days: [1, 2, 3, 4, 5], localTime: "09:00", timezone: "UTC", enabled: true, nextAt: AT };
const routineThread = (over = {}) => ({ threadId: "routine_1", title: "Morning news", routinePrompt: "Read the news.", permissions: { update: false, write: true },
  schedule: SCHEDULE, createdAt: AT, ...over });
const run = (over = {}) => ({ threadId: "run_1", parentThreadId: "routine_1", trigger: "manual", permissions: { update: false, write: false },
  createdAt: AT, latestTurnStatus: "completed", latestTurnSummary: "Three new stories.", ...over });

// The view over a fake client, in a linkedom document.
function mount({ slots = {}, items = () => [{ thread: routineThread(), lastRun: null }], detail = () => ({ thread: routineThread(), runs: [run()] }) } = {}) {
  const env = browserGlobals("<html><body><div id=\"routines\"></div></body></html>");
  const calls = [];
  const opened = [];
  const element = env.document.getElementById("routines");
  const client = {
    list: async () => (calls.push(["list"]), { items: items() }),
    get: async (accountId, threadId) => (calls.push(["get", threadId]), detail()),
    save: async (accountId, input) => (calls.push(["save", input]), { thread: routineThread({ threadId: input.threadId || "routine_new", title: input.title }), runs: [] }),
    remove: async (accountId, threadId) => calls.push(["remove", threadId]),
    removeRun: async (accountId, threadId) => calls.push(["removeRun", threadId]),
    run: async (accountId, input) => (calls.push(["run", input]), { allowed: true, created: true, thread: run({ threadId: "run_new" }) }),
    // As a product's subscription does: one read now, then one per change.
    subscribe: (accountId, onChange) => { void onChange(); return () => {}; }
  };
  const view = createRoutineView({ element, client, slots, onClose: () => {}, onOpenThread: (target) => opened.push(target) });
  view.setAccount({ accountId: "acct" });
  view.show();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const click = (selector) => element.querySelector(selector).dispatchEvent(new env.window.Event("click", { bubbles: true }));
  const change = (selector) => element.querySelector(selector).dispatchEvent(new env.window.Event("change", { bubbles: true }));
  // linkedom leaves `checked` undefined until written; a browser reflects the attribute.
  const sync = () => element.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = input.hasAttribute("checked"); });
  return { ...env, element, view, calls, opened, settle, click, change, sync };
}

test("the list shows each Routine with its schedule and the product's header controls, which stay open across a repaint", async () => {
  const env = mount({ slots: { headerActions: { markup: () => "<details class=\"pace\"><summary>Pace</summary></details>" } } });
  try {
    await env.settle();
    const row = env.element.querySelector("[data-routine-open=\"routine_1\"]");
    assert.match(row.textContent, /Morning news/);
    assert.match(row.textContent, /Weekdays at/);
    assert.match(row.textContent, /No runs yet/);
    assert.equal(env.element.querySelector(".chat-tool-controls .pace").nextElementSibling.dataset.routineCreate, "");
    env.element.querySelector(".pace").setAttribute("open", "");
    await env.view.refresh();
    assert.ok(env.element.querySelector(".pace").hasAttribute("open"), "an open header menu survives a repaint");
  } finally { env.restore(); }
});

test("a new Routine is saved from the form with the product's permission switches and default permissions", async () => {
  const env = mount({ items: () => [], slots: { permissions: [{ name: "write", label: "Act in the browser", hint: "Still asks before anything is sent." },
    { name: "update", label: "Update memory", hint: "What is remembered." }], defaultPermissions: { update: false, write: false } } });
  try {
    await env.settle();
    env.click("[data-routine-create]");
    env.sync();
    const switches = [...env.element.querySelectorAll(".chat-routine-allowed .chat-row-label")].map((label) => label.textContent);
    assert.deepEqual(switches, ["Act in the browser", "Update memory"]);
    env.element.querySelector("[name=title]").value = "Digest";
    env.element.querySelector("[name=routinePrompt]").value = "Summarize my tabs.";
    env.element.querySelector("[name=cron]").value = "30 18 * * 0,6";
    env.element.querySelector("[name=cron]").dispatchEvent(new env.window.Event("input", { bubbles: true }));
    env.element.querySelector("[data-routine-form]").dispatchEvent(new env.window.Event("submit", { bubbles: true, cancelable: true }));
    await env.settle();
    const [, saved] = env.calls.find(([name]) => name === "save");
    assert.equal(saved.title, "Digest");
    assert.deepEqual(saved.permissions, { update: false, write: false }, "read-only unless the user turns acting on");
    assert.deepEqual({ days: saved.schedule.days, localTime: saved.schedule.localTime }, { days: [0, 6], localTime: "18:30" });
    assert.equal(saved.threadId, undefined);
    assert.match(saved.idempotencyKey, /^routine-save:/);
  } finally { env.restore(); }
});

test("Run now asks what this run may do, starts with everything off, and opens the queued run's conversation", async () => {
  const env = mount({ slots: { runLabel: ({ write }) => write ? "Run and act" : "Run", runNote: ({ write }) => write ? "May act." : "Reads only." } });
  try {
    await env.settle();
    await env.view.open({ threadId: "routine_1" });
    env.sync();
    env.click("[data-routine-test-run]");
    const panel = env.element.querySelector("[data-routine-run-confirm]");
    assert.match(panel.textContent, /Reads only\./);
    assert.equal(panel.querySelector("[data-routine-run-go]").textContent, "Run");
    assert.equal(panel.querySelector('[data-routine-run-permission="update"]').hasAttribute("disabled"), true, "what the Routine does not hold cannot be turned on");
    env.click("[data-routine-run-go]");
    await env.settle();
    const [, started] = env.calls.find(([name]) => name === "run");
    assert.deepEqual(started.permissions, { update: false, write: false });
    assert.deepEqual(env.opened, [{ threadId: "run_new" }]);
  } finally { env.restore(); }
});

test("a run row says its state and summary, opens its conversation and deletes its thread", async () => {
  const env = mount();
  try {
    await env.settle();
    await env.view.open({ threadId: "routine_1" });
    const row = env.element.querySelector("[data-routine-run-item=\"run_1\"]");
    assert.match(row.querySelector("summary").textContent, /Three new stories\./);
    assert.match(row.querySelector(".chat-run-body").textContent, /Completed/);
    env.click("[data-routine-run-thread=\"run_1\"]");
    assert.deepEqual(env.opened, [{ threadId: "run_1" }]);
    env.click("[data-routine-run-delete=\"run_1\"]");
    await env.settle();
    assert.deepEqual(env.calls.find(([name]) => name === "removeRun"), ["removeRun", "run_1"]);
    assert.equal(env.confirmations.length, 1, "deleting a run asks first");
  } finally { env.restore(); }
});
