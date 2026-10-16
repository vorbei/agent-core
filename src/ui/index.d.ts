// The shared chat UI's public surface (src/ui/index.jsx). React 19 and marked are peer dependencies;
// the consumer's bundler compiles the JSX (Vite in X Gardener, esbuild in pi-do).
import type { ComponentType, Context, ReactNode } from "react";
import type { TurnProjection } from "../runtime/index.js";

/** What the thread list and the chat read of a thread. */
export interface ThreadSummary {
  threadId: string;
  title: string | null;
  createdAt: string;
  updatedAt?: string;
  latestTurnStatus?: string | null;
  latestTurnUpdatedAt?: string | null;
  /** Opaque to the core; passed back to createThread when a deleted thread is replaced. */
  permissions?: unknown;
  [productField: string]: unknown;
}

/**
 * An image of a user message. `src` is what the chat shows (an object or data URL); a turn the
 * product lists may name an image it has not loaded (no `src`), which the chat shows by its label.
 */
export interface ChatImage { mimeType: string; src?: string; }

/** An image the composer attached, as it is sent: its type and base64 bytes. */
export interface ChatImageInput { mimeType: string; data: string; }

/** A turn as the chat shows it: the core projection, plus the answer so far while it runs and the user's images. */
export type ChatTurn = TurnProjection & { partialText?: string | null; internal?: boolean; images?: ChatImage[] };

/**
 * The product's transport. Every method rejects with an Error whose message is the product's
 * error (code or text); the chat words it through ChatWording.
 */
export interface ChatClient {
  listThreads(options: { limit: number }): Promise<ThreadSummary[]>;
  createThread(input: { idempotencyKey: string; permissions?: unknown }): Promise<ThreadSummary>;
  /** Without it the thread list offers no delete. */
  deleteThread?(threadId: string): Promise<unknown>;
  /** One page, oldest first; `nextBefore` is the `before` of the page above it. */
  listTurns(threadId: string, options: { limit: number; before?: string }): Promise<{ items: ChatTurn[]; nextBefore: string | null }>;
  /**
   * A message sent while the thread's turn runs steers it (`whileRunning: "steer"`). `images` is
   * present only when the product accepts images (`ChatSlots.images`); `text` may then be empty.
   */
  submitTurn(input: { threadId: string; text: string; whileRunning: "steer"; idempotencyKey: string; images?: ChatImageInput[] }): Promise<ChatTurn>;
  stopTurn(turnId: string): Promise<ChatTurn>;
  retryTurn(turnId: string, idempotencyKey: string): Promise<ChatTurn>;
  /** Calls `refresh` now and whenever the account's chats may have changed; returns the unsubscribe. */
  subscribe(refresh: () => Promise<void>): () => void;
  loadSelectedThread?(): Promise<string | null>;
  saveSelectedThread?(threadId: string | null): Promise<unknown>;
}

/** What a slot may read and do. Slots return elements; they do not call hooks themselves. */
export interface ChatContext {
  account: { accountId: string; [field: string]: unknown };
  thread: ThreadSummary | undefined;
  threads: ThreadSummary[];
  threadId: string;
  turns: ChatTurn[];
  busy: boolean;
  readOnly: boolean;
  /** Puts text in the message box and focuses it. */
  compose(text: string): void;
  openThread(threadId: string): void;
  /** Replaces a thread in the list (after the product changed it, e.g. its permissions). */
  updateThread(thread: ThreadSummary): void;
  /** Shows a turn the product started itself. */
  addTurn(turn: ChatTurn): void;
}

export interface ThreadView {
  /** No composer, no edit, retry or carry-on. */
  readOnly?: boolean;
  /** Above the messages. */
  banner?: ReactNode;
  /** After the turns. */
  notice?: ReactNode;
  /** A label for a Stop button under the turns (besides the composer's). */
  stop?: string;
}

export interface ChatSlots {
  /** Which threads the thread list shows and the chat may reopen; all when absent. */
  listed?(thread: ThreadSummary): boolean;
  /** A listed thread's row: a title in place of the thread's own and a mark beside it. */
  threadLabel?(context: { thread: ThreadSummary; threads: ThreadSummary[] }): { title?: string; mark?: ReactNode } | null;
  /** The heading a listed thread is shown under; Chats when absent or null. Chats come first. */
  threadGroup?(context: { thread: ThreadSummary; threads: ThreadSummary[] }): string | null;
  threadView?(context: { thread: ThreadSummary; threads: ThreadSummary[]; turns: ChatTurn[] }): ThreadView | null;
  /** An empty thread's welcome; a one-line prompt when absent. */
  welcome?(context: ChatContext): ReactNode;
  /** Above the edit notice and the composer (pending approvals, confirmations). */
  tray?(context: ChatContext): ReactNode;
  /** Just above the composer (recording status, the tab the message is about). */
  controls?(context: ChatContext): ReactNode;
  /** The composer's settings popover; no popover when absent. */
  settings?(context: ChatContext): ReactNode;
  /** A user message the product shows its own way; the default rendering when it returns nothing. */
  userInput?(turn: ChatTurn): ReactNode;
  /**
   * Images pasted into the message box or dropped on it are attached to the message (none when
   * absent): at most `max`, each at most `maxEdge` px on its long edge and `maxBase64` characters
   * once encoded (IMAGE_LIMITS by default); `prepare` replaces the browser's encoding (tests).
   */
  images?: { max?: number; maxEdge?: number; maxBase64?: number; prepare?(file: File): Promise<ChatImageInput & { src: string }> };
  /** Images load only when `imageSrc` returns a URL; relative links resolve against `linkBase`. */
  markdown?: { imageSrc?(href: string): string | null; linkBase?: string };
  wording?: Partial<ChatWording>;
}

