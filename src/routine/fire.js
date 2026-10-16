// How a Routine fires: one durable alarm per Routine for its next slot (moved by its start window),
// and every fire (that alarm, a retry, a manual run) opening at most one run thread whose first
// turn is the Routine's prompt. The fire key, not the alarm, decides what a replay does.
import { sha256 } from "../runtime/index.js";
import { manualRunPermissions, matchesScheduledSlot, nextRoutineTime, routineFireAt, validatePermissions } from "./schedule.js";
import { insertRunThread, recordNextAt, storedPermissions, threadRow } from "./store.js";

/** The alarm callback name every Routine job uses. */
export const ROUTINE_ALARM = "runRoutineAlarm";
// A one-off or a retry that lands on a busy Routine waits for the run in progress instead of
// being dropped, for about an hour of retries.
const DEFER_DELAY_MS = 60_000;
const MAX_DEFERRALS = 60;
/**
 * A scheduled fire on an account no browser has reached for this long turns its schedule off
 * instead of running (only for a host that reports `lastSeen`). Turning it on again resumes it.
 */
export const ROUTINE_IDLE_PAUSE_MS = 7 * 24 * 60 * 60_000;
/** How long a run skipped for want of a connected browser waits before its one retry. */
export const SYNC_RETRY_BACKOFF_MS = 60 * 60_000;
const JOB_OPTIONS = { idempotent: true, retry: { maxAttempts: 3 } };

const one = (host, query, ...params) => host.storage.sql.exec(query, ...params).toArray()[0] || null;

/**
 * Replaces a Routine's recurring alarm after a change or a fire. An archived or scheduleless
 * Routine stops firing at all; a paused one keeps only alarms other than its recurring clock.
 * `after` is the slot that just fired: an early (jittered) fire must not find it again.
 */
export async function reconcileRoutineAlarm(host, threadId, now = new Date().toISOString(), after = null) {
  const row = one(host, "SELECT status, schedule_json FROM agent_threads WHERE thread_id = ?", threadId);
  const schedule = row?.schedule_json ? JSON.parse(row.schedule_json) : null;
  const gone = !schedule || row.status !== "active";
  const existing = (await host.jobs.list()).filter((item) => item.callback === ROUTINE_ALARM && item.payload?.threadId === threadId);
  if (gone || !schedule.enabled) {
    const cancelled = existing.filter((item) => gone || item.payload?.trigger === "schedule");
    for (const item of cancelled) await host.jobs.cancel(item.id);
    // A slot announced by routine.scheduled and then withdrawn is not a missing fire.
    if (cancelled.some((item) => item.payload?.trigger === "schedule")) {
      host.log("routine.unscheduled", { threadId, reason: gone ? "ROUTINE_ARCHIVED" : "ROUTINE_DISABLED" });
    }
    if (schedule) recordNextAt(host.storage, threadId, null, now);
    return null;
  }
  const nextAt = nextRoutineTime(after && Date.parse(after) > Date.parse(now) ? after : now, schedule);
  const fireAt = routineFireAt(nextAt, schedule, now);
  // The next clock is stored before the old one goes: a failed schedule leaves the current alarm
  // to retry, a failed cancel leaves the next clock already recoverable.
  const scheduled = await host.jobs.schedule(new Date(fireAt), ROUTINE_ALARM, { threadId, scheduledFor: nextAt, trigger: "schedule" }, JOB_OPTIONS);
  recordNextAt(host.storage, threadId, nextAt, now);
  for (const item of existing) {
    if (item.payload?.trigger === "schedule" && item.id !== scheduled.id) await host.jobs.cancel(item.id);
  }
  host.log("routine.scheduled", { threadId, scheduleId: scheduled.id, nextAt, fireAt: new Date(fireAt).toISOString() });
  return { scheduleId: scheduled.id, nextAt };
}

/**
 * On start: keeps a due or leased slot (including the crash window after its job was stored but
 * before nextAt was recorded), else derives the clock again. A changed schedule cannot revive an old clock.
 */
