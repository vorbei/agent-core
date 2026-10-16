// Where a turn's Pi journal is stored: format 2 keeps journal entries as append-only
// `pi_journal_entries` rows and a small header in the turn's checkpoint; format 1 (a compatibility
// branch) keeps the whole journal inline in `checkpoint_json`. Reads materialize the active branch
// whatever the format; writes go to the turn's own format. From X Gardener
// src/cf/account/journal-store.js.
//
// Format 1 compatibility: removal condition "no format-1 checkpoint remains in production"
// (pi_journal_inventory byFormat has no "1"); test packages/agent-core/test/pi/journal-store.test.js
// and Gardener tests/pi-journal-store.test.js.
import { checkpointWithMessages } from "./journal.js";
import { PI_JOURNAL_FORMAT } from "./entry-types.js";

export const MAX_CHECKPOINT_BYTES = 1_800_000;

/** The journal table, byte-compatible with X Gardener's migration 14. */
export const PI_JOURNAL_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS pi_journal_entries (
      session_id TEXT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, entry_type TEXT NOT NULL,
      first_kept_entry_id TEXT, entry_seq INTEGER NOT NULL, entry_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, entry_id), UNIQUE (session_id, entry_seq))`,
  "CREATE INDEX IF NOT EXISTS pi_journal_parent ON pi_journal_entries(session_id, parent_id)"
]);

const rows = (storage, query, ...args) => storage.sql.exec(query, ...args).toArray();
const one = (storage, query, ...args) => rows(storage, query, ...args)[0] || null;
const identity = value => value;

/**
 * A checkpoint (or one journal entry) as stored JSON. `encode` replaces payloads the product
 * stores elsewhere with their references first. Throws CHECKPOINT_TOO_LARGE past the row limit.
 */
export function serializeCheckpoint(value, { encode = identity } = {}) {
  const json = JSON.stringify(encode(value));
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_CHECKPOINT_BYTES) throw Object.assign(new Error('CHECKPOINT_TOO_LARGE'),
    { code: 'CHECKPOINT_TOO_LARGE', bytes, maxBytes: MAX_CHECKPOINT_BYTES });
  return json;
}

/**
 * The checkpoint as the turn's format stores it. Format 2 appends the journal entries it does not
 * have yet and returns the header; format 1 returns the inline journal. Call inside the same
 * transaction as the turn's state update.
 */
export function checkpointForStorage(storage, turn, checkpoint, { encode = identity } = {}) {
  if (Number(turn.journal_format) !== PI_JOURNAL_FORMAT) {
    const cold = checkpoint?.piSession?.entries?.filter(entry => entry.coldPayload) || [];
    if (!cold.length) return checkpoint;
    // A format-1 write must not persist the sparse recovery view as inline history.
    const originals = new Map(rows(storage, `SELECT entry_id, entry_json FROM pi_journal_entries
      WHERE session_id = ? AND entry_id IN (SELECT value FROM json_each(?))`, turn.session_id,
    JSON.stringify(cold.map(entry => entry.id))).map(row => [row.entry_id, JSON.parse(row.entry_json)]));
    if (originals.size !== cold.length) throw new Error('PI_JOURNAL_COLD_PAYLOAD_MISSING');
    return { ...checkpoint, piSession: { ...checkpoint.piSession,
      entries: checkpoint.piSession.entries.map(entry => entry.coldPayload ? originals.get(entry.id) : entry) } };
  }
  const journal = checkpoint?.piSession;
  if (!journal?.header || !Array.isArray(journal.entries)) throw new Error('PI_JOURNAL_REQUIRED');
  const snapshotIds = journal.entries.map(entry => entry?.id).filter(Boolean);
  const existing = new Set(snapshotIds.length ? rows(storage, `SELECT entry_id FROM pi_journal_entries WHERE session_id = ?
    AND entry_id IN (SELECT value FROM json_each(?))`, turn.session_id, JSON.stringify(snapshotIds)).map(row => row.entry_id) : []);
  let sequence = Number(one(storage, 'SELECT COALESCE(MAX(entry_seq), -1) AS value FROM pi_journal_entries WHERE session_id = ?', turn.session_id)?.value ?? -1) + 1;
  const now = new Date().toISOString();
  for (const entry of journal.entries) {
    if (!entry?.id || existing.has(entry.id)) continue;
    storage.sql.exec(`INSERT INTO pi_journal_entries
      (session_id, entry_id, parent_id, entry_type, first_kept_entry_id, entry_seq, entry_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, turn.session_id, entry.id, entry.parentId || null, entry.type,
      entry.type === 'compaction' ? entry.firstKeptEntryId || null : null, sequence++, serializeCheckpoint(entry, { encode }), now);
  }
  return { ...checkpoint, piSession: {
    format: PI_JOURNAL_FORMAT, header: journal.header, leafId: journal.leafId,
    maxSeq: sequence - 1
  } };
}

