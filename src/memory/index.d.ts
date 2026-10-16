// Types of the memory layer (src/memory/index.js). Plain declarations: no build step.

// ---------------------------------------------------------------- page guides

/** A site's bundled page guides, as the consumer ships them. */
export interface GuideDomain {
  name?: string;
  /** Hosts the guides apply to; a subdomain of one matches too. */
  domains: string[];
  /** `apps`: an app guide, about the app in front on a page that shows a phone (bundle ids). */
  pages: { name: string; paths: string[]; content: string; verifiedOn?: string | null; apps?: string[] }[];
}

export interface PageGuide {
  /** `bundled:<page name>` for a bundled guide. */
  id: string;
  source: "bundled" | "learned";
  host: string;
  pathPrefix: string;
  content: string;
  since: string | null;
  /** An app guide's bundle id: the app in front it was chosen for. */
  app?: string;
}

export function pathCovers(prefix: string, pathname: string): boolean;
export function bundledPageGuide(domains: GuideDomain[], url: string): PageGuide | null;
export function bundledAppGuide(domains: GuideDomain[], url: string, app: string | null | undefined): PageGuide | null;

// ---------------------------------------------------------------- long-term memory

/** A Durable Object's storage, or anything with the same shape (node:sqlite in tests). */
export interface SqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
  transactionSync<T>(closure: () => T): T;
}

export interface MemoryRow {
  memory_id: string;
  kind: "fact" | "instruction" | "event";
  content: string;
  /** "agent" (saved by the model), "user_confirmed", legacy "user", or a consumer's own type. */
  source_type: string;
  source_id: string | null;
  evidence_json: string | null;
  confidence: number | null;
  status: "active" | "superseded" | "forgotten";
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  recorded_source_type?: string;
  replacement?: { requestedMemoryId: string; applied: boolean; targetScope?: { kind: string; sourceType: string; browser?: { website: string; flow: string } } | null };
}

export interface RememberInput {
  kind: "fact" | "instruction" | "event";
  content: string;
  sourceType: string;
  sourceId?: string;
  sourceIds?: string[];
  supersedes?: string;
  expiresAt?: string;
  confidence?: number;
  turnId?: string;
}

export const MEMORY_INSTRUCTION_MAX: number;
/** CREATE statements, one per entry. */
export const MEMORY_SCHEMA: readonly string[];
export class MemoryError extends Error { constructor(code: string, message: string); code: string; }
export function rememberPermission(input: { kind?: string; supersedes?: string; browser?: unknown }): "update" | null;
export function searchMemory(storage: SqlStorage, options?: { query?: string; limit?: number }, now?: string): MemoryRow[];
export function confirmedInstructions(storage: SqlStorage, now?: string): string[];
export function remember(storage: SqlStorage, input: RememberInput, now?: string): MemoryRow;
export function replacementReceipt(storage: SqlStorage, saved: MemoryRow, requestedMemoryId: string | undefined): MemoryRow;
/** A user_confirmed memory is forgotten only with `userInitiated` (the user's own delete); otherwise `{ forgotten: false, reason: "user_confirmed" }`. */
export function forgetMemory(storage: SqlStorage, memoryId: string, options?: { userInitiated?: boolean; now?: string }): { memoryId: string; forgotten: boolean; reason?: "user_confirmed" };
export function listInstructions(storage: SqlStorage): { memoryId: string; content: string; confirmed: boolean; createdAt: string; expiresAt: string | null }[];
export function confirmInstruction(storage: SqlStorage, memoryId: string, now?: string): { memoryId: string; confirmed: true };
export function editInstruction(storage: SqlStorage, memoryId: string, content: unknown, now?: string): { memoryId: string; content: string };

// ---------------------------------------------------------------- the model's memory tools

export type MemoryToolName = "search_memory" | "remember" | "forget_memory";
export const MEMORY_TOOL_NAMES: readonly MemoryToolName[];
/** "update" to change or forget a memory, else null (a search, a new instruction or browser lesson). Throws MEMORY_INVALID for another name. */
export function memoryToolPermission(name: string, input: unknown): "update" | null;
/** search_memory and remember always; forget_memory only with `update`. */
export function offeredMemoryTools(permission: { update?: boolean } | null | undefined): MemoryToolName[];
/** What `runMemoryTool` calls; a product may route a kind of memory (Gardener: browser experience) elsewhere. */
export interface MemoryToolStore {
  search(input: { query?: string; limit?: number; [key: string]: unknown }): unknown;
  remember(input: RememberInput & Record<string, unknown>): unknown;
  forget(memoryId: string): unknown;
}
export function memoryStore(storage: SqlStorage): MemoryToolStore;
/** The model's call: `remember` is always `sourceType: "agent"` (with the turn), `forget_memory` never user-initiated. */
export function runMemoryTool(store: MemoryToolStore, name: string, input: any, options?: { turnId?: string }): any;

// ---------------------------------------------------------------- context compaction

export interface CompactionSettings {
  contextWindow: number; reserveTokens: number; keepRecentTokens: number; compactAtTokens: number; backgroundTokens: number;
  minGrowthTokens: number; summaryTimeoutMs: number; mode?: string; triggerTokens: number; backgroundCompactAtTokens: number;
}
export const CONTEXT_COMPACTION_SETTINGS: Readonly<Omit<CompactionSettings, "mode" | "triggerTokens" | "backgroundCompactAtTokens">>;
export function contextCompactionSettings(model: { contextWindow?: number; maxTokens?: number } | undefined, overrides?: Record<string, unknown>): CompactionSettings;
export function piCompactionSettings(settings: CompactionSettings): { enabled: true; reserveTokens: number; keepRecentTokens: number };
export function estimateContextTokens(messages: unknown[]): number;
export function serializeContextForSummary(messages: unknown[]): string;
