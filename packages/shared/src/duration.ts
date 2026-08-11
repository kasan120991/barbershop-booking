/**
 * A length of time, in minutes, turned into something a person reads.
 *
 * This is the duration analogue of `formatCents` — the single place a stored minute count
 * becomes display text. It exists because there was no such place: every screen hand-rolled
 * its own, five different ways ("45 min", "45 minutes", "in 130 min", "about 130 min"), and
 * none of them rolled over into hours. A busy Saturday put "about 130 min" on a wall display
 * read from three metres and left the arithmetic to whoever was standing there.
 *
 * Deliberately NOT in `time.ts`. That module is about times of *day* — positions on a clock,
 * measured from midnight — and `formatDayMinute` and `minutesToTimeString` both throw above
 * 1440 for exactly that reason. A duration and a clock position are different quantities that
 * happen to share a unit, and keeping them apart is what stops a 130-minute service being
 * handed to a function that renders it as "2:10 AM".
 */

const MINUTES_PER_HOUR = 60;

/** "n thing" or "n things" — the only inflection this file needs. */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Minutes -> "45 mins", "1 hour", "2 hours 10 mins".
 *
 * An exact hour drops the minutes rather than saying "2 hours 0 mins", and one of anything is
 * singular. Anything not a usable number is treated as zero: callers own the copy for "less
 * than a minute" ("chair is open", "You are up") and reach this only with a real quantity, so
 * a NaN arriving here is a bug upstream and should render as nothing alarming.
 */
export function formatDuration(minutes: number): string {
  const total = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;

  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const rest = total % MINUTES_PER_HOUR;

  if (hours === 0) return plural(rest, 'min');
  if (rest === 0) return plural(hours, 'hour');

  return `${plural(hours, 'hour')} ${plural(rest, 'min')}`;
}
