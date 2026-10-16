// The executor-call queue: a tool call that an executor outside the runtime runs (the browser
// extension) is a durable row; the turn waits while the executor claims it under a lease and
// settles it once, and resumes when the last call of its step is settled.
// From X Gardener src/cf/account/function-calls.js; what the product adds (input contracts, who
// may claim what, how a result enters the turn's checkpoint) arrives through the host.
import { appendTurnStep } from "./turn-steps.js";
import { createId, nowIso, sha256 } from "./stamps.js";
import { scheduleTurns, TURN_LEASE_MS } from "./turn-scheduler.js";

/** The error a call settles with when no executor claimed it within the host's wait. */
export const EXECUTOR_OFFLINE = "CHROME_OFFLINE";
// A claim of a call that may write is final: it is never leased again.
const FINAL_ATTEMPT = 3;

const one = (host, query, ...bindings) => host.storage.sql.exec(query, ...bindings).toArray()[0] || null;
const readOnlyCall = (host, name, input) => (host.calls?.readOnly ? host.calls.readOnly(name, input) : true);

/**
 * Queues a call for the executor and records its `created` step. `input` is what the executor
 * receives (host-owned attachments included); `readContext` is host state kept with the call.
 */
export function insertFunctionCall(host, { turnId, accountId, toolCallId, functionName, input, readContext = null, logFields = {} }) {
  const now = nowIso(host);
  const callId = createId("call");
  host.storage.sql.exec(
    `INSERT INTO agent_function_calls
     (call_id, turn_id, account_id, function_name, tool_call_id, input_json, status, created_at, updated_at, read_context_json)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    callId, turnId, accountId, functionName, toolCallId, JSON.stringify(input), now, now,
    readContext ? JSON.stringify({ id: callId, ...readContext }) : null
  );
  const turn = one(host, "SELECT attempt, thread_id FROM agent_turns WHERE turn_id = ?", turnId);
  appendTurnStep(host, turnId, Number(turn?.attempt || 0), "function", "created", { toolName: functionName, toolCallId });
  host.log("agent.function.created", {
    accountId,
    threadId: turn?.thread_id || null,
    turnId,
    callId,
    functionName,
    ...logFields
  });
  return callId;
}

/**
 * Leases the oldest claimable call of a waiting turn to the executor. `excludeCallIds` are calls
 * whose result the executor is still delivering. Returns null when the host refuses the claimant,
 * `{ callId: null, activeTurns }` when nothing is claimable.
 */
export function claimFunctionCall(host, { installId, identity = null, excludeCallIds = [], now = nowIso(host) }) {
  const scope = host.claimScope ? host.claimScope({ installId, identity }) : { accept: true };
  if (!scope?.accept) return null;
  const excluded = JSON.stringify(excludeCallIds);
  host.storage.sql.exec(
    `UPDATE agent_function_calls SET status = 'created', lease_id = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE status = 'claimed' AND lease_expires_at < ? AND attempt < ${FINAL_ATTEMPT} AND call_id NOT IN (SELECT value FROM json_each(?))
       AND json_extract(result_json, '$.parked') IS NULL`,
    now, now, excluded
  );
  const row = one(host, `SELECT calls.* FROM agent_function_calls calls
    JOIN agent_turns turns ON turns.turn_id = calls.turn_id
    WHERE calls.status = 'created' AND calls.attempt < ${FINAL_ATTEMPT} AND turns.status = 'waiting_for_browser'
      AND calls.call_id NOT IN (SELECT value FROM json_each(?))
      AND calls.function_name NOT IN (SELECT value FROM json_each(?))
    ORDER BY calls.created_at, calls.rowid LIMIT 1`, excluded, JSON.stringify(scope.excludedNames || []));
  if (!row) {
    // Preserve pull diagnostics even with push hints. An empty claim is not proof of completion
    // and does not create a second execution or delivery ledger.
    const activeTurns = Number(one(host,
      "SELECT COUNT(*) AS count FROM agent_turns WHERE status IN ('queued', 'running', 'waiting_for_browser')"
    )?.count || 0);
    return { callId: null, activeTurns };
  }
  const leaseId = createId("lease");
  const writes = !readOnlyCall(host, row.function_name, JSON.parse(row.input_json));
  const leaseExpiresAt = new Date(Date.parse(now) + (host.executorLeaseMs ?? TURN_LEASE_MS)).toISOString();
  host.storage.sql.exec(
    "UPDATE agent_function_calls SET status = 'claimed', attempt = ?, lease_id = ?, lease_expires_at = ?, updated_at = ? WHERE call_id = ? AND status = 'created'",
    writes ? FINAL_ATTEMPT : Number(row.attempt || 0) + 1, leaseId, leaseExpiresAt, now, row.call_id
  );
  const turn = one(host, "SELECT attempt, thread_id FROM agent_turns WHERE turn_id = ?", row.turn_id);
  host.log("agent.function.claimed", {
    accountId: row.account_id,
    threadId: turn?.thread_id || null,
    turnId: row.turn_id,
    callId: row.call_id,
    functionName: row.function_name,
    attempt: Number(row.attempt || 0) + 1,
    leaseExpiresAt
  });
  appendTurnStep(host, row.turn_id, Number(turn?.attempt || 0), "function", "claimed", {
    toolName: row.function_name,
    toolCallId: row.tool_call_id
  });
  return { callId: row.call_id, turnId: row.turn_id, threadId: turn?.thread_id || null, accountId: row.account_id,
    functionName: row.function_name, input: JSON.parse(row.input_json), leaseId, leaseExpiresAt };
}

/** Whether this lease still holds the call; never another claimant's token or the turn contents. */
export function inspectFunctionLease(host, { callId, leaseId, now = nowIso(host) }) {
  const row = one(host, `SELECT calls.status, calls.lease_id, calls.lease_expires_at, turns.status AS turn_status
    FROM agent_function_calls calls JOIN agent_turns turns ON turns.turn_id = calls.turn_id WHERE calls.call_id = ?`, callId);
  return { active: Boolean(row && row.status === "claimed" && row.lease_id === leaseId
    && row.turn_status === "waiting_for_browser" && Date.parse(row.lease_expires_at) > Date.parse(now)) };
}

/**
 * The executor's result for a leased call, accepted once: a repeated delivery of the same result
 * is acknowledged, a different one is FUNCTION_RESULT_CONFLICT, a stale lease
 * FUNCTION_CALL_LEASE_INVALID. Returns the call's turn ID. `detail` reaches describeSettlement.
 */
export async function completeFunctionCall(host, { callId, leaseId, result, errorCode = null, executionMs = null, detail = null, now = nowIso(host) }) {
  const receipt = { key: `function-result:${callId}:${await sha256(leaseId)}`,
    hash: await sha256(JSON.stringify({ result: result ?? null, errorCode })), now };
  const accepted = acceptedResult(host, receipt);
  if (accepted) return accepted;
  const row = one(host, "SELECT * FROM agent_function_calls WHERE call_id = ?", callId);
  if (!row || row.status !== "claimed" || row.lease_id !== leaseId
    || !(Date.parse(row.lease_expires_at) > Date.parse(now))) throw new Error("FUNCTION_CALL_LEASE_INVALID");
  const storeStarted = Date.now();
  const stored = host.checkpointCodec?.store ? await host.checkpointCodec.store(result, { accountId: row.account_id, external: true }) : result;
  // External I/O permits interleaving. Recheck receipt and ownership before SQL.
  const concurrent = acceptedResult(host, receipt);
  if (concurrent) return concurrent;
  const current = one(host, "SELECT status, lease_id, lease_expires_at FROM agent_function_calls WHERE call_id = ?", callId);
  if (current?.status !== "claimed" || current.lease_id !== leaseId
    || Date.parse(current.lease_expires_at) <= Date.parse(now) + Date.now() - storeStarted) throw new Error("FUNCTION_CALL_LEASE_INVALID");
  const settled = settleFunctionCall(host, row, { result: stored, errorCode, now, receipt });
  if (executionMs !== null) host.storage.sql.exec("UPDATE agent_function_calls SET execution_ms = ? WHERE call_id = ?", executionMs, callId);
  const turn = one(host, "SELECT thread_id FROM agent_turns WHERE turn_id = ?", row.turn_id);
  const described = host.describeSettlement?.(row, settled, { result: stored, errorCode, detail })
    || { event: errorCode ? "agent.function.failed" : "agent.function.completed", fields: { errorCode: errorCode || undefined } };
  host.log(described.event, {
    accountId: row.account_id,
    threadId: turn?.thread_id || null,
    turnId: row.turn_id,
    callId,
    functionName: row.function_name,
    ...described.fields,
    pendingFunctions: settled.pending,
    // The executor round trip: from the model asking to the executor answering.
    durationMs: Math.max(0, Date.parse(now) - Date.parse(row.created_at))
  });
  if (settled.resume) scheduleTurns(host);
  return { turnId: row.turn_id };
}

function acceptedResult(host, receipt) {
  const accepted = one(host, "SELECT payload_hash, response_json FROM idempotency_records WHERE idempotency_key = ?", receipt.key);
  if (!accepted) return null;
  if (accepted.payload_hash !== receipt.hash) throw new Error("FUNCTION_RESULT_CONFLICT");
  return { turnId: JSON.parse(accepted.response_json).turnId };
}

// How long a parked call's lease outlasts its park, for the executor's own last result.
export const PARKED_CALL_GRACE_MS = 60_000;

/**
 * Parks an executor's claimed call until `until`: its lease is extended past it (by
 * PARKED_CALL_GRACE_MS), so the turn keeps waiting with no model request while the executor
 * watches for something slow, such as a long browser wait. Only as far ahead as the product allows
 * that call (host.calls.parkable; 0 or absent: it may not park), never later than a deadline the
 * call was already parked to, and one parked call per turn.
 * `expiry` is the result recovery settles the call with if the executor never delivers its own;
 * until then the call completes as any other (completeFunctionCall, same lease).
 */
export async function parkFunctionCall(host, { callId, leaseId, until, expiry, now = nowIso(host) }) {
  const row = one(host, `SELECT calls.*, turns.status AS turn_status, turns.attempt AS turn_attempt
    FROM agent_function_calls calls JOIN agent_turns turns ON turns.turn_id = calls.turn_id WHERE calls.call_id = ?`, callId);
  if (!row || row.status !== "claimed" || row.lease_id !== leaseId || row.turn_status !== "waiting_for_browser"
    || !(Date.parse(row.lease_expires_at) > Date.parse(now))) throw new Error("FUNCTION_CALL_LEASE_INVALID");
  // Not parkable (or parking is off), too late, or another call of the turn is parked already.
  const refuse = () => new Error("FUNCTION_PARK_REFUSED");
  const maxParkMs = host.calls?.parkable?.(row.function_name, JSON.parse(row.input_json)) || 0;
  if (!(Date.parse(until) > Date.parse(now)) || Date.parse(until) - Date.parse(now) > maxParkMs) throw refuse();
  // Parked again (a replaying or buggy executor), a call keeps its first deadline: never a later one.
  const parkedUntil = parkedState(row)?.until;
  if (parkedUntil && Date.parse(until) > Date.parse(parkedUntil)) throw refuse();
  if (one(host, `SELECT call_id FROM agent_function_calls WHERE turn_id = ? AND call_id != ? AND status = 'claimed'
    AND json_extract(result_json, '$.parked') IS NOT NULL`, row.turn_id, callId)) throw refuse();
  const leaseExpiresAt = new Date(Date.parse(until) + PARKED_CALL_GRACE_MS).toISOString();
  host.storage.sql.exec(`UPDATE agent_function_calls SET lease_expires_at = ?, result_json = ?, updated_at = ?
    WHERE call_id = ? AND status = 'claimed' AND lease_id = ?`,
  leaseExpiresAt, JSON.stringify({ parked: { until, expiry } }), now, callId, leaseId);
  appendTurnStep(host, row.turn_id, Number(row.turn_attempt || 0), "function", "parked", { toolName: row.function_name, toolCallId: row.tool_call_id });
  host.log("agent.function.parked", { accountId: row.account_id, turnId: row.turn_id, callId, functionName: row.function_name, until });
  // Recovery settles the call with `expiry` if nothing arrives by then.
  await host.armWatchdog(Date.parse(leaseExpiresAt) + 1_000);
  return { parked: true, until, leaseExpiresAt };
}

/** The result a parked call settles with when its lease ends without a delivery (null: not parked). */
export function parkedExpiry(call) {
  return parkedState(call)?.expiry ?? null;
}

function parkedState(call) {
  try { return JSON.parse(call.result_json || "null")?.parked ?? null; } catch { return null; }
}

/** Settles a call in one transaction, with the executor's receipt when it delivered the result. */
export function settleFunctionCall(host, call, { result, errorCode = null, now = nowIso(host), receipt = null }) {
  return host.storage.transactionSync(() => {
    const settled = settleWaitingCall(host, call, { result, errorCode, now });
    if (receipt) host.storage.sql.exec("INSERT INTO idempotency_records VALUES (?, ?, ?, ?, ?)",
      receipt.key, "function-result", receipt.hash, JSON.stringify({ turnId: call.turn_id }), now);
    return settled;
  });
}

/**
 * Writes one call's result into its waiting turn (through host.writeResult, which owns the
 * checkpoint) and settles the row. The turn resumes only when every call it created in the same
 * model step has completed or failed. Runs inside the caller's transaction.
 */
export function settleWaitingCall(host, call, { result, errorCode = null, now = nowIso(host) }) {
  const { storage } = host;
  const turn = one(host,
    "SELECT checkpoint_json, input_json, attempt, session_id, journal_format FROM agent_turns WHERE turn_id = ? AND status = 'waiting_for_browser'",
    call.turn_id
  );
  if (!turn?.checkpoint_json) throw new Error("FUNCTION_CALL_TURN_INVALID");
  const written = host.writeResult(call, turn, { result, errorCode, now });
  // The host keeps the call open (it awaits something else, such as a person's approval).
  if (written.held) return { pending: 1, resume: false, ...written.held };
  const failed = Boolean(errorCode);
  storage.sql.exec(
    `UPDATE agent_function_calls SET status = ?, result_json = ?, error_code = ?, lease_id = NULL,
     lease_expires_at = NULL, updated_at = ? WHERE call_id = ? AND status IN ('created', 'claimed')`,
    failed ? "failed" : "completed", JSON.stringify(written.result ?? null), errorCode, now, call.call_id
  );
  const remaining = storage.sql.exec(
    "SELECT call_id FROM agent_function_calls WHERE turn_id = ? AND status IN ('created', 'claimed') ORDER BY created_at",
    call.turn_id
  ).toArray();
  const pending = remaining.length;
  if (pending) {
    storage.sql.exec(
      "UPDATE agent_turns SET waiting_ref = ?, checkpoint_json = ?, updated_at = ? WHERE turn_id = ? AND status = 'waiting_for_browser'",
      remaining[0].call_id, written.checkpointJson, now, call.turn_id
    );
  } else if (written.completeTurn) {
    // The caller, not the model, chooses the next operation. Settlement must never queue inference.
    storage.sql.exec(`UPDATE agent_turns SET status = 'completed', phase = 'done', error_code = NULL, waiting_ref = NULL,
      checkpoint_json = ?, final_answer = '', updated_at = ?, completed_at = ? WHERE turn_id = ? AND status = 'waiting_for_browser'`,
      written.checkpointJson, now, now, call.turn_id);
    host.log("agent.turn.completed", { turnId: call.turn_id, executionMode: "tool" });
  } else {
    storage.sql.exec(
      `UPDATE agent_turns SET status = 'queued', phase = 'queued', error_code = NULL, waiting_ref = NULL,
       checkpoint_json = ?, updated_at = ?, completed_at = NULL WHERE turn_id = ? AND status = 'waiting_for_browser'`,
      written.checkpointJson, now, call.turn_id
    );
  }
  appendTurnStep(host, call.turn_id, Number(turn.attempt || 0), "function", failed ? "failed" : "completed", {
    toolName: call.function_name,
    toolCallId: call.tool_call_id,
    errorCode
  });
  return { pending, resume: pending === 0, functionResult: written.functionResult };
}
