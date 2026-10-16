// The durable turn around one Pi attempt: claim a queued turn, restore its journal (or the thread's
// prior conversation), answer the calls a lost attempt left, run the attempt, then suspend it on
// its executor calls, complete it, or fail or retry it; cancel a turn with the turns it owns; and
// restore a thread's prior messages for its next turn. The product plugs in through its
// TurnDriverHost (`attempt`, `calls`, `checkpointCodec`, `external`; index.d.ts).
// From X Gardener src/cf/account/turns.js and turn-recovery.js.
import * as runtime from "../runtime/index.js";
import { nowIso, nowMs } from "../runtime/stamps.js";
import { PiAttempt, latestAssistantText } from "./attempt.js";
import { PI_JOURNAL_FORMAT, SESSION_CONTEXT_VERSION } from "./entry-types.js";
import { checkpointMessages, checkpointWithMessages, nativeCheckpoint } from "./journal.js";
import { checkpointForStorage, hydrateCheckpoint, serializeCheckpoint } from "./journal-store.js";
import { restoreSessionMessages } from "./session-context.js";

import { WAITING_RESULT_PREFIX, executorWaitingResult } from "./executor-result.js";

/** At most one write of a running turn's answer so far per this many milliseconds of streaming. */
export const PARTIAL_TEXT_INTERVAL_MS = 400;

/** Model failures of one turn: the first is retried (after a backoff), the second fails it. */
export const MAX_MODEL_FAILURES_PER_TURN = 2;

const TERMINAL = "('completed','failed','cancelled')";
// Ephemeral live attempts per storage, for abort only; SQLite status and leases stay authoritative.
const liveAttempts = new WeakMap();

const rows = (host, query, ...bindings) => host.storage.sql.exec(query, ...bindings).toArray();
const one = (host, query, ...bindings) => rows(host, query, ...bindings)[0] || null;

const codec = host => host.checkpointCodec || {};
const storeValue = (host, value, accountId) => (codec(host).store ? codec(host).store(value, { accountId }) : value);
const loadValue = (host, value, accountId) => (codec(host).load ? codec(host).load(value, { accountId }) : value);
const stored = (host, turn, value) => serializeCheckpoint(checkpointForStorage(host.storage, turn, value, { encode: codec(host).encode }),
  { encode: codec(host).encode });
const readOnlyCall = (host, name, input) => (host.calls?.readOnly ? host.calls.readOnly(name, input) : true);

/** A turn's executor calls not yet settled, oldest first. */
export function pendingCalls(host, turnId) {
  return rows(host, "SELECT call_id, tool_call_id, function_name FROM agent_function_calls WHERE turn_id = ? AND status IN ('created', 'claimed') ORDER BY created_at", turnId);
}

/**
 * Runs one attempt of a queued turn (a TurnHost's `startAttempt`). Resolves when the turn waits,
 * completed, was requeued for a retry, or is no longer this attempt's; rejects with the error of a
 * turn that failed for good. `prompt` replaces the turn's own text (tests).
 * @param {import("./index.js").TurnDriverHost} host
 */
