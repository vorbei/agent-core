// How the Routine view says things: a schedule in plain words, a time and a date as the reader's
// locale writes them, how long ago something started, and a run's state. No DOM here.
import { isActiveTurnStatus } from "../runtime/projection.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "10:30" as the reader's locale writes a time of day, so the schedule and the next run agree. */
export function timeWords(localTime) {
  const [hour, minute] = String(localTime || "09:00").split(":").map(Number);
  const date = new Date(2000, 0, 1, hour, minute);
  return Number.isNaN(date.valueOf()) ? String(localTime) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Weekdays at 10:30 AM", "Every Sunday at 6:00 PM", "Mon, Wed, Fri at 9:00 AM". */
export function scheduleWords(schedule = {}) {
  const time = timeWords(schedule.localTime);
  const days = [...new Set(Array.isArray(schedule.days) ? schedule.days : [])].sort((a, b) => a - b);
  const same = (set) => days.length === set.length && set.every((day, index) => days[index] === day);
  if (!days.length) return `At ${time}`;
  if (days.length === 7) return `Every day at ${time}`;
  if (same([1, 2, 3, 4, 5])) return `Weekdays at ${time}`;
  if (same([0, 6])) return `Weekends at ${time}`;
  if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${time}`;
  return `${days.map((day) => DAY_SHORT[day]).join(", ")} at ${time}`;
}

/** scheduled | paused | running: what a list row says in one word. */
export function routineStatus(item) {
  if (isActiveTurnStatus(item.lastRun?.status)) return "running";
  return item.thread.schedule?.enabled ? "scheduled" : "paused";
}

/** The state of a run (a thread with its newest turn) in one phrase. */
export function runStateWords(run) {
  const status = run?.latestTurnStatus;
  if (status === "completed") {
    if (run.latestTurnDelivery === "partial" || run.latestTurnDelivery === "blocked") return "Finished, partly confirmed";
    if (run.latestTurnDelivery === "waiting") return "Waiting for you";
    return "Completed";
  }
  return ({ queued: "Queued", running: "Running", waiting_for_browser: "Waiting for Chrome",
    waiting_for_approval: "Needs your input", failed: "Failed", cancelled: "Stopped" })[status] || "Queued";
}

/** The run's marker: completed, partial, failed, cancelled, active or queued. */
export function runStateKind(run) {
  const status = run?.latestTurnStatus;
  if (status === "completed") return ["partial", "blocked", "waiting"].includes(run.latestTurnDelivery) ? "partial" : "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return isActiveTurnStatus(status) ? "active" : "queued";
}

/** "Today 10:23", "Tomorrow 09:00", "Yesterday 18:30", else a short date and time. */
export function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, today)) return `Today ${time}`;
  if (sameDay(date, new Date(today.getTime() + 86_400_000))) return `Tomorrow ${time}`;
  if (sameDay(date, new Date(today.getTime() - 86_400_000))) return `Yesterday ${time}`;
  return date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "19 min ago", never a bare "19m" that could be read as a duration. */
export function agoWords(value) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}
