import assert from "node:assert/strict";
import test from "node:test";
import { groupTurns } from "../../src/ui/turn-groups.js";
import { canStopTurn, canRetryTurn } from "../../src/runtime/index.js";

test('turn controls distinguish stopping active work from retrying the latest terminal chat', () => {
  for (const status of ['queued', 'running', 'waiting_for_browser', 'waiting_for_approval']) {
    assert.equal(canStopTurn({ status }), true);
    assert.equal(canRetryTurn({ turnId: 'latest', status }, 'latest'), false);
  }
  for (const status of ['failed', 'cancelled']) {
    assert.equal(canStopTurn({ status }), false);
    assert.equal(canRetryTurn({ turnId: 'latest', status }, 'latest'), true);
    assert.equal(canRetryTurn({ turnId: 'older', status }, 'latest'), false);
    assert.equal(canRetryTurn({ turnId: 'latest', status, executionMode: 'tool' }, 'latest'), false);
  }
  assert.equal(canRetryTurn({ turnId: 'latest', status: 'completed' }, 'latest'), false);
  // A turn handed to the user (waiting for them) can still be stopped.
  assert.equal(canStopTurn({ status: 'completed', phase: 'waiting_for_user' }), true);
});

test("chat progress follows explicit causal links without merging interleaved tasks or runs", () => {
  const turn = (turnId, parentTurnId = null, extra = {}) => ({ turnId, parentTurnId, accountId: "account", sessionId: "chat", runId: null, ...extra });
  const rows = [turn("a"), turn("b"), turn("a2", "a"), turn("a3", "a2"), turn("legacy"), turn("other-run", "a", { runId: "run" }), turn("other-account", "a", { accountId: "other" })];
  assert.deepEqual(groupTurns(rows).map(group => group.turns.map(row => row.turnId)), [
    ["a", "a2", "a3"], ["b"], ["legacy"], ["other-run"], ["other-account"]
  ]);
  assert.deepEqual(groupTurns(rows.slice(2, 4)).map(group => group.turns.map(row => row.turnId)), [["a2", "a3"]]);
  assert.equal(rows.length, 7);
});

test("a steer a turn took belongs to that turn's group; one whose turn is not loaded stays its own", () => {
  const turn = (turnId, extra = {}) => ({ turnId, parentTurnId: null, accountId: "account", sessionId: "chat", runId: null, ...extra });
  const rows = [turn("a"), turn("a2", { parentTurnId: "a" }), turn("s1", { mergedIntoTurnId: "a" }), turn("s2", { mergedIntoTurnId: "a2" }), turn("b"), turn("s3", { mergedIntoTurnId: "gone" })];
  assert.deepEqual(groupTurns(rows).map(group => [group.turns.map(row => row.turnId), group.steers.map(row => row.turnId)]),
    [[["a", "a2"], ["s1", "s2"]], [["b"], []], [["s3"], []]]);
});
