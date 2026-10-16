// One durable attempt of a turn on a pi-coding-agent session: the turn budget reserved at Pi's
// boundaries, journal checkpoints at message ends, queued steers placed at Pi's public hooks,
// threshold and background compaction, answer hygiene before delivery, and the checkpoint the host
// stores. What the model sees beyond the journal, and any product policy, comes in through the
// options (PiAttemptOptions in index.d.ts). From X Gardener src/pi/adapter.js (GardenerPiAdapter).
import { openPiSession } from "./session.js";
import { attemptHarness } from "./harness.js";
import { pendingActionSteer } from "./pending-action.js";
import { getLatestCompactionEntry, shouldCompact } from "@earendil-works/pi-coding-agent";
import { prepareNextTurnFromState, runThresholdCompaction } from "./pi-private.js";
import { contextCompactionSettings, estimateContextTokens, piCompactionSettings } from "../memory/index.js";
import { attemptCompaction } from "./compaction.js";
import { JOURNAL_ENTRY_TYPES } from "./entry-types.js";
import { awaitsExecutor } from "./executor-result.js";
import { createTurnBudget, modelFailureCode, spendLimitError, stripToolMarkup } from "../runtime/index.js";

export const STEP_LIMIT_ERROR = "MODEL_STEP_LIMIT";
/** The tool whose successful result hands control to the user (`details.stdout.handoff`). */
export const HANDOFF_TOOL = "handoff_to_user";

// Persistence boundaries. `journal` boundaries write the journal increment and checkpoint header;
// `budget` boundaries persist only the reservation and renew the lease without serializing history.
const BUDGET_BOUNDARIES = Object.freeze(["model_budget", "tool_budget", "compaction_budget", "notes_budget"]);
const RESUME_TEXT = "Resume the existing task from its recorded tool results. No new authorization.";
const identity = value => value;