export async function runTurnAttempt(host, turnId, { prompt = null } = {}) {
  const claim = runtime.claimTurn(host, turnId);
  if (!claim) return { claimed: false };
  const row = one(host, "SELECT rowid AS storage_rowid, * FROM agent_turns WHERE turn_id = ?", turnId);
  const startedAt = nowMs(host);
  const lifecycle = { accountId: row.account_id, threadId: row.thread_id, turnId, attempt: claim.attempt };
  host.log("agent.turn.claimed", { ...lifecycle, leaseExpiresAt: claim.leaseExpiresAt });
  const hooks = host.attempt;
  const direct = hooks.direct?.(row) || null;
  const hasLease = () => runtime.hasTurnLease(host, turnId, claim.leaseId, claim.attempt);
  const assertLease = () => runtime.assertTurnLease(host, turnId, claim);
  const events = [];
  let attempt;
  // Provider routing for this attempt; a retry skips the provider that failed.
  let routing = {};
  let servedProvider = null, failedProvider = null;
  try {
    // Persist the native wake before any external I/O; recovery needs no heartbeat.
    await host.armWatchdog();
    if (direct) {
      // The host makes the call instead of a model; the caller, not Pi, chooses the next one.
      const checkpoint = await storeValue(host, await direct({ claim, lifecycle }), row.account_id);
      const commands = pendingCalls(host, turnId);
      if (commands.length) waitForExecutor(host, turnId, claim, commands, checkpoint, lifecycle, row);
      else {
        assertLease();
        const now = nowIso(host);
        host.storage.transactionSync(() => host.storage.sql.exec(`UPDATE agent_turns SET status='completed',phase='done',checkpoint_json=?,final_answer='',
          lease_id=NULL,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE turn_id=?`, stored(host, row, checkpoint), now, now, turnId));
        host.log("agent.turn.completed", { ...lifecycle, executionMode: "tool" });
        runtime.scheduleTurns(host);
      }
      return { claimed: true, direct: true };
    }
    runtime.appendTurnStep(host, turnId, claim.attempt, "model", "started");
    // A steer marked placing by an attempt that is gone never reached a journal: it is unplaced again.
    // One turn per thread runs at a time, so every mark in this thread belongs to a lost attempt.
    runtime.releaseSteers(host, { threadId: row.thread_id });
    const saved = hydrateCheckpoint(host.storage, row, row.checkpoint_json ? JSON.parse(row.checkpoint_json) : {});
    routing = saved.modelRouting || {};
    const input = JSON.parse(row.input_json);
    // Restore the same budget and authorization before recovery can replay a read. One durable
    // budget for tools and the Pi runtime; restored counters are never reset by a resume.
    const setup = hooks.prepare({ turn: row, input, saved, claim, lifecycle, assertCurrent: assertLease,
      receipt: (name, execute, readOnly) => (callId, args, ...rest) => runtime.durableToolExecute(host, turnId, claim, { name, execute },
        { readOnly: readOnly ?? readOnlyCall(host, name, args) })(callId, args, ...rest) });
    const savedMessages = checkpointMessages(saved);
    const messages = savedMessages.length ? await recoverToolMessages(host, turnId, savedMessages, { tools: setup.tools }) : restorePriorMessages(host, row);
    if (savedMessages.length && saved.sessionContextVersion !== SESSION_CONTEXT_VERSION && input.contextPolicy === "fresh") {
      // Compatibility (session context v1/v2): an in-flight old fresh turn gets the thread's history once.
      // Removal: pi_journal_inventory shows no sessionContextVersion below 3 (test: Gardener tests/session-context.test.js).
      messages.unshift(...restorePriorMessages(host, row));
    }
    // Steers are durable rows the attempt pulls at Pi's step boundaries: `placing` (queued, marked
    // with this lease) when handed to Pi, `placed` (completed, mergedIntoTurnId) in the commit of the
    // journal entry that carries it. The product's rule says which turns take which steers.
    const text = setup.text || (turnInput => turnInput.text);
    // The images the user attached to a turn input (the product's own field), sent with its text;
    // a product that keeps them outside the row (Gardener: R2) returns a promise.
    const images = async (turnInput, inputTurnId) => (await setup.images?.(turnInput, inputTurnId)) || [];
    const nextSteer = async () => {
      if (!hasLease()) return null;
      const steer = runtime.takeSteer(host, { turn: row, leaseId: claim.leaseId, accepts: setup.acceptsSteer });
      return steer && { id: steer.id, text: text(steer.input), images: await images(steer.input, steer.id) };
    };
    const saveCheckpoint = async (checkpoint, mergedSteerId) => {
      assertLease();
      let json;
      const value = await storeValue(host, nativeCheckpoint({ sessionContextVersion: SESSION_CONTEXT_VERSION,
        piSession: checkpoint.piSession, citationRepairs: checkpoint.citationRepairs, outputReview: checkpoint.outputReview,
        taskProgress: checkpoint.taskProgress, delivery: checkpoint.delivery, handoff: checkpoint.handoff, budget: checkpoint.budget, events: events.slice(-100) }),
      row.account_id);
      assertLease();
      const now = nowIso(host);
      host.storage.transactionSync(() => {
        json = stored(host, row, value);
        host.storage.sql.exec("UPDATE agent_turns SET checkpoint_json = ?, updated_at = ?, lease_expires_at = ? WHERE turn_id = ? AND lease_id = ? AND attempt = ?",
          json, now, new Date(Date.parse(now) + runtime.turnLeaseMs(host, turnId)).toISOString(), turnId, claim.leaseId, claim.attempt);
        if (mergedSteerId) runtime.mergeSteer(host, { turnId, steerId: mergedSteerId, leaseId: claim.leaseId, now });
      });
      return json;
    };
    const pending = pendingCalls(host, turnId);
    if (pending.length && savedMessages.length) {
      const json = await saveCheckpoint(checkpointWithMessages(saved, messages, row.session_id));
      waitForExecutor(host, turnId, claim, pending, json, { ...lifecycle, recovery: "resumed" });
      return { claimed: true };
    }
    // Budget boundaries persist the reservation and renew the lease only; history is not serialized.
    const saveBudget = async (state) => {
      assertLease();
      const now = nowIso(host);
      host.storage.sql.exec(`UPDATE agent_turns SET checkpoint_json = json_set(COALESCE(checkpoint_json, '{}'), '$.budget', json(?)),
        updated_at = ?, lease_expires_at = ? WHERE turn_id = ? AND lease_id = ? AND attempt = ?`,
      JSON.stringify(state), now, new Date(Date.parse(now) + runtime.turnLeaseMs(host, turnId)).toISOString(), turnId, claim.leaseId, claim.attempt);
      await host.storage.sync?.();
      assertLease();
    };
    const prepared = await storeValue(host, {
      messages, piSession: saved.piSession || (messages.length ? priorPiSession(host, row) : undefined)
    }, row.account_id);
    const restored = await loadValue(host, prepared, row.account_id);
    assertLease();
    // The model request's lifecycle: the lease follows the request in flight, and the provider
    // that served or failed it is remembered for a retry.
    const modelEvent = (event, detail) => {
      if (event === "model.completed") servedProvider = detail.provider || servedProvider;
      // A timed-out request has no response; the provider serving this attempt is the suspect.
      if (event === "model.failed") failedProvider = detail.provider || (detail.errorCode === "MODEL_TIMEOUT" ? servedProvider : null);
      if (event === "model.started") runtime.renewModelRequestLease(host, turnId, claim, true);
      else if (/^model\.(completed|failed|cancelled)$/.test(event)) runtime.renewModelRequestLease(host, turnId, claim, false);
      host.log(event, { ...lifecycle, ...detail });
    };
    const opened = await setup.open({ routing, modelEvent, messages: restored.messages });
    const partial = partialAnswer(host, turnId, claim);
    const onEvent = event => {
      opened.options.onEvent?.(event);
      partial(event);
      if (["turn_end", "tool_execution_end"].includes(event.type)) events.push(event.type);
    };
    attempt = new (opened.Attempt || PiAttempt)({ ...opened.options,
      messages: restored.messages,
      piSession: restored.piSession,
      sessionId: row.session_id,
      taskInput: input.text,
      taskStartedAt: Date.parse(row.created_at),
      budget: setup.budget,
      handoff: saved.handoff,
      outputRecovery: saved.outputRecovery === true,
      outputReview: saved.outputReview || {},
      incrementalJournal: Number(row.journal_format) === PI_JOURNAL_FORMAT,
      nextSteer: setup.acceptsSteer ? nextSteer : null,
      onBudget: async (state, boundary) => {
        await saveBudget(state);
        host.log("agent.turn.budget", { ...lifecycle, boundary: boundary.role, callId: boundary.toolCallId,
          modelCalls: state.modelCalls, toolCalls: state.toolCallIds.length });
      },
      onCheckpoint: async (checkpoint, boundary) => {
        await saveCheckpoint(checkpoint, boundary.steerId);
        await host.storage.sync?.();
        assertLease();
        host.log("agent.turn.checkpoint", { ...lifecycle,
          boundary: boundary.role, callId: boundary.toolCallId, messageCount: checkpoint.messages.length,
          journalEntries: checkpoint.piSession?.entries?.length });
      },
      onEvent
    });
    await attempt.initialize();
    let live = liveAttempts.get(host.storage);
    if (!live) liveAttempts.set(host.storage, live = new Map());
    live.set(turnId, attempt);
    const fresh = prompt == null && !savedMessages.length;
    const submitted = fresh ? text(input) : prompt;
    const checkpoint = submitted == null ? await attempt.continue()
      : await attempt.prompt(submitted, { preface: setup.preface ?? null, images: fresh ? await images(input, turnId) : [] });
    if (!hasLease()) return { claimed: true };
    const commands = pendingCalls(host, turnId);
    if (commands.length) {
      // A model that answered past a waiting call does not answer this turn: the journal stops at
      // the last waiting result, so the executor's outcome is what the resumed run reads next.
      const premature = checkpoint.messages.at(-1)?.role === "assistant";
      const waiting = premature
        ? checkpointWithMessages(checkpoint, suspendAtPendingCalls(checkpoint.messages, commands), row.session_id)
        : nativeCheckpoint({ ...checkpoint, sessionContextVersion: SESSION_CONTEXT_VERSION, events: events.slice(-100) });
      if (premature) host.log("agent.turn.premature_answer_discarded", { ...lifecycle, pendingFunctions: commands.length });
      waitForExecutor(host, turnId, claim, commands,
        await storeValue(host, nativeCheckpoint({ ...waiting, sessionContextVersion: SESSION_CONTEXT_VERSION, events: events.slice(-100) }), row.account_id),
        { ...lifecycle, durationMs: nowMs(host) - startedAt }, row);
      return { claimed: true };
    }
    if (checkpoint.error) throw Object.assign(new Error(checkpoint.error), {
      code: checkpoint.errorCode || runtime.modelFailureCode(checkpoint.error), retryAfterMs: checkpoint.retryAfterMs, origin: "model"
    });
    if (!checkpoint.finalText?.trim()) {
      // A response cut at its output cap before any answer or tool call (its reasoning took the
      // whole budget) is MODEL_OUTPUT_LIMIT: the retry is the output recovery, not the same request.
      const cut = checkpoint.messages.at(-1)?.role === "assistant" && checkpoint.messages.at(-1).stopReason === "length";
      throw Object.assign(new Error(cut ? "model reached its output limit before answering" : "model returned no final answer"),
        { code: cut ? "MODEL_OUTPUT_LIMIT" : "MODEL_OUTPUT_EMPTY", origin: "model" });
    }
    const completedAt = nowIso(host);
    const completed = await storeValue(host, nativeCheckpoint({ ...checkpoint, sessionContextVersion: SESSION_CONTEXT_VERSION, events: events.slice(-100) }),
      row.account_id);
    assertLease();
    host.storage.transactionSync(() => {
      host.storage.sql.exec(
        `UPDATE agent_turns SET status = 'completed', phase = ?, checkpoint_json = ?, final_answer = ?,
       lease_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
       WHERE turn_id = ? AND lease_id = ? AND attempt = ?`,
        checkpoint.handoff ? "waiting_for_user" : "done", stored(host, row, completed),
        checkpoint.finalText, completedAt, completedAt, turnId, claim.leaseId, claim.attempt);
    });
    runtime.appendTurnStep(host, turnId, claim.attempt, "model", "completed");
    host.log("agent.turn.completed", { ...lifecycle, deliveryStatus: checkpoint.delivery?.status || "untracked", durationMs: nowMs(host) - startedAt });
    // The answer is committed above; what the product does with it never holds it.
    await hooks.afterCompleted?.({ turn: row, checkpoint, lifecycle, budget: setup.budget });
    runtime.scheduleTurns(host);
    return { claimed: true };
  } catch (error) {
    // A cancelled or reclaimed attempt cannot change the new owner's outcome.
    if (!hasLease()) return { claimed: true };
    const failedAt = nowIso(host);
    const errorMessage = error instanceof Error ? error.message : String(error || "MODEL_FAILED");
    const priorFailures = Number(one(host,
      "SELECT COUNT(*) AS count FROM agent_turn_steps WHERE turn_id = ? AND kind = 'model' AND outcome = 'failed'", turnId)?.count || 0);
    // MODEL_SPEND_LIMIT comes only from the spend check that refused a model request. Only the model
    // request's own failure is read for a status or a timeout: a storage, tool or host error whose
    // message says "timeout" or "503" keeps an explicit code or is MODEL_FAILED.
    const errorCode = direct ? "TOOL_FAILED" : runtime.modelFailureCode(error, { origin: error?.origin === "model" ? "model" : "other" });
    const retryAfterMs = Math.max(5_000 * 2 ** priorFailures, Number(error?.retryAfterMs) || 0);
    const budget = attempt?.budget;
    const shouldRetry = !direct && runtime.isRetryableModelFailure(errorCode) && priorFailures + 1 < MAX_MODEL_FAILURES_PER_TURN
      && retryAfterMs <= 120_000 && (!budget || budget.modelCalls < budget.maxModelCalls);
    const retryRouting = shouldRetry ? await (hooks.retryRouting ? hooks.retryRouting({ turn: row, routing, failedProvider }) : routing) : null;
    // Same checkpoint and native wake; no busy sleep or action resubmit. A retry after
    // MODEL_OUTPUT_LIMIT is the output recovery (PiAttempt `outputRecovery`), for that attempt only.
    if (shouldRetry) host.storage.sql.exec(
      `UPDATE agent_turns SET checkpoint_json = json_set(COALESCE(checkpoint_json, '{}'), '$.retryNotBefore', ?, '$.modelRouting', json(?),
        '$.outputRecovery', json(?)) WHERE turn_id = ? AND lease_id = ?`,
      nowMs(host) + retryAfterMs, JSON.stringify(retryRouting), String(errorCode === "MODEL_OUTPUT_LIMIT"), turnId, claim.leaseId);
    host.storage.sql.exec(
      `UPDATE agent_turns SET status = ?, phase = ?, error_code = ?,
       lease_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
       WHERE turn_id = ? AND lease_id = ? AND attempt = ?`,
      shouldRetry ? "queued" : "failed", shouldRetry ? "queued" : "done", errorCode, failedAt, shouldRetry ? null : failedAt,
      turnId, claim.leaseId, claim.attempt);
    runtime.appendTurnStep(host, turnId, claim.attempt, direct ? "function" : "model", "failed", { errorCode });
    host.log(shouldRetry ? "agent.turn.retrying" : "agent.turn.failed", {
      ...lifecycle,
      ...(direct ? { executionMode: "tool" } : { modelFailure: priorFailures + 1 }),
      errorCode,
      retryAfterMs: shouldRetry ? retryAfterMs : null,
      ...(retryRouting ? { failedProvider, providerIgnore: retryRouting.ignore, providerSort: retryRouting.sort } : {}),
      errorMessage: errorMessage.slice(0, 300),
      durationMs: nowMs(host) - startedAt
    });
    if (shouldRetry) {
      await host.armWatchdog(nowMs(host) + retryAfterMs);
      runtime.scheduleTurns(host);
      return { claimed: true };
    }
    runtime.scheduleTurns(host);
    throw error;
  } finally {
    // The answer so far belongs to a running attempt; a turn that waits, ended or was requeued has none.
    host.storage.sql.exec("UPDATE agent_turns SET partial_text = NULL WHERE turn_id = ? AND partial_text IS NOT NULL AND (lease_id IS NULL OR lease_id = ?)",
      turnId, claim.leaseId);
    const live = liveAttempts.get(host.storage);
    if (attempt && live?.get(turnId) === attempt) live.delete(turnId);
    if (live?.size === 0) liveAttempts.delete(host.storage);
    attempt?.dispose();
    // A steer this attempt placed but never delivered is unplaced again: a retry of this turn
    // re-places it, otherwise it is answered as its own turn.
    runtime.releaseSteers(host, { leaseId: claim.leaseId });
  }
}

