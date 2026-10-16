// The attempt's compaction extension. Pi decides when and where history is cut; this supplies the
// host's summary under the durable turn budget (blocking, or started in the background and applied
// at the next cut), defers compaction for the task after a failure, and carries the evidence the
// host retains past the cut as a typed custom message, never inside the generated summary.
// From X Gardener src/pi/extensions/compaction.js.
import { estimateContextTokens } from "../memory/index.js";
import { getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import { JOURNAL_ENTRY_TYPES } from "./entry-types.js";

const COMPACTED_EVIDENCE_TYPE = JOURNAL_ENTRY_TYPES.compactedEvidence;

/**
 * The evidence a message carries past a compaction, or null. Compatibility branch: `contextSummary`
 * is the shape stored before Pi-native compaction. Removal condition: no stored thread carries a
 * `contextSummary` message; test Gardener tests/context-compaction.test.js.
 */
export function compactedEvidence(message) {
  if (message?.contextSummary) return message.contextSummary;
  return message?.role === "custom" && message.customType === COMPACTED_EVIDENCE_TYPE ? message.details || null : null;
}

export function attemptCompaction(owner, { summarize, settings, onCompact }) {
  return pi => {
    let evidence = null;
    // Every exit returns a compaction or a cancel, so Pi never tries its default summary;
    // a storage or lease error keeps its own cause and surfaces at the next checkpoint.
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const branch = ctx.sessionManager.getBranch();
        const baseId = getLatestCompactionEntry(branch)?.id ?? null;
        let pending = owner.backgroundCompaction;
        if (pending && (pending.baseId !== baseId || !branch.some(entry => entry.id === pending.leafId))) {
          owner.backgroundCompaction = null;
          return { cancel: true };
        }
        if (pending) {
          if (owner.compactionInBackground && !pending.settled) return { cancel: true };
          const result = await pending.promise;
          const current = ctx.sessionManager.getBranch();
          if ((getLatestCompactionEntry(current)?.id ?? null) !== pending.baseId || !current.some(entry => entry.id === pending.leafId)) {
            owner.backgroundCompaction = null;
            return { cancel: true };
          }
          owner.backgroundCompaction = null;
          return await resultForPi(result, event);
        }
        if (owner.compactionInBackground) {
          // Only the allowance is durable. The preparation, promise and result die
          // with the attempt; appending new messages does not move this cut.
          pending = { baseId, leafId: branch.at(-1).id, settled: false };
          owner.backgroundCompaction = pending;
          pending.promise = summarizeForPi(event).catch(error => {
            if (!owner.contextAbort.signal.aborted) owner.contextError = error;
            return { cancel: true };
          }).then(result => { pending.settled = true; return result; });
          return { cancel: true };
        }
        return await resultForPi(await summarizeForPi(event), event);
      }
      catch (error) {
        if (!owner.contextAbort.signal.aborted) owner.contextError = error;
        return { cancel: true };
      }
    });
    async function resultForPi(result, event) {
      if (owner.contextAbort.signal.aborted) return { cancel: true };
      if (result.errorCode) return defer(result.errorCode, event.reason, event.preparation.tokensBefore);
      evidence = result.evidence || null;
      return result.compaction ? { compaction: result.compaction } : { cancel: true };
    }
    async function summarizeForPi(event) {
      const { preparation, signal } = event;
      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      const tokensBefore = preparation.tokensBefore;
      // After a deferral the original history simply stays; Pi re-checks every turn.
      if (owner.contextAbort.signal.aborted || owner.budget.compactionDeferred) return { cancel: true };
      if (!owner.reserve("compaction").ok) return { cancel: true, errorCode: "CONTEXT_COMPACTION_BUDGET" };
      await owner.persist({ role: "compaction_budget" });
      let summary;
      try {
        if (typeof summarize !== "function") throw Object.assign(new Error("Context summarizer unavailable"), { code: "CONTEXT_COMPACTION_UNAVAILABLE" });
        const deadline = AbortSignal.timeout(settings.summaryTimeoutMs);
        summary = await summarize({ previousSummary: preparation.previousSummary, messages: owner.compactionView(messages),
          signal: AbortSignal.any([signal, deadline, owner.contextAbort.signal].filter(Boolean)) });
        if (typeof summary !== "string" || !summary.trim()) throw Object.assign(new Error("Context summary was empty"), { code: "CONTEXT_COMPACTION_EMPTY" });
      } catch (error) {
        owner.contextAbort.signal.throwIfAborted();
        return { cancel: true, errorCode: error?.name === "TimeoutError" ? "CONTEXT_COMPACTION_TIMEOUT" : error?.code || "CONTEXT_COMPACTION_FAILED" };
      }
      const retained = owner.retainEvidence ? owner.retainEvidence(messages) : null;
      return { compaction: { summary: summary.trim(), firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore }, evidence: retained };
    }
    // A failure or a spent budget ends compaction for this task: the original history stays,
    // and the harness fails a view past the input limit with this cause instead of sending it.
    async function defer(errorCode, reason, tokensBefore) {
      owner.budget.compactionDeferred = true;
      owner.budget.compactionErrorCode = errorCode;
      await owner.persist({ role: "compaction_deferred" });
      await onCompact?.({ outcome: "deferred", errorCode, reason, tokensBefore });
      return { cancel: true };
    }
    pi.on("session_compact", async (event, ctx) => {
      const retained = evidence;
      evidence = null;
      if (retained && Object.values(retained).some(value => Array.isArray(value) ? value.length : Object.keys(value).length)) {
        ctx.sessionManager.appendCustomMessageEntry(COMPACTED_EVIDENCE_TYPE,
          "Exact receipts and sources from the compacted history are retained by the host.", false, retained);
      }
      let messages = ctx.sessionManager.buildSessionContext().messages;
      // Pi drops the failed response before an overflow retry only when it is last; the
      // evidence message now follows it, so drop it here.
      const failed = messages.findLastIndex(message => message.customType !== COMPACTED_EVIDENCE_TYPE);
      if (event.willRetry && ["error", "length"].includes(messages[failed]?.stopReason)) messages = messages.filter((_, index) => index !== failed);
      owner.agent.state.messages = messages;
      await owner.persist({ role: "compaction_completed" });
      await onCompact?.({ outcome: "completed", reason: event.reason, tokensBefore: event.compactionEntry.tokensBefore,
        tokensAfter: estimateContextTokens(messages), messagesAfter: messages.length });
    });
    pi.on("session_compact_failed", async event => {
      if (event.aborted) return;
      await onCompact?.({ outcome: "failed", reason: event.reason, errorCode: "CONTEXT_COMPACTION_FAILED", errorMessage: event.errorMessage });
    });
  };
}
