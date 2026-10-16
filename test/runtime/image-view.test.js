import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_IMAGE_VIEW, pruneToolImages } from "../../src/runtime/index.js";

const user = { role: "user", content: "Open Settings > General > About", timestamp: 1 };
const step = (n) => [
  { role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name: "browser", arguments: { action: "screenshot" } }], timestamp: 1000 + n },
  { role: "toolResult", toolCallId: `c${n}`, toolName: "browser", timestamp: Date.UTC(2026, 9, 12, 10, 27, n),
    content: [{ type: "text", text: `{"step":${n}}` }, { type: "image", mimeType: "image/jpeg", data: `IMG${n}` }] }
];
const history = (count) => [user, ...Array.from({ length: count }, (_, index) => step(index + 1)).flat()];
const images = (messages) => messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []);

test("the model view keeps the latest images and stubs older ones, saying what and when", () => {
  const { keep, step: block } = TOOL_IMAGE_VIEW;
  for (let count = 0; count <= 30; count++) {
    const kept = images(pruneToolImages(history(count))).length;
    assert.ok(kept >= Math.min(count, keep) && kept <= keep + block - 1, `${count} images -> ${kept} kept`);
  }
  const view = pruneToolImages(history(30));
  assert.deepEqual(images(view).map((image) => image.data).at(-1), "IMG30", "the newest picture is always there");
  const stub = view.find((message) => message.role === "toolResult").content[1];
  assert.match(stub.text, /Image omitted .* browser picture taken at 2026-10-12T10:27:01\.000Z/);
  const journal = history(30);
  pruneToolImages(journal);
  assert.equal(images(journal).length, 30, "the journal keeps every image");
});

test("the cut moves in blocks, so a growing turn rewrites its cached prefix once per block, not every request", () => {
  // Each request's view against the previous one: the earlier request's whole view must be an
  // unchanged prefix of the next, except when a block of images is dropped.
  let rewrites = 0;
  let previous = null;
  for (let count = 1; count <= 30; count++) {
    const view = JSON.stringify(pruneToolImages(history(count)).slice(0, -2));
    if (previous !== null && view !== previous) rewrites++;
    previous = JSON.stringify(pruneToolImages(history(count)));
  }
  assert.ok(rewrites <= Math.ceil(30 / TOOL_IMAGE_VIEW.step), `${rewrites} prefix rewrites over 30 screenshots`);
  assert.ok(rewrites >= 1);
  // Keeping only the latest image on every request (what pi-do did) rewrites on every new image.
  let naive = 0;
  previous = null;
  for (let count = 1; count <= 30; count++) {
    const view = JSON.stringify(pruneToolImages(history(count), { keep: 1, step: 1 }).slice(0, -2));
    if (previous !== null && view !== previous) naive++;
    previous = JSON.stringify(pruneToolImages(history(count), { keep: 1, step: 1 }));
  }
  assert.equal(naive, 29);
});
