// Durable receipts around a server tool's execution: the intent is committed before the tool may
// contact anything, the result after; a completed call ID replays its result, an unresolved write
// is never repeated under a new call ID, and every step is fenced by the turn's lease.
// From X Gardener src/cf/account/tool-execution.js and src/sqlite/cf/tool-receipts.js.
import { canonical, nowIso, sha256 } from "./stamps.js";
import { assertTurnLease } from "./turn-scheduler.js";

export function toolReceipt(storage, turnId, toolCallId) {
  return storage.sql.exec("SELECT * FROM agent_tool_receipts WHERE turn_id = ? AND tool_call_id = ?",
    turnId, toolCallId).toArray()[0] || null;
}

// Wrap the execution boundary, not just the model's visible registry. Never replay an
// interrupted write merely because a new attempt generated a new tool-call ID.
export function durableToolExecute(host, turnId, claim, tool, { readOnly = false } = {}) {
  return async (toolCallId, input, ...rest) => {
    const inputHash = await sha256(JSON.stringify(canonical(input)));
    const { idempotencyKey: _key, ...effectInput } = input;
    const effectHash = await sha256(JSON.stringify(canonical(effectInput)));
    assertTurnLease(host, turnId, claim);
    const { storage } = host;
    const turn = storage.sql.exec("SELECT account_id, thread_id FROM agent_turns WHERE turn_id = ?", turnId).toArray()[0];
    const lifecycle = { accountId: turn.account_id, threadId: turn.thread_id, turnId, attempt: claim.attempt };
    const previous = toolReceipt(storage, turnId, toolCallId);
    if (previous && (previous.tool_name !== tool.name || previous.input_hash !== inputHash)) {
      return toolErrorResult(host, tool.name, toolCallId, true,
        { code: "TOOL_CALL_ID_CONFLICT", message: "A recorded tool-call ID cannot be reused for different arguments." });
    }
    if (previous?.status === "completed") {
      host.log("agent.tool.deduplicated", { ...lifecycle, callId: toolCallId, functionName: tool.name });
      return JSON.parse(previous.result_json);
    }
    const unresolved = !readOnly && storage.sql.exec(
      "SELECT tool_call_id FROM agent_tool_receipts WHERE turn_id = ? AND tool_name = ? AND effect_hash = ? AND status = 'started' LIMIT 1",
      turnId, tool.name, effectHash).toArray()[0];
    if (unresolved) {
      host.log("agent.tool.unresolved", { ...lifecycle, callId: toolCallId, functionName: tool.name,
        originalCallId: unresolved.tool_call_id });
      return interruptedToolResult(host, tool.name, toolCallId, false);
    }
    const now = nowIso(host);
    storage.sql.exec(`INSERT INTO agent_tool_receipts
      (turn_id, tool_call_id, tool_name, input_hash, effect_hash, read_only, attempt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)
      ON CONFLICT(turn_id, tool_call_id) DO UPDATE SET attempt = excluded.attempt, updated_at = excluded.updated_at`,
      turnId, toolCallId, tool.name, inputHash, effectHash, readOnly ? 1 : 0, claim.attempt, now, now);
    // Make the intent durable before the tool may contact an external system.
    await storage.sync?.();
    assertTurnLease(host, turnId, claim);
    // An uncaught failure leaves the intent unresolved. The model loop may turn the exception into
    // a tool error; that does not prove that an external write had no effect.
    const result = await tool.execute(toolCallId, input, ...rest);
    assertTurnLease(host, turnId, claim);
    storage.sql.exec(`UPDATE agent_tool_receipts SET status = ?, result_json = ?, updated_at = ?
      WHERE turn_id = ? AND tool_call_id = ? AND attempt = ?`,
      result?.details?.effect === "unknown" ? "started" : "completed",
      JSON.stringify(result), nowIso(host), turnId, toolCallId, claim.attempt);
    return result;
  };
}

/** The result of a tool call whose process stopped: never started (safe to repeat), an interrupted read, or a write of unknown effect. */
export function interruptedToolResult(host, name, id, readOnly = false, notStarted = false) {
  return toolErrorResult(host, name, id, readOnly || notStarted, {
    code: notStarted ? "TOOL_NOT_STARTED" : "TOOL_EXECUTION_INTERRUPTED",
    message: notStarted ? "The process stopped before this tool started. It is safe to request this operation again."
      : readOnly ? "The read was interrupted. No result was recorded; refresh the read if needed."
        : "The process stopped without a recorded tool result. Its effect is unknown. Inspect current state; do not repeat this write."
  });
}

// The host words tool errors for its model; the default is the error as JSON text.
function toolErrorResult(host, name, callId, readOnly, error) {
  if (host.calls?.error) return host.calls.error({ name, callId, readOnly, error });
  return { content: [{ type: "text", text: JSON.stringify({ errorCode: error.code, message: error.message }) }],
    details: { errorCode: error.code, readOnly }, isError: true };
}
