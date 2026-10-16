// Where threads, Routines and their runs are stored: the `agent_threads` table (a Routine is a
// thread that carries a schedule and a prompt; a run is a child thread with a trigger), its reads
// with the newest turn's state, and the writes the Routine engine makes. Adopted unchanged from
// X Gardener's account storage, so no column, status value or index is renamed.
import { validatePermissions, validateRoutinePrompt, validateRoutineSchedule } from "./schedule.js";

export const THREADS_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  instruction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  context_policy TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '{"update":true,"write":true}',
  crystallize INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT,
  routine_prompt TEXT,
  parent_thread_id TEXT,
  trigger TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
, model TEXT)`,
  "CREATE INDEX IF NOT EXISTS agent_threads_account_updated ON agent_threads(account_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS agent_threads_parent ON agent_threads(parent_thread_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS agent_threads_schedule ON agent_threads(status, schedule_json)"
]);

/**
 * The columns of `agent_threads` beyond a minimal thread row (id, account, status, timestamps), as
 * `ALTER TABLE ... ADD COLUMN` definitions, for a host whose older table lacks them.
 */
export const THREAD_COLUMNS = Object.freeze([
  ["kind", "TEXT NOT NULL DEFAULT 'chat'"], ["title", "TEXT"], ["instruction", "TEXT NOT NULL DEFAULT ''"],
  ["context_policy", "TEXT NOT NULL DEFAULT 'continuous'"], ["permissions_json", `TEXT NOT NULL DEFAULT '{"update":true,"write":true}'`],
  ["crystallize", "INTEGER NOT NULL DEFAULT 1"], ["schedule_json", "TEXT"], ["routine_prompt", "TEXT"], ["parent_thread_id", "TEXT"],
  ["trigger", "TEXT"], ["model", "TEXT"]
]);

// A thread with its newest turn (a steer merged into another turn is not one).
const THREAD_SELECT = `SELECT threads.*,
      latest.status AS latest_turn_status,
      latest.updated_at AS latest_turn_updated_at,
      latest.final_answer AS latest_turn_answer,
      latest.delivery_json AS latest_turn_delivery
    FROM agent_threads threads
    LEFT JOIN agent_turns latest ON latest.rowid = (
      SELECT rowid FROM agent_turns
      WHERE thread_id = threads.thread_id
        AND json_type(input_json, '$.mergedIntoTurnId') IS NULL
      ORDER BY rowid DESC LIMIT 1
    )`;

const one = (storage, query, ...params) => storage.sql.exec(query, ...params).toArray()[0] || null;

export function threadRow(storage, threadId) {
  return one(storage, `${THREAD_SELECT} WHERE threads.thread_id = ?`, threadId);
}

/** Active threads, newest activity first: all of them, only Routines, or no Routine and no run. */
export function threadRows(storage, { routines = "all", limit }) {
  const filter = routines === "only" ? "AND threads.schedule_json IS NOT NULL"
    : routines === "none" ? "AND threads.schedule_json IS NULL AND threads.parent_thread_id IS NULL" : "";
  return storage.sql.exec(`${THREAD_SELECT} WHERE threads.status = 'active' ${filter}
     ORDER BY threads.updated_at DESC LIMIT ?`, limit).toArray();
}

/** A Routine's active runs, newest first. */
export function runRows(storage, { parentThreadId, limit }) {
  return storage.sql.exec(`${THREAD_SELECT} WHERE threads.parent_thread_id = ? AND threads.status = 'active'
     ORDER BY threads.created_at DESC, threads.thread_id DESC LIMIT ?`, parentThreadId, limit).toArray();
}

/** Every Routine that may still fire; read on start to re-arm one alarm each. */
export function scheduledRoutineRows(storage) {
  return storage.sql.exec("SELECT * FROM agent_threads WHERE status = 'active' AND schedule_json IS NOT NULL ORDER BY thread_id").toArray();
}

export function insertRoutine(storage, { threadId, accountId, title, routinePrompt, permissions, schedule, enabled, now }) {
  storage.sql.exec(
    `INSERT INTO agent_threads
     (thread_id, account_id, kind, title, instruction, status, context_policy, permissions_json, crystallize,
      schedule_json, routine_prompt, created_at, updated_at, archived_at)
     VALUES (?, ?, 'chat', ?, '', 'active', 'continuous', ?, 1, ?, ?, ?, ?, NULL)`,
    threadId, accountId, title, JSON.stringify(validatePermissions(permissions)),
    JSON.stringify(validateRoutineSchedule({ ...schedule, enabled, nextAt: null })), validateRoutinePrompt(routinePrompt), now, now
  );
  return threadRow(storage, threadId);
}

/** Only the fields the caller sent change; `nextAt` belongs to the scheduler alone. */
export function updateRoutineRow(storage, { threadId, title, routinePrompt, permissions, schedule, enabled, now }) {
  const row = one(storage, "SELECT * FROM agent_threads WHERE thread_id = ?", threadId);
  if (!row || !row.schedule_json) throw new Error("ROUTINE_NOT_FOUND");
  if (row.status !== "active") throw new Error("AGENT_THREAD_NOT_ACTIVE");
  const current = JSON.parse(row.schedule_json);
  const next = validateRoutineSchedule({
    ...(schedule ? { ...schedule } : { days: current.days, localTime: current.localTime, timezone: current.timezone,
      ...(current.jitterMinutes ? { jitterMinutes: current.jitterMinutes } : {}) }),
    enabled: enabled === undefined ? current.enabled : enabled,
    // A changed clock or a disabled Routine invalidates the stored next fire.
    nextAt: schedule || enabled === false ? null : current.nextAt
  });
  storage.sql.exec(
    `UPDATE agent_threads SET title = COALESCE(?, title), permissions_json = COALESCE(?, permissions_json),
       routine_prompt = COALESCE(?, routine_prompt), schedule_json = ?, updated_at = ? WHERE thread_id = ?`,
    title ?? null, permissions === undefined ? null : JSON.stringify(validatePermissions(permissions)),
    routinePrompt === undefined ? null : validateRoutinePrompt(routinePrompt), JSON.stringify(next), now, threadId
  );
  return threadRow(storage, threadId);
}

export function recordNextAt(storage, threadId, nextAt, now) {
  storage.sql.exec(
    "UPDATE agent_threads SET schedule_json = json_set(schedule_json, '$.nextAt', ?), updated_at = ? WHERE thread_id = ? AND schedule_json IS NOT NULL",
    nextAt, now, threadId
  );
}

/**
 * A run's thread: an ordinary chat under its Routine, named and set up as the Routine is,
 * including the instruction the Routine stores (an earlier editor's). A Routine has no model of
 * its own: a model an old row still stores is ignored, and the run uses the default model.
 */
export function insertRunThread(storage, { threadId, routine, permissions, trigger, now }) {
  storage.sql.exec(
    `INSERT INTO agent_threads
     (thread_id, account_id, kind, title, instruction, status, context_policy, permissions_json, crystallize,
      model, parent_thread_id, trigger, created_at, updated_at, archived_at)
     VALUES (?, ?, 'chat', ?, ?, 'active', 'continuous', ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    threadId, routine.account_id, routine.title, routine.instruction || "", JSON.stringify(validatePermissions(permissions)),
    routine.crystallize !== 0 ? 1 : 0, routine.thread_id, trigger, now, now
  );
}

