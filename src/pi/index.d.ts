// Types of the Pi layer (src/pi/index.js). Plain declarations: no build step. Pi's own types are
// left as `any` here so that a consumer type-checks without resolving pi-coding-agent's types.
import type { FunctionCallRow, SqlStorage, TurnBudget, TurnClaim, TurnHost, TurnRow, ToolResult } from "../runtime/index.js";

/** The journal's persisted custom-entry types (never renamed without a journal migration). */
export const JOURNAL_ENTRY_TYPES: Readonly<{ turnAuthorization: string; resume: string; compactedEvidence: string }>;
export const CHECKPOINT_VERSION: 2;
export const SESSION_CONTEXT_VERSION: 3;
export const PI_JOURNAL_FORMAT: 2;
export const PI_PRIVATE_API_PIN: string;
export const STEP_LIMIT_ERROR: "MODEL_STEP_LIMIT";
export const HANDOFF_TOOL: "handoff_to_user";
export const MAX_CHECKPOINT_BYTES: number;
/** `pi_journal_entries` and its index, byte-compatible with X Gardener's migration 14. */
export const PI_JOURNAL_SCHEMA: readonly string[];

/** A Pi session journal: SessionManager header, entries (or, stored, `format`/`maxSeq`) and the active leaf. */
export interface PiJournal { header: any; entries?: any[]; leafId: string | null; format?: number; maxSeq?: number; }
/** A turn's checkpoint as the runtime writes it; products add their own fields. */
export interface Checkpoint { checkpointVersion?: number; sessionContextVersion?: number; piSession?: PiJournal; messages?: any[]; [field: string]: any; }
/** The columns of an `agent_turns` row the journal store reads. */
export interface JournalTurn { session_id: string; journal_format: number | null; checkpoint_json?: string | null; }

export function checkpointMessages(checkpoint?: Checkpoint): any[];
export function checkpointWithMessages(checkpoint: Checkpoint, messages: any[], sessionId?: string): Checkpoint;
export function nativeCheckpoint(checkpoint: Checkpoint): Checkpoint;
export function loadJournal(cwd: string, journal: PiJournal | undefined, sessionId?: string): any;
export function snapshotJournal(manager: any): PiJournal;
export function reconcileMessages(manager: any, messages: any[]): void;
export function openPiSession(options: { model: any; streamFn: any; systemPrompt: string; messages?: any[]; piSession?: PiJournal; sessionId?: string;
  extensions: Array<(pi: any) => void>; compaction?: object }): Promise<{ session: any; dispose(): void; getExtensionError(): any;
  snapshot(messages: any[], options?: { incremental?: boolean }): PiJournal; commit(snapshot: PiJournal): void }>;

export function serializeCheckpoint(value: unknown, options?: { encode?: (value: any) => any }): string;
export function checkpointForStorage(storage: SqlStorage, turn: JournalTurn, checkpoint: Checkpoint, options?: { encode?: (value: any) => any }): Checkpoint;
export function hydrateCheckpoint(storage: SqlStorage, turn: JournalTurn, checkpoint?: Checkpoint): Checkpoint;
export function readTurnCheckpoint(storage: SqlStorage, turnId: string): Checkpoint | null;
export function readActiveJournalSubset(storage: SqlStorage, sessionId: string, leafId: string | null): any[];
/** A settled result written into a waiting turn's journal; call inside a TurnHost's writeResult. */
export function writeJournalResult<T extends Record<string, unknown>>(storage: SqlStorage, turn: JournalTurn & { checkpoint_json: string },
  replace: (checkpoint: Checkpoint) => T & { messages: any[]; checkpoint?: Checkpoint }, options?: { encode?: (value: any) => any }):
  Omit<T, "messages" | "checkpoint"> & { checkpointJson: string };

export interface JournalMigrationOptions { limit?: number; after?: number | null; apply?: boolean; applyEnabled?: boolean;
  encode?: (value: any) => any; log?: (event: string, detail: Record<string, unknown>) => void; }
export function inventoryPiJournal(storage: SqlStorage, options?: { applyEnabled?: boolean }): Record<string, any>;
export function migratePiJournal(storage: SqlStorage, options?: JournalMigrationOptions): Record<string, any>;
export function rollbackPiJournal(storage: SqlStorage, options?: JournalMigrationOptions): Record<string, any>;

