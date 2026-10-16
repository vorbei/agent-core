// An output policy (PiAttemptOptions.outputPolicy) that repairs a final answer by asking the model
// again, each kind at most once per turn and only while the turn has a model request left: an
// answer that was only tool-call markup printed as text gets one tools-off request for prose
// (`plain`), and an answer over the user's explicit length limit one tools-off rewrite request
// (`length`). A rewrite that comes back empty keeps the answer it was asked to rewrite. The
// requests' wording is the product's; each starts with `wording.prefix`, so an attempt that resumes
// after one was sent knows a reply is owed (`answering`: the product sends it without tools). The
// kinds already asked persist in the budget state (`repairs`). From pi-do src/worker/turns.ts.
import { answerLength, lengthLimit, stripToolMarkup } from "../runtime/index.js";

const textOf = message => typeof message?.content === "string" ? message.content
  : (message?.content || []).flatMap(block => block.type === "text" ? [block.text ?? ""] : []).join("");

/**
 * @param {{ userText: string, messages: any[], wording: { prefix: string, plain: string, length(length: number, max: number, unit: "words" | "characters"): string },
 *   onRepair?(kind: "plain" | "length"): void }} options `messages` are the attempt's restored journal.
 */
export function answerRepairPolicy({ userText, messages, wording, onRepair = () => {} }) {
  const limit = lengthLimit(userText);
  let answering = textOf(messages.findLast(message => message.role === "user")).startsWith(wording.prefix);
  let fallback = "";
  return {
    /** Whether the next model request answers a repair request (it goes without tools). */
    get answering() { return answering; },
    repairing: () => false,
    extension: () => () => {},
    error: () => null,
    async review(attempt) {
      for (;;) {
        const latest = attempt.agent.state.messages.at(-1);
        if (attempt.agent.state.errorMessage || latest?.role !== "assistant" || latest.content?.some(block => block.type === "toolCall")) return;
        const { text, stripped } = stripToolMarkup(textOf(latest).trim());
        if (!text && fallback) {
          attempt.agent.state.messages = [...attempt.agent.state.messages.slice(0, -1), { ...latest, content: [{ type: "text", text: fallback }] }];
          return;
        }
        const length = text && limit ? answerLength(text, limit.unit) : 0;
        const repair = stripped && !text ? { kind: "plain", request: wording.plain }
          : limit && length > limit.max ? { kind: "length", request: wording.length(length, limit.max, limit.unit) } : null;
        // `repairs` enters the saved budget only with the first repair, so a turn that needs none
        // stores the budget exactly as before (X Gardener's checkpoint bytes).
        const repairs = Array.isArray(attempt.budget.repairs) ? attempt.budget.repairs : [];
        if (!repair || repairs.includes(repair.kind) || attempt.remaining("model") <= 0 || !attempt.spendAvailable()) return;
        fallback ||= text;
        attempt.budget.repairs = [...repairs, repair.kind];
        onRepair(/** @type {"plain" | "length"} */ (repair.kind));
        answering = true;
        attempt.session.setActiveToolsByName([]);
        await attempt.session.prompt(repair.request, { expandPromptTemplates: false });
      }
    },
  };
}