/**
 * The answer so far (`agent_turns.partial_text`) while the model streams, for the chat
 * (`partialText` in the projection): written under the attempt's lease at most once per
 * PARTIAL_TEXT_INTERVAL_MS and only when it changed, so one streamed message costs at most one row
 * write per interval; cleared when the message ends. Each write tells the UI (`notify(["ui"])`).
 */
function partialAnswer(host, turnId, claim) {
  let writtenAt = -Infinity, written = null;
  const write = text => {
    host.storage.sql.exec(`UPDATE agent_turns SET partial_text = ? WHERE turn_id = ? AND lease_id = ? AND attempt = ?${text === null ? " AND partial_text IS NOT NULL" : ""}`,
      text, turnId, claim.leaseId, claim.attempt);
    written = text;
    host.notify?.(["ui"]);
  };
  return event => {
    if (event.message?.role !== "assistant") return;
    if (event.type === "message_update") {
      const now = nowMs(host);
      if (now - writtenAt < PARTIAL_TEXT_INTERVAL_MS) return;
      const text = latestAssistantText([event.message]).slice(-runtime.PARTIAL_TEXT_MAX_CHARS);
      if (!text.trim() || text === written) return;
      writtenAt = now;
      write(text);
    } else if (event.type === "message_end" && written !== null) write(null);
  };
}

