// Types of the browser layer (src/browser/index.js). Plain declarations: no build step.
/// <reference types="chrome" />

export class BrowserCoreError extends Error {
  constructor(code: string, message: string);
  code: string;
}

/** The parts of the extension API the browser layer uses; tests pass fakes. */
export type ChromeApi = Pick<typeof chrome, "debugger" | "tabs"> & Partial<Pick<typeof chrome, "windows" | "storage" | "tabGroups">>;

export interface CdpConfig {
  /** Only these methods may be sent; null or absent allows all. */
  allowedMethods?: ReadonlySet<string> | null;
  commandTimeoutMs?: number;
  idleDetachMs?: number;
  /** How long to wait for nested iframe sessions to finish attaching. */
  childSetupMs?: number;
}

/** A CDP command on the tab's root session or on a child (cross-process iframe) session. */
export interface Send {
  <T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** The tab's cross-process iframe sessions, nested ones included; turns auto-attach on for the attachment's lifetime. */
  iframeSessions(): Promise<string[]>;
}

export function withTab<T>(api: ChromeApi, tabId: number, work: (send: Send) => Promise<T>, options?: CdpConfig): Promise<T>;

/** One document of the tab. `sessionId` is set when the frame lives in another process. */
export interface FrameDoc {
  frameId: string; loaderId: string; url: string; mimeType?: string; parentId?: string; sessionId?: string;
  /** The root frame of its CDP target: the page's main frame, or a cross-process iframe's own root. */
  targetRoot?: boolean;
}
export interface FrameTree { frame: { id: string; url: string; loaderId: string; mimeType?: string; parentId?: string; name?: string }; childFrames?: FrameTree[]; }

export const MAX_FRAMES: number;
export function frameDocuments(send: Send): Promise<FrameDoc[]>;
export function childFrameId(send: Send, backendNodeId: number, sessionId?: string): Promise<string | null>;
export function frameDocumentObject(send: Send, frame: FrameDoc, options?: { worldName?: string; objectGroup?: string }): Promise<string | null>;
export function evaluateInFrame<T>(send: Send, frame: FrameDoc, isMain: boolean, expression: string, worldName?: string): Promise<T | null>;

export interface Clickable {
  backendNodeId: number;
  /** textContent, trimmed, 100 characters (agent-browser's cursor script). */
  text: string;
  /** Rendered text, whitespace collapsed, 100 characters. */
  label: string;
  tagName: string; hasOnClick: boolean; hasCursorPointer: boolean; hasTabIndex: boolean; isEditable: boolean;
  hiddenInputType: string | null; hiddenInputChecked: string | null;
}
export const MAX_CLICKABLES: number;
export interface ClickableDiscovery {
  clickables: Clickable[];
  /** Set when discovery failed part-way (a page-script exception, a failed CDP call): cursor-only controls may be missing. */
  discoveryError: "CLICKABLE_DISCOVERY_FAILED" | null;
}
/** `max`: absent, non-finite or non-positive is MAX_CLICKABLES. `worldName`: run in that isolated world instead of the page world. */
export function findClickables(send: Send, frame: FrameDoc, options?: { max?: number; worldName?: string }): Promise<ClickableDiscovery>;

export interface HitResult {
  hit: boolean;
  covering?: { tag: string; role: string | null; name: string } | null;
  popup?: { role: string; name: string };
  /** The miss may be what scrolling did to the page (see settledHitTest). */
  retry?: boolean;
}
export function boxCenter(model: { content?: number[]; border?: number[] } | undefined, content?: boolean): { x: number; y: number };
export function nodeClickPoint(send: Send, backendNodeId: number, sessionId?: string, options?: { content?: boolean }): Promise<{ x: number; y: number }>;
export function hitTest(send: Send, backendNodeId: number, point: { x: number; y: number },
  options?: { sessionId?: string; crossOrigin?: boolean; content?: boolean; local?: boolean }): Promise<HitResult>;
export function settledHitTest(send: Send, backendNodeId: number, point: { x: number; y: number },
  options?: { sessionId?: string; crossOrigin?: boolean; content?: boolean; local?: boolean; timeoutMs?: number;
    measure?: () => Promise<{ x: number; y: number }>; sleep?: (ms: number) => Promise<void> }): Promise<HitResult & { point: { x: number; y: number } }>;
export function obscuredMessage(result: HitResult): string;

export function scrollPage(send: Send, options: { dy: number; dx?: number; screen?: number; wheel?: boolean; sleep?: (ms: number) => Promise<void> }):
  Promise<{ method: "script" | "wheel"; scrollX: number; scrollY: number; deltaY: number; scrollHeight: number; viewportHeight: number; scroller?: string }>;

export function selectOptions(send: Send, backendNodeId: number, values: string[], sessionId?: string): Promise<{ matched: number; chosen: string[] }>;

export interface AgentWindowConfig {
  /** storage.session key remembering the agent window id. */
  storageKey: string;
  /** Tab group the agent's tabs join (needs the tabGroups permission); absent: no grouping. */
  groupTitle?: string;
  legacyGroupTitles?: string[];
  groupColor?: chrome.tabGroups.ColorEnum;
}
export function rememberedAgentWindowId(api: ChromeApi, config: AgentWindowConfig): Promise<number | null>;
export function agentWindowId(api: ChromeApi, config: AgentWindowConfig): Promise<number | null>;
export function createAgentTab(api: ChromeApi, tab: { url: string; active?: boolean; windowId?: number }, config: AgentWindowConfig): Promise<chrome.tabs.Tab>;
export function prepareInput(api: ChromeApi, tab: chrome.tabs.Tab, send: Send, sleep: (ms: number) => Promise<void>,
  options?: { emulateFocus?: boolean; settleMs?: number; probeMs?: number }): Promise<{ visibility: "visible" | "hidden" | null; focusEmulation: boolean }>;
