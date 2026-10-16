import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTING_ACTIONS, BROWSER_ACTIONS, BROWSER_TOOL_PARAMETERS, browserToolParameters, COMMAND_ACTION, parseBrowserCall, PRESS_KEYS, READING_ACTIONS } from "../../src/browser-tool/index.js";

test("the browser tool's calls are validated once: refs normalized, URLs http(s) only, each action's arguments required", () => {
  assert.deepEqual(parseBrowserCall({ action: "click", tabId: 3, ref: "@e12" }), { action: "click", tabId: 3, ref: "e12" });
  assert.deepEqual(parseBrowserCall({ action: "open", url: "https://example.com" }), { action: "open", url: "https://example.com/" });
  assert.deepEqual(parseBrowserCall({ action: "snapshot", tabId: 1, filter: " price ", interactive: true }), { action: "snapshot", tabId: 1, filter: "price", interactive: true });
  for (const [input, message] of [
    [{ action: "eval", tabId: 1 }, /action must be one of/],
    [{ action: "click", ref: "e1" }, /click requires tabId/],
    [{ action: "click", tabId: 1, ref: "#submit" }, /ref must look like e12/],
    [{ action: "navigate", tabId: 1, url: "javascript:alert(1)" }, /absolute http\(s\) URL/],
    [{ action: "press", tabId: 1, key: "Meta+Q" }, /key must be one of/],
    [{ action: "type", tabId: 1, ref: "e1", text: "x".repeat(10_001) }, /at most 10000/],
    [null, /arguments must be an object/],
  ]) assert.throws(() => parseBrowserCall(input), error => error.code === "INVALID_ARGS" && message.test(error.message));
});

test("arguments an action does not read are ignored, so a model that fills every property with placeholders is not refused", () => {
  // The shape gpt-6.1-sol and gpt-6-luna sent on the phone page (refused four times in a row on dev.51).
  const filled = { tabId: 7, url: "", ref: "", text: "", option: "", submit: false, key: "Enter", direction: "down", filter: "", interactive: false, maxChars: 60_000, args: ["snapshot"] };
  assert.deepEqual(parseBrowserCall({ ...filled, action: "screenshot" }), { action: "screenshot", tabId: 7 });
  assert.deepEqual(parseBrowserCall({ ...filled, action: "snapshot" }), { action: "snapshot", tabId: 7, interactive: false });
  assert.deepEqual(parseBrowserCall({ ...filled, action: "tabs" }), { action: "tabs" });
  assert.deepEqual(parseBrowserCall({ ...filled, action: "scroll" }), { action: "scroll", tabId: 7, direction: "down" });
  assert.deepEqual(parseBrowserCall({ ...filled, action: COMMAND_ACTION, args: ["screenshot", "--inline"] }, { command: true }), { action: "command", args: ["screenshot", "--inline"] });
  // What an action does read is still validated.
  assert.throws(() => parseBrowserCall({ ...filled, action: "click" }), /ref must look like e12/);
  assert.throws(() => parseBrowserCall({ ...filled, action: "open" }), /absolute http\(s\) URL/);
});

test("the parameter schema offers exactly the actions and keys the parser accepts; acting and reading actions partition what touches a page", () => {
  assert.deepEqual(BROWSER_TOOL_PARAMETERS.properties.action.anyOf.map(item => item.const), [...BROWSER_ACTIONS]);
  assert.deepEqual(BROWSER_TOOL_PARAMETERS.properties.key.anyOf.map(item => item.const), [...PRESS_KEYS]);
  assert.deepEqual(BROWSER_TOOL_PARAMETERS.required, ["action"]);
  assert.ok([...ACTING_ACTIONS, ...READING_ACTIONS].every(action => BROWSER_ACTIONS.includes(action)));
  assert.equal(ACTING_ACTIONS.filter(action => READING_ACTIONS.includes(action)).length, 0);
});

test("a product with a command grammar offers the command action in the same tool; one without keeps the actions alone", () => {
  assert.throws(() => parseBrowserCall({ action: COMMAND_ACTION, args: ["find", "text", "Sign in", "click"] }), /action must be one of/);
  assert.deepEqual(parseBrowserCall({ action: COMMAND_ACTION, args: ["find", "text", "Sign in", "click"], tabId: 9 }, { command: true }),
    { action: "command", args: ["find", "text", "Sign in", "click"] }, "a command carries its argv only");
  for (const args of [undefined, [], ["x".repeat(8_001)], Array(33).fill("a"), [1]]) {
    assert.throws(() => parseBrowserCall({ action: COMMAND_ACTION, args }, { command: true }), /command requires args/);
  }
  const withCommand = browserToolParameters({ command: true });
  assert.deepEqual(withCommand.properties.action.anyOf.map(entry => entry.const), [...BROWSER_ACTIONS, COMMAND_ACTION]);
  assert.equal(withCommand.properties.args.type, "array");
  assert.equal(JSON.stringify(browserToolParameters()), JSON.stringify(BROWSER_TOOL_PARAMETERS), "without a grammar the schema is the actions' alone");
  assert.equal(BROWSER_TOOL_PARAMETERS.properties.args, undefined);
});
