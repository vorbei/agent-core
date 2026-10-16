// The names and versions the Pi journal persists. They are stored in production journals and turn
// checkpoints (X Gardener's since 0.4; pi-do uses the same literals), so they are data, not wording:
// renaming one is a journal migration with its own plan. The custom types keep the product prefix
// they were first written with; tests/source-boundaries.test.js exempts exactly these literals.

/** Custom message types the runtime writes into the journal. */
export const JOURNAL_ENTRY_TYPES = Object.freeze({
  /** The turn's authorization state, sent with the prompt; the user's text stays verbatim. */
  turnAuthorization: "gardener_turn_authorization",
  /** The hidden host event that resumes a suspended run. */
  resume: "gardener_resume",
  /** Exact receipts and sources carried past a compaction (never in the generated summary). */
  compactedEvidence: "gardener_compacted_evidence"
});

/** `checkpoint.checkpointVersion`: one authoritative native journal (2); older records carry `messages`. */
export const CHECKPOINT_VERSION = 2;
/** `checkpoint.sessionContextVersion`: v3 also carries failed and cancelled turns into the next user message. */
export const SESSION_CONTEXT_VERSION = 3;
/** `agent_turns.journal_format`: 2 = `pi_journal_entries` rows + checkpoint header; 1 = inline journal. */
export const PI_JOURNAL_FORMAT = 2;