export function watchOpenedTabs(api: ChromeApi, sleep: (ms: number) => Promise<void>): { stop(): Promise<chrome.tabs.Tab[]> };
export function describeOpenedTabs(tabs: chrome.tabs.Tab[]): string;

export function isPdfViewer(send: Send): Promise<boolean>;
export function sameDocument(actual: string, requested: string): boolean;
export function pdfViewerInputMessage(readAction: string): string;

export const HIT_TEST: string;
export const SELECT_OPTIONS: string;
export const DISCOVER_CLICKABLES: string;
export const DESCRIBE_CLICKABLES: string;
export function hitsComposedTarget(el: unknown, x: number, y: number): boolean;
export function observeScroll(this: unknown, dx: number, dy: number, screen?: number): Promise<{ target: string; scrollX: number; scrollY: number; deltaX: number; deltaY: number; settled: boolean;
  scrollHeight: number; viewportHeight: number; scroller?: string }>;

// ---------------------------------------------------------------- the code sandbox

/** A run as the sandbox takes it, after codeRunRequest validated and clamped it. */
export interface CodeRunRequest {
  language: "js" | "bash";
  /** js: the body of an async function (`return` the answer, `console.log` for notes); bash: a script. */
  code: string;
  /** Files the run starts with, path to text: the shell's files (relative paths under /home/user), `files` in js. */
  files: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
}
/** What a product asks for: a request before validation; limits default to CODE_RUN_LIMITS. */
export interface CodeRunInput { language?: "js" | "bash"; code: string; files?: Record<string, string>; timeoutMs?: number; maxOutputChars?: number }
/**
 * One run's outcome. js: `value` (the returned value as text) and `logs` (console lines); bash:
 * `stdout`, `stderr` and `exitCode` (ok when 0, else EXIT_STATUS). A run that did not finish:
 * `error.code` EXEC_TIMEOUT, CODE_ERROR (a throw, a syntax error), SANDBOX_FAILED,
 * SANDBOX_UNAVAILABLE or CODE_LANGUAGE_UNAVAILABLE. `truncated`: an output was cut at its cap.
 */
export interface CodeRunResult {
  ok: boolean;
  value?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: { code: string; message: string; name?: string };
  logs: string[];
  truncated: boolean;
}
export const CODE_RUN_LIMITS: Readonly<{
  maxCodeChars: number; maxFiles: number; maxFilesChars: number; maxPathChars: number;
  timeoutMs: number; minTimeoutMs: number; maxTimeoutMs: number;
  outputChars: number; minOutputChars: number; maxOutputChars: number;
  logLines: number; logLineChars: number; errorChars: number; stderrChars: number;
  shellFileSystemBytes: number; shellOutputBytes: number;
}>;
export const CODE_LANGUAGES: readonly ["js", "bash"];
/** The sandboxed page's file name, for the manifest's `sandbox.pages`. */
export const CODE_SANDBOX_PAGE: string;
/** The manifest's `content_security_policy.sandbox`. */
export const CODE_SANDBOX_CSP: string;
/** Throws an error with `code` CODE_REQUIRED, CODE_TOO_LARGE, CODE_LANGUAGE_INVALID or CODE_FILES_INVALID. */
export function codeRunRequest(input: unknown): CodeRunRequest;
export function codeRunFailure(code: string, message: string, logs?: string[]): CodeRunResult;

/** The extension page's handle: `run` throws only for an invalid request (codeRunRequest's codes). */
export interface CodeSandbox {
  run(input: CodeRunInput): Promise<CodeRunResult>;
  /** Removes the sandboxed page; the next run embeds a new one. */
  dispose(): void;
}
/** `shellSource`: the Worker script for bash runs, loaded on the first bash run (a JavaScript run never loads it). */
export function createCodeSandbox(options: { document: Document; url: string; shellSource?: () => Promise<string>; graceMs?: number; readyMs?: number }): CodeSandbox;

/** Throws an error with `code` SANDBOX_SOURCE_UNAVAILABLE or SANDBOX_SOURCE_MISMATCH. */
export function loadPinnedSource(options: { sha256: string; url: string; fetch: typeof fetch; caches?: CacheStorage | null }): Promise<string>;

/** The Worker as the sandboxed page drives it. */
export interface CodeWorker {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error", listener: (event: any) => void): void;
  terminate(): void;
}
export function serveCodeSandboxPage(page: Window, options: { workerSource: string; spawn?: (source: string) => CodeWorker }): void;
export function runInWorker(input: unknown, workerSource: string, spawn: (source: string) => CodeWorker): Promise<CodeRunResult>;

/** A just-bash-compatible shell class (`Bash` from "just-bash/browser"). */
export type ShellConstructor = new (options: {
  files: Record<string, string>; cwd: string; executionLimitProfile: "hardened";
  executionLimits: { maxExecutionTimeMs: number; maxFileSystemBytes: number; maxOutputSize: number };
}) => { exec(script: string, options: { rawScript: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number }> };
export interface CodeMessagePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: any }) => void): void;
  start?(): void;
}
export const CODE_WORKER_BLOCKED_GLOBALS: readonly string[];
/** In the Worker: serves one run; without `Bash`, a bash run is CODE_LANGUAGE_UNAVAILABLE. */
export function serveCodeRun(scope: typeof globalThis, options?: { Bash?: ShellConstructor; port?: CodeMessagePort }): void;
