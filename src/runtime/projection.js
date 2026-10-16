// The turn projection: what a product's API returns for a turn row and its chat UI reads. The base
// fields come from the core's `agent_turns` columns; each product adds its own fields (between the
// identity and the lifecycle, in its own order) and its progress items from its own activity
// source. From X Gardener src/cf/account/turns.js (projectAgentTurn), contract/agent-turn.js (the
// validator and turn controls) and contract/turn-activity.js (the progress label).

export const TURN_PROJECTION_VERSION = "agent-turn-projection-v1";

export const ACTIVE_TURN_STATUSES = Object.freeze(["queued", "running", "waiting_for_browser", "waiting_for_approval"]);
const TURN_STATUSES = new Set([...ACTIVE_TURN_STATUSES, "completed", "failed", "cancelled"]);
/** The progress list keeps a turn's newest items. */
export const TURN_PROGRESS_LIMIT = 24;
/** A running turn's answer so far keeps its newest characters, up to this many. */
export const PARTIAL_TEXT_MAX_CHARS = 4_000;

/** @param {string | null | undefined} status */
export function isActiveTurnStatus(status) {
  return ACTIVE_TURN_STATUSES.includes(/** @type {string} */ (status));
}

/** A turn the user can stop: still running, or handed to the user and waiting for them. */
export function canStopTurn(turn) {
  return turn?.phase === "waiting_for_user" || isActiveTurnStatus(turn?.status);
}

/** Only the thread's latest turn, failed or cancelled, and not a direct tool turn, is retried. */
export function canRetryTurn(turn, latestTurnId) {
  if (turn?.executionMode === "tool") return false;
  return turn?.turnId === latestTurnId && ["failed", "cancelled"].includes(turn?.status);
}

/**
 * The projection of an `agent_turns` row (columns account_id, turn_id, session_id, status, phase,
 * handoff_json, waiting_ref, final_answer, partial_text, error_code, created_at, updated_at,
 * completed_at). `fields` are the product's own, placed after the identity; `errorCode` overrides
 * the stored code. `partialText`, the answer so far, is present only while the turn runs and has one.
 */
export function projectTurn(row, { fields = {}, progress, errorCode = row.error_code || null }) {
  return {
    version: TURN_PROJECTION_VERSION, accountId: row.account_id, turnId: row.turn_id,
    ...fields,
    sessionId: row.session_id, status: row.status, phase: row.phase,
    ...(row.handoff_json ? { handoff: JSON.parse(row.handoff_json) } : {}),
    progress,
    waiting: row.waiting_ref ? { ref: row.waiting_ref } : null,
    finalAnswer: row.status === "completed" ? row.final_answer || "" : null,
    ...(row.status === "running" && row.partial_text ? { partialText: row.partial_text } : {}),
    errorCode, createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at || null
  };
}

/**
 * A turn's progress from the product's activity items (`{ id, label, at, ... }`): the newest
 * items oldest first, and while the turn is active the latest item's label as its own.
 */
export function turnProgress(items, status, labels) {
  const latest = [...items].sort((a, b) => a.at.localeCompare(b.at)).slice(-TURN_PROGRESS_LIMIT);
  const active = isActiveTurnStatus(status);
  return { label: active ? (latest.at(-1)?.label || (status === "queued" ? labels.queued : labels.working)) : labels.done, items: latest };
}

const BASE_FIELDS = ["version", "accountId", "turnId", "sessionId", "status", "phase", "progress", "waiting", "handoff",
  "finalAnswer", "partialText", "errorCode", "createdAt", "updatedAt", "completedAt", "mergedIntoTurnId", "cancel"];
// A turn list's items add the user-visible input text and the parent turn link.
const LIST_ITEM_FIELDS = ["input", "parentTurnId"];
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Checks the base fields of a projection; `fields` names the product's own fields (which it checks
 * itself). Throws an Error saying what is wrong; returns the value.
 */
export function validateTurnProjection(value, expectedAccountId, { listItem = false, fields = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("projection must be an object");
  const allowed = new Set([...BASE_FIELDS, ...fields, ...(listItem ? LIST_ITEM_FIELDS : [])]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown projection field: ${key}`);
  }
  if (value.version !== TURN_PROJECTION_VERSION) throw new Error("unsupported projection version");
  if (!TURN_STATUSES.has(value.status)) throw new Error("invalid turn status");
  if (value.mergedIntoTurnId !== undefined && (value.status !== "completed" || typeof value.mergedIntoTurnId !== "string"
    || !value.mergedIntoTurnId || value.mergedIntoTurnId === value.turnId)) throw new Error("invalid merged turn");
  // Cancel response only: the running turn is placing this queued steer, so the cancel changed
  // nothing. The steer is answered exactly once: merged when delivered, otherwise re-placed by a
  // retry of that turn or run as its own turn.
  if (value.cancel !== undefined && (value.cancel !== "already_delivering" || value.status !== "queued")) throw new Error("invalid cancel outcome");
  if (expectedAccountId && value.accountId !== expectedAccountId) throw new Error("cross-account projection");
  if (value.errorCode != null && (typeof value.errorCode !== "string" || !ERROR_CODE.test(value.errorCode))) throw new Error("invalid turn error code");
  if (value.status === "completed" && typeof value.finalAnswer !== "string") throw new Error("completed turn needs finalAnswer");
  if (value.status !== "completed" && value.finalAnswer != null) throw new Error("non-completed turn cannot expose finalAnswer");
  if (value.partialText !== undefined && (value.status !== "running" || typeof value.partialText !== "string" || !value.partialText
    || value.partialText.length > PARTIAL_TEXT_MAX_CHARS)) throw new Error("invalid partial text");
  if (listItem && value.parentTurnId != null && (typeof value.parentTurnId !== "string" || !value.parentTurnId)) throw new Error("invalid parent turn id");
  return value;
}