/** Finished `agent_turns` rows (hydrated checkpoints) in thread order → the next turn's prior messages. */
export function restoreSessionMessages(rows: Array<Record<string, any>>): any[];
export function compactedEvidence(message: any): Record<string, any> | null;
export function announcesPendingAction(text: string): string | null;
export function pendingActionSteer(owner: PiAttempt, options: { wording: string; onEvent?: (event: any) => void }): (pi: any) => void;
export function latestAssistantText(messages: any[]): string;

/** A product's task bookkeeping, driven by the attempt (Gardener: task_checkpoint and its receipts). */
export interface TaskProgress {
  tool?: { name: string; label?: string; description: string; parameters: unknown; execute(...args: any[]): Promise<ToolResult> };
  /** The custom type of the reminder sent before a run finishes. */
  noticeType: string;
  importHistory(messages: any[], startedAt?: number): void;
  /** A projected tool result to replace Pi's, or undefined. */
  toolResult(event: any): { details: any; content: any[] } | undefined;
  beforeFinish(): string | null;
  snapshot(): Record<string, any>;
  summary(): { status: string; pending: string[]; items: any[]; [field: string]: any };
}

/** The product's task hooks (Gardener: task progress, its compaction evidence, exact artifact links). */
export interface TaskHooks {
  /** The task's bookkeeping, or none. */
  progress?: TaskProgress | null;
  /** What a compaction keeps exactly, as a typed custom message. */
  retainEvidence?(messages: any[]): Record<string, unknown> | null;
  /** The delivered final answer message. */
  finalizeAnswer?(message: any, attempt: PiAttempt): any;
}

/** An output check installed by the product (Gardener: X source review; pi-do: answer length and plain prose). */
export interface OutputPolicy {
  repairing(outputReview: Record<string, any>): boolean;
  extension(attempt: PiAttempt): (pi: any) => void;
  error(messages: any[]): { code: string; message: string } | null;
  review(attempt: PiAttempt): Promise<void>;
}

/**
 * What one attempt is given, one member per line (tests/source-boundaries.test.js counts them: a
 * product need is first fitted into an existing member). The product hooks are the last eight.
 */
export interface PiAttemptOptions {
  model: any;
  streamFn: any;
  systemPrompt: string;
  tools?: any[];
  messages?: any[];
  piSession?: PiJournal;
  sessionId?: string;
  maxSteps: number;
  maxToolCalls: number;
  /** A ledger from runtime createTurnBudget, or its saved state. */
  budget?: TurnBudget | Record<string, any>;
  citationRepairs?: number;
  contextSettings?: Record<string, unknown>;
  summarizeContext?(input: { previousSummary?: string; messages: any[]; signal: AbortSignal }): Promise<string>;
  onCompact?(detail: Record<string, any>): Promise<void> | void;
  onEvent?(event: any): void;
  /** Journal boundary: the host stores the checkpoint (and marks `boundary.steerId` placed in the same commit). */
  onCheckpoint?(checkpoint: Record<string, any>, boundary: { role: string; toolCallId?: string; steerId?: string }): Promise<void>;
  /** Budget boundary: the host stores the reservation only. */
  onBudget?(state: Record<string, any>, boundary: { role: string; toolCallId?: string }): Promise<void>;
  incrementalJournal?: boolean;
  /** The next durable steer, marked placing by the host, or null. */
  nextSteer?: (() => Promise<{ id: string; text: string; images?: any[] } | null> | { id: string; text: string; images?: any[] } | null) | null;
  handoff?: Record<string, any>;
  taskInput?: string;
  taskStartedAt?: number;
  outputPolicy?: OutputPolicy;
  outputReview?: Record<string, any>;
  /** Native Pi extensions (registered last). */
  extensions?: Array<(pi: any) => void>;
  /** The product's task hooks: its bookkeeping, what a compaction keeps exactly, the delivered answer. */
  task?: TaskHooks;
  /** Extensions that need the attempt, registered after compaction; null skips one. */
  plugins?: Array<(attempt: PiAttempt) => ((pi: any) => void) | null>;
  /** The model view of the history (a stable prefix). Default: unchanged. */
  contextView?(messages: any[]): any[];
  /** The dynamic tail after the history; must include `budgetLine`. Default: [budgetLine]. */
  contextTail?(view: any[], budgetLine: any): Promise<any[]> | any[];
  /** The view compaction estimates and summarizes. Default: unchanged. */
  compactionView?(messages: any[]): any[];
  /** Installs the announced-action steer with this wording (`{{CLAIM}}`). */
  pendingActionWording?: string | null;
  /**
   * This attempt is the output recovery after MODEL_OUTPUT_LIMIT (set by the turn driver): its
   * requests go without tools, with twice `model.maxTokens`, Pi's `reasoning: "low"` and
   * `outputLimitWording` appended to the system prompt.
   */
  outputRecovery?: boolean;
  /** The product's notice for the output recovery (tell the model to answer now, briefly). */
  outputLimitWording?: string | null;
}

