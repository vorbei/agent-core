// Model view only: tool-result images older than the most recent few are replaced by a short text
// stub; the journal keeps every image. Each screenshot costs a model thousands of input tokens on
// every later request of the conversation (one measured turn: 31 requests, 53K input tokens each), and an
// old picture of a screen that has since changed is evidence of nothing.
//
// Providers cache the byte-identical request prefix, so a stub that moves one image further on
// every request would rewrite the cached prefix every time. The cut therefore moves in blocks
// (as Anthropic's computer-use reference loop does): images are dropped `step` at a time, so the
// view holds between `keep` and `keep + step - 1` images and the prefix changes once per `step`
// new images. The stub is derived from the message alone, so a resumed turn sends the same bytes.
//
// Measured live (evals/tool-image-view.mjs, gpt-6.1-sol, 30 steps, 15 pictures, each arm its own
// cache): with the cache working, a cut rewrites the
// rest of the history uncached, which costs more than the cached pictures it removes. Keeping 2
// and dropping 4 at a time cut input tokens 19 % but raised cost 22 %; dropping 8 at a time, 10 %
// and 7 %. So the default bounds a picture-heavy turn instead of trimming every one: the view holds
// 4 to 15 pictures and the first cut comes with the 16th.
export const TOOL_IMAGE_VIEW = Object.freeze({ keep: 4, step: 12 });

/**
 * @param {any[]} messages Pi messages (tool results carry `{type:"image"}` content blocks)
 * @param {{ keep?: number, step?: number }} [options]
 * @returns {any[]} the same array when nothing is dropped, else a copy with stubs
 */
export function pruneToolImages(messages, { keep = TOOL_IMAGE_VIEW.keep, step = TOOL_IMAGE_VIEW.step } = {}) {
  const holders = [];
  messages.forEach((message, index) => {
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) return;
    message.content.forEach((block, position) => { if (block?.type === "image") holders.push([index, position]); });
  });
  let drop = Math.max(0, holders.length - keep);
  drop -= drop % Math.max(1, step);
  if (!drop) return messages;
  const dropped = new Map();
  for (const [index, position] of holders.slice(0, drop)) dropped.set(index, [...(dropped.get(index) || []), position]);
  return messages.map((message, index) => {
    const positions = dropped.get(index);
    if (!positions) return message;
    const stub = { type: "text", text: imageStub(message) };
    return { ...message, content: message.content.map((block, position) => positions.includes(position) ? stub : block) };
  });
}

function imageStub(message) {
  const at = Number.isFinite(Number(message.timestamp)) && Number(message.timestamp) > 0
    ? ` taken at ${new Date(Number(message.timestamp)).toISOString()}` : "";
  return `[Image omitted from this view: an earlier ${message.toolName || "tool"} picture${at}. Only the most recent pictures are kept; take a new screenshot if you need to see the screen now.]`;
}
