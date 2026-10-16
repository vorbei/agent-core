import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_SCHEMA, mergeSteer, releaseSteers, takeSteer, unset } from "../../src/runtime/index.js";
import { sqliteStorage } from "../memory/sqlite-storage.js";

function fixture() {
  const storage = sqliteStorage();
  for (const statement of RUNTIME_SCHEMA) storage.sql.exec(statement);
  return { storage, now: () => Date.parse("2026-10-09T08:00:00.000Z"), log: () => {} };
}

function insert(host, turnId, input, permissions = {}) {
  host.storage.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, session_id, runtime_version, status, phase,
    permissions_json, input_json, idempotency_key, input_hash, created_at, updated_at)
    VALUES (?, 'acct', 'thread', 'thread', 'test', 'queued', 'queued', ?, ?, ?, 'h', '2026-10-09T08:00:00.000Z', '2026-10-09T08:00:00.000Z')`,
  turnId, JSON.stringify(permissions), JSON.stringify(input), `key-${turnId}`);
  return host.storage.sql.exec("SELECT rowid AS storage_rowid, * FROM agent_turns WHERE turn_id = ?", turnId).toArray()[0];
}
const input = (host, turnId) => JSON.parse(host.storage.sql.exec("SELECT input_json FROM agent_turns WHERE turn_id = ?", turnId).toArray()[0].input_json);
const status = (host, turnId) => host.storage.sql.exec("SELECT status FROM agent_turns WHERE turn_id = ?", turnId).toArray()[0].status;

test("the oldest steer the product accepts is taken once, placed with its journal entry, and released when its attempt is lost", () => {
  const host = fixture();
  const running = insert(host, "run", { text: "start" });
  insert(host, "queued", { text: "queue me", whileRunning: "queue" });
  insert(host, "write", { text: "needs write", whileRunning: "steer" }, { write: true });
  insert(host, "plain", { text: "and this", whileRunning: "steer" });
  const accepts = ({ permissions }) => unset(permissions.write);
  assert.deepEqual(takeSteer(host, { turn: running, leaseId: "lease-1", accepts }), { id: "plain", input: { text: "and this", whileRunning: "steer" } });
  assert.equal(input(host, "plain").placingLease, "lease-1");
  assert.equal(takeSteer(host, { turn: running, leaseId: "lease-1", accepts }), null, "a placing steer is not taken twice");

  releaseSteers(host, { threadId: "thread" });
  assert.equal(input(host, "plain").placingLease, undefined, "a new attempt releases a lost attempt's marks");
  takeSteer(host, { turn: running, leaseId: "lease-2", accepts });
  mergeSteer(host, { turnId: "run", steerId: "plain", leaseId: "lease-1" });
  assert.equal(status(host, "plain"), "queued", "only the attempt holding the mark can merge it");
  mergeSteer(host, { turnId: "run", steerId: "plain", leaseId: "lease-2" });
  assert.equal(status(host, "plain"), "completed");
  assert.deepEqual(input(host, "plain"), { text: "and this", whileRunning: "steer", mergedIntoTurnId: "run" });
  assert.equal(status(host, "write"), "queued", "a steer the product refuses waits for its own turn");
});

test("an attempt's end releases only its own marks", () => {
  const host = fixture();
  const running = insert(host, "run", { text: "start" });
  insert(host, "steer", { text: "more", whileRunning: "steer" });
  takeSteer(host, { turn: running, leaseId: "lease-1" });
  releaseSteers(host, { leaseId: "lease-other" });
  assert.equal(input(host, "steer").placingLease, "lease-1");
  releaseSteers(host, { leaseId: "lease-1" });
  assert.equal(input(host, "steer").placingLease, undefined);
  assert.deepEqual([undefined, null, false, 0, 1, true, "0"].map(unset), [true, true, true, true, false, false, false]);
});
