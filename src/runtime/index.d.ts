// Types of the runtime layer (src/runtime/index.js). Plain declarations: no build step.

export function modelFailureCode(error: unknown, options?: { origin?: "model" | "other" }): string;
export function isRetryableModelFailure(code: string): boolean;
/** A call (and its toolResult message, when there is one) whose result the text model can judge without having seen the screen. */
export type TextRead = (call: any, result?: any) => boolean;
/** The default text read: a browser call whose result is the page as text (tabs, select_tab, snapshot, read_text). */
export const browserTextRead: TextRead;
/** Whether the request answering `messages` needs the vision model: a new tool image, or a vision-model step that was not a text read. */
export function needsVision(messages?: any[], visionModelId?: string | null, textRead?: TextRead, since?: number): boolean;
/** The text model's view: tool-result images replaced by a stable stub. The same array when there are none. */
export function withoutToolImages<T>(messages?: T[]): T[];
/** The default image view: keep the latest `keep` tool-result images, drop older ones `step` at a time. */
export const TOOL_IMAGE_VIEW: Readonly<{ keep: number; step: number }>;
/** Model view: older tool-result images become a text stub; the cut moves in blocks of `step` so the cached prefix stays stable. */
export function pruneToolImages<T>(messages: T[], options?: { keep?: number; step?: number }): T[];
/** A request that needs the vision model (needsVision) goes to it; every other request to the text model, tool images stubbed. */
export function routeVisionRequests(options: {
  text: { model: any; streamFn: (model: any, context: any, options?: any) => any };
  vision?: { model: any; streamFn: (model: any, context: any, options?: any) => any } | null;
  onRoute?: (route: "vision") => void;
  textRead?: TextRead;
  /** The turn's start (ms): messages older than it are earlier turns' and never route this one. */
  since?: number;
  /** Whether the vision model may take this request (its estimated cost fits the turn); false sends it to the text model. */
  affordable?: (visionModel: any, context: any) => boolean;
}):(model: any, context: any, options?: any) => any;

export type BudgetKind = "model" | "tool" | "compaction" | "notes" | "notesAuto" | "citationRepair" | "quantityRepair" | "codeExec" | "pendingActionSteer" | "answerRepair";

export interface TurnBudget {
  /** The persisted state: counters, reserved keys, ceilings, and any field the consumer saved with it. */
  state: Record<string, any>;
  reserve(kind: BudgetKind, key?: string): { ok: boolean; duplicate: boolean; remaining: number; spendLimit?: boolean };
  remaining(kind: BudgetKind): number;
  used(kind: BudgetKind): number;
  spendAvailable(): boolean;
  /** Adds a model request's estimated USD to `state.costUsd` (a budget with `maxCostUsd` only; otherwise nothing is kept). */
  addCost(usd: number | undefined): void;
  /** What the turn's own ceiling leaves (`maxCostUsd` minus `state.costUsd`); Infinity without one. */
  remainingCostUsd(): number;
  /** The code a refused model request stops with: MODEL_TURN_SPEND_LIMIT for the turn's own ceiling, else MODEL_SPEND_LIMIT. */
  spendLimitCode(): "MODEL_SPEND_LIMIT" | "MODEL_TURN_SPEND_LIMIT";
  snapshot(): Record<string, any>;
}

export const BUDGET_LIMITS: Readonly<Record<Exclude<BudgetKind, "model" | "tool">, number>>;
/** `maxCostUsd`: the turn's own spend ceiling, counted in `state.costUsd` (the account-wide cap is `modelSpendAvailable`). */
/** `maxCodeExecCalls`: the turn's code runs (`codeExec`); BUDGET_LIMITS.codeExec when unset. */
export function createTurnBudget(saved: Record<string, any> | undefined, options: { maxModelCalls: number; maxToolCalls: number; modelSpendAvailable?: () => boolean; maxCostUsd?: number; maxCodeExecCalls?: number }): TurnBudget;
export function grantManualRetry(saved: Record<string, any>, grant: { idempotencyKey: string; attempt: number; attemptBudget: number; turnBudget: { modelCalls: number; toolCalls: number } }): Record<string, any>;
export function spendLimitError(code?: "MODEL_SPEND_LIMIT" | "MODEL_TURN_SPEND_LIMIT"): Error & { code: "MODEL_SPEND_LIMIT" | "MODEL_TURN_SPEND_LIMIT" };

