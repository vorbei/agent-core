// Prompt-cache breakpoints on an OpenAI-format request for the OpenRouter models that cache only where
// a request marks it: Anthropic and Google, and OpenAI's sol models, which read 10K tokens (the
// system prompt and tools) and nothing after it unless marked (measured 2026-10-12);
// OpenAI models that cache by themselves keep
// doing so with the markers. One breakpoint on the system prompt and one at the end of the
// append-only history, the newest tool result or assistant text, so the next request reads every
// step before its own. The dynamic tail after the history (the budget line, a knowledge card) is
// never marked: a breakpoint there is written once and never read again.

const EXPLICIT_CACHE_MODEL = /^(anthropic|google|openai)\//;
const BREAKPOINT = Object.freeze({ type: "ephemeral" });

/** Marks `messages` (OpenAI chat format) in place for an OpenRouter model id; other ids are left alone. */
export function markPromptCache(modelId, messages) {
  if (!EXPLICIT_CACHE_MODEL.test(String(modelId || "")) || !Array.isArray(messages)) return;
  const system = messages.find(message => message.role === "system");
  const historyEnd = messages.findLast(message => (message.role === "tool" || message.role === "assistant") && textOf(message));
  for (const message of new Set([system, historyEnd])) {
    if (!message) continue;
    if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
    const block = Array.isArray(message.content) ? message.content.findLast(part => part?.type === "text" && part.text) : null;
    if (block) block.cache_control = BREAKPOINT;
  }
}

/** The message's text, empty when it carries none (an assistant message with only tool calls). */
function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.filter(part => part?.type === "text").map(part => part.text || "").join("") : "";
}
