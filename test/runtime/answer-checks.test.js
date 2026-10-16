import { test } from "node:test";
import assert from "node:assert/strict";
import { answerLength, lengthLimit, stripToolMarkup } from "../../src/runtime/index.js";

test("removes closed tool-call markup that is the whole answer or its trailing part", () => {
  for (const [input, expected] of [
    ['<｜DSML｜ calls>\n<｜DSML｜ invoke name="browser">\n</｜DSML｜ invoke>\n</｜DSML｜ calls>', ""],
    ["Done.\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>browser{}<｜tool▁call▁end｜><｜tool▁calls▁end｜>", "Done."],
    ['Checking.\n<tool_call>{"name":"browser"}</tool_call>', "Checking."],
    ['  Two lines of prose.\n\nKept as written.  \n<tool_call>{"a":1}</tool_call>\n  <tool_call>{"b":2}</tool_call>\n', "  Two lines of prose.\n\nKept as written."],
    ['<function_calls>\n<invoke name="browser"></invoke>\n</function_calls>', ""],
    ['\n<tool_call>{}</tool_call>', ""],
  ]) assert.deepEqual(stripToolMarkup(input), { text: expected, stripped: true }, JSON.stringify(input));
});

test("keeps prose that mentions tool-call tags, fenced examples, mid-answer and unclosed markup", () => {
  for (const input of [
    "Qwen3 wraps each call in <tool_call></tool_call> tags, and the runtime parses them before showing the reply.",
    "Qwen3 marks a call with\n<tool_call>{\"name\": \"search\"}</tool_call>\nand then waits for the tool result.",
    'The format is:\n```xml\n<function_calls>\n<invoke name="search"></invoke>\n</function_calls>\n```',
    'An unterminated fence:\n```\n<tool_call>{"name":"x"}</tool_call>',
    'Models print <invoke name="x"></invoke>',
    '<function_calls><invoke name="browser"></invoke></function_calls>\nThen the answer follows.',
    'Unclosed: <｜DSML｜ calls>\n<｜DSML｜ invoke name="browser">',
    'Use the `browser` tool with {"action":"tabs"} to list tabs.\n',
    "  padded answer  ",
  ]) assert.deepEqual(stripToolMarkup(input), { text: input, stripped: false }, JSON.stringify(input));
});

test("finds an explicit length limit in English or Chinese, and none in a plain number", () => {
  for (const [text, expected] of [
    ["Give me three practical checks, in English, under 130 words.", { max: 130, unit: "words" }],
    ["Summarize it in 50 words or fewer", { max: 50, unit: "words" }],
    ["请用中文回答，200 字以内。", { max: 200, unit: "words" }],
    ["不超过100字", { max: 100, unit: "words" }],
    ["a reply of at most 280 characters", { max: 280, unit: "characters" }],
    ["Tell me about the 300 MB limit and the three checks.", null],
  ]) assert.deepEqual(lengthLimit(/** @type {string} */ (text)), expected, String(text));
});

test("counts words and CJK characters, not a trailing JSON line", () => {
  assert.equal(answerLength("The 300 MB limit applies to files, not references.", "words"), 9);
  assert.equal(answerLength("数据同步免费。", "words"), 6);
  assert.equal(answerLength('Two words.\n{"url":"https://a.example/","hops":3}', "words"), 2);
  assert.equal(answerLength("héllo", "characters"), 5);
});
