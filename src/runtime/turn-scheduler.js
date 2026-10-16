// Which queued turn runs next and under which lease: claim (one unfinished turn per thread, the
// account's model concurrency, the attempt budget, the host's priority), the lease checks every
// write is fenced by, and starting ready turns into free model slots.
// From X Gardener src/cf/account/turn-scheduler.js.
import { createId, nowIso, nowMs } from "./stamps.js";

/** A running turn's lease, and the floor of the lease the host's model deadline stretches. */
export const TURN_LEASE_MS = 2 * 60_000;
// While a model request is in flight the lease ends at its deadline plus this margin, so a
// request whose executor was lost is reclaimed then, not after the whole turn lease; settling the
// request restores the turn lease.
export const MODEL_REQUEST_LEASE_MARGIN_MS = 15_000;

const TERMINAL = "('completed', 'failed', 'cancelled')";
const priorityOf = (host, row) => (host.turnPriority ? host.turnPriority(row) : 0);

/** The lease of a running attempt: at least TURN_LEASE_MS, and two model deadlines (of that turn's model, when named). */
export const turnLeaseMs = (host, turnId) => Math.max(TURN_LEASE_MS, 2 * host.modelDeadlineMs(turnId));

export function claimTurn(host, turnId, now = nowIso(host)) {
  const { storage } = host;
  let claim = null;
  let exhausted = false;
  storage.transactionSync(() => {
    const row = one(storage, "SELECT rowid AS storage_rowid, * FROM agent_turns WHERE turn_id = ?", turnId);
    if (!row || ["completed", "failed", "cancelled", "waiting_for_browser", "waiting_for_approval"].includes(row.status)) return;
    if (Number(JSON.parse(row.checkpoint_json || "{}").retryNotBefore || 0) > Date.parse(now)) return;
    if (row.status === "running" && row.lease_expires_at && row.lease_expires_at >= now) return;
    const predecessor = one(storage,
      `SELECT turn_id FROM agent_turns
       WHERE thread_id = ? AND rowid < ?
         AND status NOT IN ${TERMINAL}
       ORDER BY rowid LIMIT 1`,
      row.thread_id, row.storage_rowid
    );
    if (predecessor) return;
    // A lower-priority turn never takes the model slot an eligible higher-priority one waits for.
    const priority = priorityOf(host, row);
    if (priority > 0 && readyTurns(host).some(other => priorityOf(host, other) < priority)) return;
    const active = Number(one(storage,
      `SELECT COUNT(*) AS count FROM agent_turns
       WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at >= ?)`,
      now
    )?.count || 0);
    if (active >= host.modelConcurrency()) return;
    const attempt = Number(row.attempt || 0) + 1;
    if (attempt > (JSON.parse(row.checkpoint_json || "{}").budget?.attemptBudget || host.maxAttempts)) {
      storage.sql.exec(
        `UPDATE agent_turns SET status = 'failed', phase = 'done', error_code = 'TURN_ATTEMPTS_EXHAUSTED',
         lease_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE turn_id = ?`,
        now, now, turnId
      );
      exhausted = true;
      return;
    }
    const leaseId = createId("lease");
    const leaseExpiresAt = new Date(Date.parse(now) + turnLeaseMs(host, turnId)).toISOString();
    storage.sql.exec(
      `UPDATE agent_turns SET status = 'running', phase = 'model', attempt = ?, lease_id = ?,
       lease_expires_at = ?, updated_at = ? WHERE turn_id = ?`,
      attempt, leaseId, leaseExpiresAt, now, turnId
    );
    claim = { attempt, leaseId, leaseExpiresAt };
  });
  if (exhausted) scheduleTurns(host);
  return claim;
}

/** Shortens the lease to the model deadline while a request is in flight, restores it after. */
export function renewModelRequestLease(host, turnId, claim, inFlight, now = nowMs(host)) {
  const leaseMs = inFlight ? host.modelDeadlineMs(turnId) + MODEL_REQUEST_LEASE_MARGIN_MS : turnLeaseMs(host, turnId);
  host.storage.sql.exec(
    "UPDATE agent_turns SET lease_expires_at = ? WHERE turn_id = ? AND lease_id = ? AND attempt = ? AND status = 'running'",
    new Date(now + leaseMs).toISOString(), turnId, claim.leaseId, claim.attempt
  );
  // A failed re-arm keeps the previous wake; recovery is then only slower.
  host.background(host.armWatchdog().catch(() => {}));
}

/** Starts the ready queued turns that fit the free model slots, higher priority first, then oldest. */
export function scheduleTurns(host) {
  const active = Number(one(host.storage,
    "SELECT COUNT(*) AS count FROM agent_turns WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at >= ?)",
    nowIso(host)
  )?.count || 0);
  const capacity = Math.max(0, host.modelConcurrency() - active);
  if (!capacity) return [];
  const ready = readyTurns(host)
    .map(row => ({ row, priority: priorityOf(host, row) }))
    .sort((a, b) => a.priority - b.priority || a.row.storage_rowid - b.row.storage_rowid)
    .slice(0, capacity)
    .map(({ row }) => row.turn_id);
  for (const turnId of ready) {
    host.background(host.startAttempt(turnId).catch((error) => {
      host.log("agent.turn.background_failed", {
        turnId,
        errorCode: error.code || "TURN_BACKGROUND_FAILED",
        errorMessage: error.message
      });
    }));
  }
  return ready;
}

export function hasTurnLease(host, turnId, leaseId, attempt) {
  const row = one(host.storage, "SELECT lease_id, attempt, status, lease_expires_at FROM agent_turns WHERE turn_id = ?", turnId);
  return row?.status === "running" && row.lease_id === leaseId && Number(row.attempt) === Number(attempt)
    && row.lease_expires_at > nowIso(host);
}

/** Throws MODEL_TURN_LEASE_LOST when the claim no longer holds the turn. */
export function assertTurnLease(host, turnId, claim) {
  if (!hasTurnLease(host, turnId, claim.leaseId, claim.attempt)) {
    throw Object.assign(new Error("Turn lease is no longer current"), { code: "MODEL_TURN_LEASE_LOST" });
  }
}

// Queued turns that may start now: past any retry delay and first unfinished in their thread.
function readyTurns(host) {
  return host.storage.sql.exec(
    `SELECT candidate.rowid AS storage_rowid, candidate.turn_id, candidate.thread_id FROM agent_turns AS candidate
     WHERE candidate.status = 'queued'
       AND COALESCE(json_extract(candidate.checkpoint_json, '$.retryNotBefore'), 0) <= ?
       AND NOT EXISTS (
         SELECT 1 FROM agent_turns AS predecessor
         WHERE predecessor.thread_id = candidate.thread_id
           AND predecessor.rowid < candidate.rowid
           AND predecessor.status NOT IN ${TERMINAL}
       )
     ORDER BY candidate.rowid`,
    nowMs(host)
  ).toArray();
}

function one(storage, query, ...bindings) {
  return storage.sql.exec(query, ...bindings).toArray()[0] || null;
}
