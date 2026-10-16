// What a Routine is made of, checked and computed without storage: its weekly schedule (days, a
// time of day, a zone, a random start window), the five-part cron an editor shows it as, the next
// slot after an instant, its prompt, and the {update, write} permissions a run may hold.

const DAY_MS = 24 * 60 * 60_000;
const SCHEDULE_FIELDS = new Set(["days", "localTime", "timezone", "enabled", "nextAt", "jitterMinutes"]);
const PERMISSION_FIELDS = new Set(["update", "write"]);
/** A Routine may fire up to this many minutes before or after its clock, chosen afresh each time. */
export const ROUTINE_JITTER_MAX_MINUTES = 120;

/**
 * A stored schedule: one time of day on chosen weekdays (0 is Sunday) in a zone, on or off.
 * `nextAt` is the scheduler's own bookkeeping and is never accepted from a caller.
 */
export function validateRoutineSchedule(value) {
  const fail = () => { throw new Error("ROUTINE_SCHEDULE_INVALID"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (Object.keys(value).some((key) => !SCHEDULE_FIELDS.has(key))) fail();
  if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7 || new Set(value.days).size !== value.days.length
    || value.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) fail();
  if (typeof value.localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)) fail();
  if (typeof value.timezone !== "string" || !value.timezone || value.timezone.length > 64) fail();
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); } catch { fail(); }
  if (typeof value.enabled !== "boolean") fail();
  if (value.nextAt != null && !Number.isFinite(Date.parse(value.nextAt))) fail();
  if (value.jitterMinutes != null && (!Number.isInteger(value.jitterMinutes) || value.jitterMinutes < 0
    || value.jitterMinutes > ROUTINE_JITTER_MAX_MINUTES)) fail();
  return { days: [...value.days], localTime: value.localTime, timezone: value.timezone,
    enabled: value.enabled, nextAt: value.nextAt ?? null, ...(value.jitterMinutes ? { jitterMinutes: value.jitterMinutes } : {}) };
}

/** The text each run starts from. */
export function validateRoutinePrompt(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) throw new Error("ROUTINE_PROMPT_INVALID");
  return value.trim();
}

/** What a thread's turns may do: `update` memory and settings, `write` (act outside reading). */
export function validatePermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !PERMISSION_FIELDS.has(key))
    || typeof value.update !== "boolean" || typeof value.write !== "boolean") throw new Error("AGENT_THREAD_PERMISSIONS_INVALID");
  return { update: value.update, write: value.write };
}

/**
 * A manual run may ask for fewer permissions than its Routine holds, for that run only. A request
 * can only narrow them, never widen them; absent means the Routine's own.
 */
export function manualRunPermissions(routinePermissions, requested) {
  const held = validatePermissions(routinePermissions);
  if (requested === undefined) return held;
  const asked = validatePermissions(requested);
  return { update: held.update && asked.update, write: held.write && asked.write };
}

/** The first slot of `schedule` strictly after `now`, as an ISO instant. */
export function nextRoutineTime(now, schedule, timezone = schedule.timezone || "UTC") {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error("invalid schedule start");
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  const days = new Set(schedule.days);
  const localNow = zonedParts(nowDate, timezone);
  const localMidnight = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
  for (let offset = 0; offset < 14; offset += 1) {
    const localDate = new Date(localMidnight + offset * DAY_MS);
    if (!days.has(localDate.getUTCDay())) continue;
    const candidate = zonedDateToUtc({ year: localDate.getUTCFullYear(), month: localDate.getUTCMonth() + 1,
      day: localDate.getUTCDate(), hour, minute }, timezone);
    if (candidate.getTime() > nowDate.getTime()) return candidate.toISOString();
  }
  throw new Error("routine has no schedulable day");
}

/**
 * When the alarm for slot `nextAt` rings: the slot moved by a random amount within the schedule's
 * start window, never into the past. The slot itself stays the clock that keys the fire.
 */
export function routineFireAt(nextAt, schedule, now, random = Math.random) {
  const jitterMs = (schedule.jitterMinutes || 0) * 60_000;
  return Math.max(Date.parse(nextAt) + Math.round((random() * 2 - 1) * jitterMs), Date.parse(now) + 1_000);
}

/** Whether `scheduledFor` is the schedule's current slot (its recorded `nextAt`, or derivable when none is recorded). */
export function matchesScheduledSlot(schedule, scheduledFor) {
  if (typeof scheduledFor !== "string") return false;
  if (schedule.nextAt === scheduledFor) return true;
  if (schedule.nextAt !== null) return false;
  const slot = Date.parse(scheduledFor);
  return Number.isFinite(slot) && slot > 0 && new Date(slot).toISOString() === scheduledFor
    && nextRoutineTime(new Date(slot - 1).toISOString(), schedule) === scheduledFor;
}

/** The schedule's days and time as a five-part cron (`30 10 * * 1-5`). */
export function scheduleToCron(schedule = {}) {
  const [hour = "9", minute = "0"] = String(schedule.localTime || "09:00").split(":");
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [1, 2, 3, 4, 5];
  const weekday = days.length === 7 ? "*" : compactWeekdays(days);
  return `${Number(minute)} ${Number(hour)} * * ${weekday}`;
}

/**
 * The cron a schedule can be: fixed minute and hour, `*` day-of-month and month, a weekday list or
 * ranges. Anything else is null, never rewritten.
 */
export function parseCronSchedule(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6](?:-[0-6])?(?:,[0-6](?:-[0-6])?)*)$/);
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const days = match[3] === "*" ? [0, 1, 2, 3, 4, 5, 6] : expandWeekdays(match[3]);
  if (!days.length) return null;
  return { days, localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function compactWeekdays(days) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const consecutive = sorted.every((day, index) => !index || day === sorted[index - 1] + 1);
  return consecutive && sorted.length > 2 ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(",");
}

function expandWeekdays(value) {
  const days = new Set();
  for (const part of value.split(",")) {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < 0 || end > 6) return [];
    for (let day = start; day <= end; day += 1) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

// The wall clock a reader asked for, as an instant. Two offsets can produce that clock: the one in
// force just before it and the one just after, so both are tried. On the day a zone springs
// forward the requested clock may not exist at all and neither matches; the slot is then the
// moment the gap ends, which is the first instant that has actually reached the requested time.
function zonedDateToUtc(target, timezone) {
  const targetValue = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const guess = targetValue - zoneOffsetMs(targetValue, timezone);
  for (const candidate of [targetValue - zoneOffsetMs(guess, timezone), guess]) {
    if (localValue(candidate, timezone) === targetValue) return new Date(candidate);
  }
  return new Date(gapEnd(targetValue, timezone));
}

// The first instant whose local clock has reached a time the zone skipped. Bisection, because the
// size of the jump and the moment it happens are the zone's business, not ours.
function gapEnd(targetValue, timezone) {
  let before = targetValue - DAY_MS;
  let after = targetValue + DAY_MS;
  while (after - before > 60_000) {
    const middle = before + Math.floor((after - before) / 2 / 60_000) * 60_000;
    if (middle === before) break;
    if (localValue(middle, timezone) < targetValue) before = middle;
    else after = middle;
  }
  return after;
}

function localValue(value, timezone) {
  const local = zonedParts(new Date(value), timezone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
}

function zoneOffsetMs(value, timezone) {
  return localValue(value, timezone) - Math.floor(value / 60_000) * 60_000;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day), hour: Number(value.hour), minute: Number(value.minute) };
}
