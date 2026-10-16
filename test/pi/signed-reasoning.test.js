import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { withSignedReasoning } from "agent-core/pi";

// The shape OpenRouter streamed for claude-haiku-5.5 asked for no reasoning effort (2026-10-10
// capture; the signature is shortened): the reasoning arrives signed, with no text.
const SIGNED = { type: "reasoning.text", signature: "CAQS+AsKEAgSGAI4AUIIdGhpbmtpbmcSDIAxPCXe9HRVQA2upRoM.eyJlbmRwb2ludCI6ImEifQ", format: "anthropic-claude-v1", index: 0 };
const chunk = body => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "anthropic/claude-haiku-5.5", ...body })}\n\n`;

function streamed(...chunks) {
  const bytes = new TextEncoder().encode(chunks.join("") + "data: [DONE]\n\n");
  // Split mid-line, as a network stream may deliver it.
  return new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 29) controller.enqueue(bytes.slice(at, at + 29));
    controller.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const model = { id: "anthropic/claude-haiku-5.5", name: "haiku", api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.test/api/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192 };
const tool = { name: "check", description: "Checks a number.", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } };

test("reasoning returned only signed is kept and sent back on the tool loop's next request", async () => {
  const bodies = [];
  const responses = [
    streamed(
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_details: [SIGNED] }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "check", arguments: "{\"n\":1097}" } }] }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 550, total_tokens: 560 } })),
    streamed(
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "16" }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })),
  ];
  const fetchImpl = withSignedReasoning(async (_input, init) => { bodies.push(JSON.parse(String(init.body))); return responses.shift(); });
  const context = { systemPrompt: "system", tools: [tool], messages: [{ role: "user", content: "How many primes?", timestamp: 0 }] };

  const first = await streamSimple(model, context, { apiKey: "test", fetch: fetchImpl }).result();
  assert.equal(first.stopReason, "toolUse");
  const thinking = first.content.find(block => block.type === "thinking");
  assert.ok(thinking, "the signed reasoning is kept as a thinking block");
  assert.deepEqual(JSON.parse(thinking.thinkingSignature), [{ ...SIGNED, text: "" }]);

  context.messages.push(first, { role: "toolResult", toolCallId: "call_1", toolName: "check", isError: false, content: [{ type: "text", text: "prime" }], timestamp: 0 });
  const second = await streamSimple(model, context, { apiKey: "test", fetch: fetchImpl }).result();
  assert.equal(second.stopReason, "stop");
  const replayed = bodies[1].messages.find(message => message.role === "assistant");
  assert.deepEqual(replayed.reasoning_details, [{ ...SIGNED, text: "" }]);
  assert.equal(replayed.tool_calls[0].id, "call_1");
});

test("a response without signed reasoning passes through unchanged", async () => {
  const text = chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi", reasoning_details: [{ type: "reasoning.text", text: "shown", index: 0 }] }, finish_reason: null }] });
  const response = await withSignedReasoning(async () => streamed(text))("https://openrouter.test", {});
  assert.equal(await response.text(), `${text}data: [DONE]\n\n`);
  const failed = new Response("bad", { status: 400 });
  assert.equal(await withSignedReasoning(async () => failed)("https://openrouter.test", {}), failed);
});
