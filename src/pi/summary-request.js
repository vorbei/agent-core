// A compaction summary asked of the turn's own model through its Pi stream function (an attempt's
// `summarizeContext`): Pi's native compaction decides when and where history is cut and keeps the
// summary in the journal. The request is abandoned when the attempt's signal fires (the attempt then
// keeps the full history and asks no more in this turn). The prose is the product's. From pi-do
// src/worker/compaction.ts.
import { serializeContextForSummary } from "../memory/index.js";

/**
 * @param {{ model: any, streamFn: (model: any, context: any, options: any) => any, systemPrompt: string,
 *   request(previousSummary: string | null, history: string): string, onCost?(usd: number | undefined): void, now?(): number }} options
 * @returns {(input: { previousSummary?: string, messages: any[], signal: AbortSignal }) => Promise<string>}
 */
export function streamedSummary({ model, streamFn, systemPrompt, request, onCost = () => {}, now = Date.now }) {
  return async ({ previousSummary, messages, signal }) => {
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error(`summary abandoned: ${String(signal.reason?.message ?? signal.reason ?? "aborted")}`),
        { name: signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError" }));
      if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => {}); // settles after the request won the race
    const ask = async () => {
      const stream = await streamFn(model, { systemPrompt, messages: [{ role: "user", timestamp: now(),
        content: request(previousSummary ?? null, serializeContextForSummary(messages)) }], tools: [] }, { signal });
      return stream.result();
    };
    const result = await Promise.race([ask(), aborted]);
    onCost(result.usage?.cost?.total);
    const summary = result.stopReason === "error" ? "" : result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").trim();
    if (!summary) throw Object.assign(new Error(result.errorMessage || "empty summary"), { code: "CONTEXT_COMPACTION_EMPTY" });
    return summary;
  };
}