export async function ensureRoutineAlarm(host, threadId, now = new Date().toISOString(), schedules = null) {
  const existing = (schedules || await host.jobs.list()).filter((item) => item.callback === ROUTINE_ALARM
    && item.payload?.threadId === threadId && item.payload?.trigger === "schedule");
  const row = one(host, "SELECT status, schedule_json FROM agent_threads WHERE thread_id = ?", threadId);
  const schedule = row?.schedule_json ? JSON.parse(row.schedule_json) : null;
  const current = row?.status === "active" && schedule?.enabled
    ? existing.find((item) => matchesScheduledSlot(schedule, item.payload.scheduledFor)) : null;
  if (!current) return reconcileRoutineAlarm(host, threadId, now);
  if (schedule.nextAt === null) recordNextAt(host.storage, threadId, current.payload.scheduledFor, now);
  for (const item of existing) if (item.id !== current.id) await host.jobs.cancel(item.id);
  return { scheduleId: current.id, nextAt: current.payload.scheduledFor };
}

/** The alarm callback for a recurring fire, a retry, and a one-off armed by an older release. */
export async function runRoutineAlarm(host, payload = {}, now = new Date().toISOString()) {
  const { threadId, scheduledFor, trigger = "schedule", retryOf = null, windowEndsAt = null } = payload;
  if (trigger === "schedule" && idle(host, now)) return pauseIdleRoutine(host, threadId, scheduledFor, now);
  if (trigger === "retry" && !(Date.parse(now) < Date.parse(windowEndsAt))) {
    const skipped = { threadId, trigger, scheduledFor, retryOf, reason: "RETRY_WINDOW_PASSED" };
    record(host, skipped, now);
    return refusal(skipped);
  }
  // A retry is keyed by the run it repeats, so the reconnect and the backoff alarm open it once.
  const fireKey = trigger === "retry" ? `${threadId}:retry:${retryOf}` : `${threadId}:${trigger}:${scheduledFor}`;
  const result = await startRoutineRun(host, { threadId, trigger, scheduledFor, fireKey, now });
  if (trigger !== "schedule" && result.reason === "PREVIOUS_RUN_ACTIVE") await deferFire(host, payload, now);
  // Advance only after this slot was started, replayed, or explicitly skipped. A thrown fire keeps
  // the leased job, whose bounded retry owns the same slot.
  if (trigger === "schedule") await reconcileRoutineAlarm(host, threadId, now, scheduledFor);
  return result;
}

/**
 * A run whose browser work no browser picked up is retried once, before the Routine's next slot:
 * at the browser's next connection (`fireRoutineRetries`), or after the backoff. A retry's own
 * expiry is final, and so is a run with no slot left in its window.
 */
export async function retryRunAfterSyncExpiry(host, runThreadId, now = new Date().toISOString()) {
  const run = one(host, `SELECT run.parent_thread_id AS thread_id, run.trigger, routine.schedule_json FROM agent_threads run
    JOIN agent_threads routine ON routine.thread_id = run.parent_thread_id
    WHERE run.thread_id = ? AND routine.schedule_json IS NOT NULL AND routine.status = 'active'`, runThreadId);
  if (!run) return null;
  const schedule = JSON.parse(run.schedule_json);
  const retryAt = new Date(Date.parse(now) + (host.browserLive?.(now) ? DEFER_DELAY_MS : SYNC_RETRY_BACKOFF_MS)).toISOString();
  const retry = run.trigger !== "retry" && schedule.enabled === true && schedule.nextAt && retryAt < schedule.nextAt;
  record(host, { threadId: run.thread_id, trigger: run.trigger, runThreadId, reason: "SYNC_WAIT_EXPIRED", retryAt: retry ? retryAt : null }, now);
  if (!retry) return null;
  await host.jobs.schedule(new Date(retryAt), ROUTINE_ALARM, { threadId: run.thread_id, scheduledFor: null, trigger: "retry",
    retryOf: runThreadId, windowEndsAt: schedule.nextAt }, JOB_OPTIONS);
  return retryAt;
}

/** A browser coming back: open any armed retry now. */
export async function fireRoutineRetries(host, now = new Date().toISOString()) {
  const armed = (await host.jobs.list()).filter((item) => item.callback === ROUTINE_ALARM && item.payload?.trigger === "retry");
  for (const item of armed) {
    await runRoutineAlarm(host, item.payload, now);
    await host.jobs.cancel(item.id);
  }
  return armed.length;
}