export interface LengthLimit { max: number; unit: "words" | "characters"; }
export function stripToolMarkup(text: string): { text: string; stripped: boolean };
export function lengthLimit(userText: string): LengthLimit | null;
export function answerLength(text: string, unit: LengthLimit["unit"]): number;

// ---------------------------------------------------------------- the durable turn queue

/** A Durable Object's storage, or anything with the same shape (node:sqlite in tests). */
export interface SqlStorage {
  sql: { exec(query: string, ...bindings: any[]): { toArray(): any[] } };
  transactionSync<T>(fn: () => T): T;
  /** Waits until earlier writes are durable; a tool's intent is synced before the tool runs. */
  sync?(): Promise<void>;
}

/** The tables RUNTIME_SCHEMA creates, and its statements (each idempotent). */
export const RUNTIME_TABLES: readonly string[];
export const RUNTIME_SCHEMA: readonly string[];

/** A row of `agent_turns` as SQLite returns it (`storage_rowid` where the runtime selected it). */
export interface TurnRow { turn_id: string; thread_id: string | null; storage_rowid?: number; [column: string]: unknown; }
/** A row of `agent_function_calls`. */
export interface FunctionCallRow {
  call_id: string; turn_id: string; account_id: string; function_name: string; tool_call_id: string;
  input_json: string; status: "created" | "claimed" | "completed" | "failed"; lease_id: string | null;
  lease_expires_at: string | null; result_json: string | null; error_code: string | null; attempt: number;
  created_at: string; updated_at: string; read_context_json: string | null; execution_ms: number | null;
}
/** The waiting turn a settlement writes into. */
export interface WaitingTurn { checkpoint_json: string; input_json: string; attempt: number; session_id: string; journal_format: number; }
export interface Settlement { result: unknown; errorCode: string | null; now: string; }

/** How a settled result entered the waiting turn (host.writeResult). */
export type WrittenResult =
  | { held: Record<string, unknown> }
  | { held?: undefined; result: unknown; checkpointJson: string; functionResult?: unknown; completeTurn?: boolean };

/** What a tool call returns to the model loop. */
export interface ToolResult { content: any[]; details?: any; isError?: boolean; [field: string]: unknown; }

export interface TurnClaim { attempt: number; leaseId: string; leaseExpiresAt?: string; }
export interface SettledCall { pending: number; resume: boolean; functionResult?: unknown; [held: string]: unknown; }

/** How the product's tool calls look to the runtime. Every member is optional. */
export interface CallPolicy {
  /** Whether a call only reads: a writing executor call is leased once and expires as EFFECT_UNKNOWN; an interrupted read is replayed. Default true. */
  readOnly?(name: string, input: any): boolean;
  /** Whether a tool name is an executor call (it runs outside the runtime, through the call queue). Default false. */
  executor?(name: string): boolean;
  /** The journal's messages with a settled executor call's outcome in place of its waiting result. Default: the result as JSON text. */
  settled?(messages: any[], call: FunctionCallRow, options: { readOnly: boolean }): any[];
  /** Words a tool error for the model. Default: the error as JSON text. */
  error?(error: { name: string; callId: string; readOnly: boolean; error: { code: string; message: string } }): ToolResult;
  /** How far ahead (ms) a claimed call may park (parkFunctionCall), such as a long browser wait; 0 (the default): it may not. */
  parkable?(name: string, input: any): number;
}

