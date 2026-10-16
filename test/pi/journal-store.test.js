import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  PI_JOURNAL_SCHEMA, checkpointForStorage, checkpointMessages, hydrateCheckpoint, inventoryPiJournal, migratePiJournal,
  nativeCheckpoint, serializeCheckpoint, snapshotJournal, writeJournalResult
} from "agent-core/pi";

function storage() {
  const db = new DatabaseSync(":memory:");
  const store = {
    sql: { exec(query, ...args) {
      if (/^\s*(SELECT|WITH)\b/i.test(query)) return { toArray: () => db.prepare(query).all(...args) };
      if (args.length) db.prepare(query).run(...args); else db.exec(query);
      return { toArray: () => [] };
    } },
    transactionSync(fn) {
      db.exec("SAVEPOINT t");
      try { const value = fn(); db.exec("RELEASE t"); return value; }
      catch (error) { db.exec("ROLLBACK TO t; RELEASE t"); throw error; }
    }
  };
  for (const statement of PI_JOURNAL_SCHEMA) store.sql.exec(statement);
  store.sql.exec(`CREATE TABLE agent_turns (turn_id TEXT, session_id TEXT, status TEXT, journal_format INTEGER, checkpoint_json TEXT)`);
  return store;
}

const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const call = id => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }], api: "x", provider: "p", model: "m",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: 2 });
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3 });

function journal(messages) {
  const manager = SessionManager.inMemory();
  for (const message of messages) manager.appendMessage(message);
  return snapshotJournal(manager);
}

test("format 2 stores the journal as rows and a header, and reads back the same messages", () => {
  const store = storage();
  const turn = { session_id: "s", journal_format: 2 };
  const checkpoint = nativeCheckpoint({ piSession: journal([user("hi", 1), call("c1"), result("c1", "waiting")]), budget: { modelCalls: 1 } });
  const stored = checkpointForStorage(store, turn, checkpoint);
  assert.equal(stored.piSession.format, 2);
  assert.equal(stored.piSession.entries, undefined, "the header carries no inline entries");
  assert.equal(store.sql.exec("SELECT COUNT(*) AS n FROM pi_journal_entries").toArray()[0].n, 3);
  assert.deepEqual(checkpointMessages(hydrateCheckpoint(store, turn, stored)), checkpointMessages(checkpoint));
  // Writing the same journal again appends nothing.
  checkpointForStorage(store, turn, checkpoint);
  assert.equal(store.sql.exec("SELECT COUNT(*) AS n FROM pi_journal_entries").toArray()[0].n, 3);
});

test("format 1 keeps the journal inline (compatibility branch)", () => {
  const store = storage();
  const checkpoint = nativeCheckpoint({ piSession: journal([user("hi", 1)]) });
  assert.equal(checkpointForStorage(store, { session_id: "s", journal_format: 1 }, checkpoint), checkpoint);
  assert.equal(hydrateCheckpoint(store, { session_id: "s", journal_format: 1 }, checkpoint), checkpoint);
  // Legacy settlement replaced messages without a journal; those records still read.
  assert.deepEqual(checkpointMessages({ messages: [user("legacy", 1)] }), [user("legacy", 1)]);
});

test("a settled result replaces its waiting tool result as a new branch, keeping the old one", () => {
  const store = storage();
  const turn = { session_id: "s", journal_format: 2 };
  const waiting = checkpointForStorage(store, turn, nativeCheckpoint({ piSession: journal([user("hi", 1), call("c1"), result("c1", "waiting")]) }));
  const written = writeJournalResult(store, { ...turn, checkpoint_json: JSON.stringify(waiting) }, checkpoint => ({
    messages: checkpointMessages(checkpoint).map(message => message.role === "toolResult" ? result("c1", "the page") : message),
    receipt: "kept"
  }));
  assert.equal(written.receipt, "kept", "the product's other fields come back");
  const messages = checkpointMessages(hydrateCheckpoint(store, turn, JSON.parse(written.checkpointJson)));
  assert.equal(messages.at(-1).content[0].text, "the page");
  assert.equal(store.sql.exec("SELECT COUNT(*) AS n FROM pi_journal_entries").toArray()[0].n, 4, "the waiting entry stays on its branch");
});

test("a stored checkpoint has a byte ceiling, measured after the product's encoding", () => {
  assert.throws(() => serializeCheckpoint({ text: "x".repeat(2_000_000) }), { code: "CHECKPOINT_TOO_LARGE" });
  assert.equal(serializeCheckpoint({ image: "x".repeat(2_000_000) }, { encode: () => ({ image: "ref" }) }), '{"image":"ref"}');
});

test("migration from format 1 is a validated dry run unless the product enables apply", () => {
  const store = storage();
  const checkpoint = nativeCheckpoint({ piSession: journal([user("hi", 1)]) });
  store.sql.exec("INSERT INTO agent_turns VALUES ('t1', 's', 'completed', 1, ?)", JSON.stringify(checkpoint));
  assert.equal(inventoryPiJournal(store).migratable, 1);
  assert.deepEqual(migratePiJournal(store).validated, 1);
  assert.equal(store.sql.exec("SELECT journal_format FROM agent_turns").toArray()[0].journal_format, 1, "a dry run writes nothing");
  assert.throws(() => migratePiJournal(store, { apply: true }), { code: "PI_JOURNAL_MIGRATION_DISABLED" });
  assert.equal(migratePiJournal(store, { apply: true, applyEnabled: true }).migrated, 1);
  assert.equal(inventoryPiJournal(store).byFormat["2"], 1);
});
