import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confirmedInstructions, confirmInstruction, MEMORY_SCHEMA, memoryStore, memoryToolPermission, offeredMemoryTools, runMemoryTool, searchMemory,
} from "../../src/memory/index.js";
import { sqliteStorage } from "./sqlite-storage.js";

function store() {
  const storage = sqliteStorage();
  for (const statement of MEMORY_SCHEMA) storage.sql.exec(statement);
  return storage;
}

test("a message without the update permission may search and save a new instruction, never change or forget a memory", () => {
  assert.deepEqual(offeredMemoryTools({ update: false }), ["search_memory", "remember"]);
  assert.deepEqual(offeredMemoryTools({ update: true }), ["search_memory", "remember", "forget_memory"]);
  assert.equal(memoryToolPermission("search_memory", { query: "x" }), null);
  assert.equal(memoryToolPermission("remember", { kind: "instruction", content: "Answer briefly." }), null);
  assert.equal(memoryToolPermission("remember", { kind: "fact", content: "Lives in Berlin." }), "update");
  assert.equal(memoryToolPermission("remember", { kind: "instruction", content: "x", supersedes: "mem_1" }), "update");
  assert.equal(memoryToolPermission("forget_memory", { memoryId: "mem_1" }), "update");
  assert.throws(() => memoryToolPermission("propose_action", {}), { code: "MEMORY_INVALID" });
});

test("what the model saves is its own, never confirmed, and its forget keeps what the user confirmed", () => {
  const storage = store();
  const memory = memoryStore(storage);
  const saved = runMemoryTool(memory, "remember", { kind: "instruction", content: "Answer in English.", sourceType: "user_confirmed" }, { turnId: "turn_1" });
  assert.equal(saved.source_type, "agent");
  assert.deepEqual(confirmedInstructions(storage), []);
  confirmInstruction(storage, saved.memory_id);
  assert.deepEqual(runMemoryTool(memory, "forget_memory", { memoryId: saved.memory_id, userInitiated: true }),
    { memoryId: saved.memory_id, forgotten: false, reason: "user_confirmed" });
  assert.deepEqual(confirmedInstructions(storage), ["Answer in English."]);
  const fact = runMemoryTool(memory, "remember", { kind: "fact", content: "Prefers trains." });
  assert.equal(runMemoryTool(memory, "forget_memory", { memoryId: fact.memory_id }).forgotten, true);
  assert.deepEqual(runMemoryTool(memory, "search_memory", { query: "Prefers" }), searchMemory(storage, { query: "Prefers" }));
});