/** How checkpoints and delivered results are stored when they carry payloads kept elsewhere (Gardener: images in R2). */
export interface CheckpointCodec {
  /** The stored form of a value (references only), applied to every serialized checkpoint and journal entry. */
  encode?(value: any): any;
  /** Moves payloads out before a value is stored (outside any transaction); `external` for a result an executor delivered. */
  store?(value: any, context: { accountId: string; external?: boolean }): Promise<any>;
  /** Brings them back before a model sees the value. */
  load?(value: any, context: { accountId: string }): Promise<any>;
}

/** Work the product holds open for a turn outside the runtime (Gardener: an X action awaiting approval). */
export interface ExternalWork {
  /** Resumes calls held open for it, during recovery. */
  recover?(now: string): void;
  /** Withdraws it when its turn is cancelled (inside the cancel's transaction). */
  cancel?(turnId: string, now: string): void;
}

/**
 * What the durable turn queue needs from the product that runs it (scheduling, executor calls,
 * receipts and recovery; the Pi layer's turn driver adds `attempt`). Hooks are optional unless marked.
 */
export interface TurnHost {
  storage: SqlStorage;
  /** Milliseconds clock; Date.now when absent. */
  now?(): number;
  log(event: string, detail: Record<string, unknown>): void;
  /** Tells the product's clients what changed. */
  notify?(topics: Array<"ui" | "work">): void;
  /** Keeps background work alive (a Durable Object's ctx.waitUntil). */
  background(task: Promise<unknown>): void;
  /** Persists the next recovery wake before external I/O; with `at` (ms), also a wake at that time (a retry's). */
  armWatchdog(at?: number): Promise<void>;
  /** Runs one attempt of a ready turn (agent-core/pi runTurnAttempt, or the product's wrapper of it). */
  startAttempt(turnId: string): Promise<unknown>;
  /** Turns that may run model requests at once. */
  modelConcurrency(): number;
  /**
   * One model request's deadline; the running lease is at least two of these. `turnId` names the
   * turn when known (a product whose turns run on models with different timeouts answers per turn).
   */
  modelDeadlineMs(turnId?: string): number;
  /** Attempts per turn unless its saved budget says otherwise (`checkpoint.budget.attemptBudget`). */
  maxAttempts: number;
  /** How long a created call waits for an executor before its turn fails with EXECUTOR_OFFLINE. */
  executorClaimWaitMs: number;
  /** How long an executor holds a claimed call (covers a person's confirmation); TURN_LEASE_MS when absent. */
  executorLeaseMs?: number;

  /** 0 runs first; a turn yields its model slot to any ready turn with a lower number. Default 0. */
  turnPriority?(turn: TurnRow): number;
  /** Whether this executor may claim, and which call names it may not. Default: anyone, anything. */
  claimScope?(claim: { installId?: string; identity?: unknown }): { accept: boolean; excludedNames?: string[] };
  /** Read-only rules, executor-call names, settled and error results. */
  calls?: CallPolicy;
  /** Required: writes a settled result into the waiting turn's checkpoint, or holds the call open. */
  writeResult(call: FunctionCallRow, turn: WaitingTurn, settlement: Settlement): WrittenResult;
  /** Payloads stored outside the turn rows. */
  checkpointCodec?: CheckpointCodec;
  /** The event and fields a delivered result is logged with. */
  describeSettlement?(call: FunctionCallRow, settled: SettledCall, delivery: { result: unknown; errorCode: string | null; detail: unknown }): { event: string; fields: Record<string, unknown> };
  /** Work held open outside the runtime: resumed by recovery, withdrawn by a cancel. */
  external?: ExternalWork;
}

export const TURN_LEASE_MS: number;
export const MODEL_REQUEST_LEASE_MARGIN_MS: number;
/** "CHROME_OFFLINE": the stored error of a call no executor claimed in time. */
export const EXECUTOR_OFFLINE: string;