/** Parks a turn on its executor calls with this checkpoint (a stored JSON string or a value). */
function waitForExecutor(host, turnId, claim, commands, checkpointValue, lifecycle, row = null) {
  runtime.assertTurnLease(host, turnId, claim);
  host.storage.transactionSync(() => {
    const serialized = typeof checkpointValue === "string" ? checkpointValue : stored(host, row, checkpointValue);
    host.storage.sql.exec(`UPDATE agent_turns SET status = 'waiting_for_browser', phase = 'browser', checkpoint_json = ?,
      waiting_ref = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE turn_id = ? AND lease_id = ? AND attempt = ?`,
    serialized, commands[0].call_id, nowIso(host), turnId, claim.leaseId, claim.attempt);
  });
  for (const command of commands) {
    runtime.appendTurnStep(host, turnId, claim.attempt, "function_wait", "waiting", { toolName: command.function_name, toolCallId: command.tool_call_id });
  }
  host.log("agent.turn.waiting_for_function", { ...lifecycle, turnId, attempt: claim.attempt,
    callId: commands[0].call_id, functionName: commands[0].function_name, pendingFunctions: commands.length });
  host.notify?.(["ui", "work"]);
}

/**
 * A provider can still answer after the tool batch that queued executor calls. The journal is
 * kept up to the last waiting result, so the executor settles it and the resumed run reads facts.
 */
