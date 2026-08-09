/**
 * Time-of-day helpers.
 *
 * Opening hours and barber shifts are stored as **minutes from local midnight**, not
 * as timestamps, and that is deliberate: a weekly recurring rule like "Saturday
 * 9:00–17:00" has to mean 9am in the shop on every Saturday, including the two a year
 * where the clocks move. A stored instant would silently become 8am or 10am; a
 * stored offset from midnight cannot.
 *
 * These are pure conversions with no timezone knowledge at all — resolving a local
 * minute-offset to a real UTC instant needs `ShopSettings.timezone` and lives on the
 * server. Keeping this file zone-free is what lets it ship to the browser.
 */

/** Minutes in a day. 1440 is valid as an END time, meaning midnight tomorrow. */
export const MINUTES_IN_DAY = 1440;

export function isValidDayMinute(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MINUTES_IN_DAY;
}

/** 540 -> "09:00". Zero-padded 24-hour, which is what `<input type="time">` expects. */
export function minutesToTimeString(minutes: number): string {
  if (!isValidDayMinute(minutes)) {
    throw new RangeError(`Expected 0–${MINUTES_IN_DAY} minutes, received: ${String(minutes)}`);
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** "09:00" -> 540. Returns null on anything unparseable, so callers can show a field error. */
export function timeStringToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return null;
  if (mins > 59) return null;

  const total = hours * 60 + mins;
  return isValidDayMinute(total) ? total : null;
}

/** 540 -> "9:00 AM", for display. Never for input — round-tripping a 12-hour string is lossy. */
export function formatDayMinute(minutes: number, locale = 'en-US'): string {
  if (!isValidDayMinute(minutes)) {
    throw new RangeError(`Expected 0–${MINUTES_IN_DAY} minutes, received: ${String(minutes)}`);
  }
  // An arbitrary fixed date: only the time component is rendered, and using UTC
  // getters/setters keeps the host machine's zone out of it entirely.
  const date = new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/** "9:00 AM – 5:00 PM". The en dash is intentional — it is a range, not a hyphenated word. */
export function formatDayMinuteRange(
  openMinute: number,
  closeMinute: number,
  locale = 'en-US',
): string {
  return `${formatDayMinute(openMinute, locale)} – ${formatDayMinute(closeMinute, locale)}`;
}

/** 0 = Sunday, matching `Date.prototype.getDay()` and the `dayOfWeek` column. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? `Day ${String(dayOfWeek)}`;
}

/** Matches a calendar date with no time or zone, e.g. "2026-12-25". */
export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) return false;
  // Rejects 2026-02-31, which passes the pattern but is not a real day.
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}