export function turnLeaseMs(host: TurnHost, turnId?: string): number;
export function claimTurn(host: TurnHost, turnId: string, now?: string): TurnClaim | null;
export function renewModelRequestLease(host: TurnHost, turnId: string, claim: TurnClaim, inFlight: boolean, now?: number): void;
export function scheduleTurns(host: TurnHost): string[];
export function hasTurnLease(host: TurnHost, turnId: string, leaseId: string, attempt: number): boolean;
/** Throws `{ code: "MODEL_TURN_LEASE_LOST" }`. */
export function assertTurnLease(host: TurnHost, turnId: string, claim: TurnClaim): void;
export function appendTurnStep(host: TurnHost, turnId: string, attempt: number, kind: string, outcome: string,
  detail?: { toolName?: string | null; toolCallId?: string | null; errorCode?: string | null }): void;
export function recoverTurns(host: TurnHost, now?: string): Promise<void>;

/** What a product decides about a user's retry (queueTurnRetry). */
export interface RetryOptions {
  /** The model and tool calls a retry grants on top of what the turn used. */
  turnBudget: { modelCalls: number; toolCalls: number };
  /** False refuses with TURN_NOT_RETRYABLE (checked before a repeated key is acknowledged). Default true. */
  retryable?(turn: TurnRow): boolean;
  /** The permissions JSON the retried turn runs under; may throw to refuse. Default: the turn's own. */
  permissions?(turn: TurnRow): string;
  /** An error code when work the product holds for the turn is still open, else null. */
  pendingWork?(turnId: string): string | null;
}
/** Queues a failed or cancelled turn again for a user's retry (once per idempotency key). Throws its refusal code as the message. */
export function queueTurnRetry(host: TurnHost, turnId: string, idempotencyKey: string, options: RetryOptions): { retried: boolean };
/** The newest `limit` turns before `before` (oldest first) and the anchor of the page before them; throws AGENT_TURN_NOT_FOUND for an unknown anchor. */
export function turnPage(host: TurnHost, page: { threadId?: string | null; limit: number; before?: string | null; columns?: string }):
  { rows: Array<TurnRow & { storage_rowid: number }>; nextBefore: string | null };

/** What a product's API returns for a turn and its chat reads (agent-turn-projection-v1). */
export interface TurnProgressItem { id: string; label: string; at: string; tool?: string; errorCode?: string; }
export interface TurnProjection {
  version: string; accountId: string; turnId: string; sessionId: string;
  status: "queued" | "running" | "waiting_for_browser" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
  phase: string; progress: { label: string; items: TurnProgressItem[] }; waiting: { ref: string } | null;
  handoff?: unknown; finalAnswer: string | null; errorCode: string | null;
  /** A running turn's answer so far while the model streams it (absent otherwise). */
  partialText?: string;
  createdAt: string; updatedAt: string; completedAt: string | null;
  mergedIntoTurnId?: string; cancel?: "already_delivering";
  /** Turn list items: the user's text (null for an internal turn) and the turn an internal one continues. */
  input?: string | null; parentTurnId?: string | null;
  [productField: string]: unknown;
}
export const TURN_PROJECTION_VERSION: string;
export const ACTIVE_TURN_STATUSES: readonly string[];
export const TURN_PROGRESS_LIMIT: number;
/** The most characters of a running turn's answer so far (`partialText`): its newest ones. */
export const PARTIAL_TEXT_MAX_CHARS: number;
export function isActiveTurnStatus(status: string | null | undefined): boolean;
export function canStopTurn(turn: Partial<TurnProjection> | null | undefined): boolean;
export function canRetryTurn(turn: Partial<TurnProjection> | null | undefined, latestTurnId: string | null | undefined): boolean;
export function projectTurn(row: Record<string, any>, options: { fields?: Record<string, unknown>; progress: TurnProjection["progress"]; errorCode?: string | null }): TurnProjection;
export function turnProgress(items: TurnProgressItem[], status: string, labels: { queued: string; working: string; done: string }): TurnProjection["progress"];
export function validateTurnProjection<T>(value: T, expectedAccountId?: string | null, options?: { listItem?: boolean; fields?: string[] }): T;

export function createId(prefix: string): string;
export function createSecret(): string;
export function sha256(value: string | Uint8Array): Promise<string>;

