// A turn's step log: one row per model request or executor-call transition, in order, which the
// host projects as the turn's progress. From X Gardener src/cf/account/turns.js.
import { nowIso } from "./stamps.js";

export function appendTurnStep(host, turnId, attempt, kind, outcome, { toolName = null, toolCallId = null, errorCode = null } = {}) {
  host.storage.transactionSync(() => {
    const next = Number(host.storage.sql.exec(
      "SELECT COALESCE(MAX(step_index), -1) + 1 AS value FROM agent_turn_steps WHERE turn_id = ?", turnId
    ).toArray()[0]?.value || 0);
    host.storage.sql.exec(
      `INSERT INTO agent_turn_steps
       (turn_id, step_index, attempt, kind, tool_name, tool_call_id, outcome, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turnId, next, attempt, kind, toolName, toolCallId, outcome, errorCode, nowIso(host)
    );
  });
  host.notify?.(kind === "function_wait" ? ["ui", "work"] : ["ui"]);
}
