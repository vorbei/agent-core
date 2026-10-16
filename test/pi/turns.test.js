import assert from "node:assert/strict";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { PARTIAL_TEXT_INTERVAL_MS, PI_JOURNAL_SCHEMA, WAITING_RESULT_PREFIX, cancelTurn, checkpointMessages, executorWaitingResult, insertTurn, readTurnCheckpoint,
  restorePriorMessages, runTurnAttempt, withModelDeadline, writeJournalResult } from "agent-core/pi";
import { PARTIAL_TEXT_MAX_CHARS, RUNTIME_SCHEMA, claimFunctionCall, completeFunctionCall, createTurnBudget, insertFunctionCall, projectTurn, recoverTurns,
  validateTurnProjection } from "agent-core/runtime";
import { sqliteStorage } from "../memory/sqlite-storage.js";

// SHA-256 of "{}", the receipt hash of a call without arguments.
const EMPTY_INPUT_HASH = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const text = message => typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("");

// A product with one executor tool ("browser") and one server tool ("read"), on a faux model.
function driver(responses, { maxModelCalls = 8, onBrowser = () => {}, fauxOptions = {}, hostFields = {}, onEvent, openOptions = {}, wrapStream = streamFn => streamFn, images } = {}) {
  const storage = sqliteStorage();
  storage.sync = async () => {};
  for (const statement of [...RUNTIME_SCHEMA, ...PI_JOURNAL_SCHEMA]) storage.sql.exec(statement);
  const faux = createFauxCore(fauxOptions);
  faux.setResponses(responses);
  const requests = [];
  const events = [];
  const host = {
    storage,
    log: (event, detail) => events.push({ event, ...detail }),
    background: () => {},
    armWatchdog: async () => {},
    startAttempt: async () => {},
    modelConcurrency: () => 2,
    modelDeadlineMs: () => 1_000,
    maxAttempts: 5,
    executorClaimWaitMs: 60_000,
    ...hostFields,
    calls: { executor: name => name === "browser", readOnly: () => true },
    writeResult: (call, turn, { result, errorCode }) => writeJournalResult(storage, turn, checkpoint => ({ result,
      messages: checkpointMessages(checkpoint).map(message => message.role === "toolResult" && message.toolCallId === call.tool_call_id
        ? { ...message, content: [{ type: "text", text: errorCode || JSON.stringify(result) }], isError: Boolean(errorCode) } : message) })),
    attempt: {
      prepare: ({ turn, receipt }) => {
        const tools = [
          { name: "browser", label: "browser", description: "Browser", parameters: Type.Object({ url: Type.String() }),
            execute: async (toolCallId, params) => (onBrowser(), executorWaitingResult({ functionName: "browser",
              callId: insertFunctionCall(host, { turnId: turn.turn_id, accountId: "acct", toolCallId, functionName: "browser", input: params }) })) },
          { name: "read", label: "read", description: "Read", parameters: Type.Object({}),
            execute: receipt("read", async () => ({ content: [{ type: "text", text: "read once" }], details: {} }), true) }
        ];
        return { tools, budget: createTurnBudget({}, { maxModelCalls, maxToolCalls: 8 }), acceptsSteer: () => true, ...(images ? { images } : {}),
          open: async () => ({ options: { model: faux.getModel(), systemPrompt: "test", tools, maxSteps: maxModelCalls, maxToolCalls: 8, onEvent, ...openOptions,
            streamFn: wrapStream((model, context, options) => { requests.push(structuredClone(context.messages)); return faux.streamSimple(model, context, options); }) } }) };
      }
    }
  };
  const queue = (turnId, input = {}) => insertTurn(host, { turnId, accountId: "acct", threadId: "thread", runtimeVersion: "test", permissions: {},
    input: { text: `ask ${turnId}`, ...input }, idempotencyKey: `key-${turnId}`, inputHash: turnId });
  const turn = turnId => storage.sql.exec("SELECT * FROM agent_turns WHERE turn_id = ?", turnId).toArray()[0];
  return { host, storage, faux, requests, events, queue, turn, run: turnId => runTurnAttempt(host, turnId) };
}

