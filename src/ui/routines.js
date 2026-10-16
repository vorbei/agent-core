// The Routine view: the account's Routines as a list, and one editor page over it (name,
// instructions, schedule set by days and time or by cron, the permissions a run holds, the run
// history with Run now). A run opens as its conversation in the chat. Plain DOM markup and
// listeners over the product's RoutineClient, with the product's parts in RoutineSlots, so an
// HTML-string panel and a React one both use it; its styles are ui/routines.css. From X Gardener
// sidepanel/routines-view.js.
import { isActiveTurnStatus } from "../runtime/projection.js";
import { parseCronSchedule, scheduleToCron } from "../routine/schedule.js";
import { DAY_SHORT, agoWords, formatDateTime, routineStatus, runStateKind, runStateWords, scheduleWords } from "./routine-text.js";
import { focusPageTitle, pageHeadMarkup } from "./page.js";

export { agoWords, formatDateTime, routineStatus, runStateKind, runStateWords, scheduleWords, timeWords } from "./routine-text.js";

// Lucide outline icons (lucide:x, plus, trash-2, play, rotate-cw) and a clock for a row's marker;
// routines.css sets their size.
const PLUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-7-7v14"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5h4"/></svg>';
const REFRESH_ICON ='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

const DEFAULT_SLOTS = {
  title: (thread) => thread?.title || String(thread?.routinePrompt || "").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 60) || "Untitled routine",
  permissions: [
    { name: "write", label: "Act", hint: "Do what the instructions describe, not only read." },
    { name: "update", label: "Update memory", hint: "Change what is remembered about you." }
  ],
  defaultPermissions: { update: false, write: false },
  runNote: ({ write }) => write ? "This run may act, as far as the instructions allow." : "This run takes no action. It reads and reports.",
  runLabel: () => "Run",
  runLine: (run) => String(run.latestTurnSummary || "").trim(),
  instructionsHint: "Each run starts from this text.",
  emptyList: "No routines yet. A Routine runs a set of instructions on a schedule.",
  deleteNote: "Every future run stops and its history leaves these lists. Audit records are kept; nothing already done is undone.",
  headerActions: null
};

// Where each action's answer is shown: next to the control that started it.
const NOTICE_AT = { save: "form", "test-run": "run", "delete-run": "runs", delete: "delete" };
const STATUS_WORDS = { scheduled: "Scheduled", paused: "Paused", running: "Running" };

/**
 * Mounts the Routine view in `element` and returns its handle. The product's shell calls
 * `setAccount` and `show`/`hide`, routes Escape to `handleEscape`, and opens one Routine with `open`.
 * @param {{ element: HTMLElement, client: import("./index.d.ts").RoutineClient, onClose(): void,
 *   onOpenThread(target: { threadId: string }): void, slots?: Partial<import("./index.d.ts").RoutineSlots> }} options
 */
