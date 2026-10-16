// The one place the runtime reaches into Pi internals, exactly two, both verified on the pinned
// version. Pi's automatic threshold compaction prepares the same cut and emits the same hooks as
// Pi's own between-turn check, without aborting the active run (unlike the public compact()); and
// the agent loop's own context snapshot is refreshed after a background cut lands. A Pi upgrade
// must re-verify both and move this pin together with every package.json that pins Pi
// (packages/agent-core/test/pi/pi-private.test.js, Gardener tests/source-boundaries.test.js).
export const PI_PRIVATE_API_PIN = "0.84.4";

export function runThresholdCompaction(session) {
  if (typeof session._runAutoCompaction !== "function") {
    throw new Error(`PI_PRIVATE_API_MISSING: AgentSession._runAutoCompaction (verified on Pi ${PI_PRIVATE_API_PIN})`);
  }
  return session._runAutoCompaction("threshold", false);
}

/** Pi's loop prepares the next request from its own snapshot; make it read the agent's current messages. */
export function prepareNextTurnFromState(agent) {
  const prepareNextTurn = agent.prepareNextTurnWithContext;
  if (typeof prepareNextTurn !== "function") {
    throw new Error(`PI_PRIVATE_API_MISSING: Agent.prepareNextTurnWithContext (verified on Pi ${PI_PRIVATE_API_PIN})`);
  }
  agent.prepareNextTurnWithContext = (turn, signal) => prepareNextTurn({ ...turn,
    context: { ...turn.context, messages: agent.state.messages.slice() } }, signal);
}
