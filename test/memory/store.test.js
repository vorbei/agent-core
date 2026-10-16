import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confirmedInstructions, confirmInstruction, editInstruction, forgetMemory, listInstructions, MEMORY_SCHEMA, remember, rememberPermission, searchMemory,
} from "../../src/memory/index.js";
import { sqliteStorage } from "./sqlite-storage.js";

function store() {
  const storage = sqliteStorage();
  for (const statement of MEMORY_SCHEMA) storage.sql.exec(statement);
  return storage;
}

test("an agent's instruction reaches the prompt only after the user confirms it", () => {
  const storage = store();
  const saved = remember(storage, { kind: "instruction", content: "Answer in English.", sourceType: "agent" });
  assert.deepEqual(confirmedInstructions(storage), []);
  assert.deepEqual(listInstructions(storage).map(item => [item.content, item.confirmed]), [["Answer in English.", false]]);
  confirmInstruction(storage, saved.memory_id);
  assert.deepEqual(confirmedInstructions(storage), ["Answer in English."]);
  editInstruction(storage, saved.memory_id, "Answer in German.");
  assert.deepEqual(confirmedInstructions(storage), ["Answer in German."]);
  assert.throws(() => editInstruction(storage, saved.memory_id, "x".repeat(501)), { code: "MEMORY_INVALID" });
  assert.throws(() => confirmInstruction(storage, "mem_missing"), { code: "MEMORY_NOT_FOUND" });
});

test("prompt instructions are bounded: newest first, expired ones out, within the total budget", () => {
  const storage = store();
  for (let index = 0; index < 10; index++) {
    const saved = remember(storage, { kind: "instruction", content: `${index} ${"r".repeat(400)}`, sourceType: "agent" }, `2026-01-01T00:00:0${index}.000Z`);
    confirmInstruction(storage, saved.memory_id, `2026-01-01T00:00:${10 + index}.000Z`);
  }
  const expiring = remember(storage, { kind: "instruction", content: "old rule", sourceType: "agent", expiresAt: "2026-01-02T00:00:00.000Z" });
  confirmInstruction(storage, expiring.memory_id, "2026-01-01T00:01:00.000Z");
  const now = "2026-02-01T00:00:00.000Z";
  const shown = confirmedInstructions(storage, now);
  assert.ok(!shown.includes("old rule"));
  assert.equal(shown.length, 4); // 4 x 402 characters fit in 2000; the fifth would not
  assert.match(shown[0], /^9 /);
});

test("a save deduplicates, supersedes within its source type, and never replaces a confirmed memory", () => {
  const storage = store();
  const first = remember(storage, { kind: "fact", content: "Lives in Berlin", sourceType: "agent", sourceId: "home" });
  assert.equal(remember(storage, { kind: "fact", content: "Lives in Berlin", sourceType: "agent", sourceId: "home" }).memory_id, first.memory_id);
  const moved = remember(storage, { kind: "fact", content: "Lives in Paris", sourceType: "agent", sourceId: "home" });
  assert.deepEqual(searchMemory(storage, { query: "Lives" }).map(row => row.content), ["Lives in Paris"]);

  const rule = remember(storage, { kind: "instruction", content: "Be brief.", sourceType: "agent" });
  confirmInstruction(storage, rule.memory_id);
  const attempt = remember(storage, { kind: "instruction", content: "Be verbose.", sourceType: "agent", supersedes: rule.memory_id });
  assert.deepEqual(attempt.replacement, { requestedMemoryId: rule.memory_id, applied: false, targetScope: { kind: "instruction", sourceType: "user_confirmed" } });
  assert.ok(confirmedInstructions(storage).includes("Be brief."));
  // The agent cannot forget it either; the user's own delete can.
  assert.deepEqual(forgetMemory(storage, rule.memory_id), { memoryId: rule.memory_id, forgotten: false, reason: "user_confirmed" });
  assert.ok(confirmedInstructions(storage).includes("Be brief."));
  assert.equal(forgetMemory(storage, rule.memory_id, { userInitiated: true }).forgotten, true);
  assert.ok(!confirmedInstructions(storage).includes("Be brief."));

  const replaced = remember(storage, { kind: "fact", content: "Lives in Rome", sourceType: "agent", supersedes: moved.memory_id });
  assert.equal(replaced.replacement?.applied, true);
  assert.equal(forgetMemory(storage, replaced.memory_id).forgotten, true);
  assert.deepEqual(searchMemory(storage, { query: "Lives" }), []);
});

test("search is a literal substring: LIKE wildcards in the query match only themselves", () => {
  const storage = store();
  remember(storage, { kind: "fact", content: "100% sure", sourceType: "agent" });
  remember(storage, { kind: "fact", content: "1000 sure", sourceType: "agent" });
  assert.deepEqual(searchMemory(storage, { query: "100%" }).map(row => row.content), ["100% sure"]);
});

test("which saves need the Update permission", () => {
  assert.equal(rememberPermission({ kind: "instruction" }), null);
  assert.equal(rememberPermission({ kind: "event", browser: {} }), null);
  assert.equal(rememberPermission({ kind: "fact" }), "update");
  assert.equal(rememberPermission({ kind: "event" }), "update");
  assert.equal(rememberPermission({ kind: "instruction", supersedes: "mem_1" }), "update");
});
