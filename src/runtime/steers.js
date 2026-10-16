// Steers: a user message sent while its thread's turn runs is a queued turn row (whileRunning
// "steer") that the running attempt takes at Pi's step boundaries. Taken, it is `placing`: still
// queued, marked with the attempt's lease. Delivered, it is `placed`: completed and merged into the
// running turn, in the same commit as the journal entry that carries it. A mark whose attempt is
// gone is released, and the steer is placed again or answered as its own turn.
// From X Gardener src/cf/account/turns.js.
import { nowIso } from "./stamps.js";

/**
 * Marks the thread's oldest unplaced steer that `accepts` (a product rule over the row, such as
 * permissions) as placing under `leaseId` and returns it, or null. One transaction.
 * @param {import("./index.js").TurnHost} host
 * @param {{ turn: { account_id: string, thread_id: string, storage_rowid: number }, leaseId: string, accepts?: (row: { turn_id: string, input: any, permissions: any }) => boolean }} request
 */
export function takeSteer(host, { turn, leaseId, accepts = () => true }) {
  return host.storage.transactionSync(() => {
    const candidates = host.storage.sql.exec(`SELECT turn_id, input_json, permissions_json FROM agent_turns
      WHERE account_id = ? AND thread_id = ? AND rowid > ? AND status = 'queued' AND attempt = 0
        AND json_extract(input_json, '$.whileRunning') = 'steer'
        AND json_type(input_json, '$.placingLease') IS NULL
      ORDER BY rowid`, turn.account_id, turn.thread_id, turn.storage_rowid).toArray()
      .map(row => ({ turn_id: row.turn_id, input: JSON.parse(row.input_json), permissions: JSON.parse(row.permissions_json || "{}") || {} }));
    const steer = candidates.find(row => accepts(row));
    if (!steer) return null;
    host.storage.sql.exec("UPDATE agent_turns SET input_json = json_set(input_json, '$.placingLease', ?) WHERE turn_id = ?",
      leaseId, steer.turn_id);
    return { id: steer.turn_id, input: steer.input };
  });
}

/** The placed steer is merged into the running turn. Call in the transaction that writes the journal entry carrying it. */
export function mergeSteer(host, { turnId, steerId, leaseId, now = nowIso(host) }) {
  host.storage.sql.exec(`UPDATE agent_turns SET status = 'completed', phase = 'done',
          input_json = json_set(json_remove(input_json, '$.placingLease'), '$.mergedIntoTurnId', ?), final_answer = '', updated_at = ?, completed_at = ?
          WHERE turn_id = ? AND status = 'queued' AND json_extract(input_json, '$.placingLease') = ?`, turnId, now, now, steerId, leaseId);
}

/**
 * Releases placing marks: those of one attempt (`leaseId`, when it ends), or every mark in a
 * thread (`threadId`, when an attempt starts: one turn per thread runs at a time, so every mark
 * there belongs to a lost attempt).
 * @param {import("./index.js").TurnHost} host
 * @param {{ leaseId: string } | { threadId: string }} scope
 */
export function releaseSteers(host, scope) {
  if ("leaseId" in scope) host.storage.sql.exec(`UPDATE agent_turns SET input_json = json_remove(input_json, '$.placingLease')
      WHERE status = 'queued' AND json_extract(input_json, '$.placingLease') = ?`, scope.leaseId);
  else host.storage.sql.exec(`UPDATE agent_turns SET input_json = json_remove(input_json, '$.placingLease')
      WHERE thread_id = ? AND status = 'queued' AND json_type(input_json, '$.placingLease') IS NOT NULL`, scope.threadId);
}

/** A JSON value SQLite reads as 0 (absent, null, false or 0): a flag that is not set. */
export const unset = value => value === undefined || value === null || value === false || value === 0;
