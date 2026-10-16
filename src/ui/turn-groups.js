// A chat's turns grouped by explicit causal links (an internal turn continues its parent). From X
// Gardener src/ext/sidepanel/chat/turn-groups.js.
// Group only explicit causal links. Old unlinked internal turns remain visible;
// adjacency alone cannot distinguish a continuation from another user task.
// A steer the running turn took (`mergedIntoTurnId`) is that turn's, not a turn of its own: it is
// listed in its group's `steers`, so the answer that replied to it is shown after it. A steer
// whose turn is not loaded (an earlier page) stays a turn of its own.
export function groupTurns(turns) {
  const groups = [];
  const byTurn = new Map();
  for (const turn of turns) {
    const joined = turn.mergedIntoTurnId && byTurn.get(turn.mergedIntoTurnId);
    if (joined) { joined.steers.push(turn); continue; }
    const parent = turn.parentTurnId && byTurn.get(turn.parentTurnId);
    const group = parent && parent.accountId === turn.accountId && parent.sessionId === turn.sessionId && parent.runId === turn.runId
      ? parent : { id: turn.turnId, accountId: turn.accountId, sessionId: turn.sessionId, runId: turn.runId, turns: [], steers: [] };
    if (!group.turns.length) groups.push(group);
    group.turns.push(turn);
    byTurn.set(turn.turnId, group);
  }
  return groups;
}
