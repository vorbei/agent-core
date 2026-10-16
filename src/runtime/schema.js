// The SQLite tables of the durable turn runtime, as statements a host applies (or proves it
// already has): turns, their steps, executor calls, tool receipts and idempotency records.
// Adopted unchanged from X Gardener's account storage (its migrations 1-15 build exactly this
// shape; a Gardener test compares the two), so no table, column, status value or index is renamed.

export const RUNTIME_TABLES = Object.freeze([
  "agent_turns",
  "agent_turn_steps",
  "agent_function_calls",
  "agent_tool_receipts",
  "idempotency_records"
]);

// A turn is one user message (or internal request) of a thread. `input_json` carries the request
// and the steer marks (`whileRunning`, `placingLease`, `mergedIntoTurnId`); `checkpoint_json` the
// attempt's saved state (`budget`, `retryNotBefore`, the journal checkpoint); `partial_text` the
// answer so far while the model streams it (the turn driver's, NULL outside a streamed message).
const TURNS = `CREATE TABLE IF NOT EXISTS agent_turns (
  turn_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  thread_id TEXT,
  permissions_json TEXT NOT NULL DEFAULT '{"update":true,"write":true}',
  session_id TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_browser', 'waiting_for_approval', 'completed', 'failed', 'cancelled')),
  phase TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  checkpoint_json TEXT,
  journal_format INTEGER NOT NULL DEFAULT 1,
  delivery_json TEXT,
  handoff_json TEXT,
  projection_ready INTEGER NOT NULL DEFAULT 0,
  final_answer TEXT,
  partial_text TEXT,
  error_code TEXT,
  waiting_ref TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)`;

// The delivery and handoff projections follow every checkpoint write, in the same transaction.
const projectionTrigger = (name, event) => `CREATE TRIGGER IF NOT EXISTS turn_projection_${name} AFTER ${event} ON agent_turns BEGIN
  UPDATE agent_turns SET delivery_json = json_extract(NEW.checkpoint_json, '$.delivery'),
    handoff_json = json_extract(NEW.checkpoint_json, '$.handoff'), projection_ready = 1
    WHERE turn_id = NEW.turn_id;
END`;

const STEPS = `CREATE TABLE IF NOT EXISTS agent_turn_steps (
  turn_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  tool_call_id TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, step_index)
)`;

// A call whose execution happens in an executor outside the runtime (the browser extension): the
// turn waits while it is `created` or `claimed`, and resumes when its last call is settled.
const FUNCTION_CALLS = `CREATE TABLE IF NOT EXISTS agent_function_calls (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  function_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'claimed', 'completed', 'failed')),
  lease_id TEXT,
  lease_expires_at TEXT,
  result_json TEXT,
  error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_context_json TEXT,
  execution_ms REAL
)`;

// Execution receipts survive the gap between a tool effect and the model's next message. They are
// not a second conversation history.
const TOOL_RECEIPTS = `CREATE TABLE IF NOT EXISTS agent_tool_receipts (
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  effect_hash TEXT NOT NULL,
  read_only INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, tool_call_id)
)`;

// One accepted request per key; an executor's result is recorded here as operation `function-result`.
const IDEMPOTENCY = `CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

/** Every statement, in order; each is idempotent (`IF NOT EXISTS`). */
export const RUNTIME_SCHEMA = Object.freeze([
  TURNS,
  "CREATE INDEX IF NOT EXISTS agent_turns_recovery ON agent_turns(status, updated_at)",
  "CREATE INDEX IF NOT EXISTS agent_turns_session ON agent_turns(session_id, created_at)",
  "CREATE INDEX IF NOT EXISTS agent_turns_created ON agent_turns(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS agent_turns_thread ON agent_turns(thread_id, created_at)",
  projectionTrigger("insert", "INSERT"),
  projectionTrigger("update", "UPDATE OF checkpoint_json"),
  STEPS,
  FUNCTION_CALLS,
  "CREATE INDEX IF NOT EXISTS agent_function_calls_claimable ON agent_function_calls(status, created_at)",
  "CREATE INDEX IF NOT EXISTS agent_function_calls_turn_status_created ON agent_function_calls(turn_id, status, created_at)",
  TOOL_RECEIPTS,
  "CREATE INDEX IF NOT EXISTS agent_tool_receipts_unresolved ON agent_tool_receipts(turn_id, tool_name, effect_hash) WHERE status = 'started'",
  IDEMPOTENCY
]);
