// One page of turns for a product's turn list: the newest `limit` turns of a thread (or of the
// account) before an anchor turn, oldest first, with the anchor of the page before them. Each
// product projects the rows itself (its activity source and fields differ). From X Gardener
// src/cf/account/turns.js (listAgentTurns).

/**
 * @param {import("./index.js").TurnHost} host
 * @param {{ threadId?: string | null, limit: number, before?: string | null, columns?: string }} page
 *   `columns` is the SELECT list (the row also carries `storage_rowid`); `before` a turn id of the
 *   same thread, else AGENT_TURN_NOT_FOUND.
 * @returns {{ rows: Record<string, any>[], nextBefore: string | null }}
 */
export function turnPage(host, { threadId = null, limit, before = null, columns = "*" }) {
  const rows = (query, ...bindings) => host.storage.sql.exec(query, ...bindings).toArray();
  const anchor = before ? rows(`SELECT rowid AS position FROM agent_turns WHERE turn_id = ?${threadId ? " AND thread_id = ?" : ""}`,
    before, ...(threadId ? [threadId] : []))[0] : null;
  if (before && !anchor) throw new Error("AGENT_TURN_NOT_FOUND");
  const found = rows(`SELECT rowid AS storage_rowid, ${columns} FROM agent_turns
    ${threadId ? "WHERE thread_id = ?" : ""} ${anchor ? `${threadId ? "AND" : "WHERE"} rowid < ?` : ""}
    ORDER BY rowid DESC LIMIT ?`, ...(threadId ? [threadId] : []), ...(anchor ? [anchor.position] : []), limit + 1);
  const page = found.slice(0, limit).reverse();
  return { rows: page, nextBefore: found.length > limit ? page[0].turn_id : null };
}
