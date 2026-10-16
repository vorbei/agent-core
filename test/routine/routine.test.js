import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_SCHEMA } from "../../src/runtime/index.js";
import {
  ALARM_JOBS_SCHEMA, THREADS_SCHEMA, addAlarmJob, addRoutine, alarmJobs, cancelAlarmJob, deleteRoutine, editRoutine, manualRunPermissions,
  nextRoutineTime, parseCronSchedule, requestRoutineRun, routineDetail, routineFireAt, routineList, runAlarm, runRoutineAlarm,
  scheduleToCron, validateRoutineSchedule
} from "../../src/routine/index.js";
import { sqliteStorage } from "../memory/sqlite-storage.js";

const NOW = "2026-09-04T08:00:00.000Z"; // a Friday
const WEEKDAYS = { days: [1, 2, 3, 4, 5], localTime: "09:00", timezone: "UTC" };

// A RoutineHost over node:sqlite: the core's alarm jobs, turns queued as plain rows, no ledger.
function fixture({ active = true } = {}) {
  const storage = sqliteStorage();
  storage.setAlarm = (at) => { storage.alarmAt = at; };
  storage.deleteAlarm = () => { storage.alarmAt = null; };
  for (const statement of [...RUNTIME_SCHEMA, ...THREADS_SCHEMA, ...ALARM_JOBS_SCHEMA]) storage.sql.exec(statement);
  const one = (query, ...params) => storage.sql.exec(query, ...params).toArray()[0] || null;
  const records = new Map();
  const queued = [];
  const alarms = { storage, callbacks: ["runRoutineAlarm"], invoke: (callback, payload) => runRoutineAlarm(host, payload), recover: async () => {}, log: () => {} };
  const host = {
    storage,
    account: () => ({ accountId: "acct", active }),
    jobs: {
      schedule: (when, callback, payload, options) => addAlarmJob(alarms, when, callback, payload, options),
      list: () => alarmJobs(alarms),
      cancel: (id) => cancelAlarmJob(alarms, id)
    },
    ledger: () => {},
    log: () => {},
    idempotent: {
      run: async (name, input, work) => records.get(input.idempotencyKey) ?? records.set(input.idempotencyKey, await work()).get(input.idempotencyKey),
      replay: async (name, input) => records.get(input.idempotencyKey) ?? null,
      record: async (name, input, result) => { records.set(input.idempotencyKey, result); return result; }
    },
    runs: {
      prepare: async ({ threadId, input, idempotencyKey }) => {
        const existing = one("SELECT turn_id, input_json FROM agent_turns WHERE idempotency_key = ?", idempotencyKey);
        if (existing && JSON.parse(existing.input_json).text !== input) throw new Error("IDEMPOTENCY_CONFLICT");
        return { threadId, input, idempotencyKey, existingTurnId: existing?.turn_id ?? null };
      },
      queue: ({ threadId, input, idempotencyKey }) => {
        const turnId = `turn_${queued.length + 1}`;
        storage.sql.exec(`INSERT INTO agent_turns (turn_id, account_id, thread_id, permissions_json, session_id, runtime_version, status, phase,
          input_json, idempotency_key, input_hash, created_at, updated_at) VALUES (?, 'acct', ?, ?, ?, 'test', 'queued', 'queued', ?, ?, 'h', ?, ?)`,
        turnId, threadId, one("SELECT permissions_json FROM agent_threads WHERE thread_id = ?", threadId).permissions_json, threadId,
        JSON.stringify({ text: input }), idempotencyKey, NOW, NOW);
        return turnId;
      },
      finish: (prepared, turnId) => queued.push(turnId),
      busy: (routineId) => one(`SELECT run.thread_id FROM agent_threads run JOIN agent_turns turn ON turn.thread_id = run.thread_id
        WHERE run.parent_thread_id = ? AND turn.status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`, routineId)
    },
    view: (row) => ({ threadId: row.thread_id, title: row.title, parentThreadId: row.parent_thread_id, trigger: row.trigger,
      permissions: JSON.parse(row.permissions_json), schedule: row.schedule_json && JSON.parse(row.schedule_json), status: row.status }),
    defaultPermissions: { update: false, write: false }
  };
  return { host, storage, alarms, queued, one };
}

