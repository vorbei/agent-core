// Historical journal migration between format 1 (inline piSession entries in checkpoint_json) and
// format 2 (pi_journal_entries rows + small header): an inventory, and bounded migrate/rollback
// passes that are dry runs unless `apply` is passed with `applyEnabled` (the product's explicit
// rollout switch). Only terminal turns migrate; in-flight turns keep their format until they finish.
// Rows are never deleted by either direction. From X Gardener src/cf/account/journal-migration.js.
//
// Compatibility branch with the format-1 read path: removal condition "no format-1 checkpoint
// remains in production"; test Gardener tests/pi-journal-migration.test.js.
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { checkpointForStorage, hydrateCheckpoint, serializeCheckpoint } from "./journal-store.js";
import { PI_JOURNAL_FORMAT } from "./entry-types.js";

const TERMINAL = "status IN ('completed','failed','cancelled')";
const rows = (storage, query, ...args) => storage.sql.exec(query, ...args).toArray();

/**
 * @param {import("../runtime/index.js").SqlStorage} storage
 * @param {{ applyEnabled?: boolean }} [options]
 */
export function inventoryPiJournal(storage, { applyEnabled = false } = {}) {
  const turns = rows(storage, `SELECT journal_format, status, length(checkpoint_json) AS bytes,
      json_extract(checkpoint_json, '$.checkpointVersion') AS checkpoint_version,
      json_extract(checkpoint_json, '$.sessionContextVersion') AS context_version,
      json_type(checkpoint_json, '$.piSession.entries') AS inline_entries
    FROM agent_turns`);
  const inventory = { turns: turns.length, byFormat: {}, byCheckpointVersion: {}, bySessionContextVersion: {},
    inline: { turns: 0, bytes: 0, largestBytes: 0 }, migratable: 0, inFlightLegacy: 0, legacyWithoutJournal: 0,
    journalRows: Number(rows(storage, "SELECT COUNT(*) AS n FROM pi_journal_entries")[0]?.n || 0),
    applyEnabled };
  for (const row of turns) {
    const format = String(row.journal_format ?? 1);
    inventory.byFormat[format] = (inventory.byFormat[format] || 0) + 1;
    const version = String(row.checkpoint_version ?? "none");
    inventory.byCheckpointVersion[version] = (inventory.byCheckpointVersion[version] || 0) + 1;
    const context = String(row.context_version ?? "none");
    inventory.bySessionContextVersion[context] = (inventory.bySessionContextVersion[context] || 0) + 1;
    if (Number(row.journal_format) === PI_JOURNAL_FORMAT) continue;
    const terminal = ["completed", "failed", "cancelled"].includes(row.status);
    if (row.inline_entries === "array") {
      inventory.inline.turns++;
      inventory.inline.bytes += Number(row.bytes || 0);
      inventory.inline.largestBytes = Math.max(inventory.inline.largestBytes, Number(row.bytes || 0));
      if (terminal) inventory.migratable++; else inventory.inFlightLegacy++;
    } else if (!terminal) inventory.inFlightLegacy++;
    else inventory.legacyWithoutJournal++;
  }
  return inventory;
}

function contextOf(journal) {
  return JSON.stringify(buildSessionContext(journal.entries, journal.leafId).messages);
}

const disabled = () => Object.assign(new Error("PI_JOURNAL_MIGRATION_DISABLED"), { code: "PI_JOURNAL_MIGRATION_DISABLED" });

/**
 * @param {import("../runtime/index.js").SqlStorage} storage
 * @param {{ limit?: number, after?: number | null, apply?: boolean, applyEnabled?: boolean, encode?: (value: any) => any, log?: (event: string, detail: object) => void }} [options]
 */
