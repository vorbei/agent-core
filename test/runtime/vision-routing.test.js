import { test } from "node:test";
import assert from "node:assert/strict";
import { routeVisionRequests } from "../../src/runtime/index.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (name, model = "text") => ({ role: "assistant", model, content: [{ type: "toolCall", id: name, name, arguments: {} }] });
const toolResult = (...content) => ({ role: "toolResult", toolCallId: "t", toolName: "browser", content });
const image = { type: "image", data: "/9j/AAAA", mimeType: "image/jpeg" };
const images = (messages) => messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "image").length;

function router() {
  const sent = [];
  const routes = [];
  const stream = (name) => (model, context) => { sent.push({ route: name, model: model.id, messages: context.messages }); return name; };
  const streamFn = routeVisionRequests({ text: { model: { id: "text" }, streamFn: stream("text") },
    vision: { model: { id: "vision" }, streamFn: stream("vision") }, onRoute: (route) => routes.push(route) });
  return { streamFn, sent, routes };
}

test("a request goes to the vision model when it answers a new tool image or a vision step beyond a text read", () => {
  const { streamFn, sent, routes } = router();
  const history = [user("solve the puzzle on my phone")];
  const ask = () => streamFn({ id: "text" }, { messages: [...history] });
  const call = (name, args, model = "text") => ({ role: "assistant", model, content: [{ type: "toolCall", id: name, name, arguments: args }] });

  assert.equal(ask(), "text");
  history.push(call("browser", { action: "snapshot" }), toolResult({ type: "text", text: "snapshot: no elements" }));
  assert.equal(ask(), "text", "a text-only result keeps the text model");
  // Hosts add user-role context (a page guide) after a tool result; the image is still the new result.
  history.push(call("browser", { action: "screenshot" }), toolResult({ type: "text", text: "screenshot" }, image), user("[page guide]"));
  assert.equal(ask(), "vision");
  assert.equal(images(sent.at(-1).messages), 1, "the vision model sees the picture");
  // The vision model ran code on what it saw: its result continues on the vision model.
  history.push(call("run_code", { code: "search()" }, "vision"), toolResult({ type: "text", text: "{\"move\":\"Nxf8+\",\"tap\":[623,648]}" }));
  assert.equal(ask(), "vision", "the vision model's own computation continues with it");
  // The vision model tapped a board drawn on a canvas: the receipt is text, but only it can judge it
  // (measured: the text model reasoned 69-77 s blind on such receipts and timed out once).
  history.push(call("browser", { action: "command", args: ["batch", "mouse move 623 648", "mouse down", "mouse up"] }, "vision"),
    toolResult({ type: "text", text: "Ready · tap done" }));
  assert.equal(ask(), "vision", "the vision model judges the result of its own tap");
  history.push(call("browser", { action: "snapshot" }, "vision"), toolResult({ type: "text", text: "- button \"Continue\" [ref=e7]" }));
  assert.equal(ask(), "text", "after a text read the text model takes over");
  history.push(call("browser", { action: "click", ref: "e7" }), toolResult({ type: "text", text: "clicked" }));
  assert.equal(ask(), "text", "and keeps the turn while its own steps continue");
  history.push(call("browser", { action: "screenshot" }), toolResult({ type: "text", text: "screenshot" }, image));
  assert.equal(ask(), "vision", "a new picture goes to the vision model");
  assert.deepEqual(sent.map((request) => request.route), ["text", "text", "vision", "vision", "vision", "text", "text", "vision"]);
  assert.deepEqual(routes, ["vision", "vision", "vision", "vision"]);
});

test("the text model never receives a tool image: it gets a stable stub telling it how to look again", () => {
  const { streamFn, sent } = router();
  const history = [user("open settings"), assistant("screenshot"), toolResult({ type: "text", text: "receipt" }, image), assistant("click"),
    toolResult({ type: "text", text: "clicked" })];
  streamFn({ id: "text" }, { messages: history });
  streamFn({ id: "text" }, { messages: [...history, assistant("snapshot"), toolResult({ type: "text", text: "tree" })] });
  const [first, second] = sent;
  assert.equal(first.route, "text");
  assert.equal(images(first.messages), 0);
  const stub = first.messages[2].content.map((block) => block.text).join("\n");
  assert.match(stub, /receipt/, "the result's own text stays");
  assert.match(stub, /screenshot/i, "the stub says how to see the screen again");
  // The cached prefix stays byte-identical from one text request to the next.
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.equal(images(history), 1, "the journal keeps the image");
});

test("without a vision model every request stays on the text model, images untouched", () => {
  const sent = [];
  const streamFn = routeVisionRequests({ text: { model: { id: "text" }, streamFn: (model, context) => { sent.push(context.messages); return model.id; } } });
  assert.equal(streamFn({ id: "text" }, { messages: [user("x"), assistant("screenshot"), toolResult(image)] }), "text");
  assert.equal(images(sent[0]), 1);
});