export class PiAttempt {
  constructor({ model, streamFn, systemPrompt, tools = [], messages, maxSteps, maxToolCalls, summarizeContext, contextSettings, onCompact, onEvent,
    taskInput = "", taskStartedAt, task = {}, citationRepairs = 0, outputReview = {}, outputPolicy, budget, piSession, sessionId,
    extensions = [], plugins = [], onCheckpoint, onBudget, handoff, incrementalJournal = false, nextSteer = null,
    contextView = identity, contextTail = null, compactionView = identity, pendingActionWording = null,
    outputRecovery = false, outputLimitWording = null }) {
    const { progress = null, retainEvidence = null, finalizeAnswer = null } = task || {};
    this.handoff = handoff;
    this.outputPolicy = outputPolicy;
    // Host-owned steer queue: returns the next durable steer `{ id, text }` (marked placing) or null.
    this.nextSteer = onCheckpoint ? nextSteer : null;
    this.placing = null;
    this.takingSteer = false;
    // Model view hooks: a stable-prefix projection of the history, the dynamic tail after it,
    // the view compaction estimates and summarizes, and what survives a compaction exactly.
    this.contextView = contextView;
    this.contextTail = contextTail;
    this.compactionView = compactionView;
    this.retainEvidence = retainEvidence;
    this.finalizeAnswer = finalizeAnswer;
    // Retain the existing checkpoint shape across upgrades. Only an installed
    // output policy interprets this state; the generic runtime carries it.
    this.outputReview = { quantityRepairs: 0, fallback: false, ...outputReview };
    this.stepLimitReached = false;
    // Legacy checkpoints carried citation repairs beside the budget; the budget owns them now.
    const ledger = budget?.state ? budget : createTurnBudget({ citationRepairs, ...budget }, { maxModelCalls: maxSteps, maxToolCalls });
    this.budget = ledger.state;
    this.reserve = ledger.reserve;
    this.remaining = ledger.remaining;
    this.spendAvailable = ledger.spendAvailable;
    this.addCost = ledger.addCost || (() => {});
    this.spendLimitCode = ledger.spendLimitCode || (() => "MODEL_SPEND_LIMIT");
    this.incrementalJournal = incrementalJournal;
    this.stepsRemaining = this.remaining("model");
    this.taskInput = taskInput;
    this.taskStartedAt = taskStartedAt;
    this.contextAbort = new AbortController();
    this.progress = progress;
    const taskTool = this.progress?.tool && !this.isOutputRepairing() ? this.progress.tool : null;
    // Explicit host tools are registered as one extension; products may also bring native extensions.
    if (tools.length) extensions = [pi => {
      for (const tool of tools) pi.registerTool({ ...tool, executionMode: "sequential" });
    }, ...extensions];
    if (this.isOutputRepairing()) extensions = [];
    const contextConfig = contextCompactionSettings(model, contextSettings);
    this.contextConfig = contextConfig;
    this.backgroundCompactAtTokens = contextConfig.backgroundCompactAtTokens;
    this.inputLimitTokens = contextConfig.contextWindow - contextConfig.reserveTokens;
    // The output recovery (the retry after MODEL_OUTPUT_LIMIT): every request of this attempt goes
    // without tools, with twice the model's output budget, low reasoning effort (Pi's `reasoning`
    // option; a transport applies what its provider supports) and the product's notice.
    const recover = outputRecovery
      ? (model, context, options) => [{ ...context, tools: [],
        systemPrompt: outputLimitWording ? `${context.systemPrompt}\n\n${outputLimitWording}` : context.systemPrompt },
      { ...options, reasoning: "low", ...(model.maxTokens > 0 ? { maxTokens: model.maxTokens * 2 } : {}) }]
      : (model, context, options) => [context, options];
    this.options = { model, streamFn: (model, context, options) => streamFn(model,
      ...recover(model, this.stepsRemaining <= 0 ? { ...context, tools: [] } : context, options)), systemPrompt, messages, piSession, sessionId,
      compaction: piCompactionSettings(contextConfig),
      // First turn_end hook. A tool batch that left a call waiting for its executor ends the run
      // there: no steer or reminder may make Pi send another request before the executor's result
      // (its answer could only be cut as premature, at the cost of a model request). An answer that
      // reached the spend cap is delivered and reviewed with no model step left, so no host steer,
      // repair or review may buy another request for it. A response's estimated cost counts toward
      // a turn's own spend ceiling (a budget with `maxCostUsd`) first.
      extensions: [pi => pi.on("turn_end", event => {
        if (!["error", "aborted"].includes(event.message?.stopReason)) this.addCost(event.message?.usage?.cost?.total);
        this.awaitingExecutor = (event.toolResults || []).some(awaitsExecutor);
        if (event.message?.content?.some(block => block.type === "toolCall") || this.spendAvailable()) return;
        this.spendStopped = true;
        this.stepsRemaining = 0;
      }), pi => {
        // Host steers are pulled at Pi's public boundaries, each followed by Pi's steering poll:
        // agent_start (a resumed or continued run) and turn_end (registered before the harness's
        // own reminders, so a user steer keeps its place ahead of them).
        pi.on("agent_start", () => this.placeSteer());
        pi.on("turn_end", event => ["error", "aborted"].includes(event.message?.stopReason) ? undefined : this.placeSteer());
      }, ...(outputPolicy ? [outputPolicy.extension(this)] : []), attemptHarness(this, { taskTool, maxSteps, onEvent }),
        ...(pendingActionWording ? [pendingActionSteer(this, { onEvent, wording: pendingActionWording })] : []),
        attemptCompaction(this, { summarize: summarizeContext, settings: contextConfig, onCompact: async detail => {
          if (detail.reason === "overflow" && ["failed", "deferred"].includes(detail.outcome)) {
            this.contextError = Object.assign(new Error(detail.errorMessage || detail.errorCode), {
              code: detail.outcome === "deferred" ? detail.errorCode : modelFailureCode(detail.errorMessage)
            });
          }
          await onCompact?.(detail);
        } }),
        ...plugins.map(plugin => plugin(this)).filter(Boolean), ...extensions] };
    this.onEvent = onEvent;
    this.onCheckpoint = onCheckpoint;
    this.onBudget = onBudget;
  }

  get citationRepairs() { return Number(this.budget.citationRepairs || 0); }

  // Single persistence entry for every hook. Budget boundaries never serialize
  // history; journal boundaries commit the incremental journal after the host
  // acknowledges the write, so a failed persist re-sends the same entries.
  async persist(boundary) {
    if (BUDGET_BOUNDARIES.includes(boundary.role)) {
      if (this.onBudget) return this.onBudget(this.budget, boundary);
      if (!this.onCheckpoint) return undefined;
    }
    if (!this.onCheckpoint) return undefined;
    const checkpoint = this.checkpoint();
    try { await this.onCheckpoint(checkpoint, boundary); }
    catch (error) { this.contextError = error; throw error; }
    this.runtime.commit(checkpoint.piSession);
    return checkpoint;
  }

