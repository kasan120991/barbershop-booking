/**
 * The shop's clock and calendar.
 *
 * Every instant in this app is stored UTC and must be *shown* in the shop's timezone,
 * never the browser's — a barber checking the book from home in another state has to
 * see the times the shop will actually run to. That rule was already being followed,
 * by two identical copies of the same `Intl.DateTimeFormat` helper in `calendar.vue`
 * and `queue.vue`. `/my-day` would have been the third, so it lives here now.
 *
 * The part that is not a copy is `dayRange`. `GET /appointments` takes `from` and `to`
 * as **instants**, not a date, so asking for "Tuesday" means knowing which UTC moment
 * Tuesday starts at in the shop's zone — and that is not a fixed offset. The server has
 * `localDayWindow` in `services/availability.ts` for exactly this and does it with
 * luxon, but `packages/shared/src/time.ts` is deliberately zone-free (luxon is
 * server-only, and shared ships to every browser), so the client has to do it with
 * `Intl`. Naive date maths is the specific bug the server refuses to commit; doing it
 * here would move that bug rather than avoid it.
 */

import type { ShopSettingsDto } from '@francis/shared';

/** Only until the real settings arrive. Matches the fallback the pages already used. */
const FALLBACK_ZONE = 'America/New_York';

const MINUTES_PER_DAY = 1440;

export function useShopClock() {
  const api = useApi();

  const settings = useState<ShopSettingsDto | null>('shop:settings', () => null);

  /**
   * `/shop-settings` is unauthenticated and tiny, and this is a no-op once anything
   * has loaded it. Pages that need a *correct* day boundary must await it — with the
   * fallback zone a shop in Los Angeles would fetch the wrong day entirely.
   */
  async function ensureLoaded(): Promise<void> {
    if (settings.value === null) {
      settings.value = (await api<{ settings: ShopSettingsDto }>('/shop-settings')).settings;
    }
  }

  const timezone = computed(() => settings.value?.timezone ?? FALLBACK_ZONE);

  // --- Reading an instant ---------------------------------------------------

  /** "2:45 PM", in the shop's zone. */
  function clock(iso: string | Date | null): string {
    if (iso === null) return '';
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone.value,
    }).format(typeof iso === 'string' ? new Date(iso) : iso);
  }

  /** The hour of the shop's day an instant falls in, 0–23. For bucketing, not display. */
  function hourOf(iso: string | Date): number {
    const date = typeof iso === 'string' ? new Date(iso) : iso;
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.value,
      hour12: false,
      hour: '2-digit',
    }).formatToParts(date).find((part) => part.type === 'hour')?.value;

    // `hour12: false` renders midnight as 24 in some engines.
    return Number(hour ?? '0') % 24;
  }

  /** The shop-local `YYYY-MM-DD` an instant falls on — the day it belongs to here. */
  function localDate(iso: string | Date): string {
    const date = typeof iso === 'string' ? new Date(iso) : iso;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.value,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  }

  // --- Going the other way, which is the hard direction ---------------------

  /**
   * The shop zone's offset from UTC at a given instant, in minutes.
   *
   * Formats the instant as wall-clock in the shop's zone, reassembles those parts as
   * though they were UTC, and takes the difference. It is the standard trick and the
   * only one available without a timezone database in the bundle.
   */
  function offsetMinutesAt(instant: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.value,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);

    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

    // `hour12: false` renders midnight as 24 in some engines, which would put the
    // reassembled instant a day out.
    const hour = pick('hour') % 24;

    const asIfUtc = Date.UTC(
      pick('year'),
      pick('month') - 1,
      pick('day'),
      hour,
      pick('minute'),
      pick('second'),
    );

    return (asIfUtc - instant.getTime()) / 60_000;
  }

  /**
   * A shop-local date plus a minute-of-day, as the UTC instant it really is.
   *
   * Measured twice on purpose. The offset has to be sampled at *some* instant, and on
   * the two days a year the clocks move, the offset at the guess differs from the
   * offset at the answer — which is the hour that silently shifts every appointment if
   * you only look once.
   */
  function localMinuteToUtc(localDay: string, minuteOfDay: number): Date {
    const [year, month, day] = localDay.split('-').map(Number);
    const naive = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) + minuteOfDay * 60_000;

    const firstPass = naive - offsetMinutesAt(new Date(naive)) * 60_000;
    const secondPass = naive - offsetMinutesAt(new Date(firstPass)) * 60_000;

    return new Date(secondPass);
  }

  /** The `{ from, to }` a range endpoint needs for one shop-local day. */
  function dayRange(localDay: string): { from: string; to: string } {
    return {
      from: localMinuteToUtc(localDay, 0).toISOString(),
      to: localMinuteToUtc(localDay, MINUTES_PER_DAY).toISOString(),
    };
  }

  /** The same, for a run of days starting at `localDay`. */
  function rangeOfDays(localDay: string, days: number): { from: string; to: string } {
    return {
      from: localMinuteToUtc(localDay, 0).toISOString(),
      to: localMinuteToUtc(localDay, MINUTES_PER_DAY * days).toISOString(),
    };
  }

  // --- Plain calendar maths on `YYYY-MM-DD` ---------------------------------
  //
  // No zone involved: these move a date on the calendar, and the conversion to an
  // instant happens above. Done in UTC so a browser's own offset cannot shift a day.

  function addDays(localDay: string, days: number): string {
    const [year, month, day] = localDay.split('-').map(Number);
    const moved = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
    return moved.toISOString().slice(0, 10);
  }

  /** Today, in the shop's zone — which is not always the browser's today. */
  function today(): string {
    return localDate(new Date());
  }

  /**
   * The Monday on or before a date.
   *
   * Monday-first, unlike `DAY_NAMES` and the `dayOfWeek` columns, which are Sunday-first
   * because that is what `Date.prototype.getDay()` returns and the schema follows it.
   * A week *view* is read as a working week and starts where the work does; a stored
   * `dayOfWeek` is an index and starts where the standard does. Different jobs.
   */
  function weekStart(localDay: string): string {
    const [year, month, day] = localDay.split('-').map(Number);
    const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
    // Sunday (0) belongs to the week that began six days earlier.
    return addDays(localDay, weekday === 0 ? -6 : 1 - weekday);
  }

  /** "Tuesday, 11 August" — for a date that is a calendar date, not an instant. */
  function longDate(localDay: string, options: Intl.DateTimeFormatOptions = {}): string {
    const [year, month, day] = localDay.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      // The parts came from a shop-local date, so rendering them in any other zone
      // could shift the day back off the date it names.
      timeZone: 'UTC',
      ...options,
    }).format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)));
  }

  return {
    settings,
    timezone,
    ensureLoaded,
    clock,
    hourOf,
    localDate,
    dayRange,
    rangeOfDays,
    addDays,
    today,
    weekStart,
    longDate,
  };
}
