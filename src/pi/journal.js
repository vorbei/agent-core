// The branch journal: a Pi SessionManager journal loaded into a turn's temp directory, the
// reconciliation of a changed message view onto it as a new branch (a settled result replacing its
// waiting receipt, a compaction re-appended after kept entries, custom entries retained), and the
// model messages a checkpoint holds. From X Gardener src/pi/journal.js.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_VERSION } from "./entry-types.js";

export function checkpointMessages(checkpoint = {}) {
  // Compatibility branch: legacy settlement replaced messages without updating piSession. Prefer
  // that projection ONLY for legacy records; v2 has one authoritative native journal. Removal
  // condition: no checkpoint without checkpointVersion 2 remains (pi_journal_inventory
  // byCheckpointVersion); test packages/agent-core/test/pi/journal.test.js.
  if (checkpoint.checkpointVersion !== CHECKPOINT_VERSION && Array.isArray(checkpoint.messages)) return checkpoint.messages;
  return checkpoint.piSession?.entries ? buildSessionContext(checkpoint.piSession.entries, checkpoint.piSession.leafId).messages : [];
}

export function loadJournal(cwd, journal, sessionId) {
  // Legacy thread IDs can contain ':'; they remain public thread IDs, not Pi
  // filesystem-safe session IDs. Let upstream allocate an ID and persist it once.
  if (!journal?.header || !Array.isArray(journal.entries)) return SessionManager.inMemory(cwd,
    { id: typeof sessionId === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId) ? sessionId : undefined });
  const path = join(cwd, "session.jsonl");
  writeFileSync(path, [journal.header, ...journal.entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const manager = SessionManager.open(path, cwd, cwd);
  if (journal.leafId === null) manager.resetLeaf();
  else if (journal.leafId) manager.branch(journal.leafId);
  return manager;
}

export function snapshotJournal(manager) {
  // Preserve original branches for exact history reads; leafId owns the model view.
  return structuredClone({ header: manager.getHeader(), entries: manager.getEntries(), leafId: manager.getLeafId() });
}

// Browser replacement and legacy conversion use upstream branch/append APIs.
// They do not need a model, ResourceLoader or a live AgentSession.
export function checkpointWithMessages(checkpoint, messages, sessionId) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-journal-"));
  try {
    const manager = loadJournal(cwd, checkpoint.piSession, sessionId);
    reconcileMessages(manager, messages);
    return nativeCheckpoint({ ...checkpoint, piSession: snapshotJournal(manager) });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// Call with a current native snapshot, not a legacy journal/projection pair.
export function nativeCheckpoint(checkpoint) {
  if (!checkpoint.piSession?.header || !Array.isArray(checkpoint.piSession.entries)) throw new Error("PI_JOURNAL_REQUIRED");
  const { messages: _messages, finalText: _text, error: _error, errorCode: _code, ...record } = checkpoint;
  return { ...record, checkpointVersion: CHECKPOINT_VERSION };
}

export function reconcileMessages(manager, messages) {
  const current = manager.buildSessionContext().messages;
  if (sameMessages(current, messages)) return;
  const branch = manager.getBranch();
  const view = manager.buildContextEntries().filter(entry => sessionEntryToContextMessages(entry).length);
  if (view[0]?.type === "compaction" && view.length === current.length) return reconcileCompacted(manager, branch, view, current, messages);
  // Compare against the same projection Pi builds: message and custom-message
  // entries in branch order, with key order ignored. A typed custom message must
  // not read as a divergence that re-appends the whole history on a new branch.
  const entries = branch.filter(entry => entry.type === "message" || entry.type === "custom_message");
  const projected = entries.length === current.length ? current : entries.map(entry => entry.type === "message" ? entry.message : null);
  let common = 0;
  while (common < messages.length && common < entries.length && projected[common] !== null &&
    sameMessage(projected[common], messages[common])) common++;
  if (common) manager.branch(entries[common - 1].id);
  else manager.resetLeaf();
  retainCustomEntries(manager, branch);
  appendMessages(manager, messages.slice(common));
}

// A Pi compaction projects as [summary, entries kept from before it, entries after it].
// Kept entries sit before the compaction on the path, so a change among them (a
// browser result replacing its waiting receipt) re-appends the compaction after them.
function reconcileCompacted(manager, branch, view, current, messages) {
  const [compaction] = view;
  const position = new Map(branch.map((entry, index) => [entry.id, index]));
  const keptEnd = 1 + view.slice(1).filter(entry => position.get(entry.id) < position.get(compaction.id)).length;
  let common = 0;
  while (common < messages.length && common < current.length && sameMessage(current[common], messages[common])) common++;
  if (common === 0) { manager.resetLeaf(); retainCustomEntries(manager, branch); appendMessages(manager, messages); return; }
  if (common >= keptEnd) {
    manager.branch(common > keptEnd ? view[common - 1].id : compaction.id);
    retainCustomEntries(manager, branch);
    appendMessages(manager, messages.slice(common));
    return;
  }
  const from = view[common];
  if (from.parentId) manager.branch(from.parentId);
  else manager.resetLeaf();
  retainCustomEntries(manager, branch);
  const firstKept = appendMessages(manager, messages.slice(common, keptEnd))[0];
  manager.appendCompaction(compaction.summary, common === 1 ? firstKept : compaction.firstKeptEntryId,
    compaction.tokensBefore, compaction.details, compaction.fromHook, compaction.usage);
  appendMessages(manager, messages.slice(keptEnd));
}

// Pi custom entries are plugin state, not model messages. Keep them when
// replacing a tool receipt or compacting the model view onto a new branch.
function retainCustomEntries(manager, branch) {
  const retained = new Set(manager.getBranch().map(entry => entry.id));
  for (const entry of branch) if (entry.type === 'custom' && !retained.has(entry.id)) {
    manager.appendCustomEntry(entry.customType, structuredClone(entry.data));
  }
}

function appendMessages(manager, messages) {
  return messages.map(message => message.role === "custom"
    ? manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details)
    : manager.appendMessage(structuredClone(message)));
}

function sameMessages(a, b) {
  return a.length === b.length && a.every((message, index) => sameMessage(message, b[index]));
}

// Pi projects a custom-message entry with the entry's append time, which can
// differ by milliseconds from the in-memory message; identity is its typed content.
function sameMessage(a, b) {
  if (a?.role === "custom" || b?.role === "custom") {
    const strip = message => message?.role === "custom" ? { ...message, timestamp: undefined } : message;
    return JSON.stringify(canonical(strip(a))) === JSON.stringify(canonical(strip(b)));
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
