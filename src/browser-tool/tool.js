// The core browser tool's action model: one `browser` call is one action (tabs, open, select_tab,
// navigate, snapshot, click, type, select, press, scroll, read_text, screenshot) on a tab named by
// its id, with refs (e12) from that tab's latest snapshot. Its actions, keys, argument rules and
// parameter schema are defined here once; a product executes the validated call with its own
// executor and words the tool for the model with the guidance layer's description. A product whose
// executor has a command grammar beneath the actions (Gardener's agent-browser argv) also offers
// the `command` action: one argv array, run as that executor runs it, so the browser stays one tool.

export const BROWSER_TOOL = "browser";

export const BROWSER_ACTIONS = /* @__PURE__ */ Object.freeze([
  "tabs", "open", "select_tab", "navigate", "snapshot", "click", "type", "select", "press", "scroll", "read_text", "screenshot",
]);

export const PRESS_KEYS = /* @__PURE__ */ Object.freeze([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End",
]);

/** The action that passes an argv array to the product's executor (`browserToolParameters({ command: true })`). */
export const COMMAND_ACTION = "command";
/** Bounds of a command's argv: at most 32 arguments of at most 8000 characters. */
const COMMAND_ARGS_MAX = 32;
const COMMAND_ARG_CHARS = 8_000;

/** Actions that act on a page (a run that may only read may not make them). */
export const ACTING_ACTIONS = /* @__PURE__ */ Object.freeze(["click", "type", "select", "press"]);
/** Actions that only read: they change nothing a repeat could change twice. */
export const READING_ACTIONS = /* @__PURE__ */ Object.freeze(["tabs", "select_tab", "snapshot", "scroll", "read_text", "screenshot"]);

// Which arguments each action requires. `tabId` is explicit on every page action: there is no implicit target.
const REQUIRED = /* @__PURE__ */ Object.freeze({
  tabs: [], open: ["url"], select_tab: ["tabId"], navigate: ["tabId", "url"], snapshot: ["tabId"],
  click: ["tabId", "ref"], type: ["tabId", "ref", "text"], select: ["tabId", "ref", "option"], press: ["tabId", "key"], scroll: ["tabId", "direction"],
  read_text: ["tabId"], screenshot: ["tabId"],
});

// Which arguments each action reads besides its required ones. Arguments an action does not read
// are ignored, not validated: models that fill every schema property send placeholders ("", 0,
// "unused") for them, and refusing those cost a model request each on the live phone page.
const OPTIONAL = /* @__PURE__ */ Object.freeze({
  snapshot: ["filter", "interactive"], type: ["submit"], read_text: ["maxChars"],
});

const REF = /^@?e\d{1,5}$/;

/** @param {readonly string[]} values */
const literals = values => ({ anyOf: values.map(value => ({ type: "string", const: value })) });

/** The tool's parameters as a JSON schema (the products' tool registries take JSON schemas). */
export const BROWSER_TOOL_PARAMETERS = /* @__PURE__ */ browserToolParameters();

/**
 * The parameters, with the `command` action and its `args` when the product's executor has a
 * command grammar. @param {{ command?: boolean }} [options]
 */
export function browserToolParameters({ command = false } = {}) {
  const offered = command ? [...BROWSER_ACTIONS, COMMAND_ACTION] : BROWSER_ACTIONS;
  return Object.freeze({
    type: "object",
    required: ["action"],
    properties: {
      action: literals(offered),
      tabId: { type: "integer", minimum: 0 },
      url: { type: "string" },
      ref: { type: "string", description: "e12, from the latest snapshot of this tab" },
      text: { type: "string" },
      option: { type: "string", description: "select: the option's value or visible text" },
      submit: { type: "boolean", description: "type: press Enter after typing" },
      key: /* @__PURE__ */ literals(PRESS_KEYS),
      direction: /* @__PURE__ */ literals(["up", "down"]),
      filter: { type: "string", description: "snapshot: keep lines whose name or value contains one of these space-separated words" },
      interactive: { type: "boolean", description: "snapshot: controls only" },
      maxChars: { type: "integer", minimum: 100, maximum: 60_000 },
      ...(command ? { args: { type: "array", minItems: 1, maxItems: COMMAND_ARGS_MAX, items: { type: "string", maxLength: COMMAND_ARG_CHARS },
        description: "command: the command as an argv array of strings, e.g. [\"find\",\"text\",\"Sign in\",\"click\"]" } } : {}),
    },
  });
}