  async initialize() {
    if (this.runtime) return;
    this.runtime = await openPiSession(this.options);
    this.session = this.runtime.session;
    this.agent = this.session.agent;
    // Recover a settled handoff if interruption happened before its checkpoint.
    // Current-turn call IDs exclude handoffs in prior continuous history.
    const handoffResult = this.agent.state.messages.findLast(message => message.role === 'toolResult'
      && message.toolName === HANDOFF_TOOL && this.budget.toolCallIds.includes(message.toolCallId)
      && message.details?.exitCode === 0 && message.details?.stdout?.handoff);
    this.handoff ||= handoffResult?.details.stdout.handoff;
    this.progress?.importHistory(this.agent.state.messages, this.taskStartedAt);
    // Pi has no extension stop-budget hook; use its public host guard. All
    // business steering and evidence policy run through the extensions above.
    this.agent.shouldStopAfterTurn = async turn => {
      // Pi invokes this after the whole response's tool batch has settled.
      // Error/length recovery stays with Pi's native overflow path and retry fence.
      if (this.backgroundCompactAtTokens > 0 && !["error", "length", "aborted"].includes(turn.message.stopReason)) await this.compactIfDue();
      this.stepsRemaining = this.spendStopped ? 0 : this.remaining("model");
      return Boolean(this.handoff) || this.awaitingExecutor || this.stepsRemaining <= 0 || this.isOutputRepairing();
    };
    // Pi's loop keeps its own context snapshot. Refresh it after a landed
    // background cut before Pi prepares the next request and drains steering.
    if (this.backgroundCompactAtTokens > 0) prepareNextTurnFromState(this.agent);
    if (this.onEvent) this.session.subscribe(this.onEvent);
    // Agent listeners are awaited. Subscribe after the original Session listener:
    // its native journal already contains this message when we snapshot it.
    // Session.subscribe is a notification-only API and cannot provide this fence.
    if (this.onCheckpoint) this.unsubscribeCheckpoint = this.agent.subscribe(async event => {
      if (event.type !== "message_end" || this.isOutputRepairing()) return;
      const message = event.message;
      if (message.role !== "user" && message.role !== "toolResult" && !(message.role === "assistant"
        && message.stopReason === "toolUse" && message.content?.some(block => block.type === "toolCall"))) return;
      // The placed steer is the next user message Pi delivers (placement waits for an empty Pi queue);
      // its row is marked placed in the same commit as the journal entry that carries it.
      const prompted = message.role === "user" && this.awaitingPrompt;
      const steer = message.role === "user" && !prompted && this.placing?.text === userText(message) ? this.placing : null;
      await this.persist({ role: message.role, toolCallId: message.toolCallId, ...(steer ? { steerId: steer.id } : {}) });
      if (steer) this.placing = null;
      if (prompted) { this.awaitingPrompt = false; await this.placeSteer(); }
    });
    if (this.aborted) this.agent.abort();
  }

  // `preface` is host runtime state (for example the turn's Write authorization).
  // It is persisted as a typed custom entry so the user's text stays verbatim.
  // `images` (Pi ImageContent) are the user's attachments, sent in the same user message as the text.
  prompt(input, { preface = null, images = [] } = {}) {
    return this.run(async () => {
      this.taskInput = typeof input === "string" ? input : this.taskInput;
      this.awaitingPrompt = true;
      if (preface) await this.session.sendCustomMessage({ customType: JOURNAL_ENTRY_TYPES.turnAuthorization, display: false, content: preface }, { triggerTurn: false });
      await this.compactIfDue();
      await this.session.prompt(input, { expandPromptTemplates: false, ...(images.length ? { images } : {}) });
    });
  }

  // Resume through the public Session API so its streaming/steering lifecycle
  // owns the run. Calling agent.continue() directly leaves Session idle while
  // the Agent is busy. Keep this host event hidden, not a fabricated user turn.
  continue() {
    return this.run(async () => {
      await this.compactIfDue();
      await this.session.sendCustomMessage({
        customType: JOURNAL_ENTRY_TYPES.resume, display: false,
        content: RESUME_TEXT
      }, { triggerTurn: true });
    });
  }

