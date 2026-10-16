// Model view only: reasoning from turns before the latest user message is left out of the request.
// A reasoning model needs its own reasoning back only inside the tool loop that produced it
// (DeepSeek asks for it there and asks callers to remove earlier turns' reasoning); afterwards it
// is re-sent on every request without informing anything. The journal keeps every block.
//
// The boundary is the latest user message, as for the product's observation stubs: a turn's own
// requests stay append-only, and earlier history changes once, when a new user message starts.

/** @param {any[]} messages @returns {any[]} */
export function withoutEarlierReasoning(messages) {
  const boundary = messages.findLastIndex(message => message.role === "user");
  if (boundary <= 0) return messages;
  let changed = false;
  const view = messages.map((message, index) => {
    if (index > boundary || message.role !== "assistant" || !message.content?.some(isThinking)) return message;
    changed = true;
    return { ...message, content: message.content.filter(block => !isThinking(block)) };
  });
  return changed ? view : messages;
}

/** @param {any} block */
const isThinking = block => block?.type === "thinking";
