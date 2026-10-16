// Checks on a turn's final answer, in code rather than in the prompt: tool-call markup a model
// wrote as text (instead of calling the tool) is removed, and an explicit length limit the user
// set ("under 130 words", "200 字以内") is found and measured. From pi-do src/worker/answer.ts.

/** @typedef {import("./index.js").LengthLimit} LengthLimit */

// Tool-call syntaxes models have been seen to print as text: DeepSeek's DSML and special-token
// forms, and the generic XML-ish ones. Only a CLOSED block counts.
const MARKUP_BLOCKS = [
  /<｜DSML｜\s*(?:function_)?calls>[^]*?<\/｜DSML｜\s*(?:function_)?calls>/y,
  /<｜tool▁calls▁begin｜>[^]*?<｜tool▁calls▁end｜>/y,
  /<｜tool▁call▁begin｜>[^]*?<｜tool▁call▁end｜>/y,
  /<tool_calls?>[^]*?<\/tool_calls?>/y,
  /<function_calls>[^]*?<\/function_calls>/y,
  /<invoke name=[^]*?<\/invoke>/y,
];

/** Whether `index` falls inside a ``` code fence of `text`. @param {string} text @param {number} index */
const inFence = (text, index) => ((text.slice(0, index).match(/^[ \t]*```/gm) ?? []).length % 2) === 1;

/**
 * Where the closed block that ends exactly at `end` starts, or -1: it starts on its own line,
 * outside a code fence. @param {string} text @param {number} end
 */
function trailingBlockStart(text, end) {
  const head = text.slice(0, end);
  for (let line = head.lastIndexOf("\n", end - 1); ; line = line > 0 ? head.lastIndexOf("\n", line - 1) : -1) {
    const start = line + 1 + (/^[ \t]*/.exec(head.slice(line + 1))?.[0].length ?? 0);
    if (head[start] === "<") for (const pattern of MARKUP_BLOCKS) {
      pattern.lastIndex = start;
      if (pattern.exec(head)?.index === start && pattern.lastIndex === end && !inFence(head, start)) return start;
    }
    if (line < 0) return -1;
  }
}

/**
 * The answer without tool-call markup the model printed instead of calling a tool, and whether
 * any was removed. Only closed blocks that make up the whole message or its trailing part (after
 * the last prose) are removed, each starting on its own line and outside a code fence; prose that
 * mentions `<tool_call>` or shows one in a fence is kept, and the text before the markup is
 * returned unchanged (only the whitespace that separated it from the markup is dropped).
 * @param {string} text
 */
export function stripToolMarkup(text) {
  let end = text.trimEnd().length;
  for (let start = trailingBlockStart(text, end); start >= 0; start = trailingBlockStart(text, end)) end = text.slice(0, start).trimEnd().length;
  if (end === text.trimEnd().length) return { text, stripped: false };
  return { text: text.slice(0, end), stripped: true };
}

const NUMBER = "(\\d{1,5})";
const WORD_LIMITS = [
  new RegExp(`\\b(?:under|within|at most|no more than|not more than|fewer than|less than|max(?:imum)?(?: of)?|up to|in)\\s+${NUMBER}\\s+words?\\b`, "i"),
  new RegExp(`\\b${NUMBER}\\s+words?\\s+(?:or (?:fewer|less)|max(?:imum)?|at most|or under)\\b`, "i"),
  new RegExp(`${NUMBER}\\s*(?:个)?(?:字|词)(?:以内|之内|以下|内)`),
  new RegExp(`(?:不超过|不多于|少于|最多|控制在)\\s*${NUMBER}\\s*(?:个)?(?:字|词)`),
];
const CHARACTER_LIMITS = [
  new RegExp(`\\b(?:under|within|at most|no more than|fewer than|less than|max(?:imum)?(?: of)?|up to)\\s+${NUMBER}\\s+(?:characters|chars)\\b`, "i"),
  new RegExp(`\\b${NUMBER}\\s+(?:characters|chars)\\s+(?:or (?:fewer|less)|max(?:imum)?|at most)\\b`, "i"),
];

/** The explicit length limit in the user's message, or null. A word limit wins over a character limit. @param {string} userText @returns {LengthLimit | null} */
export function lengthLimit(userText) {
  for (const pattern of WORD_LIMITS) {
    const match = pattern.exec(userText);
    if (match && Number(match[1]) > 0) return { max: Number(match[1]), unit: "words" };
  }
  for (const pattern of CHARACTER_LIMITS) {
    const match = pattern.exec(userText);
    if (match && Number(match[1]) > 0) return { max: Number(match[1]), unit: "characters" };
  }
  return null;
}

/**
 * The answer's length in the limit's unit. A Latin word or number counts as one word and so does
 * each CJK character; a trailing one-line JSON object (a machine-readable result the user asked
 * to append) is not counted.
 * @param {string} text @param {"words" | "characters"} unit
 */
export function answerLength(text, unit) {
  const prose = text.replace(/\n?[ \t]*\{[^\n]*\}\s*$/, "").trim();
  if (unit === "characters") return [...prose].length;
  return (prose.match(/[A-Za-z0-9][A-Za-z0-9'’.,%£$€/-]*/g) ?? []).length + (prose.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
}
