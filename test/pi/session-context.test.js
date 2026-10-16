import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SESSION_CONTEXT_VERSION, nativeCheckpoint, restoreSessionMessages, snapshotJournal } from "agent-core/pi";

const user = text => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "p", model: "m",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 2 });
const texts = messages => messages.map(message => message.content[0].text);

function current(messages, extra = {}) {
  const manager = SessionManager.inMemory();
  for (const message of messages) manager.appendMessage(message);
  return JSON.stringify(nativeCheckpoint({ sessionContextVersion: SESSION_CONTEXT_VERSION, piSession: snapshotJournal(manager), ...extra }));
}

test("the latest current checkpoint is the whole prior conversation", () => {
  const rows = [
    { turn_id: "a", status: "completed", input_json: '{"text":"one"}', final_answer: "first", checkpoint_json: null },
    { turn_id: "b", status: "completed", input_json: '{"text":"two"}', checkpoint_json: current([user("one"), assistant("first"), user("two"), assistant("second")]) }
  ];
  assert.deepEqual(texts(restoreSessionMessages(rows)), ["one", "first", "two", "second"]);
});

test("a failed turn's history is kept with a note that it ended without completion", () => {
  const restored = restoreSessionMessages([{ turn_id: "f", status: "failed", error_code: "MODEL_HTTP_503",
    checkpoint_json: current([user("go"), assistant("half")]), updated_at: "2026-01-01T00:00:00.000Z" }]);
  assert.deepEqual(texts(restored).slice(0, 2), ["go", "half"]);
  const note = JSON.parse(restored.at(-1).content[0].text);
  assert.deepEqual([note.historicalTurn, note.status, note.errorCode], ["f", "failed", "MODEL_HTTP_503"]);
});

test("older rows are rebuilt turn by turn (session context v1 and v2 compatibility)", () => {
  const v1 = JSON.stringify({ sessionContextVersion: 1, messages: [user("old"), assistant("cumulative")] });
  const rows = [
    { turn_id: "x", status: "completed", input_json: '{"text":"bare"}', final_answer: "bare answer", checkpoint_json: null, created_at: "2026-01-01T00:00:00.000Z" },
    { turn_id: "y", status: "completed", input_json: '{"text":"old"}', checkpoint_json: v1 },
    { turn_id: "z", status: "failed", input_json: '{"text":"next"}', checkpoint_json: JSON.stringify({ sessionContextVersion: 2, messages: [user("old"), user("next"), assistant("partial")] }) }
  ];
  // v1 continuous journals were cumulative: they replace what came before. A failed v2 turn keeps only its own suffix.
  const restored = restoreSessionMessages(rows);
  assert.deepEqual(texts(restored).slice(0, 4), ["old", "cumulative", "next", "partial"]);
  assert.equal(restored.length, 5);
  assert.equal(JSON.parse(restored.at(-1).content[0].text).historicalTurn, "z");
});
