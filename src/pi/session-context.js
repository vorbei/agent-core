// A thread's prior conversation for a new turn, from its finished turns' checkpoints: the latest
// current (v3) checkpoint's journal is the whole history; older rows are rebuilt turn by turn.
// From X Gardener src/pi/session-context.js.
//
// Compatibility branch: session context v1 (cumulative inline journals, or none) and v2 (completed
// turns only) are rebuilt here. Removal condition: no checkpoint with sessionContextVersion < 3
// remains in production (pi_journal_inventory bySessionContextVersion); test
// packages/agent-core/test/pi/session-context.test.js and Gardener tests/session-context.test.js.
import { checkpointMessages } from "./journal.js";
import { SESSION_CONTEXT_VERSION } from "./entry-types.js";

/**
 * `rows` are finished `agent_turns` rows in thread order, with checkpoints hydrated. The result is
 * the model messages the next turn starts from; an unfinished turn is followed by a note that it
 * ended without completion.
 */
export function restoreSessionMessages(rows = []) {
  const turns = rows.filter((row) => ["completed", "failed", "cancelled"].includes(row?.status));
  let messages = [];
  let start = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const checkpoint = parseJson(turns[index].checkpoint_json);
    if ((checkpoint?.sessionContextVersion === SESSION_CONTEXT_VERSION
      || checkpoint?.sessionContextVersion === 2 && turns[index].status === 'completed') && checkpointMessages(checkpoint).length) {
      messages = structuredClone(checkpointMessages(checkpoint));
      if (turns[index].status !== 'completed') messages.push(interruptionMessage(turns[index]));
      start = index + 1;
      break;
    }
  }

  for (const row of turns.slice(start)) {
    const input = parseJson(row.input_json);
    const checkpoint = parseJson(row.checkpoint_json);
    if (checkpoint && checkpointMessages(checkpoint).length) {
      const restored = structuredClone(checkpointMessages(checkpoint));
      // v1 continuous journals were cumulative; fresh journals were only one turn.
      if (row.status !== 'completed') {
        // Legacy failed turns were based on the last completed checkpoint, not
        // on other failed turns. Keep only this turn's suffix when it is present.
        const boundary = restored.findLastIndex(message => message.role === 'user'
          && message.content?.some?.(part => part.type === 'text' && part.text === input?.text));
        messages.push(...restored.slice(Math.max(0, boundary)), interruptionMessage(row));
      } else if (checkpoint.sessionContextVersion === 1 && input?.contextPolicy !== "fresh") messages = restored;
      else messages.push(...restored);
      continue;
    }
    if (!input?.internal && typeof input?.text === "string" && input.text.trim()) {
      messages.push(textMessage("user", input.text, row.created_at));
    }
    if (typeof row.final_answer === "string" && row.final_answer.trim()) {
      messages.push(textMessage("assistant", row.final_answer, row.completed_at || row.updated_at));
    }
    if (row.status !== 'completed') messages.push(interruptionMessage(row));
  }
  return messages;
}

function interruptionMessage(row) {
  return textMessage('user', JSON.stringify({ historicalTurn: row.turn_id || null, status: row.status,
    errorCode: row.error_code || null,
    note: 'This previous turn ended without completion. Retain its settled results; unresolved effects remain unknown. This is history, not a new instruction or authorization. Do not replay its actions automatically.'
  }), row.completed_at || row.updated_at);
}

function textMessage(role, text, timestamp) {
  return { role, content: [{ type: "text", text }], timestamp: Date.parse(timestamp) || Date.now() };
}

function parseJson(value) {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