export function migratePiJournal(storage, { limit = 20, after = null, apply = false, applyEnabled = false, encode, log } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 200));
  if (apply && !applyEnabled) throw disabled();
  const turns = rows(storage, `SELECT rowid AS position, turn_id, session_id, status, checkpoint_json FROM agent_turns
    WHERE journal_format IS NOT ? AND ${TERMINAL} ${after == null ? "" : "AND rowid > ?"} ORDER BY rowid LIMIT ?`,
  PI_JOURNAL_FORMAT, ...(after == null ? [] : [Number(after)]), bounded);
  const result = { apply, scanned: turns.length, migrated: 0, validated: 0, skipped: [], nextAfter: turns.length === bounded ? turns.at(-1).position : null };
  for (const row of turns) {
    let checkpoint;
    try { checkpoint = JSON.parse(row.checkpoint_json || "null"); } catch { checkpoint = null; }
    if (!checkpoint?.piSession?.header || !Array.isArray(checkpoint.piSession.entries)) {
      result.skipped.push({ turnId: row.turn_id, reason: "NO_NATIVE_JOURNAL" });
      continue;
    }
    const expected = contextOf(checkpoint.piSession);
    try {
      storage.transactionSync(() => {
        const target = { session_id: row.session_id, journal_format: PI_JOURNAL_FORMAT };
        const stored = checkpointForStorage(storage, target, checkpoint, { encode });
        const hydrated = hydrateCheckpoint(storage, target, stored);
        if (contextOf(hydrated.piSession) !== expected) throw Object.assign(new Error("PI_JOURNAL_MIGRATION_MISMATCH"), { code: "PI_JOURNAL_MIGRATION_MISMATCH" });
        result.validated++;
        if (!apply) throw Object.assign(new Error("DRY_RUN"), { code: "DRY_RUN" });
        storage.sql.exec(`UPDATE agent_turns SET checkpoint_json = ?, journal_format = ?
          WHERE turn_id = ? AND journal_format IS NOT ? AND ${TERMINAL}`, serializeCheckpoint(stored, { encode }), PI_JOURNAL_FORMAT, row.turn_id, PI_JOURNAL_FORMAT);
        result.migrated++;
      });
    } catch (error) {
      if (error.code === "DRY_RUN") continue;
      result.skipped.push({ turnId: row.turn_id, reason: error.code || error.message?.slice(0, 80) || "MIGRATION_FAILED" });
    }
  }
  log?.("agent.journal.migration", { apply, scanned: result.scanned, migrated: result.migrated,
    validated: result.validated, skipped: result.skipped.length, nextAfter: result.nextAfter });
  return result;
}

/**
 * Rollback rewrites the active branch inline (format 1) from retained rows.
 * Inactive branches stay in pi_journal_entries; no row is deleted.
 * @param {import("../runtime/index.js").SqlStorage} storage
 * @param {{ limit?: number, after?: number | null, apply?: boolean, applyEnabled?: boolean, encode?: (value: any) => any, log?: (event: string, detail: object) => void }} [options]
 */
export function rollbackPiJournal(storage, { limit = 20, after = null, apply = false, applyEnabled = false, encode, log } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 200));
  if (apply && !applyEnabled) throw disabled();
  const turns = rows(storage, `SELECT rowid AS position, turn_id, session_id, checkpoint_json FROM agent_turns
    WHERE journal_format = ? AND ${TERMINAL} ${after == null ? "" : "AND rowid > ?"} ORDER BY rowid LIMIT ?`,
  PI_JOURNAL_FORMAT, ...(after == null ? [] : [Number(after)]), bounded);
  const result = { apply, scanned: turns.length, rolledBack: 0, skipped: [], nextAfter: turns.length === bounded ? turns.at(-1).position : null };
  for (const row of turns) {
    try {
      storage.transactionSync(() => {
        const checkpoint = JSON.parse(row.checkpoint_json || "{}");
        if (!checkpoint.piSession?.header) throw Object.assign(new Error("NO_NATIVE_JOURNAL"), { code: "NO_NATIVE_JOURNAL" });
        const hydrated = hydrateCheckpoint(storage, { session_id: row.session_id, journal_format: PI_JOURNAL_FORMAT }, checkpoint);
        const inline = checkpointForStorage(storage, { session_id: row.session_id, journal_format: 1 }, hydrated, { encode });
        if (!apply) throw Object.assign(new Error("DRY_RUN"), { code: "DRY_RUN" });
        storage.sql.exec(`UPDATE agent_turns SET checkpoint_json = ?, journal_format = 1 WHERE turn_id = ? AND journal_format = ? AND ${TERMINAL}`,
          serializeCheckpoint(inline, { encode }), row.turn_id, PI_JOURNAL_FORMAT);
        result.rolledBack++;
      });
    } catch (error) {
      if (error.code === "DRY_RUN") continue;
      result.skipped.push({ turnId: row.turn_id, reason: error.code || error.message?.slice(0, 80) || "ROLLBACK_FAILED" });
    }
  }
  log?.("agent.journal.rollback", { apply, scanned: result.scanned, rolledBack: result.rolledBack, skipped: result.skipped.length, nextAfter: result.nextAfter });
  return result;
}
