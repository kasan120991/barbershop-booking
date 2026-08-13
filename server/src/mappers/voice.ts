/**
 * The one place a machine value becomes a spoken word.
 *
 * A voice model cannot say `2026-08-11T14:00:00.000Z`, and a text-to-speech engine reads
 * `4500` as "four thousand five hundred". Everything the receptionist voices is built
 * here, so there is a single file to check when something reads badly down a phone line —
 * and a single file whose tests can assert that no raw instant or cuid ever escapes.
 *
 * It lives in `server/` rather than in `shared` because every one of these needs
 * `ShopSettings.timezone` and Luxon, and `shared` has neither by design. That is the same
 * boundary that keeps `waitMinutes` in `mappers/queue.ts`.
 *
 * All day arithmetic goes through `DateTime.setZone`, never raw `Date` maths, so a
 * booking either side of a clock change is spoken in the hour the caller will actually
 * turn up.
 */

import { formatCentsSpoken, formatDuration } from '@francis/shared';
import { DateTime } from 'luxon';

/** "2:15 PM". The minutes are always spoken, because "two PM" and "two fifteen" differ. */
export function spokenClock(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at).setZone(timezone).toFormat('h:mm a');
}

/**
 * "today", "tomorrow", "Thursday", or "Thursday the 28th" once a plain weekday would be
 * ambiguous.
 *
 * A weekday name is only unambiguous inside the next seven days — past that, "Thursday"
 * could be either of two, and a caller who turns up a week early is the failure this
 * avoids. Compared on local calendar days rather than elapsed hours, so a booking at 9am
 * tomorrow is "tomorrow" even when it is fourteen hours away.
 */
export function spokenDay(at: Date, timezone: string, now: Date): string {
  const day = DateTime.fromJSDate(at).setZone(timezone).startOf('day');
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day');
  const days = Math.round(day.diff(today, 'days').days);

  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days < 7) return day.toFormat('cccc');

  return `${day.toFormat('cccc')} the ${ordinal(day.day)}`;
}

/** "today at 2:15 PM", "Thursday at 10:00 AM". */
export function spokenWhen(at: Date, timezone: string, now: Date): string {
  return `${spokenDay(at, timezone, now)} at ${spokenClock(at, timezone)}`;
}

/** "today at 2:15 PM with Andre" — one offer, exactly as the caller hears it. */
export function spokenOffer(
  offer: { startAt: Date; barberName: string },
  timezone: string,
  now: Date,
): string {
  return `${spokenWhen(offer.startAt, timezone, now)} with ${offer.barberName}`;
}

/**
 * A wait, in words.
 *
 * Three distinct outcomes, and they must stay three: `null` means nobody can do the work
 * today, zero means walk in now, and a number is a wait. Collapsing the first into "no
 * wait" would send somebody down to a shop that cannot cut their hair.
 */
export function spokenWait(minutes: number | null): string {
  if (minutes === null) return 'nothing available today';
  if (minutes <= 0) return 'no wait right now';
  return `about ${formatDuration(minutes)}`;
}

/** "$45" rather than "$45.00" — see `formatCentsSpoken` for why the cents are dropped. */
export function spokenPrice(cents: number): string {
  return formatCentsSpoken(cents);
}

/** "45 mins", "1 hour 30 mins". The shared formatter — TTS reads both correctly. */
export function spokenDuration(minutes: number): string {
  return formatDuration(minutes);
}

/**
 * "a haircut and a beard trim" — a list a person would say out loud.
 *
 * The Oxford comma is omitted deliberately: it is inaudible, and the pause it implies is
 * already produced by the "and".
 */
export function spokenList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * "Thursday at 2:15 PM with Andre, a haircut, 45 mins, $45" — a whole booking, read back.
 *
 * The order is the order a person confirms one in: when, who, what, how long, how much.
 */
export function spokenBooking(
  booking: {
    startAt: Date;
    barberName: string;
    serviceNames: readonly string[];
    durationMinutes: number;
    priceCentsTotal: number;
  },
  timezone: string,
  now: Date,
): string {
  return [
    spokenWhen(booking.startAt, timezone, now),
    `with ${booking.barberName}`,
    spokenList(booking.serviceNames),
    spokenDuration(booking.durationMinutes),
    spokenPrice(booking.priceCentsTotal),
  ]
    .filter((part) => part.length > 0)
    .join(', ');
}

/** 1 -> "1st", 22 -> "22nd". English ordinals, including the teens that break the rule. */
function ordinal(day: number): string {
  const remainderTen = day % 10;
  const remainderHundred = day % 100;

  if (remainderTen === 1 && remainderHundred !== 11) return `${String(day)}st`;
  if (remainderTen === 2 && remainderHundred !== 12) return `${String(day)}nd`;
  if (remainderTen === 3 && remainderHundred !== 13) return `${String(day)}rd`;
  return `${String(day)}th`;
}
