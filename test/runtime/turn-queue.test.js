import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_SCHEMA, claimFunctionCall, claimTurn, completeFunctionCall, durableToolExecute, insertFunctionCall,
  createTurnBudget, inspectFunctionLease, parkFunctionCall, queueTurnRetry, recoverTurns, scheduleTurns, spendLimitError, turnPage
} from "../../src/runtime/index.js";
import { sqliteStorage } from "../memory/sqlite-storage.js";

// A host over node:sqlite with a fake clock. Turns start only when a test asks (startAttempt records).
function fixture(hooks = {}) {
  const storage = sqliteStorage();
  for (const statement of RUNTIME_SCHEMA) storage.sql.exec(statement);
  const host = {
    storage,
    clock: Date.parse("2026-10-09T08:00:00.000Z"),
    now: () => host.clock,
    events: [],
    started: [],
    log: (event, detail) => host.events.push({ event, ...detail }),
    background: () => {},
    armWatchdog: async () => {},
    startAttempt: async turnId => { host.started.push(turnId); },
    modelConcurrency: () => 2,
    modelDeadlineMs: () => 90_000,
    maxAttempts: 5,
    executorClaimWaitMs: 60_000,
    writeResult: (call, turn, { result }) => ({ result, checkpointJson: JSON.stringify({ ...JSON.parse(turn.checkpoint_json), [call.tool_call_id]: result }) }),
    ...hooks
  };
  return host;
}

