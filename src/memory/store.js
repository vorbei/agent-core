// Long-term account memory over a SQL store shaped like a Durable Object's (`storage.sql.exec`,
// `storage.transactionSync`): what the agent may save (facts, events, standing instructions),
// how a save is deduplicated and supersedes an older one, what the user confirms, and which
// confirmed instructions reach the system prompt. From X Gardener src/sqlite/cf/memory.js,
// src/cf/account/memory-view.js and contract/agent-tools.js (rememberPermission).

/** @typedef {import("./index.js").SqlStorage} SqlStorage */
/** @typedef {import("./index.js").MemoryRow} MemoryRow */
/** @typedef {import("./index.js").RememberInput} RememberInput */

/** Instructions are one short rule each; only confirmed ones reach the prompt, within these bounds. */
export const MEMORY_INSTRUCTION_MAX = 500;
const PROMPT_INSTRUCTIONS = 8;
const PROMPT_INSTRUCTION_CHARS = 2_000;
const SEARCH_LIMIT = 20;

/** The `memories` table and its index, one statement each (X Gardener's account schema; a consumer may already have it). */
export const MEMORY_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memories (
    memory_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'instruction', 'event')),
    content TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    evidence_json TEXT,
    confidence REAL,
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'forgotten')),
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT)`,
  "CREATE INDEX IF NOT EXISTS memories_active ON memories(status, kind, updated_at DESC)",
]);

export class MemoryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "MemoryError"; this.code = code; }
}

/** @param {SqlStorage} storage @param {string} query @param {unknown[]} bindings @returns {any[]} */
const rows = (storage, query, ...bindings) => storage.sql.exec(query, ...bindings).toArray();
/** @param {SqlStorage} storage @param {string} query @param {unknown[]} bindings @returns {any} */
const one = (storage, query, ...bindings) => rows(storage, query, ...bindings)[0] ?? null;
const isoNow = () => new Date().toISOString();

/**
 * The permission a `remember` call needs. A new instruction needs none: it waits for the user's
 * confirmation before it can reach the prompt. A new browser-experience note is a hint for later
 * runs on that website (it can never authorize an action). Facts, plain events and replacements
 * change what the agent recalls at once, so they need Update.
 * @param {{ kind?: string, supersedes?: string, browser?: unknown }} input @returns {"update" | null}
 */
export function rememberPermission(input) {
  if (input.supersedes) return "update";
  if (input.kind === "instruction" && !input.browser) return null;
  if (input.kind === "event" && input.browser) return null;
  return "update";
}

/**
 * Active memories whose content contains `query` (a literal substring, not a semantic search),
 * newest first. A legacy `user` source (model-authored during a user turn) is shown as `agent`.
 * @param {SqlStorage} storage @param {{ query?: string, limit?: number }} [options] @param {string} [now]
 * @returns {MemoryRow[]}
 */
export function searchMemory(storage, { query = "", limit = 10 } = {}, now = isoNow()) {
  const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return rows(storage, `SELECT * FROM memories WHERE status = 'active'
    AND (expires_at IS NULL OR expires_at > ?) AND content LIKE ? ESCAPE '\\'
    ORDER BY updated_at DESC LIMIT ?`, now, pattern, Math.min(limit, SEARCH_LIMIT))
    .map(row => row.source_type === "user" ? { ...row, source_type: "agent", recorded_source_type: "user" } : row);
}

/**
 * The confirmed, unexpired standing instructions for the system prompt: newest first, at most
 * eight, each cut to the instruction limit, within a total budget.
 * @param {SqlStorage} storage @param {string} [now] @returns {string[]}
 */
export function confirmedInstructions(storage, now = isoNow()) {
  let used = 0;
  return rows(storage, `SELECT content FROM memories WHERE status = 'active' AND kind = 'instruction'
    AND source_type = 'user_confirmed' AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY updated_at DESC LIMIT ${PROMPT_INSTRUCTIONS}`, now).flatMap(row => {
    const content = String(row.content || "").trim().slice(0, MEMORY_INSTRUCTION_MAX);
    if (!content || used + content.length > PROMPT_INSTRUCTION_CHARS) return [];
    used += content.length;
    return [content];
  });
}

/**
 * Saves a memory. An identical active memory (same kind, content, source and expiry) is returned
 * instead of a copy, unless a replacement is requested. A new memory supersedes, in the same
 * transaction, the active ones of its kind with the same source id, or the one named by
 * `supersedes`, but only within its own source type (an agent save never replaces a memory the
 * user confirmed; it may replace a legacy `user` one).
 * @param {SqlStorage} storage @param {RememberInput} input @param {string} [now]
 */
export function remember(storage, input, now = isoNow()) {
  const sourceId = input.sourceId || null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
  const duplicate = one(storage, `SELECT * FROM memories WHERE status = 'active' AND kind = ? AND content = ?
    AND source_type = ? AND source_id IS ? AND expires_at IS ? LIMIT 1`, input.kind, input.content, input.sourceType, sourceId, expiresAt);
  if (duplicate && !input.supersedes) return duplicate;
  const memoryId = `mem_${crypto.randomUUID().replaceAll("-", "")}`;
  const evidence = { sourceType: input.sourceType, sourceId, sourceIds: input.sourceIds || [], turnId: input.turnId || null, supersedes: input.supersedes || null };
  storage.transactionSync(() => {
    storage.sql.exec(`INSERT INTO memories
      (memory_id, kind, content, source_type, source_id, evidence_json, confidence, status, superseded_by, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
    memoryId, input.kind, input.content, input.sourceType, sourceId, JSON.stringify(evidence), input.confidence ?? null, now, now, expiresAt);
    if (sourceId || input.supersedes) storage.sql.exec(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ?
      WHERE memory_id != ? AND status = 'active' AND kind = ?
      AND (source_type = ? OR (source_type = 'user' AND ? = 'agent'))
      AND ((? IS NOT NULL AND source_id = ?) OR memory_id = ?)`,
    memoryId, now, memoryId, input.kind, input.sourceType, input.sourceType, sourceId, sourceId, input.supersedes || null);
  });
  return replacementReceipt(storage, one(storage, "SELECT * FROM memories WHERE memory_id = ?", memoryId), input.supersedes);
}

/**
 * The saved row, plus — when a replacement was requested — whether it was applied, and if not,
 * the scope of the memory that stayed unchanged.
 * @param {SqlStorage} storage @param {MemoryRow} saved @param {string | undefined} requestedMemoryId
 */
export function replacementReceipt(storage, saved, requestedMemoryId) {
  if (!requestedMemoryId) return saved;
  const target = one(storage, "SELECT kind, source_type, evidence_json, superseded_by FROM memories WHERE memory_id = ?", requestedMemoryId);
  const applied = target?.superseded_by === saved.memory_id;
  /** @type {Record<string, any>} */
  const replacement = { requestedMemoryId, applied };
  if (!applied) {
    replacement.targetScope = target ? { kind: target.kind, sourceType: target.source_type } : null;
    if (target?.source_type === "browser_experience") {
      const { website, flow } = JSON.parse(target.evidence_json);
      replacement.targetScope.browser = { website, flow };
    }
  }
  return { ...saved, replacement };
}

/**
 * Marks one memory forgotten; history is not rewritten. A memory the user confirmed is forgotten
 * only on the user's own request (`userInitiated`, the Memory view's delete), never by the
 * agent's forget tool — the same guard as a replacement: the refusal is a receipt with
 * `forgotten: false` and `reason: "user_confirmed"`, and the memory stays active.
 * @param {SqlStorage} storage @param {string} memoryId @param {{ userInitiated?: boolean, now?: string }} [options]
 * @returns {{ memoryId: string, forgotten: boolean, reason?: "user_confirmed" }}
 */
export function forgetMemory(storage, memoryId, { userInitiated = false, now = isoNow() } = {}) {
  const target = one(storage, "SELECT source_type, status FROM memories WHERE memory_id = ?", memoryId);
  if (target?.status === "active" && target.source_type === "user_confirmed" && !userInitiated) return { memoryId, forgotten: false, reason: "user_confirmed" };
  storage.sql.exec("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE memory_id = ?", now, memoryId);
  return { memoryId, forgotten: Boolean(one(storage, "SELECT memory_id FROM memories WHERE memory_id = ? AND status = 'forgotten'", memoryId)) };
}

/** The account's active standing instructions for the user's Memory view, newest first. @param {SqlStorage} storage */
export function listInstructions(storage) {
  return rows(storage, `SELECT memory_id, content, source_type, created_at, updated_at, expires_at FROM memories
    WHERE status = 'active' AND kind = 'instruction' ORDER BY updated_at DESC LIMIT 100`)
    .map(row => ({ memoryId: row.memory_id, content: row.content, confirmed: row.source_type === "user_confirmed",
      createdAt: row.created_at, expiresAt: row.expires_at || null }));
}

/**
 * The user confirms an instruction the agent saved; only then can it reach the prompt. Never an
 * agent tool.
 * @param {SqlStorage} storage @param {string} memoryId @param {string} [now]
 */
export function confirmInstruction(storage, memoryId, now = isoNow()) {
  if (!one(storage, "SELECT memory_id FROM memories WHERE memory_id = ? AND kind = 'instruction' AND status = 'active'", memoryId)) {
    throw new MemoryError("MEMORY_NOT_FOUND", "No active instruction with that id");
  }
  storage.sql.exec("UPDATE memories SET source_type = 'user_confirmed', updated_at = ? WHERE memory_id = ?", now, memoryId);
  return { memoryId, confirmed: true };
}

/**
 * The user's wording replaces the agent's; a confirmed instruction stays confirmed.
 * @param {SqlStorage} storage @param {string} memoryId @param {unknown} content @param {string} [now]
 */
export function editInstruction(storage, memoryId, content, now = isoNow()) {
  const text = String(content ?? "").trim();
  if (!text || text.length > MEMORY_INSTRUCTION_MAX) throw new MemoryError("MEMORY_INVALID", `An instruction is 1 to ${MEMORY_INSTRUCTION_MAX} characters`);
  if (!one(storage, "SELECT memory_id FROM memories WHERE memory_id = ? AND kind = 'instruction' AND status = 'active'", memoryId)) {
    throw new MemoryError("MEMORY_NOT_FOUND", "No active instruction with that id");
  }
  storage.sql.exec("UPDATE memories SET content = ?, updated_at = ? WHERE memory_id = ?", text, now, memoryId);
  return { memoryId, content: text };
}
