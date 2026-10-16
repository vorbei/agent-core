// Types of the Routine view (src/ui/routines.js, exported as agent-core/ui/routines). Plain declarations.

export interface RoutineThreadView {
  threadId: string;
  title?: string | null;
  routinePrompt?: string;
  permissions: { update: boolean; write: boolean };
  schedule?: { days: number[]; localTime: string; timezone: string; enabled: boolean; nextAt: string | null; jitterMinutes?: number };
  parentThreadId?: string;
  trigger?: string;
  createdAt: string;
  latestTurnStatus?: string | null;
  latestTurnDelivery?: string | null;
  latestTurnSummary?: string | null;
}
export interface RoutineListItem { thread: RoutineThreadView; lastRun: { threadId: string; trigger: string; status: string | null; createdAt: string } | null; }
export interface RoutineDetail { thread: RoutineThreadView; runs: RoutineThreadView[]; }
export interface RoutineSave {
  threadId?: string; title: string; routinePrompt: string; enabled: boolean; permissions: { update: boolean; write: boolean };
  schedule: { days: number[]; localTime: string; timezone: string; jitterMinutes?: number }; idempotencyKey: string;
}

/** The product's transport. Each call rejects with an Error whose message the view shows (empty: a default). */
export interface RoutineClient {
  list(accountId: string): Promise<{ items: RoutineListItem[] }>;
  get(accountId: string, threadId: string): Promise<RoutineDetail>;
  /** Creates (no `threadId`) or updates a Routine; answers its detail. */
  save(accountId: string, input: RoutineSave): Promise<RoutineDetail>;
  remove(accountId: string, threadId: string): Promise<unknown>;
  /** Deletes one run's thread. */
  removeRun(accountId: string, threadId: string): Promise<unknown>;
  /** Starts one run now; `permissions` can only narrow the Routine's own. */
  run(accountId: string, input: { threadId: string; permissions: { update: boolean; write: boolean }; idempotencyKey: string }):
    Promise<{ allowed: true; created: boolean; thread: RoutineThreadView } | { allowed: false; reason: string }>;
  /** Calls `onChange` once now and again whenever the account's Routines may have changed; returns the unsubscribe. */
  subscribe(accountId: string, onChange: () => void): () => void;
}

/** The product's parts of the view. */
export interface RoutineSlots {
  /** A Routine's name in the list and the editor. */
  title(thread: RoutineThreadView): string;
  /** The permission switches, in order; names are `write` and `update`. */
  permissions: { name: "write" | "update"; label: string; hint: string }[];
  /** A new Routine's permissions. */
  defaultPermissions: { update: boolean; write: boolean };
  /** Under a run's switches: what this run may do. */
  runNote(input: { write: boolean; update: boolean; account: unknown }): string;
  /** The button that starts the run. */
  runLabel(input: { write: boolean; update: boolean; account: unknown }): string;
  /** A finished run's line in the history (empty: its state). */
  runLine(run: RoutineThreadView): string;
  instructionsHint: string;
  emptyList: string;
  /** After "Delete “name”?". */
  deleteNote: string;
  /** Controls beside "+" in the head: markup on every paint, `bind` once with the view's element. */
  headerActions: { markup(): string; bind?(element: HTMLElement): void } | null;
}

export interface RoutineView {
  setAccount(account: { accountId: string } | null): void;
  show(): void;
  hide(): void;
  refresh(options?: { quiet?: boolean; passive?: boolean }): Promise<unknown>;
  /** Closes the innermost open part; true when it handled the key. */
  handleEscape(): boolean;
  /** Opens one Routine's editor. */
  open(target: { threadId: string }): Promise<void>;
}

export function createRoutineView(options: { element: HTMLElement; client: RoutineClient; onClose(): void;
  onOpenThread(target: { threadId: string }): void; slots?: Partial<RoutineSlots> }): RoutineView;
export function routineRowSummary(item: RoutineListItem): string;
export function scheduleWords(schedule?: { days?: number[]; localTime?: string }): string;
export function timeWords(localTime?: string): string;
export function formatDateTime(value: string | number): string;
export function agoWords(value: string): string;
export function routineStatus(item: RoutineListItem): "scheduled" | "paused" | "running";
export function runStateWords(run: { latestTurnStatus?: string | null; latestTurnDelivery?: string | null }): string;
export function runStateKind(run: { latestTurnStatus?: string | null; latestTurnDelivery?: string | null }): string;
