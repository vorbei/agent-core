// The attempt's native Pi lifecycle hooks: a model step is reserved (and persisted) before each
// request, the model view is projected and given its dynamic tail, a tool call is gated by the
// tool budget and a handoff, a tool result reaches the task progress, and a finished response gets
// the progress reminder or the last-step notice. Product policy arrives through the attempt's
// options (contextView, contextTail, progress). Originally from X Gardener.
import { estimateContextTokens } from '../memory/index.js';
import { spendLimitError } from '../runtime/index.js';
import { withoutEarlierReasoning } from './reasoning-view.js';

const HANDOFF_TOOL = "handoff_to_user";

export function attemptHarness(owner, { taskTool, maxSteps, onEvent }) {
  return pi => {
    if (taskTool) pi.registerTool({ ...taskTool, executionMode: "sequential" });
    pi.on("session_start", (_event, ctx) => onEvent?.({ type: "session_start",
      sessionId: ctx.sessionManager.getSessionId(), toolCount: pi.getActiveTools().length }));
    pi.on("context", async (event, ctx) => {
      // Host cancellation stops before inference, including one raised during compaction.
      if (owner.contextAbort.signal.aborted) { owner.contextError = owner.contextAbort.signal.reason; throw owner.contextError; }
      const reservation = owner.reserve("model");
      if (reservation.spendLimit) { owner.contextError = spendLimitError(owner.spendLimitCode()); throw owner.contextError; }
      owner.stepsRemaining = reservation.remaining;
      await owner.persist({ role: "model_budget" });
      if (owner.repairMessages) return { messages: owner.repairMessages };
      const messages = owner.contextView(withoutEarlierReasoning(event.messages));
      // With compaction deferred, a view past the hard input limit fails with its original
      // cause instead of sending a request the provider must reject.
      if (owner.budget.compactionDeferred) {
        const activeTools = new Set(pi.getActiveTools());
        const tokens = estimateContextTokens([...messages, { role: 'user', content: ctx.getSystemPrompt() },
          { role: 'user', content: JSON.stringify(pi.getAllTools().filter(tool => activeTools.has(tool.name))) }]);
        if (tokens >= owner.inputLimitTokens) {
          owner.contextError = Object.assign(new Error('Context exceeds the model input limit and compaction is deferred for this task'),
            { code: owner.budget.compactionErrorCode || 'CONTEXT_COMPACTION_BUDGET' });
          throw owner.contextError;
        }
      }
      // Dynamic tail after the history (the budget line, and whatever the product adds around it).
      // History stays a stable prefix; the tail is re-billed uncached on every request.
      const budgetLine = { role: "user", timestamp: Date.now(), content: [{ type: "text", text:
        `Runtime budget: ${owner.stepsRemaining} model calls after this response; ${Math.max(0, owner.budget.maxToolCalls - owner.budget.toolCallIds.length)} tool dispatches remain. These are ceilings, not targets. Chrome suspension does not reset them. Reserve capacity for delivery; retain settled results and do not replay uncertain writes.` }] };
      return { messages: [...messages, ...(owner.contextTail ? await owner.contextTail(messages, budgetLine) : [budgetLine])] };
    });
    pi.on("tool_call", async event => {
      if (owner.handoff) return { block: true, reason: "Control was handed to the user. No further operation dispatched this round." };
      if (owner.stepsRemaining <= 0) return { block: true,
        reason: "FINAL_RESPONSE_REQUIRED: last model call is reserved for delivery. No operation dispatched." };
      const reservation = owner.reserve("tool", event.toolCallId);
      if (reservation.duplicate) return; // Existing durable receipt owns replay/reconciliation.
      if (!reservation.ok) {
        return { block: true, reason: "TOOL_BUDGET_EXHAUSTED: no operation dispatched. Answer from recorded results and disclose unfinished work." };
      }
      await owner.persist({ role: "tool_budget", toolCallId: event.toolCallId });
    });
    pi.on("tool_result", event => {
      if (event.toolName === HANDOFF_TOOL && event.details?.exitCode === 0 && event.details.stdout?.handoff) {
        owner.handoff = event.details.stdout.handoff;
      }
      // Progress records the receipt and may return a projected result; the stored result is
      // never mutated in place.
      return owner.progress?.toolResult(event);
    });
    pi.on("turn_end", event => {
      if (owner.handoff) return;
      if (event.message?.stopReason === "error" && event.message.providerErrorCategory === "context_limit") return;
      const continuing = (event.message?.content || []).some(block => block.type === "toolCall");
      if (owner.isOutputRepairing()) return;
      if (owner.stepsRemaining <= 0) { owner.stepLimitReached = continuing; return; }
      if (!continuing) {
        // A typed host message, not user text: the model reads it as a user-role steer, but it is
        // no turn boundary for observation stubs, so the next request extends the cached prefix.
        const notice = owner.progress?.beforeFinish();
        if (notice) pi.sendMessage({ customType: owner.progress.noticeType, display: false, content: notice }, { deliverAs: "steer" });
      }
      // Not after a batch that waits for its executor: the run ends there (see PiAttempt).
      if (continuing && owner.stepsRemaining === 1 && maxSteps > 1 && !owner.awaitingExecutor) {
        pi.sendUserMessage("Tool budget notice: this is your last step for tools in this turn. Do not call another tool. Answer now from the recorded results, state exactly what remains undone, and do not claim anything a tool result does not show.", { deliverAs: "steer" });
      }
    });
  };
}