/** The {update, write} a stored thread holds. */
export function storedPermissions(row) {
  return validatePermissions(JSON.parse(row.permissions_json));
}

/** The newest run of a Routine, for a list row: its thread, trigger, state and start. */
export function lastRun(storage, threadId) {
  const row = runRows(storage, { parentThreadId: threadId, limit: 1 })[0];
  return row ? { threadId: row.thread_id, trigger: row.trigger, status: row.latest_turn_status || null, createdAt: row.created_at } : null;
}

/**
 * Recoverable archival of a Routine with its runs: it leaves the lists, its schedule is off, its
 * receipts stay. `busy` names an unfinished run, which holds it open.
 */
export function archiveRoutine(storage, { accountId, threadId, now, busy }) {
  return storage.transactionSync(() => {
    const thread = one(storage, "SELECT * FROM agent_threads WHERE thread_id = ? AND account_id = ?", threadId, accountId);
    if (!thread) throw new Error("AGENT_THREAD_NOT_FOUND");
    if (!thread.schedule_json) throw new Error("AGENT_THREAD_KIND_INVALID");
    if (thread.status === "archived") return thread;
    if (busy(threadId)) throw new Error("AGENT_THREAD_BUSY");
    storage.sql.exec(`UPDATE agent_threads SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE parent_thread_id = ? AND status = 'active'`, now, now, threadId);
    storage.sql.exec("UPDATE agent_threads SET schedule_json = json_set(schedule_json, '$.enabled', json('false'), '$.nextAt', NULL) WHERE thread_id = ?", threadId);
    storage.sql.exec("UPDATE agent_threads SET status = 'archived', archived_at = ?, updated_at = ? WHERE thread_id = ?", now, now, threadId);
    return one(storage, "SELECT * FROM agent_threads WHERE thread_id = ?", threadId);
  });
}
