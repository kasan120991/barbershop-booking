/**
 * Spoken formatting. Pure — no database, so these run with MAMP off.
 *
 * The last test in this file is the important one: it asserts that nothing raw ever
 * reaches a string the assistant will voice. A change that pastes an ISO instant or a
 * cuid into `say` fails here, at a second's cost, rather than on a phone call.
 */

import { describe, expect, it } from 'vitest';

import {
  spokenBooking,
  spokenClock,
  spokenDay,
  spokenDuration,
  spokenList,
  spokenOffer,
  spokenPrice,
  spokenWait,
  spokenWhen,
} from './voice.js';

const TZ = 'America/New_York';

/** Tuesday 11 August 2026, 10:00 local (EDT, UTC-4). */
const TUESDAY_10AM = new Date('2026-08-11T14:00:00.000Z');
/** The same Tuesday at 00:30 UTC — still Monday evening in the shop. */
const NOW_MONDAY = new Date('2026-08-10T16:00:00.000Z');

describe('spokenClock', () => {
  it('renders the wall clock in the shop, not in UTC', () => {
    expect(spokenClock(TUESDAY_10AM, TZ)).toBe('10:00 AM');
  });

  it('keeps the minutes, because "two" and "two fifteen" are different appointments', () => {
    expect(spokenClock(new Date('2026-08-11T18:15:00.000Z'), TZ)).toBe('2:15 PM');
  });
});

describe('spokenDay', () => {
  it('says today and tomorrow by local calendar day, not by elapsed hours', () => {
    // 14 hours apart, but a different date in the shop — a caller means the date.
    expect(spokenDay(TUESDAY_10AM, TZ, NOW_MONDAY)).toBe('tomorrow');
    expect(spokenDay(TUESDAY_10AM, TZ, new Date('2026-08-11T12:00:00.000Z'))).toBe('today');
  });

  it('names the weekday inside the next week', () => {
    expect(spokenDay(TUESDAY_10AM, TZ, new Date('2026-08-07T12:00:00.000Z'))).toBe('Tuesday');
  });

  it('adds the date once a bare weekday would be ambiguous', () => {
    // Eight days out: "Tuesday" could be either of two, and a caller who turns up a
    // week early is exactly what this avoids.
    const spoken = spokenDay(TUESDAY_10AM, TZ, new Date('2026-08-03T12:00:00.000Z'));
    expect(spoken).toBe('Tuesday the 11th');
  });

  it('gets the awkward ordinals right', () => {
    const on = (iso: string) => spokenDay(new Date(iso), TZ, new Date('2026-01-01T12:00:00.000Z'));
    expect(on('2026-03-01T17:00:00.000Z')).toMatch(/the 1st$/);
    expect(on('2026-03-02T17:00:00.000Z')).toMatch(/the 2nd$/);
    expect(on('2026-03-03T17:00:00.000Z')).toMatch(/the 3rd$/);
    // The teens break the rule and are the ones a naive implementation gets wrong.
    expect(on('2026-03-11T17:00:00.000Z')).toMatch(/the 11th$/);
    expect(on('2026-03-12T17:00:00.000Z')).toMatch(/the 12th$/);
    expect(on('2026-03-13T17:00:00.000Z')).toMatch(/the 13th$/);
    expect(on('2026-03-21T17:00:00.000Z')).toMatch(/the 21st$/);
  });
});

describe('daylight saving', () => {
  /**
   * The whole reason this file uses Luxon rather than `Date` arithmetic.
   *
   * 2026-03-08 is the US spring-forward. A 10:00 local appointment is 15:00Z the day
   * before the change and 14:00Z the day after; both must be spoken as ten o'clock,
   * because that is the time the caller will read on the wall when they arrive.
   */
  it('speaks the wall-clock hour on both sides of the change', () => {
    const beforeChange = new Date('2026-03-07T15:00:00.000Z');
    const afterChange = new Date('2026-03-08T14:00:00.000Z');

    expect(spokenClock(beforeChange, TZ)).toBe('10:00 AM');
    expect(spokenClock(afterChange, TZ)).toBe('10:00 AM');
  });

  it('counts the short day as one day, so "tomorrow" stays tomorrow', () => {
    // 23 real hours between these two local mornings, not 24.
    const saturday = new Date('2026-03-07T15:00:00.000Z');
    const sunday = new Date('2026-03-08T14:00:00.000Z');

    expect(spokenDay(sunday, TZ, saturday)).toBe('tomorrow');
  });
});