/**
 * Every fire enters here. The run thread is an ordinary chat whose first turn is the Routine's
 * prompt; `permissions` (manual runs only) narrows the Routine's own for this one run.
 */
export async function startRoutineRun(host, { threadId, trigger, scheduledFor = null, fireKey, permissions, now = new Date().toISOString() }) {
  const account = host.account();
  if (!account) throw new Error("ACCOUNT_NOT_BOOTSTRAPPED");
  const routine = one(host, "SELECT * FROM agent_threads WHERE thread_id = ?", threadId);
  if (!routine || routine.account_id !== account.accountId || !routine.schedule_json) throw new Error("ROUTINE_NOT_FOUND");
  const detail = { threadId, trigger, scheduledFor };
  // Hashed before the transaction: everything that decides whether this fire opens a run commits
  // together, and an object yields on an await, where two fires could both pass a busy check.
  const fireHash = await sha256(fireKey);
  const runThreadId = `run_${fireHash.slice(0, 32)}`;
  const turnKey = `routine-run:${fireHash.slice(0, 48)}`;
  const completedFire = () => {
    const thread = threadRow(host.storage, runThreadId);
    const turn = one(host, "SELECT turn_id FROM agent_turns WHERE thread_id = ? AND idempotency_key = ?", runThreadId, turnKey);
    return thread && turn ? { allowed: true, created: false, thread: host.view(thread) } : null;
  };
  const prior = completedFire();
  if (prior) return prior;
  let prompt = routine.routine_prompt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let prepared;
    try {
      prepared = await host.runs.prepare({ threadId: runThreadId, input: prompt, idempotencyKey: turnKey });
    } catch (error) {
      const replay = error.message === "IDEMPOTENCY_CONFLICT" ? completedFire() : null;
      if (replay) return replay;
      throw error;
    }
    let outcome = null;
    let skipped = null;
    let changedPrompt = null;
    const skip = (reason, extra = {}) => { skipped = { ...detail, ...extra, reason }; outcome = refusal(skipped); return null; };
    const link = host.storage.transactionSync(() => {
      const existing = threadRow(host.storage, runThreadId);
      // A thread with no turn is an interrupted fire, not a finished one: finish it here.
      if (existing && prepared.existingTurnId) {
        outcome = { allowed: true, created: false, thread: host.view(existing) };
        return null;
      }
      // The await above is the race boundary: read the Routine and the account once, here.
      const current = one(host, "SELECT * FROM agent_threads WHERE thread_id = ?", threadId);
      if (!current || !current.schedule_json || current.status !== "active") return skip("ROUTINE_ARCHIVED");
      if (!host.account()?.active) return skip("ACCOUNT_PAUSED");
      const schedule = ["schedule", "retry"].includes(trigger) ? JSON.parse(current.schedule_json) : null;
      if (schedule && schedule.enabled !== true) return skip("ROUTINE_DISABLED");
      if (!existing && trigger === "schedule" && !matchesScheduledSlot(schedule, scheduledFor)) return skip("STALE_SCHEDULE");
      if (current.routine_prompt !== prompt) {
        changedPrompt = current.routine_prompt;
        return null;
      }
      const busy = host.runs.busy(threadId);
      if (busy && busy.thread_id !== runThreadId) return skip("PREVIOUS_RUN_ACTIVE", { runThreadId: busy.thread_id });
      if (!existing) {
        insertRunThread(host.storage, { threadId: runThreadId, routine: current, trigger, now,
          permissions: manualRunPermissions(storedPermissions(current), permissions) });
      }
      // Every fire is activity on the Routine, so its own row moves with its newest run.
      host.storage.sql.exec("UPDATE agent_threads SET updated_at = ? WHERE thread_id = ?", now, threadId);
      return host.runs.queue(prepared);
    });
    if (changedPrompt !== null) {
      prompt = changedPrompt;
      continue;
    }
    if (!link) {
      if (skipped) record(host, skipped, now);
      return outcome;
    }
    host.runs.finish(prepared, link);
    host.ledger("routine.fired", { ...detail, runThreadId }, now);
    host.log("routine.fired", { threadId, trigger, scheduledFor, runThreadId, outcome: "started" });
    return { allowed: true, created: true, thread: host.view(threadRow(host.storage, runThreadId)) };
  }
  throw new Error("ROUTINE_CHANGED_DURING_FIRE");
}