test("a product's text reads hand the vision model's steps to the text model; by default only browser text reads do", () => {
  const call = (id, name, args) => ({ role: "assistant", model: "vision", content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (toolCallId, text) => ({ role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }] });
  const seen = [];
  // A product's predicate: a web fetch, and a script run whose result says it was verified.
  const textRead = (toolCall, toolResult) => {
    seen.push([toolCall.id, toolResult?.toolCallId]);
    return toolCall.name === "web_fetch" || toolCall.name === "script" && /"verified"/.test(toolResult?.content?.[0]?.text || "");
  };
  const route = (messages, read) => {
    const sent = [];
    const stream = (name) => () => { sent.push(name); return name; };
    routeVisionRequests({ text: { model: { id: "text" }, streamFn: stream("text") }, vision: { model: { id: "vision" }, streamFn: stream("vision") },
      ...(read ? { textRead: read } : {}) })({ id: "text" }, { messages });
    return sent[0];
  };
  const fetched = [user("solve"), call("f1", "web_fetch", { url: "https://engine.example/best" }), result("f1", "{\"bestmove\":\"h2g4\"}")];
  assert.equal(route(fetched), "vision", "without the product's predicate a web fetch by the vision model stays with it");
  assert.equal(route(fetched, textRead), "text");
  assert.deepEqual(seen, [["f1", "f1"]], "the predicate gets the call and its own result");
  const verified = [user("solve"), call("s1", "script", {}), result("s1", "{\"outcome\":\"verified\",\"fen\":\"8/8\"}")];
  const unknown = [user("solve"), call("s2", "script", {}), result("s2", "{\"outcome\":\"executed_unknown\"}")];
  assert.equal(route(verified, textRead), "text");
  assert.equal(route(unknown, textRead), "vision", "a result the predicate does not accept keeps the vision model");
  // Any call of the step that is not a text read keeps the vision model.
  const mixed = [user("solve"), { role: "assistant", model: "vision", content: [{ type: "toolCall", id: "f2", name: "web_fetch", arguments: {} },
    { type: "toolCall", id: "t2", name: "browser", arguments: { action: "command", args: ["mouse", "down"] } }] }, result("f2", "{}"), result("t2", "done")];
  assert.equal(route(mixed, textRead), "vision");
  // A new picture still goes to the vision model, whatever the predicate says.
  assert.equal(route([...fetched.slice(0, 2), { ...result("f1", "page"), content: [image] }], textRead), "vision");
});

// Staging 2026-10-14 (thread_e3b4e791…): a turn cut off by its spend limit right after a vision-model
// tap left that step last; the next turns ("继续吧", "把现在的结果说一下") began on the vision model
// with the whole thread ($0.51-0.91 each) and died on their first request.
test("a new turn starts on the text model although the turn before it ended on a vision step or a picture", () => {
  const stream = (name) => () => name;
  const route = (since) => routeVisionRequests({ since, text: { model: { id: "text" }, streamFn: stream("text") },
    vision: { model: { id: "vision" }, streamFn: stream("vision") } });
  const at = (message, timestamp) => ({ ...message, timestamp });
  const before = [at(user("search five apps for coffee concentrate"), 1),
    at({ role: "assistant", model: "vision", content: [{ type: "toolCall", id: "tap", name: "browser", arguments: { action: "command", args: ["mouse", "down"] } }] }, 2),
    at({ ...toolResult({ type: "text", text: "tapped" }), toolCallId: "tap" }, 3)];
  const report = [at(user("把现在的结果说一下"), 11), at(user("[budget line]"), 11)];
  assert.equal(route(10)({ id: "text" }, { messages: [...before, ...report] }), "text", "the new user turn answers on the text model");
  assert.equal(route(undefined)({ id: "text" }, { messages: [...before, ...report] }), "vision", "without the turn's start the old step still routes it");
  const pictured = [...before, at(toolResult({ type: "text", text: "screenshot" }, image), 4), ...report];
  assert.equal(route(10)({ id: "text" }, { messages: pictured }), "text", "an earlier turn's picture does not route it either");
  // Within the turn, routing is unchanged: its own picture goes to the vision model.
  const looked = [...pictured, at({ role: "assistant", model: "text", content: [{ type: "toolCall", id: "s", name: "browser", arguments: { action: "screenshot" } }] }, 12),
    at({ ...toolResult({ type: "text", text: "screenshot" }, image), toolCallId: "s" }, 13)];
  assert.equal(route(10)({ id: "text" }, { messages: looked }), "vision");
});

test("a request the vision model would take past the turn's spend ceiling stays on the text model, picture stubbed", async () => {
  const { createTurnBudget } = await import("../../src/runtime/index.js");
  const budget = createTurnBudget({}, { maxModelCalls: 10, maxToolCalls: 10, maxCostUsd: 0.5 });
  budget.addCost(0.4);
  assert.ok(Math.abs(budget.remainingCostUsd() - 0.1) < 1e-9);
  assert.equal(createTurnBudget({}, { maxModelCalls: 1, maxToolCalls: 1 }).remainingCostUsd(), Infinity);
  const sent = [];
  // A product's estimate: 180K uncached tokens at $2.5 per million is $0.45.
  const streamFn = routeVisionRequests({ text: { model: { id: "text" }, streamFn: (model, context) => { sent.push(context.messages); return model.id; } },
    vision: { model: { id: "vision" }, streamFn: (model) => model.id }, affordable: () => 180_000 * 2.5 / 1e6 <= budget.remainingCostUsd() });
  assert.equal(streamFn({ id: "text" }, { messages: [user("x"), assistant("screenshot"), toolResult(image)] }), "text");
  assert.equal(images(sent[0]), 0, "the text model gets the stub");
});
