import { test } from "node:test";
import assert from "node:assert/strict";
import { PARTIAL_TEXT_MAX_CHARS, projectTurn, turnProgress, validateTurnProjection } from "../../src/runtime/index.js";

const ROW = {
  account_id: "acct", turn_id: "turn_1", session_id: "thread_1", status: "completed", phase: "done", handoff_json: null,
  waiting_ref: null, final_answer: "Done.", error_code: null, created_at: "2026-10-09T10:00:00.000Z",
  updated_at: "2026-10-09T10:01:00.000Z", completed_at: "2026-10-09T10:01:00.000Z"
};
const LABELS = { queued: "Waiting", working: "Working", done: "How it worked" };

test("a turn row projects to the base fields with the product's fields after the identity", () => {
  const progress = turnProgress([], "completed", LABELS);
  const turn = projectTurn(ROW, { fields: { mergedIntoTurnId: undefined, delivery: { status: "untracked" } }, progress });
  assert.deepEqual(Object.keys(turn), ["version", "accountId", "turnId", "mergedIntoTurnId", "delivery", "sessionId", "status", "phase",
    "progress", "waiting", "finalAnswer", "errorCode", "createdAt", "updatedAt", "completedAt"]);
  assert.equal(turn.finalAnswer, "Done.");
  // Only a completed turn exposes an answer; a handoff and a waiting reference come from their columns.
  const failed = projectTurn({ ...ROW, status: "failed", error_code: "MODEL_HTTP_429", handoff_json: '{"reason":"login"}', waiting_ref: "call_1" }, { progress });
  assert.equal(failed.finalAnswer, null);
  assert.equal(failed.errorCode, "MODEL_HTTP_429");
  assert.deepEqual(failed.handoff, { reason: "login" });
  assert.deepEqual(failed.waiting, { ref: "call_1" });
  assert.equal(projectTurn({ ...ROW, status: "failed", error_code: "OLD" }, { progress, errorCode: "NEW" }).errorCode, "NEW");
  assert.equal(validateTurnProjection(turn, "acct", { fields: ["delivery"] }), turn);
});

test("progress keeps the newest items in time order and names an active turn by its latest step", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, label: `step ${index}`, at: `2026-10-09T10:${String(59 - index).padStart(2, "0")}:00Z` }));
  const done = turnProgress(items, "completed", LABELS);
  assert.equal(done.label, "How it worked");
  assert.equal(done.items.length, 24);
  assert.equal(done.items.at(-1).id, "s0");
  assert.equal(turnProgress(items, "running", LABELS).label, "step 0");
  assert.equal(turnProgress([], "queued", LABELS).label, "Waiting");
  assert.equal(turnProgress([], "waiting_for_browser", LABELS).label, "Working");
});

test("the base validator refuses unknown fields, foreign accounts and inconsistent answers", () => {
  const progress = turnProgress([], "completed", LABELS);
  const turn = projectTurn(ROW, { progress });
  assert.throws(() => validateTurnProjection({ ...turn, secret: 1 }, "acct"), /unknown projection field: secret/);
  assert.throws(() => validateTurnProjection(turn, "other"), /cross-account/);
  assert.throws(() => validateTurnProjection({ ...turn, status: "done" }), /invalid turn status/);
  assert.throws(() => validateTurnProjection({ ...turn, status: "failed" }), /non-completed turn cannot expose finalAnswer/);
  assert.throws(() => validateTurnProjection({ ...turn, finalAnswer: null }), /completed turn needs finalAnswer/);
  assert.throws(() => validateTurnProjection({ ...turn, mergedIntoTurnId: turn.turnId }), /invalid merged turn/);
  assert.throws(() => validateTurnProjection({ ...turn, cancel: "already_delivering" }), /invalid cancel outcome/);
  assert.throws(() => validateTurnProjection({ ...turn, status: "failed", finalAnswer: null, errorCode: "lower" }), /invalid turn error code/);
  // A turn list item adds the input and the parent link.
  assert.throws(() => validateTurnProjection({ ...turn, input: "hi" }), /unknown projection field: input/);
  assert.equal(validateTurnProjection({ ...turn, input: "hi", parentTurnId: null }, "acct", { listItem: true }).input, "hi");
  // The answer so far belongs to a running turn only.
  const running = { ...turn, status: "running", finalAnswer: null, completedAt: null };
  assert.equal(validateTurnProjection({ ...running, partialText: "so far" }, "acct").partialText, "so far");
  assert.throws(() => validateTurnProjection({ ...turn, partialText: "so far" }), /invalid partial text/);
  assert.throws(() => validateTurnProjection({ ...running, partialText: "" }), /invalid partial text/);
  assert.throws(() => validateTurnProjection({ ...running, partialText: "x".repeat(PARTIAL_TEXT_MAX_CHARS + 1) }), /invalid partial text/);
});

test("a running turn's stored answer so far is projected as partialText, and only while it runs", () => {
  const progress = turnProgress([], "running", LABELS);
  assert.equal(projectTurn({ ...ROW, status: "running", partial_text: "Reading the page" }, { progress }).partialText, "Reading the page");
  assert.equal("partialText" in projectTurn({ ...ROW, status: "running", partial_text: null }, { progress }), false);
  assert.equal("partialText" in projectTurn({ ...ROW, status: "waiting_for_browser", partial_text: "stale" }, { progress }), false);
  assert.equal("partialText" in projectTurn({ ...ROW, partial_text: "stale" }, { progress }), false);
});