export function suspendAtPendingCalls(messages, commands) {
  const toolCallIds = new Set(commands.map(command => command.tool_call_id));
  const boundary = messages.findLastIndex(message => message.role === "toolResult" && toolCallIds.has(message.toolCallId));
  if (boundary < 0) throw new Error("PENDING_FUNCTION_CHECKPOINT_MISSING");
  return messages.slice(0, boundary + 1);
}

/**
 * The journal a resumed attempt continues: a failed or aborted last response is dropped, and each
 * call of the last response gets its result: an executor call its waiting or settled result, a
 * tool with a completed receipt that result, an interrupted read is run again (with `tools`, the
 * resumed attempt's receipt-wrapped tools), anything else an interruption result. Synchronous
 * without reads to replay (a thread restore never executes tools).
 */
export function recoverToolMessages(host, turnId, messages, { tools = [] } = {}) {
  const turn = one(host, "SELECT account_id, thread_id, attempt FROM agent_turns WHERE turn_id = ?", turnId);
  const next = structuredClone(messages);
  while (next.at(-1)?.role === "assistant" && ["error", "aborted"].includes(next.at(-1).stopReason)) next.pop();
  const index = next.findLastIndex(message => message.role === "assistant");
  const calls = next[index]?.content?.filter(block => block.type === "toolCall") || [];
  const reads = [];
  for (const call of calls) {
    const receipt = runtime.toolReceipt(host.storage, turnId, call.id);
    const executorCall = one(host, "SELECT * FROM agent_function_calls WHERE turn_id = ? AND tool_call_id = ?", turnId, call.id);
    const resultIndex = next.findIndex((message, position) => position > index && message.role === "toolResult" && message.toolCallId === call.id);
    const executorName = Boolean(host.calls?.executor?.(call.name));
    const tool = !executorCall && receipt?.status !== "completed" && !executorName ? tools.find(candidate => candidate.name === call.name) : null;
    const replay = tool && (receipt ? Boolean(receipt.read_only) : resultIndex < 0 && readOnlyCall(host, call.name, call.arguments));
    if (resultIndex >= 0 && !replay) continue;
    let result;
    if (executorCall) result = executorWaitingResult({ callId: executorCall.call_id, functionName: executorCall.function_name });
    else if (receipt?.result_json) result = JSON.parse(receipt.result_json);
    else result = runtime.interruptedToolResult(host, call.name, call.id, Boolean(receipt?.read_only) || executorName, !receipt);
    const position = resultIndex >= 0 ? resultIndex : next.length;
    next[position] = { role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, timestamp: nowMs(host) };
    if (replay) reads.push({ call, tool, position });
    if (executorCall && ["completed", "failed"].includes(executorCall.status)) {
      next.splice(0, next.length, ...settledResult(host, next, { ...executorCall, tool_call_id: call.id, function_name: call.name }, true));
    }
    host.log("agent.tool.recovered", { accountId: turn.account_id, threadId: turn.thread_id,
      attempt: turn.attempt, turnId, callId: call.id, functionName: call.name,
      outcome: executorCall ? "browser_receipt" : receipt?.status === "completed" ? "deduplicated" : receipt ? "unresolved" : "not_started" });
  }
  if (reads.length) return (async () => {
    for (const { call, tool, position } of reads) {
      const result = await tool.execute(call.id, call.arguments);
      next[position] = { role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, timestamp: nowMs(host) };
    }
    return next;
  })();
  return next;
}