export function insertFunctionCall(host: TurnHost, call: { turnId: string; accountId: string; toolCallId: string; functionName: string;
  input: unknown; readContext?: Record<string, unknown> | null; logFields?: Record<string, unknown> }): string;
export function claimFunctionCall(host: TurnHost, claim: { installId?: string; identity?: unknown; excludeCallIds?: string[]; now?: string }):
  null | { callId: null; activeTurns: number }
  | { callId: string; turnId: string; threadId: string | null; accountId: string; functionName: string; input: any; leaseId: string; leaseExpiresAt: string };
export function inspectFunctionLease(host: TurnHost, lease: { callId: string; leaseId: string; now?: string }): { active: boolean };
/** Extends a claimed call's lease past `until` so its turn waits without a model request; `expiry` settles it if nothing is delivered. */
/** How long a parked call's lease outlasts its park. */
export const PARKED_CALL_GRACE_MS: number;
export function parkFunctionCall(host: TurnHost, park: { callId: string; leaseId: string; until: string; expiry: unknown; now?: string }): Promise<{ parked: true; until: string; leaseExpiresAt: string }>;
/** Throws FUNCTION_CALL_LEASE_INVALID or FUNCTION_RESULT_CONFLICT (as the message). */
export function completeFunctionCall(host: TurnHost, delivery: { callId: string; leaseId: string; result: unknown; errorCode?: string | null;
  executionMs?: number | null; detail?: unknown; now?: string }): Promise<{ turnId: string }>;
export function settleFunctionCall(host: TurnHost, call: FunctionCallRow, settlement: { result: unknown; errorCode?: string | null; now?: string;
  receipt?: { key: string; hash: string; now?: string } | null }): SettledCall;
/** Inside the caller's transaction. Throws FUNCTION_CALL_TURN_INVALID when the turn is not waiting. */
export function settleWaitingCall(host: TurnHost, call: FunctionCallRow, settlement: { result: unknown; errorCode?: string | null; now?: string }): SettledCall;

export function toolReceipt(storage: SqlStorage, turnId: string, toolCallId: string): Record<string, any> | null;
export function durableToolExecute<T extends ToolResult>(host: TurnHost, turnId: string, claim: TurnClaim,
  tool: { name: string; execute(toolCallId: string, input: any, ...rest: any[]): Promise<T> }, options?: { readOnly?: boolean }):
  (toolCallId: string, input: any, ...rest: any[]) => Promise<T | ToolResult>;
export function interruptedToolResult(host: TurnHost, name: string, id: string, readOnly?: boolean, notStarted?: boolean): ToolResult;

// ---------------------------------------------------------------- steers

/** The thread's oldest unplaced steer `accepts` takes, now marked placing under `leaseId`; or null. */
export function takeSteer(host: TurnHost, request: { turn: { account_id: string; thread_id: string; storage_rowid: number }; leaseId: string;
  accepts?(row: { turn_id: string; input: any; permissions: any }): boolean }): { id: string; input: any } | null;
/** Merges a placed steer into the running turn; inside the transaction that journals it. */
export function mergeSteer(host: TurnHost, merge: { turnId: string; steerId: string; leaseId: string; now?: string }): void;
/** Releases the placing marks of one attempt, or of every lost attempt in a thread. */
export function releaseSteers(host: TurnHost, scope: { leaseId: string } | { threadId: string }): void;
/** A JSON flag SQLite reads as 0: absent, null, false or 0. */
export function unset(value: unknown): boolean;

// ---------------------------------------------------------------- the server-side PDF read

