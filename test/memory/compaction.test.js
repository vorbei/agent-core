import { test } from "node:test";
import assert from "node:assert/strict";
import { contextCompactionSettings, estimateContextTokens, piCompactionSettings, serializeContextForSummary } from "../../src/memory/index.js";

test("compaction settings fit the model window and keep their invariants", () => {
  const settings = contextCompactionSettings({ contextWindow: 200_000, maxTokens: 20_000 }, { compactAtTokens: 150_000, backgroundTokens: 100_000 });
  assert.equal(settings.triggerTokens, 150_000);
  assert.equal(settings.keepRecentTokens, 50_000);
  // A background summary never starts where the cut would keep everything.
  assert.equal(settings.backgroundTokens, 100_000);
  assert.equal(settings.backgroundCompactAtTokens, 50_000);
  assert.deepEqual(piCompactionSettings(settings), { enabled: true, reserveTokens: 50_000, keepRecentTokens: 50_000 });
  const notes = contextCompactionSettings({ contextWindow: 200_000, maxTokens: 20_000 }, { mode: "notes" });
  assert.equal(notes.triggerTokens, 180_000);
  assert.throws(() => contextCompactionSettings(undefined, { compactAtTokens: "0" }), /Invalid context compactAtTokens/);
});

test("token estimate counts ASCII by four, other characters one each, images a fixed reserve", () => {
  assert.equal(estimateContextTokens([{ role: "user", content: "abcdefgh" }]), 6);
  assert.equal(estimateContextTokens([{ role: "user", content: [{ type: "text", text: "中文" }, { type: "image" }] }]), 4 + 4096 + 2);
});

test("history for a summarizer: roles, tool calls, and long tool results cut", () => {
  const text = serializeContextForSummary([
    { role: "user", content: "find it" },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", name: "browser", arguments: { action: "snapshot" } }] },
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(2_100) }] },
  ]);
  assert.match(text, /^\[User\]: find it\n\n\[Assistant\]: Looking\.\n\n\[Assistant tool calls\]: browser\({"action":"snapshot"}\)\n\n\[Tool result\]: x{2000}\n\[truncated\]$/);
});