/**
 * A run started by hand. Its fire key is the caller's idempotency key, and only a fire that opened
 * a run occupies it (a skip answered once must not become the permanent answer). Narrower
 * permissions are part of the request, so a replayed key cannot change what its run may do.
 */
export async function requestRoutineRun(host, { threadId, idempotencyKey, permissions, now = new Date().toISOString() }) {
  const input = permissions === undefined ? { threadId, idempotencyKey } : { threadId, idempotencyKey, permissions: validatePermissions(permissions) };
  const recorded = await host.idempotent.replay("run_routine", input);
  if (recorded) return recorded;
  const result = await startRoutineRun(host, { threadId, trigger: "manual", fireKey: `${threadId}:manual:${idempotencyKey}`,
    permissions: input.permissions, now });
  if (result.allowed !== false) await host.idempotent.record("run_routine", input, result);
  return result;
}

function idle(host, now) {
  const since = host.lastSeen?.();
  return Boolean(since) && Date.parse(now) - Date.parse(since) > ROUTINE_IDLE_PAUSE_MS;
}

async function pauseIdleRoutine(host, threadId, scheduledFor, now) {
  const row = one(host, "SELECT schedule_json FROM agent_threads WHERE thread_id = ?", threadId);
  if (row?.schedule_json) {
    host.storage.sql.exec("UPDATE agent_threads SET schedule_json = ?, updated_at = ? WHERE thread_id = ?",
      JSON.stringify({ ...JSON.parse(row.schedule_json), enabled: false, nextAt: null }), now, threadId);
  }
  host.ledger("routine.paused_idle", { threadId, scheduledFor }, now);
  host.log("routine.paused_idle", { threadId, scheduledFor, outcome: "skipped", reason: "NO_RECENT_BROWSER" });
  await reconcileRoutineAlarm(host, threadId, now, scheduledFor);
  return { allowed: false, reason: "NO_RECENT_BROWSER" };
}

// Re-arms the same fire, keeping its payload (and so its fire key) as its identity, so the run it
// eventually opens is still that one request.
async function deferFire(host, payload, now) {
  const { threadId, scheduledFor, trigger, deferred = 0 } = payload;
  const attempt = Number(deferred) + 1;
  if (attempt > MAX_DEFERRALS) {
    host.ledger("routine.skipped", { threadId, trigger, scheduledFor, reason: "DEFERRAL_EXHAUSTED", deferred }, now);
    host.log("routine.skipped", { threadId, trigger, scheduledFor, reason: "DEFERRAL_EXHAUSTED", outcome: "skipped" });
    return;
  }
  const at = new Date(Date.parse(now) + DEFER_DELAY_MS);
  const scheduled = await host.jobs.schedule(at, ROUTINE_ALARM, { ...payload, deferred: attempt }, JOB_OPTIONS);
  host.ledger("routine.deferred", { threadId, trigger, scheduledFor, retryAt: at.toISOString(), deferred: attempt }, now);
  host.log("routine.deferred", { threadId, trigger, scheduledFor, nextAt: at.toISOString(), scheduleId: scheduled.id, attempt, reason: "PREVIOUS_RUN_ACTIVE" });
}

function refusal({ reason, runThreadId }) {
  return { allowed: false, reason, ...(runThreadId ? { runThreadId } : {}) };
}

function record(host, skipped, now) {
  host.ledger("routine.skipped", skipped, now);
  // The run a sync expiry ended and whether its one retry is armed (`nextAt`) or spent: the
  // Routine health patrol counts runs that did no work and retries that never came from these.
  const expiry = skipped.reason === "SYNC_WAIT_EXPIRED"
    ? { recovery: skipped.retryAt ? "retry_armed" : "no_retry", ...(skipped.retryAt ? { nextAt: skipped.retryAt } : {}) } : {};
  host.log("routine.skipped", { threadId: skipped.threadId, trigger: skipped.trigger, scheduledFor: skipped.scheduledFor,
    runThreadId: skipped.runThreadId, reason: skipped.reason, outcome: "skipped", ...expiry });
}
