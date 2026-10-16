// The browser-tool layer's public surface: the core browser tool's action model (its actions, keys,
// argument rules and parameter schema), which a product registers and runs with its own executor.
// Kept apart from the browser layer (the extension-side executor) so a Worker registers the tool
// without importing the executor, and the executor's bundles do not change with it. Types are in
// index.d.ts.
export { ACTING_ACTIONS, BROWSER_ACTIONS, BROWSER_TOOL, BROWSER_TOOL_PARAMETERS, browserToolParameters, COMMAND_ACTION, httpUrl, parseBrowserCall, PRESS_KEYS, READING_ACTIONS } from "./tool.js";