function queue(host, turnId, threadId, extra = {}) {
  const at = new Date(host.now()).toISOString();
  host.storage.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, session_id, runtime_version, status, phase,
    input_json, idempotency_key, input_hash, created_at, updated_at) VALUES (?, 'acct', ?, ?, 'test', 'queued', 'queued', '{}', ?, 'h', ?, ?)`,
  turnId, threadId, threadId, `key-${turnId}`, at, at);
  if (extra.checkpoint) host.storage.sql.exec("UPDATE agent_turns SET checkpoint_json = ? WHERE turn_id = ?", JSON.stringify(extra.checkpoint), turnId);
}

const row = (host, turnId) => host.storage.sql.exec("SELECT * FROM agent_turns WHERE turn_id = ?", turnId).toArray()[0];
const waitOn = (host, turnId) => host.storage.sql.exec(
  "UPDATE agent_turns SET status = 'waiting_for_browser', lease_id = NULL, lease_expires_at = NULL, checkpoint_json = '{}' WHERE turn_id = ?", turnId);

test("turns start oldest first, one per thread, into free model slots, and a host priority goes first", () => {
  const host = fixture({ turnPriority: turn => (turn.thread_id === "background" ? 1 : 0) });
  queue(host, "bg", "background");
  queue(host, "a1", "a");
  queue(host, "a2", "a");
  queue(host, "b1", "b");
  assert.deepEqual(scheduleTurns(host), ["a1", "b1"]);
  assert.equal(claimTurn(host, "bg"), null, "a lower-priority turn yields while a higher one is ready");
  assert.equal(claimTurn(host, "a2"), null, "the second turn of a thread waits for the first");
  assert.equal(claimTurn(host, "a1").attempt, 1);
  assert.equal(claimTurn(host, "b1").attempt, 1);
  assert.deepEqual(scheduleTurns(host), [], "both model slots are held");
  queue(host, "later", "c", { checkpoint: { retryNotBefore: host.clock + 10_000 } });
  assert.equal(claimTurn(host, "later"), null, "a retry delay is honoured");
});

test("an expired lease requeues the turn until its attempt budget is used, then the turn fails", async () => {
  const host = fixture();
  queue(host, "t", "a", { checkpoint: { budget: { attemptBudget: 2 } } });
  claimTurn(host, "t");
  host.clock += 10 * 60_000;
  await recoverTurns(host);
  assert.equal(row(host, "t").status, "queued");
  assert.equal(claimTurn(host, "t").attempt, 2);
  host.clock += 10 * 60_000;
  await recoverTurns(host);
  assert.equal(row(host, "t").status, "failed");
  assert.equal(row(host, "t").error_code, "TURN_ATTEMPTS_EXHAUSTED");
});

test("an executor call is claimed under a lease, its result is accepted once, and the turn resumes", async () => {
  const host = fixture({ claimScope: ({ installId }) => ({ accept: installId === "mine", excludedNames: ["secret_read"] }) });
  queue(host, "t", "a");
  claimTurn(host, "t");
  const hidden = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "tc0", functionName: "secret_read", input: {} });
  const callId = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "tc1", functionName: "browser", input: { action: "snapshot" } });
  waitOn(host, "t");
  assert.equal(claimFunctionCall(host, { installId: "other" }), null);
  const claimed = claimFunctionCall(host, { installId: "mine" });
  assert.equal(claimed.callId, callId, "a name the scope excludes is not handed out");
  assert.deepEqual(claimed.input, { action: "snapshot" });
  assert.equal(inspectFunctionLease(host, { callId, leaseId: claimed.leaseId }).active, true);
  host.storage.sql.exec("UPDATE agent_function_calls SET status = 'completed' WHERE call_id = ?", hidden);
  await completeFunctionCall(host, { callId, leaseId: claimed.leaseId, result: { text: "page" } });
  assert.equal(row(host, "t").status, "queued");
  assert.deepEqual(JSON.parse(row(host, "t").checkpoint_json), { tc1: { text: "page" } });
  assert.deepEqual(host.started, ["t"], "the resumed turn is started");
  assert.deepEqual(await completeFunctionCall(host, { callId, leaseId: claimed.leaseId, result: { text: "page" } }), { turnId: "t" });
  await assert.rejects(completeFunctionCall(host, { callId, leaseId: claimed.leaseId, result: { text: "other" } }), /FUNCTION_RESULT_CONFLICT/);
  const steps = host.storage.sql.exec("SELECT kind, outcome, tool_call_id FROM agent_turn_steps WHERE turn_id = 't' ORDER BY step_index").toArray();
  assert.deepEqual(steps.filter(step => step.tool_call_id === "tc1").map(step => step.outcome), ["created", "claimed", "completed"]);
});

test("a held result keeps its call open, and a writing call is leased once and expires as effect unknown", async () => {
  const host = fixture({
    calls: { readOnly: name => name !== "write" },
    writeResult: (call, turn, { result }) => {
      if (!result?.hold) return { result, checkpointJson: turn.checkpoint_json };
      // The host owns a held call: no lease, so it is neither reclaimed nor timed out.
      host.storage.sql.exec("UPDATE agent_function_calls SET lease_id = NULL, lease_expires_at = NULL WHERE call_id = ?", call.call_id);
      return { held: { awaiting: "approval" } };
    }
  });
  queue(host, "t", "a");
  claimTurn(host, "t");
  const held = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "h", functionName: "read", input: {} });
  const write = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "w", functionName: "write", input: {} });
  waitOn(host, "t");
  const first = claimFunctionCall(host, { installId: "x" });
  assert.equal(first.callId, held);
  await completeFunctionCall(host, { callId: held, leaseId: first.leaseId, result: { hold: true } });
  assert.equal(row(host, "t").status, "waiting_for_browser");
  const claimedWrite = claimFunctionCall(host, { installId: "x" });
  assert.equal(claimedWrite.callId, write);
  host.clock += 10 * 60_000;
  assert.equal(claimFunctionCall(host, { installId: "x" }).callId, null, "an expired write is not leased again");
  await recoverTurns(host);
  const settled = host.storage.sql.exec("SELECT status, error_code FROM agent_function_calls WHERE call_id = ?", write).toArray()[0];
  assert.deepEqual({ ...settled }, { status: "failed", error_code: "EFFECT_UNKNOWN" });
});

test("a parked call keeps its turn waiting past the usual lease, completes as any call, or settles with its stored miss at the deadline", async () => {
  const wakes = [];
  const host = fixture({
    calls: { readOnly: name => name !== "write", parkable: (name, input) => (name === "browser" && input.wait === "long" ? 6 * 60 * 60_000 : 0) },
    armWatchdog: async at => { if (at !== undefined) wakes.push(at); }
  });
  const iso = ms => new Date(ms).toISOString();
  const expiry = { reason: "browser_wait_timed_out", after: { observed: false, reason: "deadline" } };
  queue(host, "t", "a");
  claimTurn(host, "t");
  const callId = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "w1", functionName: "browser", input: { wait: "long" } });
  const short = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "r1", functionName: "browser", input: { wait: "short" } });
  waitOn(host, "t");
  const claimed = claimFunctionCall(host, { installId: "x" });
  const other = claimFunctionCall(host, { installId: "x" });
  assert.equal(claimed.callId, callId);
  // Only a call the product calls parkable, within the longest park, with a live lease.
  await assert.rejects(parkFunctionCall(host, { callId: short, leaseId: other.leaseId, until: iso(host.clock + 30 * 60_000), expiry }), /FUNCTION_PARK_REFUSED/);
  await assert.rejects(parkFunctionCall(host, { callId, leaseId: claimed.leaseId, until: iso(host.clock + 7 * 60 * 60_000), expiry }), /FUNCTION_PARK_REFUSED/);
  await assert.rejects(parkFunctionCall(host, { callId, leaseId: "stolen", until: iso(host.clock + 30 * 60_000), expiry }), /FUNCTION_CALL_LEASE_INVALID/);
  const parked = await parkFunctionCall(host, { callId, leaseId: claimed.leaseId, until: iso(host.clock + 30 * 60_000), expiry });
  assert.equal(parked.leaseExpiresAt, iso(host.clock + 31 * 60_000), "a minute's grace for the executor's own result");
  assert.deepEqual(wakes, [host.clock + 31 * 60_000 + 1_000], "the host wakes to settle it if nothing arrives");
  await completeFunctionCall(host, { callId: short, leaseId: other.leaseId, result: { text: "page" } });

  // Twenty minutes on (ten past the usual two-minute lease) the call is still the executor's: not
  // reclaimed, not timed out, the turn still waiting and no attempt started.
  host.clock += 20 * 60_000;
  assert.equal(claimFunctionCall(host, { installId: "x" }).callId, null, "a parked call is not handed out again");
  await recoverTurns(host);
  assert.equal(row(host, "t").status, "waiting_for_browser");
  assert.equal(inspectFunctionLease(host, { callId, leaseId: claimed.leaseId }).active, true);
  assert.deepEqual(host.started, [], "no attempt (no model request) while parked");
  // Parked again (a replaying or buggy executor), the call keeps its first deadline: a later one is
  // refused and the lease does not move; the same or an earlier one is no extension.
  const leaseOf = () => host.storage.sql.exec("SELECT lease_expires_at FROM agent_function_calls WHERE call_id = ?", callId).toArray()[0].lease_expires_at;
  const firstLease = leaseOf();
  await assert.rejects(parkFunctionCall(host, { callId, leaseId: claimed.leaseId, until: iso(host.clock + 30 * 60_000), expiry }), /FUNCTION_PARK_REFUSED/);
  assert.equal(leaseOf(), firstLease);
  await parkFunctionCall(host, { callId, leaseId: claimed.leaseId, until: parked.until, expiry });
  assert.equal(leaseOf(), firstLease);
  // The executor's result settles it as any other, and the turn resumes once.
  await completeFunctionCall(host, { callId, leaseId: claimed.leaseId, result: { reason: "browser_wait_completed" } });
  assert.equal(row(host, "t").status, "queued");
  assert.deepEqual(JSON.parse(row(host, "t").checkpoint_json).w1, { reason: "browser_wait_completed" });
  assert.deepEqual(host.started, ["t"]);

  // A second turn whose executor never answers: at the lease's end recovery settles the stored miss,
  // not a timeout error; and a turn holds one parked call at a time.
  queue(host, "u", "b");
  claimTurn(host, "u");
  const lost = insertFunctionCall(host, { turnId: "u", accountId: "acct", toolCallId: "w2", functionName: "browser", input: { wait: "long" } });
  const second = insertFunctionCall(host, { turnId: "u", accountId: "acct", toolCallId: "w3", functionName: "browser", input: { wait: "long" } });
  waitOn(host, "u");
  const lease = claimFunctionCall(host, { installId: "x" }), lease2 = claimFunctionCall(host, { installId: "x" });
  await parkFunctionCall(host, { callId: lost, leaseId: lease.leaseId, until: iso(host.clock + 10 * 60_000), expiry });
  await assert.rejects(parkFunctionCall(host, { callId: second, leaseId: lease2.leaseId, until: iso(host.clock + 10 * 60_000), expiry }), /FUNCTION_PARK_REFUSED/);
  await completeFunctionCall(host, { callId: second, leaseId: lease2.leaseId, result: { text: "quick" } });
  host.clock += 11 * 60_000 + 1_000;
  await recoverTurns(host);
  const settled = host.storage.sql.exec("SELECT status, error_code, result_json FROM agent_function_calls WHERE call_id = ?", lost).toArray()[0];
  assert.deepEqual([settled.status, settled.error_code, JSON.parse(settled.result_json)], ["completed", null, expiry]);
  assert.equal(row(host, "u").status, "queued");
  const steps = host.storage.sql.exec("SELECT outcome FROM agent_turn_steps WHERE turn_id = 'u' AND tool_call_id = 'w2' ORDER BY step_index").toArray();
  assert.deepEqual(steps.map(step => step.outcome), ["created", "claimed", "parked", "completed"]);
});

test("a stopped turn's parked call is no longer the executor's", async () => {
  const host = fixture({ calls: { parkable: () => 60 * 60_000 } });
  queue(host, "t", "a");
  claimTurn(host, "t");
  const callId = insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "w", functionName: "browser", input: {} });
  waitOn(host, "t");
  const claimed = claimFunctionCall(host, { installId: "x" });
  await parkFunctionCall(host, { callId, leaseId: claimed.leaseId, until: new Date(host.clock + 30 * 60_000).toISOString(), expiry: { reason: "miss" } });
  // What a turn's cancel does to its open calls (agent-core/pi cancelTurn).
  host.storage.sql.exec("UPDATE agent_turns SET status = 'cancelled' WHERE turn_id = 't'");
  host.storage.sql.exec("UPDATE agent_function_calls SET status = 'failed', error_code = 'TURN_CANCELLED', lease_id = NULL, lease_expires_at = NULL WHERE turn_id = 't'");
  assert.equal(inspectFunctionLease(host, { callId, leaseId: claimed.leaseId }).active, false, "the executor disarms when it checks");
  await assert.rejects(completeFunctionCall(host, { callId, leaseId: claimed.leaseId, result: {} }), /FUNCTION_CALL_LEASE_INVALID/);
});

test("a call no executor claims in time fails its turn as offline", async () => {
  const host = fixture();
  queue(host, "t", "a");
  claimTurn(host, "t");
  insertFunctionCall(host, { turnId: "t", accountId: "acct", toolCallId: "c", functionName: "browser", input: {} });
  waitOn(host, "t");
  host.storage.sql.exec("UPDATE agent_turns SET updated_at = ? WHERE turn_id = 't'", new Date(host.clock).toISOString());
  host.clock += 2 * 60_000;
  await recoverTurns(host);
  assert.equal(row(host, "t").status, "failed");
  assert.equal(row(host, "t").error_code, "CHROME_OFFLINE");
});

test("a tool receipt replays a completed call and refuses to repeat an unresolved write under a new call ID", async () => {
  const host = fixture();
  queue(host, "t", "a");
  const claim = claimTurn(host, "t");
  let runs = 0;
  const done = durableToolExecute(host, "t", claim, { name: "save", async execute() { runs++; return { content: [{ type: "text", text: "saved" }] }; } });
  assert.equal((await done("c1", { value: 1 })).content[0].text, "saved");
  assert.equal((await done("c1", { value: 1 })).content[0].text, "saved");
  assert.equal(runs, 1);
  assert.equal((await done("c1", { value: 2 })).details.errorCode, "TOOL_CALL_ID_CONFLICT");
  const crashing = durableToolExecute(host, "t", claim, { name: "send", async execute() { throw new Error("process lost"); } });
  await assert.rejects(crashing("s1", { to: "a", idempotencyKey: "k1" }));
  const again = await crashing("s2", { idempotencyKey: "k2", to: "a" });
  assert.equal(again.details.errorCode, "TOOL_EXECUTION_INTERRUPTED");
  host.storage.sql.exec("UPDATE agent_turns SET lease_id = 'other' WHERE turn_id = 't'");
  await assert.rejects(done("c3", { value: 3 }), { code: "MODEL_TURN_LEASE_LOST" });
});

test("a user's retry queues the latest failed turn once per key, with another allowance, and refuses what it cannot retry", () => {
  const host = fixture();
  const grant = { turnBudget: { modelCalls: 5, toolCalls: 6 } };
  queue(host, "t1", "a", { checkpoint: { budget: { maxModelCalls: 3, modelCalls: 3, maxToolCalls: 4, toolCallIds: ["c1"] }, citationRepairs: 1 } });
  assert.throws(() => queueTurnRetry(host, "t1", "short", grant), /INVALID_IDEMPOTENCY_KEY/);
  assert.throws(() => queueTurnRetry(host, "t1", "retry-key-1", grant), /TURN_NOT_RETRYABLE/, "a queued turn");
  host.storage.sql.exec("UPDATE agent_turns SET status = 'failed', phase = 'done', error_code = 'MODEL_STEP_LIMIT', attempt = 2 WHERE turn_id = 't1'");
  assert.throws(() => queueTurnRetry(host, "t1", "retry-key-1", { ...grant, pendingWork: () => "HELD_ELSEWHERE" }), /HELD_ELSEWHERE/);
  assert.throws(() => queueTurnRetry(host, "t1", "retry-key-1", { ...grant, retryable: () => false }), /TURN_NOT_RETRYABLE/);
  assert.deepEqual(queueTurnRetry(host, "t1", "retry-key-1", { ...grant, permissions: () => '{"write":true}' }), { retried: true });
  const retried = row(host, "t1");
  assert.deepEqual([retried.status, retried.error_code, retried.permissions_json], ["queued", null, '{"write":true}']);
  const { budget, citationRepairs } = JSON.parse(retried.checkpoint_json);
  assert.deepEqual([budget.maxModelCalls, budget.maxToolCalls, budget.toolCallIds, budget.attemptBudget, citationRepairs],
    [8, 7, ["c1"], 2 + host.maxAttempts, 0]);
  assert.deepEqual(queueTurnRetry(host, "t1", "retry-key-1", grant), { retried: false }, "the same key again changes nothing");
  assert.equal(host.events.filter(event => event.event === "agent.turn.manual_retry").length, 1);
  queue(host, "t2", "a");
  host.storage.sql.exec("UPDATE agent_turns SET status = 'failed' WHERE turn_id IN ('t1', 't2')");
  assert.throws(() => queueTurnRetry(host, "t1", "retry-key-2", grant), /TURN_RETRY_NOT_LATEST/);
});

test("a turn page is the newest turns before an anchor, oldest first, with the next page's anchor", () => {
  const host = fixture();
  for (const id of ["t1", "t2", "t3", "t4", "t5"]) queue(host, id, "a");
  queue(host, "other", "b");
  const first = turnPage(host, { threadId: "a", limit: 2, columns: "turn_id" });
  assert.deepEqual([first.rows.map(turn => turn.turn_id), first.nextBefore], [["t4", "t5"], "t4"]);
  const last = turnPage(host, { threadId: "a", limit: 3, before: "t2", columns: "turn_id" });
  assert.deepEqual([last.rows.map(turn => turn.turn_id), last.nextBefore], [["t1"], null]);
  assert.equal(turnPage(host, { limit: 10 }).rows.length, 6, "no thread: the account's turns");
  assert.throws(() => turnPage(host, { threadId: "a", limit: 2, before: "other" }), /AGENT_TURN_NOT_FOUND/);
});

test("a turn's own spend ceiling counts the estimates it is given; without one the budget keeps no cost", () => {
  const costed = createTurnBudget({ costUsd: 0.3 }, { maxModelCalls: 5, maxToolCalls: 5, maxCostUsd: 0.5 });
  costed.addCost(0.15);
  costed.addCost(undefined);
  assert.equal(costed.spendAvailable(), true);
  costed.addCost(0.1);
  assert.equal(costed.spendAvailable(), false);
  assert.equal(costed.reserve("model").spendLimit, true);
  assert.ok(Math.abs(costed.snapshot().costUsd - 0.55) < 1e-9);
  const plain = createTurnBudget({}, { maxModelCalls: 5, maxToolCalls: 5 });
  plain.addCost(1);
  assert.equal("costUsd" in plain.snapshot(), false);
  assert.equal(plain.spendAvailable(), true);
});

test("a stop names the cap that made it: the turn's own ceiling or the cap outside the turn", () => {
  const turnCapped = createTurnBudget({ costUsd: 0.6 }, { maxModelCalls: 5, maxToolCalls: 5, maxCostUsd: 0.5 });
  assert.equal(turnCapped.spendLimitCode(), "MODEL_TURN_SPEND_LIMIT");
  assert.equal(spendLimitError(turnCapped.spendLimitCode()).code, "MODEL_TURN_SPEND_LIMIT");
  const monthCapped = createTurnBudget({ costUsd: 0.1 }, { maxModelCalls: 5, maxToolCalls: 5, maxCostUsd: 0.5, modelSpendAvailable: () => false });
  assert.equal(monthCapped.spendLimitCode(), "MODEL_SPEND_LIMIT");
  const both = createTurnBudget({ costUsd: 0.6 }, { maxModelCalls: 5, maxToolCalls: 5, maxCostUsd: 0.5, modelSpendAvailable: () => false });
  assert.equal(both.spendLimitCode(), "MODEL_SPEND_LIMIT", "a retry cannot lift the outside cap, so it is the one named");
  assert.equal(spendLimitError().code, "MODEL_SPEND_LIMIT");
});
