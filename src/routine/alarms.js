// The Durable Object's one alarm as a durable job queue (`alarm_jobs`): jobs are stored, the alarm
// is armed for the earliest of them (or a running turn's lease expiry), and each wake claims due
// jobs under a lease, runs their callback by name and settles them with bounded retries.

/** The job table, as statements a host applies (or its own migrations already built the same). */
export const ALARM_JOBS_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS alarm_jobs (
    id TEXT PRIMARY KEY, callback TEXT NOT NULL, payload TEXT NOT NULL,
    due_at INTEGER NOT NULL, interval_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    lease TEXT, failed INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS alarm_jobs_due ON alarm_jobs(failed, due_at)"
]);

// One wake runs at most this many jobs; the re-armed alarm takes the rest.
const JOBS_PER_WAKE = 10;
// A claimed job that never settles is due again after this long (a restarted object recovers it).
const CLAIM_LEASE_MS = 300_000;

export function listAlarmJobs(storage) {
  return storage.sql.exec("SELECT * FROM alarm_jobs WHERE failed = 0 ORDER BY due_at, id").toArray();
}

export function nextAlarmTime(storage) {
  return storage.sql.exec("SELECT due_at FROM alarm_jobs WHERE failed = 0 ORDER BY due_at LIMIT 1").toArray()[0]?.due_at;
}

/** Stores a job, unless an equal one (callback, payload, interval) is already waiting. */
export function putAlarmJob(storage, { id, callback, payload, dueAt, intervalMs, maxAttempts }) {
  const json = JSON.stringify(payload ?? null);
  const existing = storage.sql.exec(
    "SELECT * FROM alarm_jobs WHERE callback = ? AND payload = ? AND interval_ms = ? AND (lease IS NULL OR interval_ms > 0) AND failed = 0 LIMIT 1",
    callback, json, intervalMs
  ).toArray()[0];
  if (existing) return existing;
  storage.sql.exec(`INSERT INTO alarm_jobs (id, callback, payload, due_at, interval_ms, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?)`, id, callback, json, dueAt, intervalMs, maxAttempts);
  return { id, callback, payload: json, due_at: dueAt, interval_ms: intervalMs };
}

export function claimAlarmJob(storage, now, lease) {
  const row = storage.sql.exec("SELECT * FROM alarm_jobs WHERE failed = 0 AND due_at <= ? ORDER BY due_at, id LIMIT 1", now).toArray()[0];
  if (!row) return null;
  // The retry deadline is stored before the callback runs, so a restarted object can recover it.
  storage.sql.exec("UPDATE alarm_jobs SET lease = ?, due_at = ?, attempts = attempts + 1 WHERE id = ?", lease, now + CLAIM_LEASE_MS, row.id);
  return { ...row, lease, attempts: row.attempts + 1, exhausted: row.attempts >= row.max_attempts };
}

export function settleAlarmJob(storage, job, succeeded, now) {
  if (succeeded && !job.interval_ms) {
    storage.sql.exec("DELETE FROM alarm_jobs WHERE id = ? AND lease = ?", job.id, job.lease);
    return;
  }
  const exhausted = !succeeded && job.attempts >= job.max_attempts;
  const nextInterval = Boolean(job.interval_ms && (succeeded || exhausted));
  const delay = nextInterval ? job.interval_ms : Math.min(60_000, 1000 * 2 ** (job.attempts - 1));
  storage.sql.exec("UPDATE alarm_jobs SET lease = NULL, due_at = ?, attempts = ?, failed = ? WHERE id = ? AND lease = ?",
    now + delay, nextInterval ? 0 : job.attempts, exhausted && !job.interval_ms ? 1 : 0, job.id, job.lease);
}

function publicJob(row) {
  return { id: row.id, callback: row.callback, payload: JSON.parse(row.payload), time: row.due_at / 1000 };
}

export function alarmJobs(host) {
  return listAlarmJobs(host.storage).map(publicJob);
}

/** Stores a job for `when` and re-arms the alarm; `intervalMs` repeats it. */
export async function addAlarmJob(host, when, callback, payload, options = {}, intervalMs = 0) {
  const dueAt = when instanceof Date ? when.getTime() : NaN;
  const maxAttempts = options.retry?.maxAttempts ?? 3;
  if (!host.callbacks.includes(callback) || !Number.isFinite(dueAt)
    || !Number.isInteger(intervalMs) || intervalMs < 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("INVALID_ALARM_JOB");
  }
  const job = putAlarmJob(host.storage, { id: crypto.randomUUID(), callback, payload, dueAt, intervalMs, maxAttempts });
  await armNextAlarm(host);
  return publicJob(job);
}

export async function cancelAlarmJob(host, id) {
  host.storage.sql.exec("DELETE FROM alarm_jobs WHERE id = ?", id);
  await armNextAlarm(host);
}

/**
 * Arms the alarm for the earliest job, a running turn's lease expiry, or the host's own next
 * deadline; deletes it when there is none. Alarm writes are serialized (`host.pending`); callbacks
 * and model or network work never hold that queue.
 */
export function armNextAlarm(host) {
  host.pending = (host.pending || Promise.resolve()).catch(() => {}).then(async () => {
    const job = nextAlarmTime(host.storage);
    const lease = host.storage.sql.exec("SELECT MIN(lease_expires_at) AS expires FROM agent_turns WHERE status = 'running'").toArray()[0]?.expires;
    const deadlines = [job, lease ? Date.parse(lease) + 1 : undefined, host.nextDeadline?.()].filter(Number.isFinite);
    if (deadlines.length) await host.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
    else await host.storage.deleteAlarm();
  });
  return host.pending;
}

/** The alarm handler: recover turns whose lease expired, run up to ten due jobs, re-arm. */
export async function runAlarm(host) {
  try {
    const expired = host.storage.sql.exec("SELECT turn_id FROM agent_turns WHERE status = 'running' AND lease_expires_at < ? LIMIT 1",
      new Date().toISOString()).toArray()[0];
    if (expired) await host.recover();
    for (let count = 0; count < JOBS_PER_WAKE; count += 1) {
      const job = claimAlarmJob(host.storage, Date.now(), crypto.randomUUID());
      if (!job) break;
      await armNextAlarm(host);
      let succeeded = false;
      try {
        if (job.exhausted) throw new Error("ALARM_RECOVERY_EXHAUSTED");
        if (!host.callbacks.includes(job.callback)) throw new Error("INVALID_ALARM_CALLBACK");
        host.log("do.alarm.started", { operation: job.callback, scheduleId: job.id, attempt: job.attempts });
        await host.invoke(job.callback, JSON.parse(job.payload));
        succeeded = true;
      } catch (error) {
        host.log("do.alarm.failed", { operation: job.callback, scheduleId: job.id, attempt: job.attempts,
          errorCode: error.code || "ALARM_CALLBACK_FAILED", errorMessage: error.message,
          outcome: job.attempts >= job.max_attempts ? "exhausted" : "retry_scheduled" });
      }
      settleAlarmJob(host.storage, job, succeeded, Date.now());
      if (succeeded) host.log("do.alarm.completed", { operation: job.callback, scheduleId: job.id });
    }
  } finally {
    await armNextAlarm(host);
  }
}