// A settled executor call's outcome in place of its waiting result (the product's model form).
function settledResult(host, messages, call, readOnly) {
  if (host.calls?.settled) return host.calls.settled(messages, call, { readOnly });
  const text = call.error_code ? `${call.error_code}: ${JSON.parse(call.result_json || "null")?.message || call.error_code}` : call.result_json || "null";
  return messages.map(message => message.role === "toolResult" && message.toolCallId === call.tool_call_id
    ? { role: "toolResult", toolCallId: call.tool_call_id, toolName: call.function_name, content: [{ type: "text", text }],
      details: { callId: call.call_id }, isError: Boolean(call.error_code), timestamp: nowMs(host) } : message);
}

/**
 * The prior conversation of a new turn: the latest finished turn's journal (it carries the thread's
 * whole, possibly compacted history), or, once, the thread rebuilt turn by turn from legacy rows.
 * A merged steer is part of the turn it joined.
 */
export function restorePriorMessages(host, turn) {
  const latest = one(host, `SELECT * FROM agent_turns
    WHERE thread_id = ? AND status IN ${TERMINAL} AND rowid < ?
      AND json_type(input_json, '$.mergedIntoTurnId') IS NULL
    ORDER BY rowid DESC LIMIT 1`, turn.thread_id, turn.storage_rowid);
  if (!latest) return [];
  const checkpoint = hydrateCheckpoint(host.storage, latest, JSON.parse(latest.checkpoint_json || "{}"));
  if (checkpoint.sessionContextVersion === SESSION_CONTEXT_VERSION && checkpointMessages(checkpoint).length) {
    return restoreSessionMessages([historicalTurn(host, latest)]);
  }
  // Compatibility (session context v1/v2): one-time legacy reconstruction. Later journals already
  // contain the thread's cumulative history, without a last-N cutoff. Removal: no sessionContextVersion
  // below 3 in production (pi_journal_inventory); test: the legacy rows of tests/pi-journal-replay.test.js.
  const prior = rows(host,
    `SELECT * FROM agent_turns
     WHERE thread_id = ? AND status IN ${TERMINAL} AND rowid < ?
       AND json_type(input_json, '$.mergedIntoTurnId') IS NULL
     ORDER BY rowid ASC`,
    turn.thread_id, turn.storage_rowid);
  return restoreSessionMessages(prior.map(row => historicalTurn(host, row)));
}