  // A run that may not start ends before it writes to the journal: an abort or the spend cap
  // throws, a handoff or a spent step budget returns the checkpoint as it is.
  async run(start) {
    await this.initialize();
    try {
      if (this.aborted) throw new Error("MODEL_ABORTED");
      if (this.handoff) return this.checkpoint({ full: true });
      if (!this.spendAvailable()) throw spendLimitError(this.spendLimitCode());
      if (this.stepsRemaining <= 0) { this.stepLimitReached = true; return this.checkpoint({ full: true }); }
      this.awaitingExecutor = false;
      await start();
      // An answer committed over the spend cap is still reviewed: with no model steps left
      // (shouldStopAfterTurn) the policy takes its deterministic path and makes no model call.
      // Output checks see the text that will be delivered; a repair answer is stripped again.
      this.stripPrintedToolMarkup();
      if (!this.handoff) await this.outputPolicy?.review(this);
      this.stripPrintedToolMarkup();
      this.finalizeDelivery();
      return this.checkpoint({ full: true });
    } finally { this.dispose(); }
  }

  // Pi checks its threshold between turns of a run, but a resumed run's first
  // inference would go out unchecked. Use the same threshold, cut and hooks.
  async compactIfDue() {
    const settings = this.options.compaction;
    if (!settings?.enabled || this.contextAbort.signal.aborted || this.budget.compactionDeferred) return;
    // Provider usage reflects the projected view; without it, estimate the compaction view.
    const tokens = this.session.getContextUsage()?.tokens ?? estimateContextTokens(this.compactionView(this.agent.state.messages));
    const blocking = shouldCompact(tokens, this.options.model.contextWindow, settings);
    const pending = this.backgroundCompaction;
    if (pending) {
      const branch = this.session.sessionManager.getBranch();
      if ((getLatestCompactionEntry(branch)?.id ?? null) !== pending.baseId || !branch.some(entry => entry.id === pending.leafId)) {
        this.backgroundCompaction = null;
        return;
      }
    }
    if (!blocking && pending && !pending.settled) return;
    if (!blocking && !pending?.settled && !(this.backgroundCompactAtTokens > 0 && tokens > this.backgroundCompactAtTokens)) return;
    // A cancelled or impossible compaction leaves history as it is; a host error surfaces at checkpoint.
    // Pi's automatic entry prepares the same cut and emits the same hooks without
    // aborting the active run, unlike manual compact(). Pi is pinned (pi-private.js).
    this.compactionInBackground = !blocking;
    try { await runThresholdCompaction(this.session); }
    finally { this.compactionInBackground = false; }
  }

  // Hand the host's next steer to Pi through its public API, one at a time and only into an empty
  // Pi queue, at a point Pi polls its steering queue next. A run that is about to stop takes none:
  // the row stays queued and is answered as its own turn.
  async placeSteer() {
    if (!this.nextSteer || this.placing || this.takingSteer || this.awaitingPrompt || this.aborted || this.handoff || this.spendStopped || this.awaitingExecutor
      || this.remaining("model") <= 0 || this.isOutputRepairing() || this.agent.hasQueuedMessages()) return;
    // The host may load the steer's images first: no second steer is taken meanwhile.
    this.takingSteer = true;
    let steer;
    try { steer = await this.nextSteer(); } finally { this.takingSteer = false; }
    if (!steer) return;
    this.placing = steer;
    // A refused message stays marked until the attempt ends; the host then releases it.
    try { await this.session.sendUserMessage(steer.images?.length ? [{ type: "text", text: steer.text }, ...steer.images] : steer.text, { deliverAs: "steer" }); }
    catch { this.placing = null; }
  }

  abort() {
    this.aborted = true;
    this.contextAbort.abort();
    this.agent?.abort();
  }

  dispose() { this.unsubscribeCheckpoint?.(); this.contextAbort.abort(); this.runtime?.dispose(); }

  isOutputRepairing() { return Boolean(this.outputPolicy?.repairing(this.outputReview)); }

  // Tool-call markup a model printed as text at the end of its answer is not part of the answer
  // (runtime/answer-checks.js decides what counts). When removing it would leave no text, the original
  // is delivered: an answer that is only markup is still the model's answer, not an empty one.
  stripPrintedToolMarkup() {
    const latest = this.agent.state.messages.at(-1);
    if (latest?.role !== "assistant" || latest === this.markupKeptOriginal || latest.content?.some(block => block.type === "toolCall")) return;
    const results = latest.content.map(block => block.type === "text" ? stripToolMarkup(block.text) : null);
    if (!results.some(result => result?.stripped)) return;
    const keptOriginal = !results.some(result => result?.text.trim());
    this.onEvent?.({ type: "tool_markup_stripped", keptOriginal });
    if (keptOriginal) { this.markupKeptOriginal = latest; return; }
    this.agent.state.messages = [...this.agent.state.messages.slice(0, -1), { ...latest,
      content: latest.content.map((block, index) => results[index] ? { ...block, text: results[index].text } : block) }];
  }

