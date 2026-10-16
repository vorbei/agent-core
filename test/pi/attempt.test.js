import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxThinking, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "agent-core/memory";
import { JOURNAL_ENTRY_TYPES, PI_PRIVATE_API_PIN, PiAttempt, checkpointMessages, nativeCheckpoint } from "agent-core/pi";
import { prepareNextTurnFromState, runThresholdCompaction } from "../../src/pi/pi-private.js";

function attempt(responses, options = {}) {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const requests = [];
  const streamFn = (model, context, streamOptions) => { requests.push(structuredClone(context.messages)); return faux.streamSimple(model, context, streamOptions); };
  return { requests, attempt: new PiAttempt({ model: faux.getModel(), streamFn, systemPrompt: "You are a test agent.", maxSteps: 8, maxToolCalls: 8, ...options }) };
}

const text = message => typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("");

test("an attempt reserves each model step, checkpoints at message ends and records its authorization as a typed entry", async () => {
  const saved = [];
  const budgets = [];
  const read = { name: "read", label: "read", description: "Read", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "the page" }], details: {} }) };
  const { attempt: run } = attempt([fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")],
    { tools: [read], onCheckpoint: async (checkpoint, boundary) => saved.push(boundary.role), onBudget: async (state, boundary) => budgets.push([boundary.role, state.modelCalls]) });
  const checkpoint = await run.prompt("read it", { preface: "Write is disabled." });
  assert.equal(checkpoint.finalText, "done");
  assert.deepEqual(budgets.map(([role]) => role), ["model_budget", "tool_budget", "model_budget"]);
  assert.deepEqual(saved, ["user", "assistant", "toolResult"], "journal boundaries; the final answer is in the returned checkpoint");
  const messages = checkpointMessages(nativeCheckpoint(checkpoint));
  assert.equal(messages[0].customType, JOURNAL_ENTRY_TYPES.turnAuthorization);
  assert.equal(checkpoint.budget.modelCalls, 2);
});

test("a queued steer is placed at Pi's public boundary and committed with the journal entry that carries it", async () => {
  const boundaries = [];
  let queued = false, offered = false;
  const read = { name: "read", label: "read", description: "Read", parameters: Type.Object({}),
    execute: async () => { queued = true; return { content: [{ type: "text", text: "the page" }], details: {} }; } };
  const { attempt: run, requests } = attempt([fauxAssistantMessage([fauxToolCall("read", {}, { id: "r1" })], { stopReason: "toolUse" }), fauxAssistantMessage("second")], {
    tools: [read],
    // The user's message arrives while the tool runs.
    nextSteer: async () => (!queued || offered ? null : (offered = true, { id: "steer-1", text: "also this" })),
    onCheckpoint: async (_checkpoint, boundary) => boundaries.push(boundary)
  });
  const checkpoint = await run.prompt("start");
  assert.equal(checkpoint.finalText, "second");
  assert.deepEqual(boundaries.filter(boundary => boundary.steerId), [{ role: "user", toolCallId: undefined, steerId: "steer-1" }]);
  assert.ok(requests.at(-1).some(message => message.role === "user" && text(message) === "also this"));
});

test("the model view and its tail come from the product, the budget line from the runtime", async () => {
  const { attempt: run, requests } = attempt([fauxAssistantMessage("ok")], {
    contextView: messages => messages.map(message => message.role === "user" ? { ...message, content: [{ type: "text", text: "projected" }] } : message),
    contextTail: async (view, budgetLine) => [{ role: "user", content: [{ type: "text", text: "card" }], timestamp: 0 }, budgetLine]
  });
  await run.prompt("raw");
  const sent = requests[0].map(text);
  assert.deepEqual(sent.slice(0, 2), ["projected", "card"]);
  assert.match(sent[2], /^Runtime budget: 7 model calls after this response; 8 tool dispatches remain\./);
});

test("a thread's earlier reasoning stays in the journal but leaves the model view once a new user message starts", async () => {
  // Live thread 2026-10-10: reasoning re-sent from earlier turns was about 40% of a 340K-token request.
  const read = { name: "read", label: "read", description: "Read", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "the page" }], details: {} }) };
  // About 30K tokens per block, two blocks per task: three tasks pass the faux model's 111K trigger.
  const reasoning = task => `${task} reasoning `.repeat(10_000);
  const toolTask = task => [fauxAssistantMessage([fauxThinking(reasoning(task)), fauxToolCall("read", {}, { id: `${task}-r` })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxThinking(reasoning(task)), { type: "text", text: `${task} done` }])];
  let history = [];
  const runs = [];
  for (const task of ["first", "second", "third"]) {
    // No summarizer: a request that reached the compaction trigger would fail the task.
    const run = attempt(toolTask(task), { tools: [read], messages: history });
    assert.equal((await run.attempt.prompt(`${task} task`)).finalText, `${task} done`);
    history = checkpointMessages(nativeCheckpoint(run.attempt.checkpoint({ full: true })));
    runs.push(run);
  }
  const thinking = request => request.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "thinking") : [])
    .map(block => block.thinking.split(" ")[0]);
  assert.deepEqual(runs[2].requests.map(thinking), [[], ["third"]], "earlier tasks' reasoning is not re-sent; the running tool loop keeps its own");
  assert.equal(history.filter(message => message.content?.some?.(block => block.type === "thinking")).length, 6, "the journal keeps it");
  const trigger = 128_000 - 16_384;
  assert.ok(estimateContextTokens(history) > trigger);
  assert.ok(runs.flatMap(run => run.requests).every(request => estimateContextTokens(request) < trigger / 2));
});

test("an answer that only repeats tool-call markup is kept; trailing markup is removed", async () => {
  const { attempt: run } = attempt([fauxAssistantMessage("Three prices.\n<tool_call>{\"name\":\"x\"}</tool_call>")]);
  assert.equal((await run.prompt("prices?")).finalText, "Three prices.");
});

test("Pi's private members are reached only on the pinned version, and the pin matches the package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], PI_PRIVATE_API_PIN);
  assert.throws(() => runThresholdCompaction({}), /PI_PRIVATE_API_MISSING/);
  assert.throws(() => prepareNextTurnFromState({ state: { messages: [] } }), /PI_PRIVATE_API_MISSING/);
});
