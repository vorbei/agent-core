// An explicit user retry of a turn that failed or was cancelled: the same turn row is queued again
// with another bounded model and tool allowance on the same journal, call ids and receipts. Leases,
// attempts already spent and settled calls are never reset. From X Gardener
// src/cf/account/turn-retry.js; which turns may be retried, under which permissions, and what other
// open work blocks a retry are the product's.
import { nowIso } from "./stamps.js";
import { grantManualRetry } from "./turn-budget.js";
import { scheduleTurns } from "./turn-scheduler.js";

const one = (host, query, ...bindings) => host.storage.sql.exec(query, ...bindings).toArray()[0] || null;

/**
 * Queues `turnId` again for a user's retry, once per idempotency key (a repeated key changes
 * nothing). Refuses with TURN_NOT_FOUND, TURN_NOT_RETRYABLE (not failed or cancelled, or the
 * product's `retryable` says no), TURN_RETRY_NOT_LATEST (a later turn exists in the thread),
 * TURN_RETRY_PENDING_CALLS (an executor call is still open), or the code `pendingWork` returns.
 * `permissions(row)` is the permissions JSON the retried turn runs under (default: its own); it may
 * throw to refuse. Returns whether the turn was queued by this call.
 * @param {import("./index.js").TurnHost} host
 * @param {string} turnId
 * @param {string} idempotencyKey
 * @param {import("./index.js").RetryOptions} options
 */
export function queueTurnRetry(host, turnId, idempotencyKey, { turnBudget, retryable = () => true, permissions = row => row.permissions_json, pendingWork = () => null }) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 160) throw new Error("INVALID_IDEMPOTENCY_KEY");
  let previousError;
  let changed = false;
  const now = nowIso(host);
  host.storage.transactionSync(() => {
    const row = one(host, "SELECT * FROM agent_turns WHERE turn_id = ?", turnId);
    if (!row) throw new Error("TURN_NOT_FOUND");
    if (!retryable(row)) throw new Error("TURN_NOT_RETRYABLE");
    const saved = JSON.parse(row.checkpoint_json || "{}");
    if (saved.budget?.manualRetryKey === idempotencyKey) return;
    if (!["failed", "cancelled"].includes(row.status)) throw new Error("TURN_NOT_RETRYABLE");
    const permissionsJson = permissions(row);
    if (one(host, "SELECT turn_id FROM agent_turns WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1", row.thread_id)?.turn_id !== turnId) throw new Error("TURN_RETRY_NOT_LATEST");
    if (one(host, "SELECT call_id FROM agent_function_calls WHERE turn_id = ? AND status IN ('created', 'claimed') LIMIT 1", turnId)) throw new Error("TURN_RETRY_PENDING_CALLS");
    const blocked = pendingWork(turnId);
    if (blocked) throw new Error(blocked);
    saved.budget = grantManualRetry(saved.budget, { idempotencyKey, attempt: row.attempt, attemptBudget: host.maxAttempts, turnBudget });
    saved.retryNotBefore = 0;
    saved.citationRepairs = 0;
    saved.outputReview = {};
    previousError = row.error_code;
    host.storage.sql.exec(`UPDATE agent_turns SET status='queued', phase='queued', error_code=NULL,
      lease_id=NULL, lease_expires_at=NULL, waiting_ref=NULL, completed_at=NULL, updated_at=?,
      permissions_json=?, checkpoint_json=? WHERE turn_id=?`, now, permissionsJson, JSON.stringify(saved), turnId);
    changed = true;
  });
  if (changed) {
    host.log("agent.turn.manual_retry", { turnId, previousError });
    scheduleTurns(host);
  }
  return { retried: changed };
}
