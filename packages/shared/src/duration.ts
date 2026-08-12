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

/**
 * What a walk-up quote says beside a barber's name, on both sides of the counter.
 *
 * The kiosk and the staff dialog ask the estimator the same question about the same
 * person minutes apart, so the three answers have to be one decision rather than two
 * copies waiting to drift — the reason this file exists at all.
 *
 * They phrase the number differently, and deliberately. The kiosk's label sits under a
 * name with no heading of its own, where a bare duration reads as how long *he* takes, so
 * it passes `suffix: 'wait'`. The desk's sits in a right-hand column under "Barber",
 * where the word is redundant and the column is being scanned.
 *
 * Three outcomes, and they must stay three: `undefined` is "no answer for this person",
 * `null` is "an answer, and it is not today", a number is a wait. Collapsing the first two
 * labels a barber who is merely missing from the payload as fully booked.
 */
export function walkInOpeningLabel(
  minutes: number | null | undefined,
  options: { suffix?: string } = {},
): string {
  if (minutes === undefined) return '';
  if (minutes === null) return 'Not today';
  // Honest here in a way it is not on a chair card: this is measured after the waiting
  // line is allocated, not before it.
  if (minutes < 1) return 'Free now';

  const spelled = formatDuration(minutes);
  return options.suffix === undefined ? spelled : `${spelled} ${options.suffix}`;
}
