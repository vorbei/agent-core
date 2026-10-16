// Types of the Routine layer (src/routine/index.js). Plain declarations: no build step.

/** A Durable Object's storage, or anything with the same shape (node:sqlite in tests). */
export interface SqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
  transactionSync<T>(closure: () => T): T;
}

// ---------------------------------------------------------------- schedule

export interface RoutineSchedule {
  /** 0 is Sunday. */
  days: number[];
  /** HH:MM in `timezone`. */
  localTime: string;
  timezone: string;
  enabled: boolean;
  /** The next slot; the scheduler's own bookkeeping. */
  nextAt: string | null;
  /** The alarm rings up to this many minutes before or after the slot. */
  jitterMinutes?: number;
}
export interface Permissions { update: boolean; write: boolean; }

export const ROUTINE_JITTER_MAX_MINUTES: number;
/** Throws ROUTINE_SCHEDULE_INVALID. */
export function validateRoutineSchedule(value: unknown): RoutineSchedule;
/** Throws ROUTINE_PROMPT_INVALID. */
export function validateRoutinePrompt(value: unknown): string;
/** Throws AGENT_THREAD_PERMISSIONS_INVALID. */
export function validatePermissions(value: unknown): Permissions;
export function manualRunPermissions(routinePermissions: Permissions, requested?: Permissions): Permissions;
export function nextRoutineTime(now: string, schedule: Pick<RoutineSchedule, "days" | "localTime" | "timezone">, timezone?: string): string;
export function routineFireAt(nextAt: string, schedule: Pick<RoutineSchedule, "jitterMinutes">, now: string, random?: () => number): number;
export function matchesScheduledSlot(schedule: RoutineSchedule, scheduledFor: unknown): boolean;
export function scheduleToCron(schedule?: Partial<Pick<RoutineSchedule, "days" | "localTime">>): string;
export function parseCronSchedule(value: unknown): { days: number[]; localTime: string } | null;

// ---------------------------------------------------------------- alarm jobs

export const ALARM_JOBS_SCHEMA: readonly string[];
export interface AlarmJob { id: string; callback: string; payload: any; /** Seconds. */ time: number; }
/** The object whose one alarm runs the jobs. */
export interface AlarmHost {
  storage: SqlStorage & { setAlarm(at: number): Promise<void> | void; deleteAlarm(): Promise<void> | void };
  /** The callback names a job may carry. */
  callbacks: readonly string[];
  invoke(callback: string, payload: any): Promise<unknown>;
  /** Called when a running turn's lease has expired. */
  recover(): Promise<unknown>;
  log(event: string, detail: Record<string, unknown>): void;
  /** Another time the alarm must ring by (ms), if any. */
  nextDeadline?(): number | undefined;
  /** The alarm write in flight (kept by the layer). */
  pending?: Promise<void>;
}
export function alarmJobs(host: AlarmHost): AlarmJob[];
export function addAlarmJob(host: AlarmHost, when: Date, callback: string, payload?: unknown, options?: { retry?: { maxAttempts?: number } }, intervalMs?: number): Promise<AlarmJob>;
export function cancelAlarmJob(host: AlarmHost, id: string): Promise<void>;
export function armNextAlarm(host: AlarmHost): Promise<void>;
export function runAlarm(host: AlarmHost): Promise<void>;
export function listAlarmJobs(storage: SqlStorage): any[];
export function nextAlarmTime(storage: SqlStorage): number | undefined;
export function putAlarmJob(storage: SqlStorage, job: { id: string; callback: string; payload: unknown; dueAt: number; intervalMs: number; maxAttempts: number }): any;
export function claimAlarmJob(storage: SqlStorage, now: number, lease: string): any;
export function settleAlarmJob(storage: SqlStorage, job: any, succeeded: boolean, now: number): void;

// ---------------------------------------------------------------- threads

/** A row of `agent_threads`, read with its newest turn (`latest_turn_*`). */
export interface ThreadRow {
  thread_id: string; account_id: string; kind: string; title: string | null; instruction: string; status: "active" | "archived";
  permissions_json: string; crystallize: number; schedule_json: string | null; routine_prompt: string | null;
  parent_thread_id: string | null; trigger: string | null; model: string | null;
  created_at: string; updated_at: string; archived_at: string | null;
  latest_turn_status?: string | null; latest_turn_updated_at?: string | null; latest_turn_answer?: string | null; latest_turn_delivery?: string | null;
  [column: string]: unknown;
}
export const THREADS_SCHEMA: readonly string[];
/** [column, ADD COLUMN definition] beyond a minimal thread row. */
export const THREAD_COLUMNS: readonly (readonly [string, string])[];
export function threadRow(storage: SqlStorage, threadId: string): ThreadRow | null;
export function threadRows(storage: SqlStorage, options: { routines?: "all" | "only" | "none"; limit: number }): ThreadRow[];
export function runRows(storage: SqlStorage, options: { parentThreadId: string; limit: number }): ThreadRow[];
export function scheduledRoutineRows(storage: SqlStorage): ThreadRow[];
export function insertRoutine(storage: SqlStorage, input: { threadId: string; accountId: string; title: string; routinePrompt: string;
  permissions: Permissions; schedule: Omit<RoutineSchedule, "enabled" | "nextAt">; enabled: boolean; now: string }): ThreadRow;
export function updateRoutineRow(storage: SqlStorage, input: { threadId: string; title?: string; routinePrompt?: string; permissions?: Permissions;
  schedule?: Omit<RoutineSchedule, "enabled" | "nextAt">; enabled?: boolean; now: string }): ThreadRow;