const create = (host, key, extra = {}) => addRoutine(host, { title: "Morning", routinePrompt: "Read the news.", schedule: WEEKDAYS,
  enabled: true, idempotencyKey: key, now: NOW, ...extra });

test("a schedule is validated, said as a cron and back, and its next slot honors the zone", () => {
  assert.deepEqual(validateRoutineSchedule({ ...WEEKDAYS, enabled: true, jitterMinutes: 45 }), { ...WEEKDAYS, enabled: true, nextAt: null, jitterMinutes: 45 });
  for (const bad of [{ ...WEEKDAYS, enabled: true, days: [] }, { ...WEEKDAYS, enabled: true, localTime: "25:00" },
    { ...WEEKDAYS, enabled: true, timezone: "Mars/Olympus" }, { ...WEEKDAYS, enabled: true, cron: "* * * * *" }, { ...WEEKDAYS, enabled: true, jitterMinutes: 121 }])
    assert.throws(() => validateRoutineSchedule(bad), /ROUTINE_SCHEDULE_INVALID/);
  assert.equal(scheduleToCron(WEEKDAYS), "0 9 * * 1-5");
  assert.deepEqual(parseCronSchedule("30 18 * * 0,6"), { days: [0, 6], localTime: "18:30" });
  assert.equal(parseCronSchedule("0 */2 * * *"), null, "what a schedule cannot hold is refused, never rewritten");
  assert.equal(nextRoutineTime(NOW, WEEKDAYS), "2026-09-04T09:00:00.000Z");
  assert.equal(nextRoutineTime("2026-09-04T09:00:00.000Z", WEEKDAYS), "2026-09-07T09:00:00.000Z", "Friday's slot rolls to Monday");
  assert.equal(nextRoutineTime(NOW, { ...WEEKDAYS, timezone: "Asia/Shanghai" }), "2026-09-07T01:00:00.000Z");
  const at = (random) => routineFireAt("2026-09-04T09:00:00.000Z", { jitterMinutes: 30 }, NOW, () => random);
  assert.equal(at(0) - Date.parse("2026-09-04T09:00:00.000Z"), -30 * 60_000);
  assert.equal(at(1) - Date.parse("2026-09-04T09:00:00.000Z"), 30 * 60_000);
  assert.equal(routineFireAt("2026-09-04T08:00:00.000Z", { jitterMinutes: 30 }, NOW, () => 0), Date.parse(NOW) + 1_000, "never in the past");
  assert.deepEqual(manualRunPermissions({ update: false, write: true }, { update: true, write: true }), { update: false, write: true });
});

test("a created Routine arms one alarm; its fire opens one run thread with the prompt, and a replay reuses it", async () => {
  const { host, storage, queued } = fixture();
  const created = await create(host, "create-1");
  const threadId = created.thread.threadId;
  assert.equal(created.thread.schedule.nextAt, "2026-09-04T09:00:00.000Z");
  assert.deepEqual(created.thread.permissions, { update: false, write: false }, "a new Routine gets the host's defaults");
  const [job] = alarmJobs({ storage });
  assert.equal(job.payload.scheduledFor, "2026-09-04T09:00:00.000Z");
  assert.ok(storage.alarmAt, "the object's alarm is armed");

  const fired = await runRoutineAlarm(host, job.payload, "2026-09-04T09:00:00.000Z");
  assert.equal(fired.created, true);
  assert.equal(fired.thread.parentThreadId, threadId);
  assert.equal(fired.thread.trigger, "schedule");
  assert.equal(queued.length, 1);
  const replay = await runRoutineAlarm(host, job.payload, "2026-09-04T09:00:00.000Z");
  assert.equal(replay.created, false);
  assert.equal(replay.thread.threadId, fired.thread.threadId);
  assert.equal(queued.length, 1, "a replayed slot never queues a second turn");
  assert.equal(routineDetail(host, { threadId }).thread.schedule.nextAt, "2026-09-07T09:00:00.000Z");
  assert.equal(alarmJobs({ storage }).length, 1, "the recurring alarm is replaced, never accumulated");
  assert.deepEqual(routineList(host).items[0].lastRun.threadId, fired.thread.threadId);
});

