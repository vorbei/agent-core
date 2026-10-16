// Context compaction policy: when a conversation's model view is summarized, how much recent
// history is kept, how context size is estimated, and how history is written out for the
// summarizer. The runtime decides where the cut lands; the summary prompt is the consumer's.
// From X Gardener src/pi/context-compaction.js.

/** @typedef {import("./index.js").CompactionSettings} CompactionSettings */

export const CONTEXT_COMPACTION_SETTINGS = Object.freeze({
  contextWindow: 1_048_576,
  reserveTokens: 16_384,
  keepRecentTokens: 50_000,
  compactAtTokens: 300_000,
  backgroundTokens: 0,
  minGrowthTokens: 50_000,
  summaryTimeoutMs: 60_000,
});

const TOOL_RESULT_SUMMARY_CHARS = 2_000;

/**
 * The settings for a model. `mode: "notes"` keeps original history up to the hard input limit
 * (notes start at `compactAtTokens`); otherwise compaction triggers at `compactAtTokens`.
 * `backgroundTokens` starts a background summary that far below the trigger (0 = off).
 * @param {{ contextWindow?: number, maxTokens?: number } | undefined} model
 * @param {Partial<Record<"mode" | "compactAtTokens" | "backgroundTokens" | "keepRecentTokens" | "minGrowthTokens" | "summaryTimeoutMs", unknown>>} [overrides]
 * @returns {CompactionSettings}
 */
export function contextCompactionSettings(model, overrides = {}) {
  /** @type {Record<string, any>} */
  const settings = { ...CONTEXT_COMPACTION_SETTINGS, contextWindow: model?.contextWindow || CONTEXT_COMPACTION_SETTINGS.contextWindow,
    reserveTokens: model?.maxTokens || CONTEXT_COMPACTION_SETTINGS.reserveTokens, mode: overrides.mode };
  for (const key of /** @type {const} */ (["compactAtTokens", "backgroundTokens", "keepRecentTokens", "minGrowthTokens", "summaryTimeoutMs"])) {
    if (overrides[key] == null || overrides[key] === "") continue;
    const value = Number(overrides[key]);
    if (!Number.isSafeInteger(value) || value < (key === "backgroundTokens" ? 0 : 1)) throw new Error(`Invalid context ${key}`);
    settings[key] = value;
  }
  const available = settings.contextWindow - settings.reserveTokens;
  if (available <= 0) throw new Error("Invalid model context/output limits");
  settings.compactAtTokens = Math.min(settings.compactAtTokens, available);
  settings.triggerTokens = settings.mode === "notes" ? available : settings.compactAtTokens;
  settings.keepRecentTokens = Math.min(settings.keepRecentTokens, Math.floor(settings.triggerTokens / 2));
  // Never starts where the cut would keep everything.
  settings.backgroundTokens = Math.min(settings.backgroundTokens, settings.triggerTokens - settings.keepRecentTokens);
  settings.backgroundCompactAtTokens = settings.backgroundTokens > 0 ? settings.triggerTokens - settings.backgroundTokens : 0;
  settings.minGrowthTokens = Math.min(settings.minGrowthTokens, Math.floor(settings.compactAtTokens / 3));
  return /** @type {CompactionSettings} */ (settings);
}

/** Pi's own compaction settings for these (Pi compacts when context > contextWindow - reserveTokens). @param {CompactionSettings} settings */
export function piCompactionSettings(settings) {
  return { enabled: true, reserveTokens: settings.contextWindow - settings.triggerTokens, keepRecentTokens: settings.keepRecentTokens };
}

/** A conservative token estimate of messages (a context reservation, not billed usage). @param {any[]} messages */
export function estimateContextTokens(messages) {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** @param {any} message */
function estimateMessageTokens(message) {
  let tokens = 4 + (Array.isArray(message.content) ? message.content.filter((/** @type {any} */ block) => block.type === "image").length * 4096 : 0);
  if (message.role === "assistant") {
    for (const block of message.content || []) {
      if (block.type === "text") tokens += estimateTextTokens(block.text);
      if (block.type === "thinking") tokens += estimateTextTokens(block.thinking) + estimateTextTokens(block.thinkingSignature);
      if (block.type === "toolCall") tokens += estimateTextTokens(`${block.name || ""}${JSON.stringify(block.arguments || {})}`);
    }
  } else {
    tokens += estimateTextTokens(contentText(message.content));
  }
  return tokens;
}

/** ASCII at four characters a token, anything else one token per character. @param {unknown} content */
function estimateTextTokens(content) {
  const text = String(content || "");
  let ascii = 0, nonAscii = 0;
  for (const character of text) {
    if (/** @type {number} */ (character.codePointAt(0)) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

/** History as plain text for a summarizer; long tool results are cut. @param {any[]} messages */
export function serializeContextForSummary(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.role === "user") parts.push(`[User]: ${contentText(message.content)}`);
    if (message.role === "assistant") {
      const text = contentText(message.content);
      if (text) parts.push(`[Assistant]: ${text}`);
      const calls = (message.content || []).filter((/** @type {any} */ block) => block.type === "toolCall")
        .map((/** @type {any} */ block) => `${block.name}(${JSON.stringify(block.arguments || {})})`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    }
    if (message.role === "toolResult") {
      const text = contentText(message.content);
      parts.push(`[Tool result]: ${text.length > TOOL_RESULT_SUMMARY_CHARS ? `${text.slice(0, TOOL_RESULT_SUMMARY_CHARS)}\n[truncated]` : text}`);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/** @param {unknown} content @returns {string} */
function contentText(content) {
  if (typeof content === "string") return content;
  return (/** @type {any[]} */ (content) || []).filter(block => block.type === "text").map(block => block.text || "").join("\n");
}
