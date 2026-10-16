// A Routine's definition as callers change and read it: create, update and delete (each
// idempotent, each reconciling the Routine's alarm), and the list and detail projections (a
// Routine with its newest run, or with its run history).
import { sha256 } from "../runtime/index.js";
import { reconcileRoutineAlarm } from "./fire.js";
import { validatePermissions, validateRoutinePrompt, validateRoutineSchedule } from "./schedule.js";
import { archiveRoutine, insertRoutine, lastRun, runRows, threadRow, threadRows, updateRoutineRow } from "./store.js";

export const ROUTINE_LIST_PROJECTION_VERSION = "routine-list-projection-v1";
export const ROUTINE_PROJECTION_VERSION = "routine-projection-v1";

const bounded = (value, fallback) => Math.max(1, Math.min(100, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback));

export function routineList(host, { limit = 20 } = {}) {
  return {
    version: ROUTINE_LIST_PROJECTION_VERSION,
    items: threadRows(host.storage, { routines: "only", limit: bounded(limit, 20) })
      .map((row) => ({ thread: host.view(row), lastRun: lastRun(host.storage, row.thread_id) }))
  };
}

export function routineDetail(host, { threadId, limit = 20 } = {}) {
  return {
    version: ROUTINE_PROJECTION_VERSION,
    thread: host.view(requireRoutine(host, threadId)),
    runs: runRows(host.storage, { parentThreadId: threadId, limit: bounded(limit, 20) }).map(host.view)
  };
}

/** A new Routine; its id derives from the idempotency key, so a retried create finds its own. */
export async function addRoutine(host, input) {
  const { now: _now, ...stable } = input;
  const account = host.account();
  if (!account) throw new Error("ACCOUNT_NOT_BOOTSTRAPPED");
  const threadId = `routine_${(await sha256(`create_routine:${account.accountId}:${input.idempotencyKey}`)).slice(0, 32)}`;
  const creation = {
    title: input.title,
    routinePrompt: validateRoutinePrompt(input.routinePrompt),
    permissions: validatePermissions(input.permissions ?? host.defaultPermissions),
    schedule: validateRoutineSchedule({ ...input.schedule, enabled: input.enabled, nextAt: null })
  };
  return host.idempotent.run("create_routine", stable, async () => {
    const now = input.now || new Date().toISOString();
    let created = false;
    host.storage.transactionSync(() => {
      const existing = host.storage.sql.exec("SELECT * FROM agent_threads WHERE thread_id = ?", threadId).toArray()[0];
      if (existing) {
        if (!sameCreation(existing, account.accountId, creation)) throw new Error("IDEMPOTENCY_CONFLICT");
        return;
      }
      insertRoutine(host.storage, { threadId, accountId: account.accountId, ...creation, enabled: creation.schedule.enabled, now });
      created = true;
    });
    if (created) {
      host.ledger("routine.created", { threadId, title: creation.title, enabled: creation.schedule.enabled }, now);
      host.log("routine.created", { accountId: account.accountId, threadId, outcome: "created" });
    }
    // The thread is the mutation; its alarm is derived, on the first attempt and on a retry.
    await reconcileRoutineAlarm(host, threadId, now);
    return routineDetail(host, { threadId });
  });
}

export function editRoutine(host, input) {
  const { now: _now, ...stable } = input;
  return host.idempotent.run("update_routine", stable, async () => {
    const now = input.now || new Date().toISOString();
    requireRoutine(host, input.threadId);
    updateRoutineRow(host.storage, { ...input, now });
    host.ledger("routine.updated", { threadId: input.threadId, ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      changed: Object.keys(stable).filter((key) => !["threadId", "idempotencyKey"].includes(key)) }, now);
    host.log("routine.updated", { threadId: input.threadId, outcome: "updated" });
    await reconcileRoutineAlarm(host, input.threadId, now);
    return routineDetail(host, { threadId: input.threadId });
  });
}

/** Recoverable archival: the definition and its runs leave the lists, receipts stay, future fires stop. */
export async function deleteRoutine(host, { threadId, now = new Date().toISOString() }) {
  const account = host.account();
  if (!account) throw new Error("ACCOUNT_NOT_BOOTSTRAPPED");
  archiveRoutine(host.storage, { accountId: account.accountId, threadId, now, busy: host.runs.busy });
  host.ledger("routine.deleted", { threadId }, now);
  host.log("routine.deleted", { accountId: account.accountId, threadId, outcome: "archived" });
  await reconcileRoutineAlarm(host, threadId, now);
  return host.view(threadRow(host.storage, threadId));
}

function requireRoutine(host, threadId) {
  const row = threadRow(host.storage, threadId);
  const account = host.account();
  if (!row || !row.schedule_json || (account && row.account_id !== account.accountId)) throw new Error("ROUTINE_NOT_FOUND");
  return row;
}

function sameCreation(row, accountId, creation) {
  if (row.account_id !== accountId || row.status !== "active" || !row.schedule_json) return false;
  const schedule = JSON.parse(row.schedule_json);
  return row.title === creation.title && row.routine_prompt === creation.routinePrompt
    && JSON.stringify(JSON.parse(row.permissions_json)) === JSON.stringify(creation.permissions)
    && JSON.stringify(schedule.days) === JSON.stringify(creation.schedule.days)
    && schedule.localTime === creation.schedule.localTime && schedule.timezone === creation.schedule.timezone
    && schedule.enabled === creation.schedule.enabled;
}