/** The absolute http(s) URL, normalized, or null. @param {string} value */
export function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

/**
 * Validates raw tool arguments into a browser call; throws an Error with `code` INVALID_ARGS
 * whose message says what is wrong. `command: true` accepts the command action (its args only).
 * @param {unknown} input
 * @param {{ command?: boolean }} [options]
 * @returns {import("./index.js").BrowserCall | import("./index.js").BrowserCommandCall}
 */
export function parseBrowserCall(input, { command = false } = {}) {
  /** @param {string} message @returns {never} */
  const fail = message => { throw Object.assign(new Error(`INVALID_ARGS: ${message}`), { code: "INVALID_ARGS" }); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("arguments must be an object");
  const action = /** @type {Record<string, any>} */ (input).action;
  const offered = command ? [...BROWSER_ACTIONS, COMMAND_ACTION] : BROWSER_ACTIONS;
  if (!offered.includes(action)) fail(`action must be one of ${offered.join(", ")}`);
  const reads = action === COMMAND_ACTION ? ["args"]
    : [...REQUIRED[/** @type {keyof typeof REQUIRED} */ (action)], ...(OPTIONAL[/** @type {keyof typeof OPTIONAL} */ (action)] || [])];
  // An empty filter is no filter; any other argument is taken as given.
  /** @type {Record<string, any>} */
  const raw = Object.fromEntries(Object.entries(/** @type {Record<string, any>} */ (input))
    .filter(([name, value]) => reads.includes(name) && !(name === "filter" && value === "")));
  if (action === COMMAND_ACTION) {
    const args = raw.args;
    if (!Array.isArray(args) || !args.length || args.length > COMMAND_ARGS_MAX
      || args.some(arg => typeof arg !== "string" || arg.length > COMMAND_ARG_CHARS)) {
      fail(`command requires args: an array of 1..${COMMAND_ARGS_MAX} strings`);
    }
    return /** @type {import("./index.js").BrowserCommandCall} */ ({ action, args: [...args] });
  }
  /** @type {Record<string, any>} */
  const call = { action };
  if (raw.tabId !== undefined) {
    if (!Number.isSafeInteger(raw.tabId) || raw.tabId < 0) fail("tabId must be a non-negative integer");
    call.tabId = raw.tabId;
  }
  if (raw.url !== undefined) {
    if (typeof raw.url !== "string" || raw.url.length > 4_096) fail("url must be a string");
    call.url = httpUrl(raw.url) ?? fail("url must be an absolute http(s) URL");
  }
  if (raw.ref !== undefined) {
    if (typeof raw.ref !== "string" || !REF.test(raw.ref)) fail("ref must look like e12 (from the latest snapshot)");
    call.ref = raw.ref.replace(/^@/, "");
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string" || raw.text.length > 10_000) fail("text must be a string of at most 10000 characters");
    call.text = raw.text;
  }
  if (raw.option !== undefined) {
    if (typeof raw.option !== "string" || !raw.option || raw.option.length > 500) fail("option must be a string of 1..500 characters");
    call.option = raw.option;
  }
  if (raw.submit !== undefined) call.submit = raw.submit === true;
  if (raw.key !== undefined) {
    if (!PRESS_KEYS.includes(raw.key)) fail(`key must be one of ${PRESS_KEYS.join(", ")}`);
    call.key = raw.key;
  }
  if (raw.direction !== undefined) {
    if (raw.direction !== "up" && raw.direction !== "down") fail("direction must be up or down");
    call.direction = raw.direction;
  }
  if (raw.filter !== undefined) {
    if (typeof raw.filter !== "string" || !raw.filter.trim() || raw.filter.length > 200) fail("filter must be a non-empty string");
    call.filter = raw.filter.trim();
  }
  if (raw.interactive !== undefined) call.interactive = raw.interactive === true;
  if (raw.maxChars !== undefined) {
    if (!Number.isSafeInteger(raw.maxChars) || raw.maxChars < 100 || raw.maxChars > 60_000) fail("maxChars must be 100..60000");
    call.maxChars = raw.maxChars;
  }
  for (const field of REQUIRED[/** @type {keyof typeof REQUIRED} */ (action)]) if (call[field] === undefined) fail(`${action} requires ${field}`);
  return /** @type {import("./index.js").BrowserCall} */ (call);
}