export class PiAttempt {
  constructor(options: PiAttemptOptions);
  readonly budget: Record<string, any>;
  readonly reserve: TurnBudget["reserve"];
  readonly remaining: TurnBudget["remaining"];
  readonly spendAvailable: TurnBudget["spendAvailable"];
  readonly addCost: TurnBudget["addCost"];
  readonly spendLimitCode: TurnBudget["spendLimitCode"];
  readonly contextConfig: Record<string, any>;
  readonly contextAbort: AbortController;
  readonly progress: TaskProgress | null;
  session: any; agent: any;
  stepsRemaining: number;
  taskInput: string;
  outputReview: Record<string, any>;
  repairMessages?: any[];
  handoff?: Record<string, any>;
  initialize(): Promise<void>;
  /** `images`: Pi ImageContent the user attached, sent in the same user message as `input`. */
  prompt(input: string, options?: { preface?: string | null; images?: any[] }): Promise<Record<string, any>>;
  continue(): Promise<Record<string, any>>;
  persist(boundary: { role: string; toolCallId?: string; steerId?: string }): Promise<Record<string, any> | undefined>;
  abort(): void;
  dispose(): void;
  isOutputRepairing(): boolean;
  checkpoint(options?: { full?: boolean }): Record<string, any>;
}

// ---------------------------------------------------------------- the durable turn driver

/** What `prepare` is given: the claimed turn, its saved checkpoint and the attempt's receipts. */
export interface AttemptContext {
  turn: TurnRow;
  input: any;
  saved: Checkpoint;
  claim: TurnClaim;
  lifecycle: { accountId: string; threadId: string | null; turnId: string; attempt: number };
  /** Throws MODEL_TURN_LEASE_LOST once this attempt no longer holds the turn. */
  assertCurrent(): void;
  /** A tool's execute behind a durable receipt (readOnly defaults to the host's `calls.readOnly`). */
  receipt(name: string, execute: (...args: any[]) => Promise<ToolResult>, readOnly?: boolean): (toolCallId: string, input: any, ...rest: any[]) => Promise<ToolResult>;
}

/** One attempt's product setup, before its journal is restored. */
export interface AttemptSetup {
  budget: TurnBudget;
  /** The attempt's tools; an interrupted read among them is replayed by recovery. */
  tools: any[];
  /** Host runtime state sent with the turn's prompt as a typed custom entry. */
  preface?: string | null;
  /** The user message of a turn input (the turn's prompt and a steer's text). Default: `input.text`. */
  text?(input: any): string;
  /**
   * The images (Pi ImageContent) the user attached to a turn input (the turn's or a steer's), sent
   * with its text; a promise when the product loads them from elsewhere. Default: none.
   */
  images?(input: any, turnId: string): any[] | Promise<any[]>;
  /** Which queued steers this turn takes; null or absent: none. */
  acceptsSteer?: ((row: { turn_id: string; input: any; permissions: any }) => boolean) | null;
  /** The attempt itself: its class (default PiAttempt) and the product's options. The driver adds the journal, budget, steer and persistence options. */
  open(context: { routing: Record<string, any>; modelEvent(event: string, detail: Record<string, any>): void; messages: any[] }):
    Promise<{ Attempt?: new (options: PiAttemptOptions) => PiAttempt; options: Partial<PiAttemptOptions> & Record<string, any> }>;
}

/** How the product runs a turn's attempt. */
export interface AttemptHooks {
  /** A turn the host runs without the model (Gardener: an MCP browser call): returns its runner, or null for a model turn. */
  direct?(turn: TurnRow): ((context: { claim: TurnClaim; lifecycle: Record<string, unknown> }) => Promise<Checkpoint>) | null;
  /** Required: the attempt's budget, tools, steer rule and Pi options. */
  prepare(context: AttemptContext): AttemptSetup;
  /** The model routing a retry uses after `failedProvider` failed. Default: unchanged. */
  retryRouting?(context: { turn: TurnRow; routing: Record<string, any>; failedProvider: string | null }): Promise<Record<string, any>>;
  /** After a turn completed (its answer committed). */
  afterCompleted?(context: { turn: TurnRow; checkpoint: Record<string, any>; lifecycle: Record<string, unknown>; budget: TurnBudget }): Promise<void>;
}

