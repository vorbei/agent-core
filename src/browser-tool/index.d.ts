// Types of the browser-tool layer (src/browser-tool/index.js). Plain declarations: no build step.

export const BROWSER_TOOL: "browser";
export const BROWSER_ACTIONS: readonly ["tabs", "open", "select_tab", "navigate", "snapshot", "click", "type", "select", "press", "scroll", "read_text", "screenshot"];
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export const PRESS_KEYS: readonly ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
export type PressKey = (typeof PRESS_KEYS)[number];
/** Actions that act on a page (a read-only run may not make them). */
export const ACTING_ACTIONS: readonly BrowserAction[];
/** Actions that only read. */
export const READING_ACTIONS: readonly BrowserAction[];

/** The action that passes an argv array to a product executor with a command grammar. */
export const COMMAND_ACTION: "command";

/** One browser action, validated (`parseBrowserCall`). */
export interface BrowserCall {
  action: BrowserAction;
  tabId?: number;
  url?: string;
  ref?: string;
  text?: string;
  /** select: the option to choose in a native <select>, by its value or its visible text. */
  option?: string;
  submit?: boolean;
  key?: PressKey;
  direction?: "up" | "down";
  filter?: string;
  interactive?: boolean;
  maxChars?: number;
}

/** The command action, validated: the argv the product's executor runs. */
export interface BrowserCommandCall {
  action: typeof COMMAND_ACTION;
  args: string[];
}

/** The tool's parameters as a JSON schema. */
export const BROWSER_TOOL_PARAMETERS: Record<string, unknown>;
/** The parameters; `command: true` adds the command action and its args. */
export function browserToolParameters(options?: { command?: boolean }): Record<string, unknown>;
/** The absolute http(s) URL, normalized, or null. */
export function httpUrl(value: string): string | null;
/** Validates raw arguments; throws an Error with `code` INVALID_ARGS. */
export function parseBrowserCall(input: unknown, options?: { command?: false }): BrowserCall;
export function parseBrowserCall(input: unknown, options: { command: true }): BrowserCall | BrowserCommandCall;