describe('spokenPrice', () => {
  it('drops the cents on a whole amount, and keeps them otherwise', () => {
    // "$45.00" is read aloud as "forty-five dollars and zero cents".
    expect(spokenPrice(4500)).toBe('$45');
    expect(spokenPrice(4550)).toBe('$45.50');
    expect(spokenPrice(12000)).toBe('$120');
  });
});

describe('spokenWait', () => {
  it('keeps "none today" and "no wait" distinct', () => {
    // Collapsing these would send somebody to a shop that cannot cut their hair.
    expect(spokenWait(null)).toBe('nothing available today');
    expect(spokenWait(0)).toBe('no wait right now');
    expect(spokenWait(25)).toBe('about 25 mins');
    expect(spokenWait(90)).toBe('about 1 hour 30 mins');
  });
});

describe('spokenList', () => {
  it('reads a list the way a person says one', () => {
    expect(spokenList([])).toBe('');
    expect(spokenList(['a haircut'])).toBe('a haircut');
    expect(spokenList(['a haircut', 'a beard trim'])).toBe('a haircut and a beard trim');
    expect(spokenList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('spokenOffer and spokenBooking', () => {
  it('names the barber on every offer', () => {
    const spoken = spokenOffer(
      { startAt: TUESDAY_10AM, barberName: 'Andre' },
      TZ,
      new Date('2026-08-11T12:00:00.000Z'),
    );
    expect(spoken).toBe('today at 10:00 AM with Andre');
  });

  it('reads a booking back in the order a person confirms one', () => {
    const spoken = spokenBooking(
      {
        startAt: TUESDAY_10AM,
        barberName: 'Andre',
        serviceNames: ['a haircut', 'a beard trim'],
        durationMinutes: 65,
        priceCentsTotal: 6500,
      },
      TZ,
      new Date('2026-08-11T12:00:00.000Z'),
    );

    expect(spoken).toBe(
      'today at 10:00 AM, with Andre, a haircut and a beard trim, 1 hour 5 mins, $65',
    );
  });
});

describe('nothing raw ever reaches the caller', () => {
  /**
   * The regression guard for this whole module.
   *
   * The failure it exists for is somebody interpolating an appointment id or a Date into
   * a `say` string because it was convenient. The assistant would then read a cuid down
   * the phone, or hand a caller an ISO timestamp as a time. Cheap to assert, and it fails
   * here rather than in a recording.
   */
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const CUID = /\bc[a-z0-9]{24}\b/;
  const BARE_CENTS = /\b\d{4,}\b/;

  it('produces words, not identifiers or instants', () => {
    const now = new Date('2026-08-10T16:00:00.000Z');
    const spoken = [
      spokenWhen(TUESDAY_10AM, TZ, now),
      spokenOffer({ startAt: TUESDAY_10AM, barberName: 'Andre' }, TZ, now),
      spokenWait(25),
      spokenPrice(4500),
      spokenDuration(45),
      spokenBooking(
        {
          startAt: TUESDAY_10AM,
          barberName: 'Andre',
          serviceNames: ['a haircut'],
          durationMinutes: 45,
          priceCentsTotal: 4500,
        },
        TZ,
        now,
      ),
    ];

    for (const line of spoken) {
      expect(line).not.toMatch(ISO);
      expect(line).not.toMatch(CUID);
      expect(line).not.toMatch(BARE_CENTS);
    }
  });
});