  finalizeDelivery() {
    let latest = this.agent.state.messages.at(-1);
    if (this.finalizeAnswer && latest?.role === "assistant" && !latest.content?.some(block => block.type === "toolCall")) {
      latest = this.finalizeAnswer(latest, this);
      this.agent.state.messages = [...this.agent.state.messages.slice(0, -1), latest];
    }
    const delivery = this.progress?.summary();
    if (delivery?.status !== "partial" || this.agent.state.errorMessage || latest?.role !== "assistant"
      || latest.content?.some(block => block.type === "toolCall")) return;
    // Bookkeeping can lag real effects. Qualify the draft, never replace its links,
    // findings or errors with a second synthetic report built from stale task labels.
    const chinese = /[㐀-鿿]/.test(this.taskInput || latestAssistantText(this.agent.state.messages));
    const notice = chinese ? "交付记录尚未核实完整。以下为模型报告，其中的完成声明不能视为已全部验证："
      : "Delivery is not fully verified. The model report below may contain unverified completion claims:";
    this.agent.state.messages = [...this.agent.state.messages.slice(0, -1), { ...latest,
      content: [{ type: "text", text: notice + "\n" }, ...latest.content] }];
    this.onEvent?.({ type: "output_delivery_incomplete", pending: delivery.pending.length, reading: delivery.reading });
  }

  // `full` returns every journal entry (terminal checkpoints, legacy inline
  // format); hook boundaries send only entries appended since the last commit.
  checkpoint({ full = false } = {}) {
    const messages = this.agent.state.messages;
    const latest = messages.at(-1);
    if (this.contextError) throw this.contextError;
    const extensionError = this.runtime.getExtensionError();
    if (extensionError) throw new Error(`PI_EXTENSION_FAILED: ${extensionError.error}`);
    // Pi has settled its native recovery; an unrecovered provider overflow is
    // terminal even when Pi emits no separate compaction-failed notification.
    if (full && latest?.role === "assistant" && latest.stopReason === "error"
      && latest.providerErrorCategory === "context_limit") {
      throw Object.assign(new Error(latest.errorMessage), { code: "CONTEXT_OVERFLOW" });
    }
    const stepLimit = this.stepLimitReached && !this.agent.state.errorMessage;
    const outputError = this.outputPolicy?.error(messages);
    const outputFallback = this.outputPolicy && this.outputReview.fallback;
    return {
      messages,
      piSession: this.runtime.snapshot(messages, { incremental: this.incrementalJournal && !full }),
      budget: structuredClone(this.budget),
      retryAfterMs: [...messages].reverse().find(message => message.role === "assistant" && message.errorMessage)?.retryAfterMs ?? null,
      citationRepairs: this.citationRepairs,
      outputReview: { ...this.outputReview },
      ...(this.progress ? { taskProgress: this.progress.snapshot(), delivery: {
        ...this.progress.summary(), ...(outputFallback ? { status: "partial" } : {})
      } } : {}),
      ...(this.handoff ? { handoff: this.handoff, delivery: { ...(this.progress?.summary() || {items:[],pending:[]}), status: 'waiting' } } : {}),
      finalText: this.handoff ? `${this.handoff.reason}\n\n${this.handoff.action}\n\n${this.handoff.remaining}` : latestAssistantText(messages),
      error: (!outputFallback && this.agent.state.errorMessage) || (stepLimit ? "the model step budget for this turn is exhausted" : outputError?.message || null),
      errorCode: (!outputFallback && latestAssistantErrorCode(messages)) || (stepLimit ? STEP_LIMIT_ERROR : outputError?.code || null)
    };
  }
}

function latestAssistantErrorCode(messages) {
  const message = [...messages].reverse().find((item) => item.role === "assistant" && item.errorMessage);
  return message?.errorCode || null;
}

function userText(message) {
  return typeof message.content === "string" ? message.content
    : (message.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");
}

export function latestAssistantText(messages) {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  return (message?.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
