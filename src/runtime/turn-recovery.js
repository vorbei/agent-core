// Reclaims what a lost executor or attempt left behind, then reschedules: calls no executor
// claimed in time fail their turn, expired call leases settle as timeouts (a write's effect is
// unknown), and expired turn leases requeue the turn until its attempt budget is used.
// From X Gardener src/cf/account/turn-scheduler.js (recoverAgentWork).
import { EXECUTOR_OFFLINE, parkedExpiry, settleFunctionCall } from "./function-calls.js";
import { nowIso } from "./stamps.js";
import { scheduleTurns } from "./turn-scheduler.js";

export async function recoverTurns(host, now = nowIso(host)) {
  const { storage } = host;
  const rows = (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray();
  const cutoff = new Date(Date.parse(now) - host.executorClaimWaitMs).toISOString();
  const abandoned = rows(`SELECT t.turn_id FROM agent_turns t
    WHERE t.status='waiting_for_browser' AND t.updated_at < ?
      AND EXISTS (SELECT 1 FROM agent_function_calls c WHERE c.turn_id=t.turn_id AND c.status='created')
      AND NOT EXISTS (SELECT 1 FROM agent_function_calls c WHERE c.turn_id=t.turn_id AND c.status='claimed')`, cutoff);
  for (const turn of abandoned) {
    storage.transactionSync(() => {
      for (const call of rows("SELECT * FROM agent_function_calls WHERE turn_id=? AND status='created'", turn.turn_id))
        settleFunctionCall(host, call, { result: null, errorCode: EXECUTOR_OFFLINE, now });
      storage.sql.exec(`UPDATE agent_turns SET status='failed',phase='done',error_code=?,
        waiting_ref=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE turn_id=?`, EXECUTOR_OFFLINE, now, now, turn.turn_id);
    });
    host.log("agent.turn.browser_unavailable", { turnId: turn.turn_id, errorCode: EXECUTOR_OFFLINE, waitMs: host.executorClaimWaitMs });
    host.notify?.(["ui", "work"]);
  }
  // Calls the host holds open for something outside the runtime (an approval) resume here.
  host.external?.recover?.(now);
  for (const call of rows("SELECT * FROM agent_function_calls WHERE status = 'claimed' AND lease_expires_at < ?", now)) {
    const readOnly = host.calls?.readOnly ? host.calls.readOnly(call.function_name, JSON.parse(call.input_json)) : true;
    // A parked call the executor never answered settles with the miss it stored when it parked.
    const expiry = parkedExpiry(call);
    const errorCode = expiry ? null : readOnly ? "BROWSER_FUNCTION_TIMEOUT" : "EFFECT_UNKNOWN";
    let settled;
    try {
      settled = settleFunctionCall(host, call, { result: expiry, errorCode, now });
    } catch (error) {
      if (error.message !== "FUNCTION_CALL_TURN_INVALID") throw error;
      // The turn already left waiting_for_browser (cancelled, orphaned, or failed); close the row so it is not reselected forever.
      storage.sql.exec(
        "UPDATE agent_function_calls SET status = 'failed', error_code = ?, lease_id = NULL, updated_at = ? WHERE call_id = ?",
        errorCode || "BROWSER_FUNCTION_TIMEOUT", now, call.call_id
      );
      continue;
    }
    host.log("agent.function.exhausted", {
      accountId: call.account_id,
      callId: call.call_id,
      turnId: call.turn_id,
      functionName: call.function_name,
      errorCode,
      pendingFunctions: settled.pending,
      recovery: "resume_with_error_result"
    });
    if (!settled.resume) continue;
    scheduleTurns(host);
  }
  storage.sql.exec(
    "UPDATE agent_turns SET status = 'queued', phase = 'queued', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND lease_expires_at < ? AND attempt < COALESCE(json_extract(checkpoint_json, '$.budget.attemptBudget'), ?)",
    now, now, host.maxAttempts
  );
  storage.sql.exec(
    `UPDATE agent_turns SET status = 'failed', phase = 'done', error_code = 'TURN_ATTEMPTS_EXHAUSTED',
     lease_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
     WHERE status = 'running' AND lease_expires_at < ? AND attempt >= COALESCE(json_extract(checkpoint_json, '$.budget.attemptBudget'), ?)`,
    now, now, now, host.maxAttempts
  );
  const scheduled = scheduleTurns(host);
  if (scheduled.length) host.log("agent.turn.recovery_started", { count: scheduled.length, at: now });
}
