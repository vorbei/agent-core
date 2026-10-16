// Types of the guidance layer (src/guidance/index.js). Plain declarations: no build step.

/** The planning rules, one "- " line each; `compute` names the product's code tool. Throws on an invalid name. */
export function planRules(tools: { compute: string }): string;

/** The rule for a length limit the user states. */
export const ANSWER_LENGTH_RULE: string;

/** The steer sent once when an answer announces an action it did not take; `{{CLAIM}}` is replaced by the claim. */
export const PENDING_ACTION_STEER: string;

/** The output recovery's notice after a response spent its whole output budget reasoning. */
export const OUTPUT_LIMIT_NOTICE: string;

/** The line naming the tab a side-panel message is about (`tabId` as the product's browser tool takes it); `null`: no tab selected. */
export function contextLine(context: { tabId: number | string; url: string; title: string } | null): string;

/** The run_code tool's description (agent-core's browser code sandbox), with the product's run timeout. */
export function runCodeDescription(limits: { timeoutSeconds: number }): string;

/** The core browser tool's description (agent-core/browser's action model). */
export const BROWSER_TOOL_DESCRIPTION: string;