// A finished turn as history. A failed or cancelled turn's journal can end in waiting results; its
// settled call rows (a cancelled call included) say what happened instead.
function historicalTurn(host, row) {
  if (!row.checkpoint_json) return row;
  const checkpoint = hydrateCheckpoint(host.storage, row, JSON.parse(row.checkpoint_json));
  if (row.status === "completed") return { ...row, checkpoint_json: JSON.stringify(checkpoint) };
  const messages = recoverToolMessages(host, row.turn_id, checkpointMessages(checkpoint));
  for (const call of rows(host, "SELECT * FROM agent_function_calls WHERE turn_id = ? AND status IN ('completed','failed')", row.turn_id)) {
    if (!messages.some(message => message.role === "toolResult" && message.toolCallId === call.tool_call_id
      && message.content?.some(part => part.text?.startsWith(WAITING_RESULT_PREFIX)))) continue;
    messages.splice(0, messages.length, ...settledResult(host, messages, call, false));
  }
  return { ...row, checkpoint_json: JSON.stringify(checkpointWithMessages(checkpoint, messages, row.session_id)) };
}

function priorPiSession(host, turn) {
  const prior = one(host, `SELECT checkpoint_json, session_id, journal_format FROM agent_turns
    WHERE thread_id = ? AND status IN ${TERMINAL} AND rowid < ?
      AND json_type(input_json, '$.mergedIntoTurnId') IS NULL
    ORDER BY rowid DESC LIMIT 1`, turn.thread_id, turn.storage_rowid);
  return prior?.checkpoint_json ? hydrateCheckpoint(host.storage, prior, JSON.parse(prior.checkpoint_json)).piSession : undefined;
}

/**
 * Queues a turn row (inside the caller's transaction when it commits other rows with it). The
 * product validated the request and computed its replay hash.
 */
