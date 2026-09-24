import type { SendingWindow, SendingWindows } from "@/src/domain/types";

export { DEFAULT_CAPS, DEFAULT_SENDING_WINDOWS } from "@/src/domain/settings-defaults";

/**
 * Sending windows are evaluated in the *recipient's* timezone for email (section 7) and
 * in the owner's for LinkedIn. Everything is pure `Intl` arithmetic so it runs in tests
 * without a clock or a timezone database.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** "YYYY-MM-DD" in the given zone. */
  dateOnly: string;
  /** Minutes since local midnight. */
  minutes: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "0";

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: isoWeekday(year, month, day),
    dateOnly: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    minutes: hour * 60 + minute,
  };
}

/** Converts a wall-clock time in a zone to the matching UTC instant (DST-safe). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = zoneOffsetMs(new Date(guess), timeZone);
  let timestamp = guess - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(timestamp), timeZone);
  if (secondOffset !== firstOffset) {
    timestamp = guess - secondOffset;
  }
  return new Date(timestamp);
}

export function instantForDateOnly(dateOnly: string, timeOfDay: string, timeZone: string): Date {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const [hour, minute] = timeOfDay.split(":").map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    throw new Error(`Invalid date/time: "${dateOnly}" ${timeOfDay}`);
  }
  return zonedTimeToUtc(year, month, day, hour, minute, timeZone);
}

export function dateOnlyInZone(date: Date, timeZone: string): string {
  return localParts(date, timeZone).dateOnly;
}

export function isWithinWindow(date: Date, timeZone: string, window: SendingWindow): boolean {
  const parts = localParts(date, timeZone);
  if (!window.days.includes(parts.weekday)) return false;
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  // A window that wraps past midnight (not used by the defaults) is handled by the
  // second clause rather than by splitting the day in two.
  if (start <= end) return parts.minutes >= start && parts.minutes < end;
  return parts.minutes >= start || parts.minutes < end;
}

/**
 * The next instant the window is open, at or after `date`. Returns `date` itself when the
 * window is already open. Searches two weeks ahead, which covers any holiday-free window.
 */
export function nextWindowStart(date: Date, timeZone: string, window: SendingWindow): Date {
  if (isWithinWindow(date, timeZone, window)) return date;

  const today = dateOnlyInZone(date, timeZone);
  for (let offset = 0; offset < 14; offset += 1) {
    const candidateDay = addDaysToDateOnly(today, offset);
    if (!window.days.includes(weekdayOf(candidateDay))) continue;
    const candidate = instantForDateOnly(candidateDay, window.start, timeZone);
    if (candidate.getTime() > date.getTime()) return candidate;
  }
  return date;
}

export function windowFor(settings: SendingWindows, channel: "email" | "linkedin"): SendingWindow {
  return channel === "email" ? settings.email : settings.linkedin;
}

/** Section 7: pacing defaults. Jitter is added by the step, never inside a workflow. */
export function spacingMinutesFor(channel: "email" | "linkedin", kind: "new" | "followup" | "invite" | "message" | "lookup"): { min: number; max: number } {
  if (channel === "email") return { min: 3, max: 9 };
  switch (kind) {
    case "invite":
    case "message":
      return { min: 1, max: 4 };
    case "lookup":
      return { min: 1, max: 3 };
    default:
      return { min: 1, max: 4 };
  }
}

/** Uniform in [min, max); the caller is a step, which may use randomness (rule 8). */
export function jitterMs(minMinutes: number, maxMinutes: number, random: () => number = Math.random): number {
  const minutes = minMinutes + random() * Math.max(0, maxMinutes - minMinutes);
  return Math.round(minutes * 60 * 1000);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeOfDay(timeOfDay: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = localParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  return asUtc - date.getTime();
}

function isoWeekday(year: number, month: number, day: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function weekdayOf(dateOnly: string): number {
  const [year, month, day] = dateOnly.split("-").map(Number);
  return isoWeekday(year ?? 1970, month ?? 1, day ?? 1);
}

function minutesOfDay(timeOfDay: string): number {
  const [hour, minute] = timeOfDay.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function addDaysToDateOnly(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