export function createRoutineView({ element, client, onClose, onOpenThread, slots: productSlots = {} }) {
  const slots = { ...DEFAULT_SLOTS, ...productSlots };
  const names = slots.permissions.map((permission) => permission.name);
  element.classList.add("chat-routines");
  let account = null;
  let routines = [];
  let routine = null;
  let selectedThreadId = null;
  let creating = false;
  let visible = false;
  let busyAction = null;
  // The answer to the last action, shown where that action happened: { at, text, isError }, where
  // `at` is "form" (Save, under the sheet header), "run" (the run panel), "runs" or "delete".
  let notice = null;
  // A failed read of the list or the open routine.
  let error = "";
  // The panel that starts one manual run from the editor: { threadId, held, chosen }. `held` is what
  // the Routine may do; `chosen` is what this run may do, all off until the user turns it on.
  let runConfirm = null;
  let deleteConfirm = false;
  // The schedule is set by day chips and a time, or by typing a cron; both write the same schedule.
  let cronMode = false;
  // Set by a successful save, so the next paint shows the saved values instead of keeping local edits.
  let discardEdits = false;
  // A run thread named by a Run now response, opened as its conversation once the run is queued.
  let queuedThreadId = null;
  // Kept through a failed response: the Worker can finish a partial create on retry.
  let createKey = null;
  let refreshPromise = null;
  let unsubscribeUpdates = null;
  let focusOnPaint = false;
  // What opened the editor page ("create" or a Routine's thread id), focused again when it closes.
  let opener = null;
  let renderedFields = {};
  // Which history rows the reader unfolded; `toggle` does not bubble, so it is caught on the way down.
  const expandedRuns = new Set();

  element.addEventListener("toggle", (event) => {
    const item = event.target.closest?.("[data-routine-run-item]");
    if (item) expandedRuns[item.open ? "add" : "delete"](item.dataset.routineRunItem);
  }, true);
  element.addEventListener("input", (event) => {
    if (event.target.closest?.('[name="cron"]')) syncScheduleFromCron();
  });
  element.addEventListener("change", handleChange);
  element.addEventListener("click", handleClick);
  element.addEventListener("submit", handleSubmit);
  // A menu among the header's actions closes on a pointer outside it.
  element.ownerDocument?.addEventListener?.("pointerdown", (event) => {
    for (const menu of element.querySelectorAll(".chat-tool-controls details[open]")) if (!menu.contains(event.target)) menu.removeAttribute("open");
  });
  slots.headerActions?.bind?.(element);

  return { setAccount, show, hide, refresh, handleEscape, open };

  function setAccount(nextAccount) {
    const changed = account?.accountId !== nextAccount?.accountId;
    account = nextAccount;
    if (changed) reset();
    if (changed && visible) watchUpdates();
  }

  function reset() {
    routines = [];
    routine = null;
    selectedThreadId = null;
    creating = false;
    notice = null;
    error = "";
    runConfirm = null;
    deleteConfirm = false;
    queuedThreadId = null;
    createKey = null;
  }

  function show() {
    visible = true;
    focusOnPaint = false;
    watchUpdates();
  }

  function hide() {
    visible = false;
    unsubscribeUpdates?.();
    unsubscribeUpdates = null;
  }

  // Opens one Routine: where the chat sends a reader of its runs.
  async function open({ threadId }) {
    selectedThreadId = threadId;
    creating = false;
    routine = null;
    notice = null;
    error = "";
    runConfirm = null;
    deleteConfirm = false;
    cronMode = false;
    await refresh();
  }

  function watchUpdates() {
    unsubscribeUpdates?.();
    unsubscribeUpdates = account ? client.subscribe(account.accountId, () => refresh({ quiet: true, passive: true })) : null;
    if (!account) void refresh();
  }

  function handleEscape() {
    if (runConfirm) {
      closeRunConfirm();
      return true;
    }
    if (deleteConfirm) {
      deleteConfirm = false;
      paint();
      return true;
    }
    if (selectedThreadId || creating) {
      closeDetail();
      return true;
    }
    onClose();
    return true;
  }

  async function refresh({ quiet = false, passive = false } = {}) {
    // A push or account switch arriving during another read still needs its own current snapshot.
    while (refreshPromise) await refreshPromise;
    if (!account) {
      reset();
      paint();
      return null;
    }
    if (!quiet && !routines.length) paintLoading();
    const accountId = account.accountId;
    const detailThreadId = selectedThreadId;
    refreshPromise = (async () => {
      try {
        const list = await client.list(accountId).catch(failWith("Could not load routines."));
        if (account?.accountId !== accountId) return null;
        routines = list.items || [];
        if (selectedThreadId && !creating) {
          const detail = await client.get(accountId, selectedThreadId).catch(failWith("Could not load this routine."));
          if (account?.accountId !== accountId || selectedThreadId !== detailThreadId) return null;
          routine = detail;
        }
        error = "";
        return routines;
      } catch (cause) {
        if (account?.accountId === accountId) error = cause.message;
        return null;
      } finally {
        refreshPromise = null;
        if (account?.accountId === accountId) {
          // Background updates must not replace a draft or steal its focus.
          if (passive && (selectedThreadId || creating)) {
            if (routine && selectedThreadId === detailThreadId && !creating) {
              refreshPristineFields();
              repaintHistory();
            }
          } else paint();
        }
      }
    })();
    return refreshPromise;
  }

  function repaintHistory() {
    const history = element.querySelector(".chat-routine-runs");
    if (history && routine) history.innerHTML = historyMarkup(routine, noticeMarkup("runs"));
  }

  function refreshPristineFields() {
    const draft = routineDraft(routine);
    const values = { ...draft, ...draft.permissions };
    for (const [name, value] of Object.entries(values)) {
      const input = field(name);
      if (!input) continue;
      const property = input.type === "checkbox" ? "checked" : "value";
      // Compare against the last value rendered into this field, not the last response: other
      // fields can update while this one remains a local edit.
      if (input[property] !== renderedFields[name]) continue;
      if (input[property] !== value) input[property] = value;
      renderedFields[name] = value;
    }
    const next = element.querySelector("[data-routine-next]");
    if (next) next.textContent = nextRunText(routine);
    syncScheduleFromCron();
  }

  function handleChange(event) {
    const runPermission = event.target.closest?.("[data-routine-run-permission]");
    if (runPermission && runConfirm) {
      runConfirm.chosen[runPermission.dataset.routineRunPermission] = Boolean(runPermission.checked);
      return repaintRunConfirm(runPermission.dataset.routineRunPermission);
    }
    if (runConfirm && event.target.closest?.("[data-routine-form]") && names.includes(event.target.name)) {
      runConfirm.held = formPermissions();
      return repaintRunConfirm();
    }
    if (event.target.closest?.("[data-routine-schedule-mode]")) return setScheduleMode(event.target.value === "cron");
    if (event.target.closest?.("[data-routine-day], [data-routine-time]")) syncCronFromSchedule();
  }

  // The day chips and the time are an editor over the cron field, which is what Save reads.
  function syncCronFromSchedule() {
    const form = element.querySelector("[data-routine-form]");
    if (!form) return;
    const days = [...form.querySelectorAll("[data-routine-day]")].filter((chip) => chip.checked).map((chip) => Number(chip.dataset.routineDay));
    const localTime = form.querySelector("[data-routine-time]")?.value || "09:00";
    const cron = form.querySelector('[name="cron"]');
    if (cron) cron.value = scheduleToCron({ days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], localTime });
    showCronProblem(parseCronSchedule(cron?.value));
  }

  function syncScheduleFromCron() {
    const form = element.querySelector("[data-routine-form]");
    const cron = form?.querySelector('[name="cron"]');
    if (!cron) return;
    const schedule = parseCronSchedule(cron.value);
    if (schedule) {
      form.querySelectorAll("[data-routine-day]").forEach((chip) => { chip.checked = schedule.days.includes(Number(chip.dataset.routineDay)); });
      const time = form.querySelector("[data-routine-time]");
      if (time) time.value = schedule.localTime;
    }
    showCronProblem(schedule);
  }

  // The chips and the time always make a valid schedule; only a typed cron can fail.
  function showCronProblem(schedule) {
    const problem = element.querySelector("[data-routine-cron-error]");
    if (problem) problem.textContent = schedule ? "" : "Use minute, hour, *, * and weekdays, such as 30 10 * * 1-5. A Routine runs at one time of day on the days you choose.";
  }

  // Leaving cron for the chips writes the chips' schedule back, so the field Save reads is never
  // one the chips do not show.
  function setScheduleMode(cron) {
    cronMode = cron;
    element.querySelector("[data-routine-days-editor]")?.toggleAttribute("hidden", cron);
    element.querySelector("[data-routine-cron-editor]")?.toggleAttribute("hidden", !cron);
    if (!cron) syncCronFromSchedule();
  }

  // A field of the open sheet by name; every name is unique within the sheet.
  function field(name) {
    return element.querySelector(`[name="${name}"]`);
  }

  async function handleClick(event) {
    const removeRun = event.target.closest("[data-routine-run-delete]");
    if (removeRun && routine && !busyAction) {
      const run = routine.runs.find((item) => item.threadId === removeRun.dataset.routineRunDelete);
      if (!run || isActiveTurnStatus(run.latestTurnStatus)) return;
      if (!globalThis.confirm(`Delete the run from ${formatDateTime(run.createdAt)}? Its conversation will be removed from history. The Routine and its schedule are unchanged. Audit records are retained; nothing it already did is undone.`)) return;
      await perform("delete-run", () => client.removeRun(account.accountId, run.threadId).catch(failWith("Could not delete this run.")));
      return;
    }
    if (event.target.closest("[data-routine-delete]") && routine && !busyAction) {
      deleteConfirm = true;
      notice = null;
      paint();
      element.querySelector("[data-routine-delete-cancel]")?.focus();
      return;
    }
    if (event.target.closest("[data-routine-delete-cancel]")) {
      deleteConfirm = false;
      paint();
      return;
    }
    if (event.target.closest("[data-routine-delete-confirm]") && routine && deleteConfirm && !busyAction) {
      await perform("delete", async () => {
        await client.remove(account.accountId, selectedThreadId).catch(failWith("Could not delete this routine."));
        closeDetail();
      });
      return;
    }
    const runThread = event.target.closest("[data-routine-run-thread]");
    if (runThread) {
      onOpenThread({ threadId: runThread.dataset.routineRunThread });
      return;
    }
    if (event.target.closest("[data-routine-detail-close]")) {
      closeDetail();
      return;
    }
    if (event.target.closest("[data-routine-create]")) {
      opener = "create";
      creating = true;
      createKey = `routine-save:${crypto.randomUUID()}`;
      routine = null;
      selectedThreadId = null;
      notice = null;
      error = "";
      runConfirm = null;
      deleteConfirm = false;
      cronMode = false;
      focusOnPaint = true;
      paint();
      return;
    }
    const openRoutine = event.target.closest("[data-routine-open]");
    if (openRoutine) {
      opener = openRoutine.dataset.routineOpen;
      focusOnPaint = true;
      await open({ threadId: openRoutine.dataset.routineOpen });
      return;
    }
    if (event.target.closest("[data-routine-refresh]")) {
      await refresh();
      return;
    }
    if (event.target.closest("[data-routine-test-run]")) return openRunConfirm();
    if (event.target.closest("[data-routine-run-cancel]")) return closeRunConfirm();
    if (event.target.closest("[data-routine-run-go]") && runConfirm && !busyAction) await testRun({ ...runConfirm.chosen });
  }

  // Every manual run starts from this panel: its permissions are off for the run until the user
  // turns them on, and the panel says what the run may do before it starts.
  function openRunConfirm() {
    if (busyAction) return;
    runConfirm = { held: formPermissions(), chosen: { update: false, write: false } };
    notice = null;
    paint();
    element.querySelector("[data-routine-run-confirm] input:not(:disabled), [data-routine-run-go]")?.focus();
  }

  function closeRunConfirm() {
    runConfirm = null;
    paint();
  }

  function repaintRunConfirm(focusName) {
    const panel = element.querySelector("[data-routine-run-confirm]");
    if (!panel || !runConfirm) return;
    panel.innerHTML = runConfirmBody(runConfirm, noticeMarkup("run"));
    if (focusName) panel.querySelector(`[data-routine-run-permission="${focusName}"]`)?.focus();
  }

  // What the open form allows: a run started from the sheet saves the form first.
  function formPermissions() {
    return { update: Boolean(field("update")?.checked), write: Boolean(field("write")?.checked) };
  }

  // Run now is a real run with the permissions chosen in its panel: an unsaved form is saved first
  // (created or updated), then the run is queued, and its conversation opens in the chat.
  async function testRun(permissions) {
    const form = element.querySelector("[data-routine-form]");
    if (!form || busyAction) return;
    queuedThreadId = null;
    await perform("test-run", async () => {
      if (creating || hasUnsavedChanges()) await submitRoutine();
      const response = await startRun(selectedThreadId, permissions);
      queuedThreadId = response.thread?.threadId || null;
      runConfirm = null;
      notice = { at: "form", text: response.created === false ? "The run is already queued." : "Run queued. Keep Chrome open if the task needs browser access." };
    });
    if (notice?.isError || !queuedThreadId) return;
    const threadId = queuedThreadId;
    queuedThreadId = null;
    onOpenThread({ threadId });
  }

  // `permissions` narrow the Routine's own for this run only; the Worker never widens them.
  async function startRun(threadId, permissions) {
    const response = await client.run(account.accountId, { threadId, permissions, idempotencyKey: `routine-run:${crypto.randomUUID()}` })
      .catch(failWith("Could not start this run."));
    if (response?.allowed === false) throw new Error(runRefusal(response.reason));
    return response || {};
  }

  async function handleSubmit(event) {
    if (!event.target.matches("[data-routine-form]")) return;
    event.preventDefault();
    await perform("save", async () => {
      await submitRoutine();
      notice = { at: "form", text: "Routine saved." };
    });
  }

  // Validates the form and writes it. Throws so both Save and Run now report the same reason and
  // Run now never queues a run against a definition the Worker refused.
  async function submitRoutine() {
    const title = field("title").value.trim();
    const routinePrompt = field("routinePrompt").value.trim();
    const schedule = parseCronSchedule(field("cron").value);
    if (!title) throw new Error("Give this Routine a name.");
    if (!routinePrompt) throw new Error("Describe what this routine should do.");
    if (!schedule) throw new Error("Choose at least one day and a time, or a cron such as 30 10 * * 1-5.");
    const jitter = Number(field("jitterMinutes")?.value);
    routine = await client.save(account.accountId, {
      ...(creating && !selectedThreadId ? {} : { threadId: selectedThreadId }),
      title,
      routinePrompt,
      enabled: field("enabled").checked,
      permissions: formPermissions(),
      schedule: { ...schedule, timezone: field("timezone").value, ...(jitter > 0 ? { jitterMinutes: Math.min(120, Math.round(jitter)) } : {}) },
      idempotencyKey: creating ? (createKey ||= `routine-save:${crypto.randomUUID()}`) : `routine-save:${crypto.randomUUID()}`
    }).catch(failWith("Could not save this routine."));
    selectedThreadId = routine.thread.threadId;
    creating = false;
    createKey = null;
    discardEdits = true;
    return routine;
  }

  async function perform(name, action) {
    if (busyAction) return;
    busyAction = name;
    error = "";
    notice = null;
    markBusyControl(name);
    try {
      await action();
      await refresh({ quiet: true });
    } catch (cause) {
      notice = { at: NOTICE_AT[name] || "form", text: cause.message || "The operation failed.", isError: true };
    } finally {
      busyAction = null;
      paint();
    }
  }

  function markBusyControl(name) {
    const [selector, label] = { save: [".chat-routine-save", "…"], "test-run": ["[data-routine-run-go]", "Queuing…"] }[name] || [];
    const control = selector ? element.querySelector(selector) : null;
    if (!control) return;
    control.disabled = true;
    control.textContent = label;
  }

  function closeDetail() {
    routine = null;
    selectedThreadId = null;
    creating = false;
    notice = null;
    error = "";
    runConfirm = null;
    deleteConfirm = false;
    cronMode = false;
    queuedThreadId = null;
    createKey = null;
    paint();
    // Back where the page was opened from: the row or New (none when the chat opened it).
    const back = opener === "create" ? element.querySelector("[data-routine-create]")
      : [...element.querySelectorAll("[data-routine-open]")].find((row) => row.dataset.routineOpen === opener);
    back?.focus();
    opener = null;
  }

  function noticeMarkup(at) {
    const shown = notice?.at === at ? notice : (at === "form" && error ? { text: error, isError: true } : null);
    return `<p class="chat-routine-feedback ${shown?.isError ? "is-error" : ""}" data-routine-notice="${at}" role="${shown?.isError ? "alert" : "status"}"${shown ? "" : " hidden"}>${escapeHtml(shown?.text || "")}</p>`;
  }

  // Field values the user changed since the last paint of the same sheet, kept across a repaint.
  function localEdits() {
    if (!element.querySelector("[data-routine-form]") || discardEdits) return null;
    const values = {};
    for (const [name, rendered] of Object.entries(renderedFields)) {
      const input = field(name);
      const value = input?.[input.type === "checkbox" ? "checked" : "value"];
      if (value !== undefined && value !== rendered) values[name] = value;
    }
    return { sheet: creating ? "new" : selectedThreadId, values };
  }

  function restoreEdits(edits) {
    if (!edits || edits.sheet !== (creating ? "new" : selectedThreadId)) return;
    for (const [name, value] of Object.entries(edits.values)) {
      const input = field(name);
      if (input) input[input.type === "checkbox" ? "checked" : "value"] = value;
    }
    if ("cron" in edits.values) syncScheduleFromCron();
  }

  function hasUnsavedChanges() {
    return Object.entries(renderedFields).some(([name, value]) => {
      const input = field(name);
      return input && input[input.type === "checkbox" ? "checked" : "value"] !== value;
    });
  }

  function paintLoading() {
    element.innerHTML = '<div class="chat-routine-loading" role="status"><span></span><p>Loading routines…</p></div>';
  }

  function paint() {
    const edits = localEdits();
    discardEdits = false;
    paintView();
    restoreEdits(edits);
  }

  function paintView() {
    const head = (controls = "") => `<header class="chat-tool-head"><h2 id="chat-routine-title">Routines</h2>${controls}</header>`;
    if (!account) {
      element.innerHTML = `${head()}<div class="chat-routine-empty"><p>Connect an account to see its routines.</p></div>`;
      return;
    }
    if (!routines.length && error && !creating) {
      element.innerHTML = `${head()}
        <div class="chat-routine-empty" role="alert"><strong>Routines unavailable</strong><p>${escapeHtml(error)}</p><button class="chat-button chat-button-secondary" data-routine-refresh>Try again</button></div>`;
      return;
    }
    // A repaint keeps a header menu that was open.
    const openMenus = [...element.querySelectorAll(".chat-tool-controls details")].map((menu) => menu.hasAttribute("open"));
    const controls = `<span class="chat-tool-controls">${routines.length && slots.headerActions ? slots.headerActions.markup() : ""}<button type="button" class="chat-routine-new" data-routine-create aria-label="New routine" title="New routine">${PLUS_ICON}<span aria-hidden="true">New</span></button></span>`;
    element.innerHTML = `${head(controls)}
      <div class="chat-routine-list" role="list">${routines.length ? routines.map(routineRowMarkup).join("")
        : `<div class="chat-routine-empty"><p>${escapeHtml(slots.emptyList)}</p><button type="button" class="chat-button chat-button-secondary" data-routine-create>New routine</button></div>`}</div>
      ${detailMarkup()}`;
    element.querySelectorAll(".chat-tool-controls details").forEach((menu, index) => { if (openMenus[index]) menu.setAttribute("open", ""); });
    // An opened page starts at its title (once the Routine is loaded, not on the loading page).
    if (focusOnPaint && (creating || routine)) {
      focusOnPaint = false;
      focusPageTitle(element.querySelector(".chat-routine-shell"));
    }
  }

  // The editor is a page over the list (agent-core/ui/page): back, "Routines", its name, and
  // Delete and Save at the right.
  function detailMarkup() {
    if (!creating && !selectedThreadId) return "";
    const back = { label: "Back to Routines", attrs: "data-routine-detail-close" };
    if (!creating && !routine) return `<section class="chat-page chat-routine-shell" role="region" aria-label="Edit Routine">${pageHeadMarkup({ title: "Routine", from: "Routines", back })}<div class="chat-page-body"><div class="chat-routine-loading" role="status"><span></span><p>Loading routine…</p></div></div></section>`;
    const draft = creating ? newRoutineDraft() : routineDraft(routine);
    renderedFields = { ...draft, ...draft.permissions };
    const schedule = parseCronSchedule(draft.cron) || { days: [], localTime: "09:00" };
    const runPanel = runConfirm ? runConfirmMarkup(runConfirm, noticeMarkup("run")) : "";
    const controls = `${creating ? "" : `<button type="button" class="chat-routine-delete" data-routine-delete aria-label="Delete Routine" title="Delete Routine" ${deleteConfirm ? 'aria-expanded="true"' : ""} ${busyAction ? "disabled" : ""}>${DELETE_ICON}</button>`}
          <button class="chat-routine-save" type="submit" form="chat-routine-form" ${busyAction === "save" ? "disabled" : ""}>${busyAction === "save" ? "…" : "Save"}</button>`;
    return `<section class="chat-page chat-routine-shell" role="region" aria-label="${creating ? "New Routine" : "Edit Routine"}">
        ${pageHeadMarkup({ title: creating ? "New Routine" : slots.title(routine.thread), from: "Routines", back, controls })}
        <div class="chat-page-body chat-sheet-scroll chat-routine-scroll">
          ${!creating && deleteConfirm ? deleteConfirmMarkup() : ""}${noticeMarkup("delete")}
          ${noticeMarkup("form")}
          <form id="chat-routine-form" data-routine-form>
            <section class="chat-sheet-row chat-routine-field">
              <label class="chat-routine-label" for="chat-routine-name">Name</label>
              <input id="chat-routine-name" class="chat-field" name="title" maxlength="120" value="${escapeHtml(draft.title)}" placeholder="Name this Routine" required>
            </section>
            <section class="chat-sheet-row chat-routine-field">
              <label class="chat-routine-label" for="chat-routine-prompt">Instructions</label>
              <textarea id="chat-routine-prompt" class="chat-field chat-routine-prompt" name="routinePrompt" maxlength="4000" rows="8" placeholder="Describe what each run should do, step by step." required>${escapeHtml(draft.routinePrompt)}</textarea>
              <small class="chat-sheet-hint">${escapeHtml(slots.instructionsHint)}</small>
            </section>
            <section class="chat-sheet-row chat-routine-when" aria-labelledby="chat-routine-when-title">
              <h3 class="chat-routine-label" id="chat-routine-when-title">Schedule</h3>
              <label class="chat-setting-row chat-permission"><span class="chat-row-text"><span class="chat-row-label">Run on a schedule</span><small data-routine-next>${escapeHtml(nextRunText(routine))}</small></span><input name="enabled" type="checkbox" aria-label="Repeat on schedule" ${draft.enabled ? "checked" : ""}><i></i></label>
              <label class="chat-setting-row chat-setting-select"><span class="chat-row-label">Set by</span><select data-routine-schedule-mode aria-label="Set the schedule by"><option value="days" ${cronMode ? "" : "selected"}>Days &amp; time</option><option value="cron" ${cronMode ? "selected" : ""}>Cron</option></select></label>
              <div data-routine-days-editor ${cronMode ? "hidden" : ""}>
                <div class="chat-day-chips" role="group" aria-label="Days">${DAY_SHORT.map((label, day) => `<label class="chat-day-chip"><input type="checkbox" data-routine-day="${day}" ${schedule.days.includes(day) ? "checked" : ""}><span>${label}</span></label>`).join("")}</div>
                <div class="chat-schedule-row"><label><span>At</span><input class="chat-field chat-field-inline" type="time" data-routine-time value="${escapeHtml(schedule.localTime)}" aria-label="Time of day" required></label><span class="chat-schedule-zone" title="Time zone">${escapeHtml(draft.timezone)}</span></div>
              </div>
              <div class="chat-cron-editor" data-routine-cron-editor ${cronMode ? "" : "hidden"}>
                <input class="chat-field chat-field-mono" name="cron" value="${escapeHtml(draft.cron)}" placeholder="30 10 * * 1-5" aria-label="Cron schedule" spellcheck="false" required>
                <small class="chat-sheet-hint is-error" data-routine-cron-error role="alert"></small>
                <small class="chat-sheet-hint">Minute, hour, *, *, weekdays (0 is Sunday), in ${escapeHtml(draft.timezone)}: one time of day on the days you choose.</small>
              </div>
              <div class="chat-schedule-row"><label><span>Start within ±</span><input class="chat-field chat-field-inline" name="jitterMinutes" type="number" min="0" max="120" step="5" value="${escapeHtml(String(draft.jitterMinutes || 0))}" aria-label="Random start window in minutes"><span>min, at random</span></label></div>
              <input name="timezone" type="hidden" value="${escapeHtml(draft.timezone)}">
            </section>
            <section class="chat-sheet-row chat-routine-allowed" aria-labelledby="chat-routine-allowed-title">
              <h3 class="chat-routine-label" id="chat-routine-allowed-title">Permissions</h3>
              ${slots.permissions.map(({ name, label, hint }) => permissionSwitch(name, label, draft.permissions[name], hint)).join("\n              ")}
            </section>
          </form>
          ${creating ? newRoutineFootMarkup(runPanel) : `<section class="chat-sheet-row chat-routine-runs">${historyMarkup(routine, noticeMarkup("runs"), runPanel)}</section>`}
        </div>
      </section>`;
  }

  // The panel that starts one manual run, in the sheet or under a list row.
  function runConfirmMarkup(confirm, noticeHtml) {
    return `<div class="chat-run-confirm" data-routine-run-confirm role="group" aria-label="Start one run">${runConfirmBody(confirm, noticeHtml)}</div>`;
  }

  function runConfirmBody({ held, chosen }, noticeHtml) {
    const allowed = { write: held.write && chosen.write, update: held.update && chosen.update };
    const busy = busyAction === "test-run";
    return `<p class="chat-run-confirm-title">Allow for this run only</p>
    ${slots.permissions.map(({ name, label }) => runPermissionSwitch(name, label, held[name], allowed[name])).join("\n    ")}
    <p class="chat-run-confirm-note ${allowed.write ? "is-warning" : ""}" data-routine-run-note>${escapeHtml(slots.runNote({ ...allowed, account }))}</p>
    <div class="chat-run-confirm-buttons"><button type="button" class="chat-button chat-button-secondary" data-routine-run-cancel ${busy ? "disabled" : ""}>Cancel</button><button type="button" class="chat-button" data-routine-run-go ${busyAction ? "disabled" : ""}>${busy ? "Queuing…" : escapeHtml(slots.runLabel({ ...allowed, account }))}</button></div>
    ${noticeHtml}`;
  }

  // One row: a marker (filled while scheduled), the name, the schedule in words, how the last run
  // went and a status pill. A run is
  // started from the Routine's editor (Run now).
  function routineRowMarkup(item) {
    const threadId = item.thread.threadId;
    const status = routineStatus(item);
    return `<div class="chat-routine-row" role="listitem"><button type="button" class="chat-routine-open" data-routine-open="${escapeHtml(threadId)}">
      <span class="chat-routine-marker is-${status}" aria-hidden="true">${CLOCK_ICON}</span><span class="chat-routine-text"><strong>${escapeHtml(slots.title(item.thread))}</strong><small>${escapeHtml(routineScheduleLine(item))}</small><small data-routine-last>${escapeHtml(routineRowSummary(item))}</small></span>
      <span class="chat-routine-pill is-${status}">${STATUS_WORDS[status]}</span>
    </button></div>`;
  }

  // A Routine not yet saved ends with the way to try it; its history and Delete come once it exists.
  function newRoutineFootMarkup(runPanel) {
    return `<section class="chat-sheet-row chat-routine-foot"><div class="chat-row-text"><span class="chat-row-label">Not saved yet</span><small>Save to schedule it, or run it once to try.</small></div>${runNowButton(Boolean(runPanel))}</section>${runPanel}`;
  }

  // Delete asks once, at the top of the sheet under the head's Delete, and says what it means there.
  function deleteConfirmMarkup() {
    return `<div class="chat-delete-confirm" role="group" aria-label="Delete this Routine"><p>Delete “${escapeHtml(slots.title(routine.thread))}”? ${escapeHtml(slots.deleteNote)}</p>
    <div class="chat-run-confirm-buttons"><button type="button" class="chat-button chat-button-secondary" data-routine-delete-cancel ${busyAction ? "disabled" : ""}>Keep it</button><button type="button" class="chat-button chat-button-danger" data-routine-delete-confirm ${busyAction ? "disabled" : ""}>${DELETE_ICON}<span>${busyAction === "delete" ? "Deleting…" : "Delete Routine"}</span></button></div></div>`;
  }

  function runNowButton(open) {
    return `<button type="button" class="chat-button chat-button-small" data-routine-test-run ${busyAction ? "disabled" : ""} title="Choose what this run may do, then run this routine now" ${open ? 'aria-expanded="true"' : ""}>${PLAY_ICON}<span>${busyAction === "test-run" ? "Queuing…" : "Run now"}</span></button>`;
  }

  function historyMarkup(detail, noticeHtml, runPanel = "") {
    return `<header><h3 class="chat-routine-label">Runs</h3><div class="chat-sheet-head-controls"><button type="button" class="chat-icon-button" data-routine-refresh aria-label="Refresh runs" title="Refresh runs">${REFRESH_ICON}</button>${runNowButton(Boolean(runPanel))}</div></header>
    ${runPanel}
    ${detail.runs.length ? `<div class="chat-run-list">${detail.runs.map((run) => runMarkup(run)).join("")}</div>` : '<p class="chat-sheet-hint">No runs yet. Run it now to see what it does.</p>'}${noticeHtml}`;
  }

  // One run in the history, folded to one line: its marker, when, and its summary (or its state).
  // Unfolded: the state, and the way to its conversation, where everything it did is.
  function runMarkup(run) {
    const kind = runStateKind(run);
    const state = runStateWords(run);
    const line = isActiveTurnStatus(run.latestTurnStatus) ? `${state} · started ${agoWords(run.createdAt)}` : slots.runLine(run) || state;
    return `<details class="chat-run-item is-${kind}" data-routine-run-item="${escapeHtml(run.threadId)}" ${expandedRuns.has(run.threadId) ? "open" : ""}>
    <summary><span class="chat-run-marker is-${kind}" aria-hidden="true"></span><span class="chat-run-when">${escapeHtml(formatDateTime(run.createdAt))}</span><span class="chat-run-short">${escapeHtml(line)}</span></summary>
    <div class="chat-run-body">
      <p><strong>${escapeHtml(state)}</strong></p>
      <nav><button type="button" class="chat-link-button" data-routine-run-thread="${escapeHtml(run.threadId)}">Open the conversation</button><button type="button" class="chat-link-button is-danger" data-routine-run-delete="${escapeHtml(run.threadId)}" ${busyAction || isActiveTurnStatus(run.latestTurnStatus) ? "disabled" : ""}>Delete this run</button></nav>
    </div>
  </details>`;
  }

  function routineDraft(detail) {
    const schedule = detail.thread.schedule || {};
    return {
      title: slots.title(detail.thread),
      routinePrompt: detail.thread.routinePrompt || "",
      enabled: Boolean(schedule.enabled),
      permissions: detail.thread.permissions,
      cron: scheduleToCron(schedule),
      timezone: schedule.timezone || "UTC",
      jitterMinutes: String(schedule.jitterMinutes || 0)
    };
  }

  function newRoutineDraft() {
    return { title: "", routinePrompt: "", enabled: false, permissions: { ...slots.defaultPermissions }, cron: "0 9 * * 1-5",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", jitterMinutes: "0" };
  }
}