/** One turn's checkpoint with its active journal branch materialized, whatever its format. */
export function readTurnCheckpoint(storage, turnId) {
  const row = one(storage, "SELECT session_id, journal_format, checkpoint_json FROM agent_turns WHERE turn_id = ?", turnId);
  if (!row) return null;
  return hydrateCheckpoint(storage, row, row.checkpoint_json ? JSON.parse(row.checkpoint_json) : {});
}

export function hydrateCheckpoint(storage, turn, checkpoint = {}) {
  const journal = checkpoint.piSession;
  if (!journal?.header || Array.isArray(journal.entries) || Number(turn.journal_format) !== PI_JOURNAL_FORMAT) return checkpoint;
  const entries = journal.leafId === null ? [] : readActiveJournalSubset(storage, turn.session_id, journal.leafId);
  return { ...checkpoint, piSession: { ...journal, entries } };
}

export function readActiveJournalSubset(storage, sessionId, leafId) {
  if (!leafId) return [];
  const path = rows(storage, `WITH RECURSIVE branch(entry_id, parent_id, entry_type, first_kept_entry_id, entry_seq) AS (
      SELECT entry_id, parent_id, entry_type, first_kept_entry_id, entry_seq FROM pi_journal_entries
        WHERE session_id = ? AND entry_id = ?
      UNION ALL
      SELECT parent.entry_id, parent.parent_id, parent.entry_type, parent.first_kept_entry_id, parent.entry_seq
        FROM pi_journal_entries parent JOIN branch child ON parent.entry_id = child.parent_id
        WHERE parent.session_id = ?
    ) SELECT * FROM branch`, sessionId, leafId, sessionId);
  if (!path.length) throw Object.assign(new Error('PI_JOURNAL_LEAF_NOT_FOUND'), {
    code: 'PI_JOURNAL_LEAF_NOT_FOUND', diagnostics: { sessionId, leafId }
  });
  const compactionIndex = path.findIndex(entry => entry.entry_type === 'compaction');
  let cutoff = path.length - 1;
  if (compactionIndex >= 0) {
    const firstKept = path[compactionIndex].first_kept_entry_id;
    const keptIndex = path.findIndex(entry => entry.entry_id === firstKept);
    cutoff = keptIndex >= compactionIndex ? keptIndex : compactionIndex;
  }
  // Keep the native parent chain and state/custom entries, but do not materialize
  // message payloads already covered by compaction. Assistant model metadata is
  // still needed by Pi's getSessionContextSettings. Cold originals are immutable:
  // checkpointForStorage skips existing IDs, and selecting an older leaf reloads
  // its full context. These spine entries must never be presented as raw history.
  const coldIds = path.slice(cutoff + 1).filter(entry => entry.entry_type === 'message').map(entry => entry.entry_id);
  const ids = path.map(entry => entry.entry_id);
  return rows(storage, `SELECT CASE WHEN entry_id IN (SELECT value FROM json_each(?))
      THEN json_set(entry_json, '$.message.content', json('[]'), '$.coldPayload', json('true'))
      ELSE entry_json END AS entry_json FROM pi_journal_entries WHERE session_id = ?
    AND entry_id IN (SELECT value FROM json_each(?)) ORDER BY entry_seq`, JSON.stringify(coldIds), sessionId, JSON.stringify(ids))
    .map(row => JSON.parse(row.entry_json));
}

/**
 * Writes a settled result into a waiting turn's journal: hydrates the turn's checkpoint, lets
 * `replace(checkpoint)` return the new model messages (and optionally a changed checkpoint), and
 * stores them as a branch of the journal. Returns replace's other fields and `checkpointJson`.
 * Runs inside the settlement's transaction (a TurnHost's writeResult).
 */
export function writeJournalResult(storage, turn, replace, { encode = identity } = {}) {
  const checkpoint = hydrateCheckpoint(storage, turn, JSON.parse(turn.checkpoint_json));
  const { messages, checkpoint: next = checkpoint, ...rest } = replace(checkpoint);
  const stored = checkpointForStorage(storage, turn, checkpointWithMessages(next, messages, turn.session_id), { encode });
  return { ...rest, checkpointJson: serializeCheckpoint(stored, { encode }) };
}
