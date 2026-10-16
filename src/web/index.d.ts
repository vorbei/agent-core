// Types of the web layer (src/web/index.js). Plain declarations: no build step.

export const WEB_EVIDENCE_VERSION: "web-evidence-v1";
export const WEB_FETCH_DEFAULT_MAX_BYTES: number;
export const WEB_FETCH_MAX_BYTES: number;

/** A refused or failed read; `code` is one of the WEB_FETCH_* codes. */
export class WebFetchError extends Error {
  constructor(code: string, message: string, detail?: Record<string, unknown>);
  code: string;
  detail: Record<string, unknown>;
}

export interface WebEvidence {
  version: "web-evidence-v1";
  evidenceId: string;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string | null;
  text: string;
  publishedAt: string | null;
  contentKind: "article" | "page_text" | "image";
  fetchedAt: string;
  truncated: boolean;
  contentHash: string;
  trust: "untrusted";
  extractor: string;
  /** Only for an image read with a product `imagePreview`. */
  image?: { mimeType: string; data: string };
}

export function fetchWebEvidence(input: { url: string; maxBytes?: number }, options?: {
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  imagePreview?: ((bytes: Uint8Array) => Promise<{ mimeType: string; data: string } | null>) | null;
  now?: () => string;
  timeoutMs?: number;
}): Promise<WebEvidence>;

export function validatePublicUrl(rawUrl: unknown): URL;
export function resolveSafeUrl(rawUrl: unknown, resolveHostname?: (hostname: string) => Promise<string[]>): Promise<URL>;
export function readBoundedBytes(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }>;
export function readBoundedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }>;
export function extractReadableContent(input: string, contentType: string): { title: string | null; text: string; publishedAt?: string | null; contentKind: "article" | "page_text" };

export const SEARCH_EVIDENCE_VERSION: "search-evidence-v1";
export const OPENROUTER_SEARCH_MODEL: string;

export interface WebSearchInput { query: string; max_results: number; include_domains?: string[] }
export interface SearchItem { title: string; url: string; snippet: string; score?: number; publishedDate?: string }
export interface SearchUsage {
  provider: "openrouter"; requestId: string; generationId: string | null;
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null;
  costUsd: number | null; searchRequests: number | null;
}
export interface SearchAttempt { provider: string; status: "skipped" | "empty" | "error"; reason?: string; message?: string }
export interface SearchEvidence {
  version: "search-evidence-v1"; provider: string; query: string; items: SearchItem[]; attempts: SearchAttempt[];
  fetchedAt: string; providerUsage: SearchUsage[]; trust: "untrusted"; contentKind: "search_snippets";
}

/** The search input with its default, or a thrown WEB_SEARCH_INPUT_INVALID. */
export function webSearchInput(input: unknown): WebSearchInput;

/**
 * Searches with the providers whose keys are given (OpenRouter, Tavily, Brave, in that order).
 * Throws an Error with `code` SEARCH_PROVIDER_UNCONFIGURED or SEARCH_PROVIDERS_FAILED, carrying
 * `attempts` and `providerUsage` (a failed billed search's cost included).
 */
export function searchWeb(input: unknown, keys: { OPENROUTER_API_KEY?: string; TAVILY_API_KEY?: string; BRAVE_API_KEY?: string }, options?: {
  fetchImpl?: typeof fetch;
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
  timeoutMs?: number;
}): Promise<SearchEvidence>;

export function openRouterSearchRequest(query: string, maxResults: number, domains?: string[]): Record<string, unknown>;
export function parseOpenRouterSearch(body: unknown): { results: SearchItem[]; usage: Omit<SearchUsage, "requestId"> };
