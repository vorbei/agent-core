// Prompt-cache breakpoints: the next request of a turn must find a breakpoint at the end of the
// history it shares with this one, never only on the dynamic tail that moves every request.
import assert from "node:assert/strict";
import test from "node:test";
import { markPromptCache } from "../../src/pi/index.js";

const request = () => [
  { role: "system", content: "Rules." },
  { role: "user", content: [{ type: "text", text: "solve this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_fetch", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "page text" },
  { role: "user", content: "Runtime budget: 40 model calls remain." }
];
const marks = messages => messages.flatMap((message, index) => Array.isArray(message.content)
  ? message.content.filter(part => part.cache_control).map(() => index) : []);

test("a breakpoint goes on the system prompt and the newest history step, not the tail", () => {
  for (const model of ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash"]) {
    const messages = request();
    markPromptCache(model, messages);
    assert.deepEqual(marks(messages), [0, 3], model);
    assert.equal(messages[4].content, "Runtime budget: 40 model calls remain.", "the dynamic tail is left as it was");
  }
  // The next request appends a step: its history end moves on, and the earlier step's text is unchanged.
  const next = request();
  next.splice(4, 0, { role: "assistant", content: "Trying another source." });
  markPromptCache("openai/gpt-5.6-sol", next);
  assert.deepEqual(marks(next), [0, 4]);
});

test("a first request has only the system breakpoint; automatic-cache models are left alone", () => {
  const first = [{ role: "system", content: "Rules." }, { role: "user", content: "hi" }, { role: "user", content: "budget" }];
  markPromptCache("anthropic/claude-sonnet-5.5", first);
  assert.deepEqual(marks(first), [0]);
  const plain = request();
  markPromptCache("deepseek/deepseek-v4.1-flash", plain);
  assert.equal(JSON.stringify(plain), JSON.stringify(request()));
});
