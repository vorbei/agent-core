import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnBudget, grantManualRetry, isRetryableModelFailure, modelFailureCode } from "../../src/runtime/index.js";

test("model failure codes: explicit codes, known codes in messages, HTTP status, timeout, overflow", () => {
  assert.equal(modelFailureCode(Object.assign(new Error("x"), { code: "CONTEXT_OVERFLOW" })), "CONTEXT_OVERFLOW");
  assert.equal(modelFailureCode(Object.assign(new Error("x"), { code: "rate-limited" })), "MODEL_RATE_LIMITED");
  assert.equal(modelFailureCode(new Error("Context overflow recovery failed after one compact-and-retry attempt.")), "CONTEXT_OVERFLOW");
  assert.equal(modelFailureCode("This model's maximum context length is 131072 tokens"), "CONTEXT_OVERFLOW");
  assert.equal(modelFailureCode("upstream said MODEL_HTTP_503"), "MODEL_HTTP_503");
  assert.equal(modelFailureCode("429 rate limited"), "MODEL_HTTP_429");
  assert.equal(modelFailureCode("Request failed with status code 502"), "MODEL_HTTP_502");
  assert.equal(modelFailureCode("The operation was aborted due to timeout"), "MODEL_TIMEOUT");
  assert.equal(modelFailureCode("something else"), "MODEL_FAILED");
  assert.equal(modelFailureCode("HTTP 503 Service Unavailable"), "MODEL_HTTP_503");
  assert.equal(modelFailureCode("HTTP/1.1 500 Internal Server Error"), "MODEL_HTTP_500");
  assert.equal(modelFailureCode('provider error: {"status": 529}'), "MODEL_HTTP_529");
  assert.equal(modelFailureCode("status: 400 invalid request"), "MODEL_HTTP_400");
  assert.equal(modelFailureCode("503: upstream connect error"), "MODEL_HTTP_503");
});

test("model failure codes: a number that is not a status, a success status, and errors from outside the model", () => {
  assert.equal(modelFailureCode("500 tokens left in the context window"), "MODEL_FAILED");
  assert.equal(modelFailureCode("Reduce the prompt by 429 words"), "MODEL_FAILED");
  assert.equal(modelFailureCode("HTTP status 200 but stream timed out"), "MODEL_TIMEOUT");
  assert.equal(modelFailureCode("status 200; the response stream ended with a timeout"), "MODEL_TIMEOUT");
  // Storage, tool and consumer errors are not model failures, whatever their message says.
  assert.equal(modelFailureCode(new Error("SQLITE_BUSY: database lock timeout"), { origin: "other" }), "MODEL_FAILED");
  assert.equal(modelFailureCode(new Error("tool fetch failed with HTTP 503"), { origin: "other" }), "MODEL_FAILED");
  assert.equal(isRetryableModelFailure(modelFailureCode(new Error("timeout"), { origin: "other" })), false);
  assert.equal(modelFailureCode(Object.assign(new Error("x"), { code: "MODEL_TIMEOUT" }), { origin: "other" }), "MODEL_TIMEOUT");
  assert.equal(isRetryableModelFailure("MODEL_HTTP_429"), true);
  assert.equal(isRetryableModelFailure("MODEL_HTTP_400"), false);
  assert.equal(isRetryableModelFailure("MODEL_TIMEOUT"), true);
  assert.equal(isRetryableModelFailure(modelFailureCode("MODEL_OUTPUT_LIMIT: model reached its output limit")), true);
  // A bare abort is not a timeout: only the deadline that cut a request says so (withModelDeadline).
  assert.equal(modelFailureCode("Request was aborted"), "MODEL_FAILED");
  assert.equal(isRetryableModelFailure("CONTEXT_OVERFLOW"), false);
  assert.equal(isRetryableModelFailure("MODEL_FAILED"), false);
});

test("turn budget: keyed reservations count once, counted kinds stop at their ceiling, state survives a snapshot", () => {
  const budget = createTurnBudget({}, { maxModelCalls: 2, maxToolCalls: 1 });
  assert.equal(budget.reserve("model").ok, true);
  assert.equal(budget.reserve("tool", "call-1").ok, true);
  assert.equal(budget.reserve("tool", "call-1").duplicate, true);
  assert.equal(budget.reserve("tool", "call-2").ok, false);
  assert.equal(budget.reserve("answerRepair").ok, true);
  assert.equal(budget.reserve("answerRepair").ok, false);
  const resumed = createTurnBudget({ ...budget.snapshot(), costUsd: 0.1 }, { maxModelCalls: 2, maxToolCalls: 1 });
  assert.equal(resumed.remaining("model"), 1);
  assert.equal(resumed.state.costUsd, 0.1, "a consumer's own fields ride along");
  assert.throws(() => resumed.reserve("tool"), /BUDGET_KEY_REQUIRED/);
});

test("a spend cap refuses model requests but not tool dispatches; a manual retry grants a fresh allowance", () => {
  let spent = false;
  const budget = createTurnBudget({}, { maxModelCalls: 5, maxToolCalls: 5, modelSpendAvailable: () => !spent });
  spent = true;
  assert.deepEqual(budget.reserve("model"), { ok: false, duplicate: false, remaining: 0, spendLimit: true });
  assert.equal(budget.reserve("tool", "t").ok, true);
  const granted = grantManualRetry({ modelCalls: 5, toolCallIds: ["a", "b"] }, { idempotencyKey: "k", attempt: 3, attemptBudget: 10, turnBudget: { modelCalls: 4, toolCalls: 6 } });
  assert.equal(granted.maxModelCalls, 9);
  assert.equal(granted.maxToolCalls, 8);
  assert.equal(granted.attemptBudget, 13);
});