test("a turn is claimed, runs its attempt and completes with its answer journaled", async () => {
  const { queue, run, turn, storage } = driver([fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  queue("t1");
  assert.deepEqual(await run("t1"), { claimed: true });
  assert.equal(turn("t1").status, "completed");
  assert.equal(turn("t1").final_answer, "done");
  assert.deepEqual(storage.sql.exec("SELECT kind, outcome FROM agent_turn_steps WHERE turn_id = 't1' ORDER BY step_index").toArray().map(Object.values),
    [["model", "started"], ["model", "completed"]]);
  assert.equal(checkpointMessages(readTurnCheckpoint(storage, "t1")).at(-1).content[0].text, "done");
  assert.deepEqual(await run("t1"), { claimed: false }, "a finished turn is not claimed again");
});

test("the answer so far is stored while the model streams, at most once per interval, and is gone when the message ends", async () => {
  // 4,100 characters streamed 4 at a time, 10 ms of the host's clock per update event.
  const full = Array.from({ length: 41 }, (_, index) => `line ${String(index).padStart(2, "0")} `.padEnd(99, ".") + "\n").join("");
  let clock = Date.parse("2026-10-09T00:00:00.000Z");
  const notified = [];
  const seen = [];
  let updates = 0;
  let fixture;
  fixture = driver([fauxAssistantMessage(full)], {
    fauxOptions: { tokenSize: { min: 1, max: 1 } },
    hostFields: { now: () => clock, notify: topics => notified.push(topics), modelDeadlineMs: () => 600_000 },
    onEvent: event => {
      if (event.type !== "message_update" || event.message.role !== "assistant") return;
      clock += 10;
      updates++;
      const row = fixture.turn("t1");
      if (row.partial_text) seen.push(projectTurn(row, { progress: { label: "", items: [] } }));
    }
  });
  const writes = [];
  const exec = fixture.storage.sql.exec.bind(fixture.storage.sql);
  fixture.storage.sql.exec = (query, ...bindings) => {
    if (/^UPDATE agent_turns SET partial_text = \?/.test(query)) writes.push({ at: clock, text: bindings[0] });
    return exec(query, ...bindings);
  };
  fixture.queue("t1");
  await fixture.run("t1");

  const texts = writes.filter(write => write.text !== null);
  // Hundreds of updates, a write only every PARTIAL_TEXT_INTERVAL_MS, and none once the text stops changing.
  assert.ok(updates > 500 && texts.length >= 5 && texts.length <= Math.ceil(updates * 10 / PARTIAL_TEXT_INTERVAL_MS) + 1, `${texts.length} writes for ${updates} updates`);
  for (let index = 1; index < texts.length; index++) assert.ok(texts[index].at - texts[index - 1].at >= PARTIAL_TEXT_INTERVAL_MS);
  for (const { text } of texts) {
    assert.ok(text.length <= PARTIAL_TEXT_MAX_CHARS);
    assert.ok(full.includes(text), "the newest characters of the answer so far");
  }
  assert.ok(texts.at(-1).text.length === PARTIAL_TEXT_MAX_CHARS && !texts.at(-1).text.startsWith("line 00"), "a long answer keeps its newest characters");
  assert.equal(writes.at(-1).text, null, "cleared when the message ends");
  assert.ok(notified.filter(topics => topics.length === 1 && topics[0] === "ui").length >= texts.length, "each write tells the UI");
  // The chat reads it from the projection while the turn runs.
  assert.ok(seen.length > 0);
  for (const view of seen) {
    assert.equal(view.status, "running");
    assert.ok(full.includes(view.partialText));
    assert.ok(validateTurnProjection(view));
  }
  const done = fixture.turn("t1");
  assert.equal(done.status, "completed");
  assert.equal(done.partial_text, null);
  assert.equal("partialText" in projectTurn(done, { progress: { label: "", items: [] } }), false);
});

test("a message's images go with its text, the turn's and a steer's, also when the product loads them asynchronously", async () => {
  const loaded = [];
  const { queue, run, turn, requests } = driver([
    fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("saw both")
  ], { images: async (input, turnId) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    loaded.push(turnId);
    return input.picture ? [{ type: "image", mimeType: "image/png", data: input.picture }] : [];
  } });
  queue("t1", { picture: "iVBORw0KGgoAAAA" });
  queue("s1", { whileRunning: "steer", picture: "iVBORw0KGgoBBBB" });
  await run("t1");
  assert.equal(turn("t1").final_answer, "saw both");
  const images = message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image").map(block => block.data) : [];
  assert.deepEqual(requests.at(-1).filter(message => message.role === "user").flatMap(images), ["iVBORw0KGgoAAAA", "iVBORw0KGgoBBBB"],
    "the turn's message and the steer each carry their own image");
  assert.deepEqual(loaded, ["t1", "s1"]);
  assert.equal(JSON.parse(turn("s1").input_json).mergedIntoTurnId, "t1");
});

test("an executor call suspends the turn; its result resumes it from the journal", async () => {
  const { host, queue, run, turn, requests } = driver([
    fauxAssistantMessage([fauxToolCall("browser", { url: "https://example.com" }, { id: "b1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("the page says hello")
  ]);
  queue("t1");
  await run("t1");
  assert.equal(turn("t1").status, "waiting_for_browser");
  const claim = claimFunctionCall(host, {});
  await completeFunctionCall(host, { callId: claim.callId, leaseId: claim.leaseId, result: { text: "hello" } });
  assert.equal(turn("t1").status, "queued");
  await run("t1");
  assert.equal(turn("t1").final_answer, "the page says hello");
  assert.ok(requests.at(-1).some(message => message.role === "toolResult" && text(message) === JSON.stringify({ text: "hello" })));
});

test("a tool batch that waits for its executor ends the run: no last-step notice and no steer buys a request that would be cut", async () => {
  let steer = () => {};
  const { host, queue, run, turn, requests } = driver([
    fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("browser", { url: "https://example.com" }, { id: "b1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("answered with the last request")
  ], { maxModelCalls: 3, onBrowser: () => steer() });
  // A steer arrives while the model's browser step runs.
  steer = () => { queue("late", { whileRunning: "steer" }); steer = () => {}; };
  queue("t1");
  await run("t1");
  assert.equal(turn("t1").status, "waiting_for_browser");
  assert.equal(requests.length, 2, "the request after the browser step waits for its result");
  assert.ok(!requests.flat().some(message => message.role === "user" && text(message).startsWith("Tool budget notice")));
  const claim = claimFunctionCall(host, {});
  await completeFunctionCall(host, { callId: claim.callId, leaseId: claim.leaseId, result: { text: "hello" } });
  await run("t1");
  assert.equal(turn("t1").final_answer, "answered with the last request");
  assert.equal(requests.length, 3);
  assert.ok(requests[2].some(message => message.role === "user" && text(message) === "ask late"), "the steer joins the resumed run");
  assert.equal(turn("late").status, "completed");
});

test("a lost attempt is requeued by recovery and its interrupted read is replayed once", async () => {
  const { host, queue, run, turn, storage } = driver([fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }), fauxAssistantMessage("after the read")]);
  queue("t1");
  // The attempt's process stops inside the read: its receipt is started, its lease expires.
  storage.sql.exec(`UPDATE agent_turns SET status = 'running', attempt = 1, lease_id = 'gone', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = 't1'`);
  storage.sql.exec(`INSERT INTO agent_tool_receipts (turn_id, tool_call_id, tool_name, input_hash, effect_hash, read_only, attempt, status, created_at, updated_at)
    VALUES ('t1', 'r1', 'read', ?, ?, 1, 1, 'started', '2000-01-01', '2000-01-01')`, EMPTY_INPUT_HASH, EMPTY_INPUT_HASH);
  await recoverTurns(host);
  assert.equal(turn("t1").status, "queued");
  // The journal the lost attempt saved ends with the tool call.
  storage.sql.exec("UPDATE agent_turns SET checkpoint_json = ? WHERE turn_id = 't1'", JSON.stringify({ sessionContextVersion: 3,
    messages: [{ role: "user", content: [{ type: "text", text: "ask t1" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: {} }], stopReason: "toolUse", api: "faux", provider: "faux", model: "faux",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 }] }));
  await run("t1");
  assert.equal(turn("t1").status, "completed");
  assert.equal(storage.sql.exec("SELECT status FROM agent_tool_receipts WHERE tool_call_id = 'r1'").toArray()[0].status, "completed");
});

test("a retryable model failure requeues the turn after a backoff; a second one fails it", async () => {
  const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 upstream unavailable" });
  const { queue, run, turn, storage } = driver([failure, failure]);
  queue("t1");
  await run("t1");
  assert.equal(turn("t1").status, "queued");
  assert.equal(turn("t1").error_code, "MODEL_HTTP_503");
  assert.ok(JSON.parse(turn("t1").checkpoint_json).retryNotBefore > Date.now());
  assert.deepEqual(await run("t1"), { claimed: false }, "not before its backoff");
  storage.sql.exec("UPDATE agent_turns SET checkpoint_json = json_set(checkpoint_json, '$.retryNotBefore', 0) WHERE turn_id = 't1'");
  await assert.rejects(run("t1"), /HTTP 503/);
  assert.equal(turn("t1").status, "failed");
});

// A response that spent the model's whole output budget on reasoning (finish_reason "length"): the
// faux model counts its output from the content, so the model's budget is smaller than the thinking.
const smallOutput = { models: [{ id: "faux-small", maxTokens: 8 }] };
const cutAtOutputLimit = thinking => fauxAssistantMessage([fauxThinking(thinking.repeat(20))], { stopReason: "length" });

test("a response cut at its output limit with no answer is retried once as the output recovery: no tools, a larger budget, less reasoning", async () => {
  const seen = [];
  const cut = cutAtOutputLimit("thinking and thinking");
  const { queue, run, turn, storage } = driver([cut, (context, options, _state, model) => {
    seen.push({ tools: context.tools?.length ?? 0, system: context.systemPrompt, maxTokens: options?.maxTokens, modelMax: model.maxTokens, reasoning: options?.reasoning });
    return fauxAssistantMessage("the answer");
  }], { openOptions: { outputLimitWording: "ANSWER NOW" }, fauxOptions: smallOutput });
  queue("t1");
  await run("t1");
  assert.equal(turn("t1").status, "queued");
  assert.equal(turn("t1").error_code, "MODEL_OUTPUT_LIMIT");
  storage.sql.exec("UPDATE agent_turns SET checkpoint_json = json_set(checkpoint_json, '$.retryNotBefore', 0) WHERE turn_id = 't1'");
  await run("t1");
  assert.equal(turn("t1").status, "completed");
  assert.equal(turn("t1").final_answer, "the answer");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tools, 0);
  assert.match(seen[0].system, /ANSWER NOW$/);
  assert.equal(seen[0].maxTokens, seen[0].modelMax * 2);
  assert.equal(seen[0].reasoning, "low");
});

test("an output recovery that is cut again fails the turn as MODEL_OUTPUT_LIMIT, and only that retry is a recovery", async () => {
  const cut = cutAtOutputLimit("still thinking");
  const seen = [];
  const { queue, run, turn, storage } = driver([cut, (context, options) => (seen.push(options?.reasoning), cut)], { fauxOptions: smallOutput });
  queue("t1");
  await run("t1");
  storage.sql.exec("UPDATE agent_turns SET checkpoint_json = json_set(checkpoint_json, '$.retryNotBefore', 0) WHERE turn_id = 't1'");
  await assert.rejects(run("t1"), /output limit/);
  assert.equal(turn("t1").status, "failed");
  assert.equal(turn("t1").error_code, "MODEL_OUTPUT_LIMIT");
  assert.deepEqual(seen, ["low"]);
  // Any other retry is the same request again.
  const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 upstream unavailable" });
  const other = driver([failure, (context, options) => (seen.push(options?.reasoning ?? null, context.tools.length), fauxAssistantMessage("ok"))]);
  other.queue("t2");
  await other.run("t2");
  other.storage.sql.exec("UPDATE agent_turns SET checkpoint_json = json_set(checkpoint_json, '$.retryNotBefore', 0) WHERE turn_id = 't2'");
  await other.run("t2");
  assert.equal(other.turn("t2").status, "completed");
  assert.deepEqual(seen.slice(1), [null, 2]);
});

test("a request cut by the model deadline fails as MODEL_TIMEOUT and is retried; a cancel is not a timeout", async () => {
  const hang = (context, options) => new Promise(resolve => options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true }));
  const { queue, run, turn, storage, events } = driver([hang, fauxAssistantMessage("after the timeout")],
    { wrapStream: streamFn => withModelDeadline(streamFn, () => 20) });
  queue("t1");
  await run("t1");
  assert.equal(turn("t1").status, "queued");
  assert.equal(turn("t1").error_code, "MODEL_TIMEOUT");
  assert.match(events.find(event => event.event === "agent.turn.retrying").errorMessage, /exceeded 20ms/);
  storage.sql.exec("UPDATE agent_turns SET checkpoint_json = json_set(checkpoint_json, '$.retryNotBefore', 0) WHERE turn_id = 't1'");
  await run("t1");
  assert.equal(turn("t1").final_answer, "after the timeout");

  const cancelled = driver([hang], { wrapStream: streamFn => withModelDeadline(streamFn, 60_000) });
  cancelled.queue("t2");
  const running = cancelled.run("t2");
  await new Promise(resolve => setTimeout(resolve, 20));
  cancelTurn(cancelled.host, "t2");
  await running;
  assert.equal(cancelled.turn("t2").status, "cancelled");
});

test("cancel ends a waiting turn and the turns it owns, not a background child; a restore reads the cancelled call", async () => {
  const { host, queue, run, turn } = driver([fauxAssistantMessage([fauxToolCall("browser", { url: "https://example.com" }, { id: "b1" })], { stopReason: "toolUse" })]);
  host.calls.settled = (messages, call) => messages.map(message => message.toolCallId === call.tool_call_id && message.role === "toolResult"
    ? { ...message, content: [{ type: "text", text: `settled ${call.error_code}` }] } : message);
  queue("t1");
  await run("t1");
  queue("child", { parentTurnId: "t1" });
  queue("detached", { parentTurnId: "t1", background: true });
  const result = cancelTurn(host, "t1");
  assert.deepEqual(result.cancelled.map(row => row.turn_id).sort(), ["child", "t1"]);
  assert.equal(turn("detached").status, "queued");
  queue("t2");
  const prior = restorePriorMessages(host, { ...turn("t2"), storage_rowid: 99 });
  const waiting = prior.find(message => message.role === "toolResult" && message.toolCallId === "b1");
  assert.equal(text(waiting), "settled TURN_CANCELLED");
  assert.ok(!prior.some(message => message.role === "toolResult" && text(message).startsWith(WAITING_RESULT_PREFIX)));
});

test("a steer an attempt is placing cannot be cancelled: it is already being delivered", async () => {
  const { host, queue, storage } = driver([]);
  queue("t1");
  queue("steer", { whileRunning: "steer", placingLease: "lease-1" });
  storage.sql.exec(`UPDATE agent_turns SET status = 'running', lease_id = 'lease-1', lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE turn_id = 't1'`);
  assert.deepEqual(cancelTurn(host, "steer"), { cancel: "already_delivering", cancelled: [] });
});

test("a steer is never dropped: it joins the turn while a model step is left, and is its own turn when it comes too late", async () => {
  // The user's message arrives during the turn's last model call (live 2026-10-10: the panel
  // showed it with no reply; the running turn's answer is the reply when it joined).
  const steerDuringLastCall = (/** @type {any} */ queue, /** @type {string} */ answerText) => () => {
    queue("steer", { text: "also remove the spam accounts", whileRunning: "steer" });
    return fauxAssistantMessage(answerText);
  };
  for (const [maxModelCalls, joins] of [[8, true], [2, false]]) {
    const drive = driver([], { maxModelCalls });
    drive.faux.setResponses([fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }),
      steerDuringLastCall(drive.queue, "first answer"), fauxAssistantMessage("answer with the steer")]);
    drive.queue("t1");
    await drive.run("t1");
    const steer = drive.turn("steer"), running = drive.turn("t1");
    assert.equal(running.status, "completed");
    if (joins) {
      assert.equal(JSON.parse(steer.input_json).mergedIntoTurnId, "t1");
      assert.equal(steer.status, "completed");
      assert.equal(running.final_answer, "answer with the steer", "the running turn answered the steer it took");
      assert.ok(drive.requests.at(-1).some(message => message.role === "user" && text(message) === "also remove the spam accounts"));
      continue;
    }
    // No model step left: the running turn did not take it; it waits, unmarked, and runs as its own turn.
    assert.equal(running.final_answer, "first answer");
    const input = JSON.parse(steer.input_json);
    assert.deepEqual([steer.status, input.mergedIntoTurnId, input.placingLease], ["queued", undefined, undefined]);
    await drive.run("steer");
    assert.deepEqual([drive.turn("steer").status, drive.turn("steer").final_answer], ["completed", "answer with the steer"]);
    assert.ok(drive.requests.at(-1).some(message => message.role === "user" && text(message) === "also remove the spam accounts"));
  }
});