test("the alarm handler runs a due Routine job and re-arms for the next slot", async () => {
  const { host, storage, alarms, queued } = fixture();
  await create(host, "create-due");
  storage.sql.exec("UPDATE alarm_jobs SET due_at = 1");
  await runAlarm(alarms);
  assert.equal(queued.length, 1);
  const [next] = alarmJobs({ storage });
  // The handler runs on the wall clock, so the next slot is the first one after now.
  assert.equal(next.payload.scheduledFor, nextRoutineTime(new Date().toISOString(), WEEKDAYS), "the next slot after the one that fired");
});

test("a busy Routine skips its slot, a manual run narrows permissions, a paused account runs nothing", async () => {
  const { host, one } = fixture();
  const threadId = (await create(host, "create-busy", { permissions: { update: true, write: true } })).thread.threadId;
  const first = await requestRoutineRun(host, { threadId, idempotencyKey: "manual-1", permissions: { update: false, write: true }, now: NOW });
  assert.equal(first.thread.trigger, "manual");
  assert.deepEqual(first.thread.permissions, { update: false, write: true }, "the run may do less than its Routine, never more");
  assert.equal((await requestRoutineRun(host, { threadId, idempotencyKey: "manual-1", permissions: { update: false, write: true }, now: NOW })).thread.threadId,
    first.thread.threadId, "a replayed key returns the same run");
  const skipped = await runRoutineAlarm(host, { threadId, scheduledFor: "2026-09-04T09:00:00.000Z", trigger: "schedule" }, "2026-09-04T09:00:00.000Z");
  assert.deepEqual(skipped, { allowed: false, reason: "PREVIOUS_RUN_ACTIVE", runThreadId: first.thread.threadId });
  one("UPDATE agent_turns SET status = 'completed'");
  // A Routine that stores an instruction (an earlier editor's) runs with it; a model an old row
  // still stores is not a Routine setting, so the run uses the default model.
  one("UPDATE agent_threads SET instruction = 'Answer in French.', model = 'cheap/model' WHERE thread_id = ?", threadId);
  const styled = await requestRoutineRun(host, { threadId, idempotencyKey: "manual-2", now: NOW });
  assert.deepEqual({ ...one("SELECT instruction, model FROM agent_threads WHERE thread_id = ?", styled.thread.threadId) },
    { instruction: "Answer in French.", model: null });
  assert.deepEqual({ ...one("SELECT instruction, model FROM agent_threads WHERE thread_id = ?", first.thread.threadId) },
    { instruction: "", model: null }, "the earlier run kept what its Routine had then");
  const paused = fixture({ active: false });
  const pausedId = (await create(paused.host, "create-paused")).thread.threadId;
  assert.deepEqual(await requestRoutineRun(paused.host, { threadId: pausedId, idempotencyKey: "manual-p", now: NOW }), { allowed: false, reason: "ACCOUNT_PAUSED" });
});

test("an edit re-derives the clock; deleting archives the Routine with its runs and stops its alarm", async () => {
  const { host, storage, one } = fixture();
  const threadId = (await create(host, "create-edit")).thread.threadId;
  const edited = await editRoutine(host, { threadId, schedule: { ...WEEKDAYS, localTime: "18:30" }, idempotencyKey: "edit-1", now: NOW });
  assert.equal(edited.thread.schedule.nextAt, "2026-09-04T18:30:00.000Z");
  const paused = await editRoutine(host, { threadId, enabled: false, idempotencyKey: "edit-2", now: NOW });
  assert.equal(paused.thread.schedule.nextAt, null);
  assert.equal(alarmJobs({ storage }).length, 0, "a paused Routine keeps no recurring alarm");
  const run = await requestRoutineRun(host, { threadId, idempotencyKey: "manual-d", now: NOW });
  await assert.rejects(deleteRoutine(host, { threadId, now: NOW }), /AGENT_THREAD_BUSY/);
  one("UPDATE agent_turns SET status = 'completed'");
  const deleted = await deleteRoutine(host, { threadId, now: NOW });
  assert.equal(deleted.status, "archived");
  assert.equal(one("SELECT status FROM agent_threads WHERE thread_id = ?", run.thread.threadId).status, "archived");
  assert.deepEqual(routineList(host).items, []);
  assert.deepEqual(await runRoutineAlarm(host, { threadId, scheduledFor: "2026-09-07T09:00:00.000Z", trigger: "schedule" }, "2026-09-07T09:00:00.000Z"),
    { allowed: false, reason: "ROUTINE_ARCHIVED" });
});
