// One durable budget per turn. Every bounded runtime allowance (model steps, tool dispatches,
// compaction, notes, output repairs, code execution) is reserved here, persisted with the turn,
// and never reset by an internal continuation or restart. Keyed kinds are idempotent: reserving
// the same key twice (duplicate delivery, replayed hook) counts once. From X Gardener
// src/pi/turn-budget.js; the model and tool ceilings are the consumer's.

/** @typedef {import("./index.js").TurnBudget} TurnBudget */

/** Ceilings of the counted kinds other than model and tool. */
export const BUDGET_LIMITS = Object.freeze({
  compaction: 2, notes: 2, notesAuto: 1, citationRepair: 2, quantityRepair: 1, codeExec: 2, pendingActionSteer: 1, answerRepair: 1,
});

/** @type {Readonly<Record<string, string>>} */
const KEYED = Object.freeze({ tool: "toolCallIds", codeExec: "codeExecCallIds" });
/** @type {Readonly<Record<string, string>>} */
const COUNTED = Object.freeze({ model: "modelCalls", compaction: "compactionCalls", notes: "notesCalls",
  citationRepair: "citationRepairs", quantityRepair: "quantityRepairs", pendingActionSteer: "pendingActionSteers", answerRepair: "answerRepairs" });

/**
 * Raised only where a spend cap refuses a model request: MODEL_TURN_SPEND_LIMIT when the turn's own
 * ceiling (`maxCostUsd`) refused it, MODEL_SPEND_LIMIT when the cap outside the turn did.
 * @param {"MODEL_SPEND_LIMIT" | "MODEL_TURN_SPEND_LIMIT"} [code]
 */
export const spendLimitError = (code = "MODEL_SPEND_LIMIT") => Object.assign(
  new Error(code === "MODEL_TURN_SPEND_LIMIT" ? "stopped: turn_spend_limit" : "stopped: spend_limit"), { code });
const SPENDING = Object.freeze(["model", "compaction", "notes"]);

/**
 * @param {Record<string, any>} [saved] a previous `snapshot()` (other fields the consumer keeps ride along)
 * @param {{ maxModelCalls: number, maxToolCalls: number, modelSpendAvailable?: () => boolean, maxCostUsd?: number, maxCodeExecCalls?: number }} options
 *   `modelSpendAvailable` is a spend cap outside the turn (an account's month); `maxCostUsd` the
 *   turn's own ceiling, counted in `state.costUsd` from the estimates `addCost` is given. Without
 *   `maxCostUsd` the state carries no cost. `maxCodeExecCalls` replaces BUDGET_LIMITS.codeExec.
 * @returns {TurnBudget}
 */