/** The TurnHost of a product whose turns run on the core's driver. */
export interface TurnDriverHost extends TurnHost {
  attempt: AttemptHooks;
}

export const MAX_MODEL_FAILURES_PER_TURN: number;
export const WAITING_RESULT_PREFIX: string;
/** A running turn's answer so far (`agent_turns.partial_text`) is written at most once per this interval while the model streams. */
export const PARTIAL_TEXT_INTERVAL_MS: number;
/** Runs one attempt of a queued turn; rejects with the error of a turn that failed for good. */
export function runTurnAttempt(host: TurnDriverHost, turnId: string, options?: { prompt?: string | null }): Promise<{ claimed: boolean; direct?: boolean }>;
export function cancelTurn(host: TurnHost, turnId: string, now?: string): { cancel?: "already_delivering"; cancelled: Array<{ turn_id: string; thread_id: string | null }> };
export function restorePriorMessages(host: TurnHost, turn: TurnRow & { storage_rowid: number }): any[];
export function recoverToolMessages(host: TurnHost, turnId: string, messages: any[], options?: { tools?: any[] }): any[] | Promise<any[]>;
export function suspendAtPendingCalls(messages: any[], calls: Array<{ tool_call_id: string }>): any[];
export function pendingCalls(host: TurnHost, turnId: string): Array<Pick<FunctionCallRow, "call_id" | "tool_call_id" | "function_name">>;
export function executorWaitingResult(call: { callId: string; functionName: string; status?: "created" | "claimed" }): ToolResult & { terminate: true };
/** Whether a tool result message waits for its executor (its batch ends the run). */
export function awaitsExecutor(message: any): boolean;
export function insertTurn(host: TurnHost, turn: { turnId: string; accountId: string; threadId: string; sessionId?: string; runtimeVersion: string;
  permissions: Record<string, unknown>; input: Record<string, unknown>; idempotencyKey: string; inputHash: string; journalFormat?: number; now?: string }): void;

// ---------------------------------------------------------------- pieces a product may use

/** A stream function whose requests report model.started / completed (with `costUsd`) / failed / cancelled to the driver's `modelEvent`. */
/** The stream function with a per-request (or per-model) deadline; a response it cut fails as MODEL_TIMEOUT. */
export function withModelDeadline<F extends (model: any, context: any, options: any) => any>(streamFn: F,
  deadlineMs: number | ((model: any) => number)): F;
/** A fetch for Pi's openai-completions stream whose signed reasoning entries without text (Anthropic via OpenRouter) Pi keeps and sends back. */
export function withSignedReasoning(fetchImpl: typeof fetch): typeof fetch;
/** Marks an OpenAI-format request's messages in place with prompt-cache breakpoints (system prompt, end of the history) for an OpenRouter model that caches only where marked. */
export function markPromptCache(modelId: string, messages: unknown[]): void;
/** The precisions an OpenRouter request accepts: no declared low-bit (fp8, fp4, int8, ...) endpoint. */
export const FULL_PRECISION_QUANTIZATIONS: readonly string[];
/** OpenRouter provider preferences restricted to full-precision endpoints (`quantizations`); the given order, sort and ignore are kept. */
export function fullPrecisionProvider<P extends Record<string, unknown>>(provider?: P | null): P & { quantizations: string[] };
export function reportModelRequests<F extends (model: any, context: any, options: any) => any>(streamFn: F,
  modelEvent: (event: string, detail: Record<string, unknown>) => void): F;
/** An attempt's `summarizeContext` that asks the turn's own model through its stream function (the prose is the product's). */
export function streamedSummary(options: { model: any; streamFn: (model: any, context: any, options: any) => any; systemPrompt: string;
  request(previousSummary: string | null, history: string): string; onCost?(usd: number | undefined): void; now?(): number }):
  (input: { previousSummary?: string; messages: any[]; signal: AbortSignal }) => Promise<string>;
/** The plain-prose and length-limit repair of a final answer, each at most once per turn (kinds kept in the budget state's `repairs`). */
export function answerRepairPolicy(options: { userText: string; messages: any[];
  wording: { prefix: string; plain: string; length(length: number, max: number, unit: "words" | "characters"): string };
  onRepair?(kind: "plain" | "length"): void }): OutputPolicy & { readonly answering: boolean };
