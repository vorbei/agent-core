// The model guidance both products send for the same core behaviour, written once: how to choose
// the path to an answer, how long an answer may be, the two runtime notices the Pi layer sends (an
// announced action not taken, a response cut at its output cap), and the context line naming the
// tab a side-panel message is about. A product places these in its own prompt and names its own
// tools; prose only one product sends stays in that product.

/**
 * The planning rules, one "- " line each. `compute` is the name of the product's code tool (pure
 * computation, no network, no page access).
 * @param {{ compute: string }} tools
 */
export function planRules({ compute }) {
  if (!/^[a-z][a-z0-9_]*$/.test(compute || "")) throw new TypeError("planRules needs the code tool's name");
  return [
    "Before the first tool call, decide how you will get the answer: from what you can already see, from a trustworthy online tool or search that computes or states it, or by working it out yourself. Take the shortest of these paths.",
    "When the answer depends on an image (one the user attached, or a screenshot), first check that it shows everything the task needs. If part of it is cut off or unreadable, say exactly what is missing and ask for it instead of filling it in.",
    `To work something out exactly (arithmetic, parsing text, transforming data, searching or enumerating cases), run code with "${compute}" instead of computing in your head; it has no network and no page access, so put the data it needs in the code.`,
    "Do not repeat an observation that already gave you what it can (the same screenshot, snapshot or read), and do not guess addresses.",
    "If two steps in a row bring nothing new, switch strategy or ask the user instead of trying variations. When a tool or site rejects your input as invalid, check that input against its source (the image or text it came from) rather than altering it.",
  ].map(rule => `- ${rule}`).join("\n");
}

/** The rule for a length limit the user states, which binds the whole final answer. */
export const ANSWER_LENGTH_RULE = "An explicit length limit from the user (\"under 130 words\", \"200 字以内\") binds the whole final answer, quotes and lists included: count before sending and cut detail rather than exceed it.";

/**
 * Sent once when the final answer ends by announcing an action it did not take (the Pi layer's
 * `pendingActionWording`); `{{CLAIM}}` is replaced with the announcing sentence.
 */
export const PENDING_ACTION_STEER = "Your reply ended with {{CLAIM}} but made no tool call, so that step was not done. If it is still part of the task and allowed, do it now with a tool call and then report the result. Otherwise answer with what was actually done and what was not. Never describe an action as done, or as happening now, without its tool result.";

/**
 * The output recovery's notice after a response spent its whole output budget reasoning
 * (MODEL_OUTPUT_LIMIT; the Pi layer's `outputLimitWording`).
 */
export const OUTPUT_LIMIT_NOTICE = "Your previous response used its whole output budget on reasoning and gave no answer. No tools are available now. Think briefly, then answer the user with what you have verified so far, and say plainly what you could not determine.";

/**
 * The line that starts a user message from a side panel: the tab the message is about, as the
 * product names it (`tabId` is what the product's browser tool takes for that tab), with its URL
 * and title when the message was sent. Attribute values are escaped; `null` says no tab is selected.
 * @param {{ tabId: number | string, url: string, title: string } | null} context
 */
export function contextLine(context) {
  if (!context) return "<browser_context>no tab selected</browser_context>";
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<browser_context tabId="${escape(context.tabId)}" url="${escape(context.url)}" title="${escape(context.title)}"/>`;
}

/**
 * The description of the code tool both products offer as run_code (agent-core's code sandbox in
 * the user's browser): JavaScript or bash, no network, no page access. `timeoutSeconds` is the
 * product's run timeout.
 * @param {{ timeoutSeconds: number }} limits
 */
export function runCodeDescription({ timeoutSeconds }) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new TypeError("runCodeDescription needs the run timeout");
  return `Run code in a sandbox in the user's browser and get its result.
language "js" (default): code is the body of an async function: "return" the answer (JSON-serializable) and use console.log for notes; the files are in the object \`files\` (path -> text).
language "bash": a bash script in a fresh in-memory shell whose commands are built in (grep, sed, awk, sort, uniq, cut, tr, wc, head, tail, jq, yq, xan for CSV, seq, find, diff, base64, sha256sum ...; "help" lists them); there is no other program to call or install (no python, node or other installed tools); you get stdout, stderr and the exit status. Relative paths are under /home/user.
files (optional): text files the run starts with, path -> content. Each run starts empty: nothing is kept between runs.
Pure computation only: no network (no fetch, no curl), no page or tab access, no tools, no package imports; a run stops after ${timeoutSeconds} seconds. Put the data it needs in the code or its files.`;
}

/** The core browser tool's description (agent-core/browser BROWSER_ACTIONS): one action per call. */
export const BROWSER_TOOL_DESCRIPTION = `Operate the user's Chrome tabs. One action per call:
tabs (list open tabs) | open {url} | select_tab {tabId} | navigate {tabId,url} |
snapshot {tabId, interactive?, filter?} | click {tabId,ref} | type {tabId,ref,text,submit?} | select {tabId,ref,option} (native <select>) |
press {tabId,key} | scroll {tabId,direction} | read_text {tabId,maxChars?} (page text; PDF text by page) | screenshot {tabId}.
Refs (e12) come from the latest snapshot of that tab.`;