export function createTurnBudget(saved = {}, { maxModelCalls, maxToolCalls, modelSpendAvailable: outsideCap = () => true, maxCostUsd, maxCodeExecCalls = BUDGET_LIMITS.codeExec }) {
  /** @type {Record<string, any>} */
  const state = { maxModelCalls, modelCalls: 0, maxToolCalls, toolCallIds: [], compactionCalls: 0, compactionDeferred: false, ...saved };
  for (const field of Object.values(KEYED)) state[field] = Array.isArray(state[field]) ? [...state[field]] : [];
  const costed = typeof maxCostUsd === "number";
  // `costUsd` is stored once a response reported a cost: a turn with none stores what it did before.
  if (costed && "costUsd" in state) state.costUsd = Number(state.costUsd) || 0;
  const turnCapReached = () => costed && (Number(state.costUsd) || 0) >= /** @type {number} */ (maxCostUsd);
  const modelSpendAvailable = () => !turnCapReached() && outsideCap();
  /** Which cap stops the turn's next model request, when one does: the cap outside the turn first, since a retry cannot lift it. */
  const spendLimitCode = () => turnCapReached() && outsideCap() ? "MODEL_TURN_SPEND_LIMIT" : "MODEL_SPEND_LIMIT";
  /** @param {number | undefined} usd */
  const addCost = (usd) => { if (costed && Number.isFinite(usd) && /** @type {number} */ (usd) > 0) state.costUsd = (Number(state.costUsd) || 0) + /** @type {number} */ (usd); };
  const limitOf = (/** @type {string} */ kind) => kind === "model" ? state.maxModelCalls : kind === "tool" ? state.maxToolCalls
    : kind === "codeExec" ? maxCodeExecCalls : /** @type {any} */ (BUDGET_LIMITS)[kind];

  /** @param {string} kind */
  function used(kind) {
    if (KEYED[kind]) return state[KEYED[kind]].length;
    if (kind === "notesAuto") return state.notesAutoAttempted ? 1 : 0;
    return Number(state[COUNTED[kind]] || 0);
  }
  const remaining = (/** @type {string} */ kind) => Math.max(0, limitOf(kind) - used(kind));

  /** Returns { ok, duplicate, remaining, spendLimit? }; `ok: false` means nothing was reserved. @param {string} kind @param {string} [key] */
  function reserve(kind, key) {
    // Each model request (a step, a context summary, notes) meets the spend cap where it is
    // reserved; tool dispatches still settle the response that crossed it.
    if (SPENDING.includes(kind) && !modelSpendAvailable()) return { ok: false, duplicate: false, remaining: 0, spendLimit: true };
    if (KEYED[kind]) {
      if (typeof key !== "string" || !key) throw new Error(`BUDGET_KEY_REQUIRED: ${kind}`);
      const list = state[KEYED[kind]];
      if (list.includes(key)) return { ok: true, duplicate: true, remaining: remaining(kind) };
      if (list.length >= limitOf(kind)) return { ok: false, duplicate: false, remaining: 0 };
      list.push(key);
      return { ok: true, duplicate: false, remaining: remaining(kind) };
    }
    if (kind === "notesAuto") {
      if (state.notesAutoAttempted) return { ok: false, duplicate: false, remaining: 0 };
      state.notesAutoAttempted = true;
      return { ok: true, duplicate: false, remaining: 0 };
    }
    const field = COUNTED[kind];
    if (!field) throw new Error(`BUDGET_KIND_UNKNOWN: ${kind}`);
    if (kind === "compaction" && state.compactionDeferred) return { ok: false, duplicate: false, remaining: 0 };
    if (used(kind) >= limitOf(kind)) return { ok: false, duplicate: false, remaining: 0 };
    state[field] = used(kind) + 1;
    return { ok: true, duplicate: false, remaining: remaining(kind) };
  }

  /** What the turn's own ceiling leaves for its next requests (Infinity without `maxCostUsd`). */
  const remainingCostUsd = () => costed ? Math.max(0, /** @type {number} */ (maxCostUsd) - (Number(state.costUsd) || 0)) : Infinity;

  return { state, reserve, remaining, used, spendAvailable: modelSpendAvailable, spendLimitCode, addCost, remainingCostUsd, snapshot: () => structuredClone(state) };
}

/**
 * An explicit user retry grants another bounded allowance on the same journal and call ids, of
 * `turnBudget` model and tool calls. Attempts and reserved keys are never reset. A turn's own spend
 * estimate and the answer repairs it asked (kept only by a budget with `maxCostUsd`, and by the
 * answer-repair policy) start again too.
 * @param {Record<string, any>} saved
 * @param {{ idempotencyKey: string, attempt: number, attemptBudget: number, turnBudget: { modelCalls: number, toolCalls: number } }} grant
 */
export function grantManualRetry(saved = {}, { idempotencyKey, attempt, attemptBudget, turnBudget }) {
  return { ...saved,
    ...("costUsd" in saved ? { costUsd: 0 } : {}), ...("repairs" in saved ? { repairs: [] } : {}),
    maxModelCalls: Number(saved.modelCalls || 0) + turnBudget.modelCalls,
    maxToolCalls: (saved.toolCallIds?.length || 0) + turnBudget.toolCalls,
    compactionCalls: 0, compactionDeferred: false, compactionErrorCode: null,
    citationRepairs: 0, quantityRepairs: 0,
    manualRetryKey: idempotencyKey, manualRetryCount: Number(saved.manualRetryCount || 0) + 1,
    attemptBudget: attempt + attemptBudget };
}
