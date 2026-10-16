// A fetch for Pi's openai-completions stream that keeps reasoning the provider signed but did not
// show. Anthropic models on OpenRouter asked for no reasoning effort return their reasoning as
// `reasoning_details` entries of type "reasoning.text" with a signature and no `text` (2026-10-10
// capture, claude-haiku-5.5). Pi's parser accepts a "reasoning.text" entry only with a string
// `text`, so it dropped the entry, kept no thinking block, and the next request of the tool loop
// went without that reasoning. Each such entry gets `text: ""`: Pi then keeps it in a thinking
// block's signature and sends it back as `reasoning_details` on the next request to the same model.

/** @param {typeof fetch} fetchImpl @returns {typeof fetch} */
export function withSignedReasoning(fetchImpl) {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    const lines = text => {
      const all = (pending + text).split("\n");
      pending = all.pop() ?? "";
      return all.map(line => `${signedLine(line)}\n`).join("");
    };
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { const out = lines(decoder.decode(chunk, { stream: true })); if (out) controller.enqueue(encoder.encode(out)); },
      flush(controller) {
        const rest = pending + decoder.decode();
        pending = "";
        if (rest) controller.enqueue(encoder.encode(signedLine(rest)));
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** One SSE line, with a signed reasoning entry that has no text given an empty one. @param {string} line */
function signedLine(line) {
  if (!line.startsWith("data:") || !line.includes('"reasoning_details"') || !line.includes('"signature"')) return line;
  let chunk;
  try { chunk = JSON.parse(line.slice(5)); } catch { return line; }
  let changed = false;
  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    for (const detail of Array.isArray(choice?.delta?.reasoning_details) ? choice.delta.reasoning_details : []) {
      if (detail?.type === "reasoning.text" && detail.text == null && typeof detail.signature === "string" && detail.signature) {
        detail.text = "";
        changed = true;
      }
    }
  }
  return changed ? `data: ${JSON.stringify(chunk)}` : line;
}