export function insertTurn(host, { turnId, accountId, threadId, sessionId = threadId, runtimeVersion, permissions, input, idempotencyKey, inputHash,
  journalFormat = PI_JOURNAL_FORMAT, now = nowIso(host) }) {
  host.storage.sql.exec(
    `INSERT INTO agent_turns
     (turn_id, account_id, thread_id, session_id, runtime_version, status, phase,
      permissions_json, input_json, idempotency_key, input_hash, journal_format, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, 0, ?, ?)`,
    turnId, accountId, threadId, sessionId, runtimeVersion, JSON.stringify(permissions), JSON.stringify(input), idempotencyKey, inputHash,
    journalFormat, now, now);
}

/**
 * Cancels a turn and every unfinished turn it owns (its `parentTurnId` children, through settled
 * owners too; a `background` child and its subtree are not owned), their open executor calls, and
 * a live attempt. A steer a live attempt is placing is already in Pi's queue: the cancel is refused
 * (`already_delivering`) and changes nothing. Returns the cancelled turns.
 */
export function cancelTurn(host, turnId, now = nowIso(host)) {
  const turn = one(host, "SELECT thread_id, status, phase FROM agent_turns WHERE turn_id = ?", turnId);
  if (!turn) throw new Error("TURN_NOT_FOUND");
  // A placed steer is a completed receipt, so the cancel below has nothing to cancel.
  if (one(host, `SELECT steer.turn_id FROM agent_turns steer JOIN agent_turns running
      ON running.lease_id = json_extract(steer.input_json, '$.placingLease')
    WHERE steer.turn_id = ? AND steer.status = 'queued' AND running.status = 'running' AND running.lease_expires_at >= ?`, turnId, now)) {
    return { cancel: "already_delivering", cancelled: [] };
  }
  const cancelled = host.storage.transactionSync(() => {
    // Walk through settled owners too: their continuations can still be active.
    // Background edges detach the entire subtree from this cancellation.
    const owned = rows(host, `WITH RECURSIVE owned(turn_id, thread_id, status, phase, depth) AS (
      SELECT turn_id, thread_id, status, phase, 0 FROM agent_turns WHERE turn_id = ?
      UNION ALL
      SELECT child.turn_id, child.thread_id, child.status, child.phase, parent.depth + 1
      FROM agent_turns child JOIN owned parent
        ON json_extract(child.input_json, '$.parentTurnId') = parent.turn_id
      WHERE json_extract(child.input_json, '$.background') IS NOT 1
    ) SELECT * FROM owned
      WHERE (depth = 0 AND (phase = 'waiting_for_user' OR status NOT IN ${TERMINAL}))
         OR (depth > 0 AND status IN ('queued','running'))
      ORDER BY depth DESC`, turnId);
    for (const cancelledTurn of owned) {
      // Work the host holds open for this turn outside the runtime (an approval) is withdrawn first.
      host.external?.cancel?.(cancelledTurn.turn_id, now);
      host.storage.sql.exec(
        `UPDATE agent_turns SET status = 'cancelled', phase = 'done', error_code = 'TURN_CANCELLED',
         lease_id = NULL, lease_expires_at = NULL, waiting_ref = NULL, updated_at = ?, completed_at = ?
         WHERE turn_id = ? AND (phase = 'waiting_for_user' OR status NOT IN ('completed', 'failed', 'cancelled'))`,
        now, now, cancelledTurn.turn_id);
      host.storage.sql.exec(`UPDATE agent_turns SET checkpoint_json = json_remove(
        CASE WHEN json_extract(checkpoint_json, '$.delivery.status') = 'waiting'
          THEN json_set(checkpoint_json, '$.delivery.status', 'blocked') ELSE checkpoint_json END,
        '$.handoff') WHERE turn_id = ? AND checkpoint_json IS NOT NULL`, cancelledTurn.turn_id);
      // The journal keeps their waiting results; a restore reads these rows instead (historicalTurn).
      host.storage.sql.exec(
        `UPDATE agent_function_calls SET status = 'failed', error_code = 'TURN_CANCELLED', lease_id = NULL,
         lease_expires_at = NULL, updated_at = ? WHERE turn_id = ? AND status IN ('created', 'claimed')`,
        now, cancelledTurn.turn_id);
    }
    return owned;
  });
  if (!cancelled.length) return { cancelled };
  const live = liveAttempts.get(host.storage);
  for (const cancelledTurn of cancelled) {
    live?.get(cancelledTurn.turn_id)?.abort();
    host.log("agent.turn.cancelled", { turnId: cancelledTurn.turn_id, threadId: cancelledTurn.thread_id });
  }
  host.notify?.(["ui", "work"]);
  runtime.scheduleTurns(host);
  return { cancelled };
}