// The client rejected without saying why: say what failed.
function failWith(fallback) {
  return (cause) => { throw new Error(cause?.message || fallback); };
}

function runPermissionSwitch(name, label, held, checked) {
  return `<label class="chat-setting-row ${held ? "" : "is-unavailable"}"><span>${escapeHtml(label)}${held ? "" : "<small>Off in this routine's permissions</small>"}</span><input type="checkbox" data-routine-run-permission="${name}" aria-label="${escapeHtml(label)} in this run" ${checked ? "checked" : ""} ${held ? "" : "disabled"}><i></i></label>`;
}

// A permission: its label and one line on what it allows, the switch at the right.
function permissionSwitch(name, label, checked, hint) {
  return `<label class="chat-setting-row chat-permission"><span class="chat-row-text"><span class="chat-row-label">${escapeHtml(label)}</span><small>${escapeHtml(hint)}</small></span><input name="${name}" type="checkbox" aria-label="${escapeHtml(label)}" ${checked ? "checked" : ""}><i></i></label>`;
}

function routineScheduleLine(item) {
  const schedule = item.thread.schedule || {};
  const words = scheduleWords(schedule);
  if (!schedule.enabled) return `${words} · paused`;
  return schedule.nextAt ? `${words} · next ${formatDateTime(schedule.nextAt)}` : words;
}

/** A list row's last line, from the list projection's `{thread, lastRun}`. */
export function routineRowSummary(item) {
  const last = item.lastRun;
  if (!last) return "No runs yet";
  const when = agoWords(last.createdAt);
  const state = runStateWords({ latestTurnStatus: last.status });
  return isActiveTurnStatus(last.status) ? `${state} · started ${when}` : `Last run ${when} · ${state}`;
}

function nextRunText(detail) {
  if (!detail) return "Save to schedule the first run.";
  const schedule = detail.thread.schedule || {};
  return schedule.enabled && schedule.nextAt ? `Next ${formatDateTime(schedule.nextAt)}` : "Off · you can still run it now";
}

function runRefusal(reason) {
  return ({
    PREVIOUS_RUN_ACTIVE: "This routine is already running. Open the run in progress.",
    ACCOUNT_PAUSED: "This account is paused. Resume it before running a routine.",
    ROUTINE_DISABLED: "This routine was disabled before its scheduled run started.",
    ROUTINE_ARCHIVED: "This routine was deleted."
  })[reason] || reason || "This routine cannot run now.";
}