export const PDF_READ_LIMITS: Readonly<{ maxBytes: number; fetchTimeoutMs: number; maxRedirects: number }>;
/** Codes: PDF_URL_INVALID, PDF_FETCH_FAILED, PDF_TOO_LARGE, PDF_INVALID (stage fetch); PDF_CONVERTER_MISSING, PDF_CONVERSION_FAILED, PDF_NO_TEXT (stage convert). */
export class PdfReadError extends Error { constructor(code: string, stage: "fetch" | "convert", message: string); code: string; stage: "fetch" | "convert"; }
export interface MarkdownConversion { format: string; data?: string; error?: string }
/** Workers AI `toMarkdown` (the AI binding's). */
export type ToMarkdown = (files: { name: string; blob: Blob }[]) => Promise<MarkdownConversion | MarkdownConversion[]>;
/** Earlier conversions by fetched URL (without its fragment); only a successful conversion is stored. */
export interface PdfCache { get(url: string): Promise<string | null>; put(url: string, markdown: string): Promise<void>; }
/** `pages`: the PDF's page count, null when the conversion has no page boundaries; `firstPage`: the first page in `text`. */
export interface PdfRead { title: string | null; pages: number | null; from: number; firstPage: number | null; text: string; }
export function pdfStartPage(url: string): number;
export function pdfPages(markdown: string, from?: number, maxChars?: number): PdfRead;
export function publicPdfUrl(url: string, options?: { allowLoopback?: boolean }): string;
export function readPdf(url: string, options: { fetch(url: string, init: RequestInit): Promise<Response>; toMarkdown: ToMarkdown | null;
  cache?: PdfCache; validateUrl?(url: string): string; limits?: { maxBytes: number; fetchTimeoutMs: number; maxRedirects: number };
  maxChars?: number }): Promise<PdfRead>;

// ---------------------------------------------------------------- sandboxed code execution

/** The Worker Loader binding (`env.<binding>`), or a test stand-in with the same `load`. */
export interface CodeLoader {
  load(code: { compatibilityDate: string; mainModule: string; modules: Record<string, { js: string }>; env: Record<string, unknown>;
    globalOutbound: null; limits: { cpuMs: number } }): { getEntrypoint(): { run(options: Record<string, number>): Promise<unknown> } };
}
/** Nested tools the code may call as `await tools.<name>(input)`, through the product's binding. */
export interface CodeExecTools {
  /** An RPC binding with `call(name, input)`; it checks the names again itself. */
  binding: unknown;
  /** Its name in the isolate's env. */
  bindingName: string;
  names: readonly string[];
  /** Nested calls per run; CODE_EXEC_LIMITS.nestedCalls when unset. */
  maxCalls?: number;
}
export interface CodeExecRequest {
  loader: CodeLoader | null | undefined;
  /** The body of an async function: `return` gives the value, `console.log` a log line. */
  code: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** None by default: the code then reaches nothing outside its isolate. */
  tools?: CodeExecTools;
  compatibilityDate?: string;
}
/**
 * `value` is the returned value as text (a string as is, else JSON); `truncated` when it was cut to
 * the output cap. Log lines past the cap end with "…", and dropped lines are counted in a last
 * "[N more log lines dropped]" line. Error codes: EXEC_TIMEOUT, EXEC_CPU_LIMIT, CODE_ERROR (a throw, or a module
 * that did not compile). Invalid input throws instead, with `code`: CODE_MODE_UNAVAILABLE,
 * CODE_REQUIRED, CODE_TOO_LARGE.
 */
export type CodeExecResult =
  | { ok: true; value: string; logs: string[]; truncated: boolean; calls: number }
  | { ok: false; error: { code: "EXEC_TIMEOUT" | "EXEC_CPU_LIMIT" | "CODE_ERROR"; message: string; name?: string }; logs: string[]; truncated: boolean; calls: number };
export const CODE_EXEC_LIMITS: Readonly<{ maxCodeChars: number; timeoutMs: number; minTimeoutMs: number; maxTimeoutMs: number;
  outputChars: number; minOutputChars: number; maxOutputChars: number; logLines: number; logLineChars: number; errorChars: number; nestedCalls: number; cpuMs: number }>;
export const CODE_EXEC_COMPATIBILITY_DATE: string;
export function runSandboxedCode(request: CodeExecRequest): Promise<CodeExecResult>;
export function sandboxModuleSource(code: string, tools?: CodeExecTools): string;