export interface ChatWording {
  assistant: string; you: string; placeholder: string; working: string; connecting: string; welcome: string;
  connectFailedTitle: string; connectFailed: string; noChat: string; newChat: string; chats: string;
  /** A thread's latest turn state by status (queued, running, waiting_for_browser, waiting_for_approval, completed, failed, cancelled). */
  threadStatus: Record<string, string>;
  chatTitle(date: string): string; deleteChat: string; deleteChatNamed(title: string): string; deleteBusy: string;
  deleteConfirm(title: string): string; deleteFailed(message: string): string; loadFailed(message: string): string;
  createFailed: string; syncFailed: string; sendFailed(message: string): string;
  loadEarlier: string; loadingEarlier: string; loadEarlierFailed(message: string): string;
  edit: string; editNotice: string; cancelEdit: string; steered: string;
  progressWorking: string; progressWaiting: string; progressDone: string; steps(count: number): string;
  waitingForYou: string; carryOn: string; carryOnText: string; cancelTask: string;
  retry: string; retryFailed(message: string): string;
  stop: string; stopping: string; stopTitle: string; stopFailed(message: string): string;
  send: string; settings: string;
  attachedImages: string; imageAlt(number: number): string; removeImage(number: number): string; openImage: string;
  imageLimit(max: number): string; imageType: string; imageFailed: string; dismiss: string;
  failure(turn: ChatTurn): string;
}

export interface ChatHandle {
  /** The chat follows this account (null hides it); the same account again changes nothing. */
  setAccount(account: { accountId: string; [field: string]: unknown } | null): void;
  /** Renders again, for slots whose product state changed. */
  render(): void;
  focus(): void;
  compose(text: string): void;
  openThread(threadId: string): void;
  unmount(): void;
}

export function mountChat(element: Element, options: {
  client: (account: { accountId: string; [field: string]: unknown }) => ChatClient;
  slots?: ChatSlots;
  /** The thread list's trigger and the element it opens in; no thread list when absent. */
  menu?: { trigger: Element; root: Element } | null;
  pageSize?: number;
}): ChatHandle;

export interface PanelHeaderOptions {
  /** An account header before the Chat control; without it the Chat control leads, then `status`. */
  lead?: string;
  status?: string;
  chat: { label?: string; triggerId: string; menuId: string };
  /** The "…" menu: one entry per view, then `extra` entries and a `note` line (markup). */
  more: { label: string; items: { view: string; label: string; icon?: string }[]; extra?: string; note?: string };
}
/** The panel header's markup (styles: agent-core/ui/panel.css). */
export function panelHeaderMarkup(options: PanelHeaderOptions): string;
export { focusPageTitle, pageHeadMarkup } from "./page.js";
/** A view control's click calls `onView`; one header menu open at a time, closed outside or on Escape. Returns the unbind. */
export function bindPanelHeader(header: Element, options: { onView(view: string): void }): () => void;
/** Marks the shown view in the header and closes the "…" menu. */
export function markPanelView(header: Element, view: string): void;

/** The image types the composer attaches, and its default limits. */
export const IMAGE_INPUT_TYPES: string[];
export const IMAGE_LIMITS: { max: number; maxEdge: number; maxBase64: number };
/** One image file downscaled and re-encoded (PNG when it fits, else JPEG) under `maxBase64`. Throws IMAGE_TYPE_UNSUPPORTED or IMAGE_UNREADABLE. */
export function prepareChatImage(file: File, limits?: { maxEdge?: number; maxBase64?: number }): Promise<ChatImageInput & { src: string }>;
export const THREAD_LIST_LIMIT: number;
export const TURN_PAGE_SIZE: number;
export function defaultWording(assistant?: string): ChatWording;
/** Turns grouped by causal links; a steer a turn took (`mergedIntoTurnId`) is in that turn's group's `steers`. */
export function groupTurns<T extends { turnId: string; parentTurnId?: string | null; mergedIntoTurnId?: string }>(turns: T[]): { id: string; turns: T[]; steers: T[] }[];
export function safeMarkdownHref(value: string, base?: string): string | null;
export function threadTitle(thread: ThreadSummary, wording: ChatWording): string;
export function formatMessageTime(value: string): string;
export const ChatConfig: Context<{ wording: ChatWording; slots: ChatSlots }>;
export const Message: ComponentType<{ message: { role: "user" | "assistant"; text: string; images?: ChatImage[]; createdAt?: string } }>;
export const Markdown: ComponentType<{ text: string; media?: ChatSlots["markdown"] }>;
export const Turn: ComponentType<Record<string, unknown>>;
export const TurnGroup: ComponentType<Record<string, unknown>>;
export const ThreadMenu: ComponentType<Record<string, unknown>>;
export const ThreadGroup: ComponentType<Record<string, unknown>>;
export const ComposerSettings: ComponentType<{ children?: ReactNode; trigger: ReactNode; label?: string }>;
export const ChatHost: ComponentType<Record<string, unknown>>;
export const chatMarkdown: unknown;
export function splitTightStrongFallback(value: string): { type: "text" | "strong"; text: string }[];