export function recordNextAt(storage: SqlStorage, threadId: string, nextAt: string | null, now: string): void;
export function storedPermissions(row: ThreadRow): Permissions;
export interface LastRun { threadId: string; trigger: string; status: string | null; createdAt: string; }
export function lastRun(storage: SqlStorage, threadId: string): LastRun | null;
export function archiveRoutine(storage: SqlStorage, input: { accountId: string; threadId: string; now: string; busy(threadId: string): unknown }): ThreadRow;

// ---------------------------------------------------------------- the host

/** What a product gives the Routine engine. */
export interface RoutineHost<View = unknown, Prepared = { existingTurnId?: string | null }, Link = unknown> {
  storage: SqlStorage;
  /** The account this object holds, and whether it may run work. */
  account(): { accountId: string; active: boolean } | null;
  /** The alarm jobs (`addAlarmJob`, `alarmJobs`, `cancelAlarmJob` over the product's AlarmHost). */
  jobs: {
    schedule(when: Date, callback: string, payload: unknown, options?: { idempotent?: boolean; retry?: { maxAttempts?: number } }): Promise<AlarmJob>;
    list(): Promise<AlarmJob[]> | AlarmJob[];
    cancel(id: string): Promise<void>;
  };
  /** An audit record (`routine.created`, `.updated`, `.deleted`, `.fired`, `.skipped`, `.deferred`, `.paused_idle`). */
  ledger(type: string, payload: Record<string, unknown>, now: string): void;
  log(event: string, detail: Record<string, unknown>): void;
  /** Idempotency by `input.idempotencyKey`: run once, or replay and record separately. */
  idempotent: {
    run<T>(name: string, input: Record<string, unknown>, work: () => Promise<T>): Promise<T>;
    replay(name: string, input: Record<string, unknown>): Promise<any>;
    record<T>(name: string, input: Record<string, unknown>, result: T): Promise<T>;
  };
  /** A run's first turn and the Routine's busy check. */
  runs: {
    /** Before the transaction; throws IDEMPOTENCY_CONFLICT for a key with other input. */
    prepare(input: { threadId: string; input: string; idempotencyKey: string }): Promise<Prepared>;
    /** Inside the transaction, after the run thread exists. */
    queue(prepared: Prepared): Link;
    /** After the commit: start the turn. */
    finish(prepared: Prepared, link: Link): void;
    /** A run of this Routine with unfinished work, if any. */
    busy(routineThreadId: string): { thread_id: string } | null;
  };
  /** A thread row as the product's API returns it. */
  view(row: ThreadRow): View;
  /** A new Routine's permissions when the caller names none. */
  defaultPermissions: Permissions;
  /** When a browser last reached this account (an idle one stops firing after ROUTINE_IDLE_PAUSE_MS); absent: never idle. */
  lastSeen?(): string | null;
  /** Whether a browser is connected now (a skipped run's retry waits less). */
  browserLive?(now: string): boolean;
}

// ---------------------------------------------------------------- firing

export type FireOutcome<View = unknown> =
  | { allowed: true; created: boolean; thread: View }
  | { allowed: false; reason: string; runThreadId?: string };

export const ROUTINE_ALARM: "runRoutineAlarm";
export const ROUTINE_IDLE_PAUSE_MS: number;
export const SYNC_RETRY_BACKOFF_MS: number;
export function reconcileRoutineAlarm(host: RoutineHost, threadId: string, now?: string, after?: string | null): Promise<{ scheduleId: string; nextAt: string } | null>;
export function ensureRoutineAlarm(host: RoutineHost, threadId: string, now?: string, schedules?: AlarmJob[] | null): Promise<{ scheduleId: string; nextAt: string } | null>;
export function runRoutineAlarm(host: RoutineHost, payload: { threadId: string; scheduledFor?: string | null; trigger?: string; retryOf?: string; windowEndsAt?: string; deferred?: number }, now?: string): Promise<FireOutcome>;
export function retryRunAfterSyncExpiry(host: RoutineHost, runThreadId: string, now?: string): Promise<string | null>;
export function fireRoutineRetries(host: RoutineHost, now?: string): Promise<number>;
export function startRoutineRun(host: RoutineHost, input: { threadId: string; trigger: string; scheduledFor?: string | null; fireKey: string; permissions?: Permissions; now?: string }): Promise<FireOutcome>;
export function requestRoutineRun(host: RoutineHost, input: { threadId: string; idempotencyKey: string; permissions?: Permissions; now?: string }): Promise<FireOutcome>;

// ---------------------------------------------------------------- definitions

export const ROUTINE_LIST_PROJECTION_VERSION: "routine-list-projection-v1";
export const ROUTINE_PROJECTION_VERSION: "routine-projection-v1";
export interface RoutineList<View = unknown> { version: "routine-list-projection-v1"; items: { thread: View; lastRun: LastRun | null }[]; }
export interface RoutineDetail<View = unknown> { version: "routine-projection-v1"; thread: View; runs: View[]; }
export interface RoutineInput {
  title: string; routinePrompt: string; permissions?: Permissions;
  schedule: Omit<RoutineSchedule, "enabled" | "nextAt">; enabled: boolean; idempotencyKey: string; now?: string;
}
export function routineList(host: RoutineHost, options?: { limit?: number }): RoutineList;
export function routineDetail(host: RoutineHost, options: { threadId: string; limit?: number }): RoutineDetail;
export function addRoutine(host: RoutineHost, input: RoutineInput): Promise<RoutineDetail>;
export function editRoutine(host: RoutineHost, input: Partial<Omit<RoutineInput, "idempotencyKey">> & { threadId: string; idempotencyKey: string; now?: string }): Promise<RoutineDetail>;
export function deleteRoutine(host: RoutineHost, input: { threadId: string; now?: string }): Promise<unknown>;
