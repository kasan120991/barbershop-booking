/**
 * Availability engine — pure, so every rule is exercised directly.
 *
 * No database, no clock: `now` is injected, which is what makes a DST boundary or a
 * "too soon to book" rule testable rather than something you wait for.
 */

import { describe, expect, it } from 'vitest';

import {
  computeAvailability,
  computeScheduledIntervals,
  type AvailabilityInput,
  type ScheduledTimeInput,
} from './availability.js';

const TZ = 'America/New_York';

/** The shop's real week: open Tue–Sat, closed Sun/Mon. */
const SHOP_HOURS = [
  { dayOfWeek: 0, openMinute: 0, closeMinute: 0, isClosed: true },
  { dayOfWeek: 1, openMinute: 0, closeMinute: 0, isClosed: true },
  ...[2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    openMinute: 540, // 09:00
    closeMinute: 1200, // 20:00
    isClosed: false,
  })),
];

/** Every seeded barber: 10:00–13:00 and 13:30–18:00. */
const SPLIT_SHIFT = [2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
  { dayOfWeek, startMinute: 600, endMinute: 780 },
  { dayOfWeek, startMinute: 810, endMinute: 1080 },
]);

/** 2026-08-11 is a Tuesday. Summer, so New York is UTC-4. */
const TUESDAY = '2026-08-11';

function makeInput(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    date: TUESDAY,
    timezone: TZ,
    durationMinutes: 45,
    slotGranularityMinutes: 15,
    bufferMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    // Well before the day under test, so notice never interferes unless asked.
    now: new Date('2026-08-01T12:00:00.000Z'),
    barberSchedules: SPLIT_SHIFT,
    shopHours: SHOP_HOURS,
    shopClosures: [],
    scheduleExceptions: [],
    busy: [],
    ...overrides,
  };
}

/** Slots as local "HH:mm" in the shop's zone, which is how a human reads them. */
function localTimes(result: { slots: Date[] }): string[] {
  return result.slots.map((slot) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: TZ,
    }).format(slot),
  );
}

describe('the working day', () => {
  it('offers the morning and afternoon with the lunch gap absent', () => {
    const times = localTimes(computeAvailability(makeInput()));

    expect(times[0]).toBe('10:00');
    // A 45-minute cut must finish by 13:00, so 12:15 is the last morning start.
    expect(times).toContain('12:15');
    expect(times).not.toContain('12:30');
    // Lunch, 13:00–13:30, is not bookable at all.
    expect(times).not.toContain('13:00');
    expect(times).toContain('13:30');
    // And must finish by 18:00.
    expect(times.at(-1)).toBe('17:15');
  });

  it('will not straddle the lunch break', () => {
    // The morning holds 180 minutes and the afternoon 270, so a 300-minute service
    // fits neither and cannot be bookable by spanning the gap between them.
    expect(localTimes(computeAvailability(makeInput({ durationMinutes: 300 })))).toEqual([]);

    // 200 minutes DOES fit the afternoon, and is offered there only.
    const fitsAfternoon = localTimes(computeAvailability(makeInput({ durationMinutes: 200 })));
    expect(fitsAfternoon[0]).toBe('13:30');
    expect(fitsAfternoon).not.toContain('10:00');
  });

  it('offers fewer starts as the service gets longer', () => {
    const short = localTimes(computeAvailability(makeInput({ durationMinutes: 15 })));
    const long = localTimes(computeAvailability(makeInput({ durationMinutes: 60 })));
    expect(short.length).toBeGreaterThan(long.length);
    expect(long.at(-1)).toBe('17:00');
  });

  it('returns nothing on a day the shop is shut', () => {
    // 2026-08-10 is a Monday.
    const result = computeAvailability(makeInput({ date: '2026-08-10' }));
    expect(result.slots).toEqual([]);
    expect(result.reason).toMatch(/closed/i);
  });
});

describe('shop closures and time off', () => {
  it('a holiday beats an available barber', () => {
    const result = computeAvailability(
      makeInput({
        shopClosures: [
          { start: new Date('2026-08-11T04:00:00.000Z'), end: new Date('2026-08-12T04:00:00.000Z') },
        ],
      }),
    );
    expect(result.slots).toEqual([]);
    expect(result.reason).toMatch(/closed/i);
  });

  it('an all-day TIME_OFF empties the day', () => {
    const result = computeAvailability(
      makeInput({
        scheduleExceptions: [
          {
            type: 'TIME_OFF',
            startAt: new Date('2026-08-11T04:00:00.000Z'),
            endAt: new Date('2026-08-12T04:00:00.000Z'),
          },
        ],
      }),
    );
    expect(result.slots).toEqual([]);
    expect(result.reason).toMatch(/off/i);
  });

  it('a mid-day BLOCK leaves slots either side of it', () => {
    // 14:00–15:30 local is 18:00–19:30Z in August. A short service, so slots can
    // genuinely fit in the half hour before the block — a 45-minute one could not,
    // which is correct but would test the duration rule rather than the block.
    const times = localTimes(
      computeAvailability(
        makeInput({
          durationMinutes: 15,
          scheduleExceptions: [
            {
              type: 'BLOCK',
              startAt: new Date('2026-08-11T18:00:00.000Z'),
              endAt: new Date('2026-08-11T19:30:00.000Z'),
            },
          ],
        }),
      ),
    );

    expect(times).toContain('13:30');
    expect(times).toContain('13:45');
    expect(times).not.toContain('14:00');
    expect(times).not.toContain('15:00');
    expect(times).toContain('15:30');
  });

  it('EXTRA_HOURS opens a day the barber does not normally work', () => {
    // 2026-08-12 is a Wednesday, but use Sunday 2026-08-09 — no weekly rule at all.
    const result = computeAvailability(
      makeInput({
        date: '2026-08-09',
        // The shop is closed Sunday, so open it for the test.
        shopHours: SHOP_HOURS.map((rule) =>
          rule.dayOfWeek === 0 ? { ...rule, isClosed: false, openMinute: 540, closeMinute: 1200 } : rule,
        ),
        scheduleExceptions: [
          {
            type: 'EXTRA_HOURS',
            // 09:00–14:00 local = 13:00–18:00Z in August.
            startAt: new Date('2026-08-09T13:00:00.000Z'),
            endAt: new Date('2026-08-09T18:00:00.000Z'),
          },
        ],
      }),
    );

    const times = localTimes(result);
    expect(times[0]).toBe('09:00');
    expect(times.at(-1)).toBe('13:15');
  });

  it('extra hours still cannot open the shop', () => {
    // Sunday, shop genuinely closed — extra hours grant the barber time but the
    // intersection with shop hours is empty.
    const result = computeAvailability(
      makeInput({
        date: '2026-08-09',
        scheduleExceptions: [
          {
            type: 'EXTRA_HOURS',
            startAt: new Date('2026-08-09T13:00:00.000Z'),
            endAt: new Date('2026-08-09T18:00:00.000Z'),
          },
        ],
      }),
    );
    expect(result.slots).toEqual([]);
  });
});

describe('existing appointments and the buffer', () => {
  it('removes a booked range', () => {
    // 10:00–10:45 local = 14:00–14:45Z.
    const times = localTimes(
      computeAvailability(
        makeInput({
          busy: [
            { start: new Date('2026-08-11T14:00:00.000Z'), end: new Date('2026-08-11T14:45:00.000Z') },
          ],
        }),
      ),
    );
    expect(times).not.toContain('10:00');
    // 10:45 is bookable the moment the previous cut ends — there is no buffer here,
    // which is exactly what the next test adds.
    expect(times[0]).toBe('10:45');
  });

  it('pushes the next start out by the buffer', () => {
    const withoutBuffer = localTimes(
      computeAvailability(
        makeInput({
          durationMinutes: 15,
          busy: [
            { start: new Date('2026-08-11T14:00:00.000Z'), end: new Date('2026-08-11T14:45:00.000Z') },
          ],
        }),
      ),
    );
    const withBuffer = localTimes(
      computeAvailability(
        makeInput({
          durationMinutes: 15,
          bufferMinutes: 30,
          busy: [
            { start: new Date('2026-08-11T14:00:00.000Z'), end: new Date('2026-08-11T14:45:00.000Z') },
          ],
        }),
      ),
    );

    // 10:45 ends the cut; without a buffer 11:00 is free, with 30 minutes it is not.
    expect(withoutBuffer).toContain('11:00');
    expect(withBuffer).not.toContain('11:00');
    expect(withBuffer).toContain('11:15');
  });
});

describe('notice and horizon', () => {
  it('drops slots inside the minimum notice window', () => {
    const times = localTimes(
      computeAvailability(
        makeInput({
          // 15:00Z on the day itself = 11:00 local.
          now: new Date('2026-08-11T15:00:00.000Z'),
          minimumNoticeMinutes: 60,
        }),
      ),
    );

    // Anything before 12:00 local is inside the hour of notice.
    expect(times).not.toContain('11:15');
    expect(times).not.toContain('11:45');
    expect(times[0]).toBe('12:00');
  });

  it('offers nothing beyond the booking horizon', () => {
    const result = computeAvailability(
      makeInput({ date: '2026-12-15', now: new Date('2026-08-01T12:00:00.000Z') }),
    );
    expect(result.slots).toEqual([]);
    expect(result.reason).toMatch(/days ahead/i);
  });
});

/**
 * The schedule half on its own — what the staff calendar reads to shade
 * non-working time. No horizon, no busy subtraction: a calendar looks months
 * ahead and at fully booked days, and must still see the working stretches.
 */
describe('computeScheduledIntervals', () => {
  function makeScheduledInput(overrides: Partial<ScheduledTimeInput> = {}): ScheduledTimeInput {
    return {
      date: TUESDAY,
      timezone: TZ,
      barberSchedules: SPLIT_SHIFT,
      shopHours: SHOP_HOURS,
      shopClosures: [],
      scheduleExceptions: [],
      ...overrides,
    };
  }

  it('returns a split shift as two intervals with the lunch gap between', () => {
    const result = computeScheduledIntervals(makeScheduledInput());

    expect(result.reason).toBeNull();
    // 10:00–13:00 and 13:30–18:00 EDT on 2026-08-11.
    expect(result.intervals.map((i) => [i.start.toISOString(), i.end.toISOString()])).toEqual([
      ['2026-08-11T14:00:00.000Z', '2026-08-11T17:00:00.000Z'],
      ['2026-08-11T17:30:00.000Z', '2026-08-11T22:00:00.000Z'],
    ]);
  });

  it('has no booking horizon — a date months out still resolves', () => {
    // 2026-12-15 is a Tuesday, far beyond the 30-day horizon that would empty the
    // bookable version of this question. The calendar must still see the shifts.
    const result = computeScheduledIntervals(makeScheduledInput({ date: '2026-12-15' }));
    expect(result.reason).toBeNull();
    expect(result.intervals).toHaveLength(2);
    // EST by then: 10:00 local is 15:00Z.
    expect(result.intervals[0]?.start.toISOString()).toBe('2026-12-15T15:00:00.000Z');
  });

  it('reports the shop closed on a day with no open hours', () => {
    // 2026-08-10 is a Monday.
    const result = computeScheduledIntervals(makeScheduledInput({ date: '2026-08-10' }));
    expect(result.intervals).toEqual([]);
    expect(result.reason).toBe('The shop is closed on this day.');
  });

  it('reports a closure date distinctly from a closed weekday', () => {
    const result = computeScheduledIntervals(
      makeScheduledInput({
        shopClosures: [
          { start: new Date('2026-08-11T04:00:00.000Z'), end: new Date('2026-08-12T04:00:00.000Z') },
        ],
      }),
    );
    expect(result.intervals).toEqual([]);
    expect(result.reason).toBe('The shop is closed on this date.');
  });

  it('reports a barber with no shifts as not working', () => {
    const result = computeScheduledIntervals(makeScheduledInput({ barberSchedules: [] }));
    expect(result.intervals).toEqual([]);
    expect(result.reason).toBe('This barber is not working on this day.');
  });

  it('reports all-day time off, and carves a mid-day block out of the shift', () => {
    const dayOff = computeScheduledIntervals(
      makeScheduledInput({
        scheduleExceptions: [
          {
            type: 'TIME_OFF',
            startAt: new Date('2026-08-11T04:00:00.000Z'),
            endAt: new Date('2026-08-12T04:00:00.000Z'),
          },
        ],
      }),
    );
    expect(dayOff.intervals).toEqual([]);
    expect(dayOff.reason).toBe('This barber is off on this date.');

    // 14:00–15:30 local out of the 13:30–18:00 afternoon leaves two pieces.
    const block = computeScheduledIntervals(
      makeScheduledInput({
        scheduleExceptions: [
          {
            type: 'BLOCK',
            startAt: new Date('2026-08-11T18:00:00.000Z'),
            endAt: new Date('2026-08-11T19:30:00.000Z'),
          },
        ],
      }),
    );
    expect(block.reason).toBeNull();
    expect(block.intervals).toHaveLength(3);
  });

  it('adds extra hours before subtracting, on a day with no weekly rule', () => {
    const result = computeScheduledIntervals(
      makeScheduledInput({
        date: '2026-08-09', // Sunday — no weekly rule.
        shopHours: SHOP_HOURS.map((rule) =>
          rule.dayOfWeek === 0
            ? { dayOfWeek: 0, openMinute: 540, closeMinute: 1200, isClosed: false }
            : rule,
        ),
        scheduleExceptions: [
          {
            type: 'EXTRA_HOURS',
            startAt: new Date('2026-08-09T13:00:00.000Z'),
            endAt: new Date('2026-08-09T18:00:00.000Z'),
          },
        ],
      }),
    );
    expect(result.reason).toBeNull();
    expect(result.intervals.map((i) => [i.start.toISOString(), i.end.toISOString()])).toEqual([
      ['2026-08-09T13:00:00.000Z', '2026-08-09T18:00:00.000Z'],
    ]);
  });

  it('resolves a shift on the fall-back day without drifting an hour', () => {
    // 2026-11-01 — the 25-hour day. 10:00–13:00 local is EST by opening: 15:00Z.
    const result = computeScheduledIntervals(
      makeScheduledInput({
        date: '2026-11-01',
        shopHours: SHOP_HOURS.map((rule) =>
          rule.dayOfWeek === 0
            ? { dayOfWeek: 0, openMinute: 540, closeMinute: 1200, isClosed: false }
            : rule,
        ),
        barberSchedules: [{ dayOfWeek: 0, startMinute: 600, endMinute: 780 }],
      }),
    );
    expect(result.intervals.map((i) => [i.start.toISOString(), i.end.toISOString()])).toEqual([
      ['2026-11-01T15:00:00.000Z', '2026-11-01T18:00:00.000Z'],
    ]);
  });
});

/**
 * The tests the whole timezone approach exists for.
 *
 * A weekly rule says "10:00 on Tuesdays". Stored as a UTC instant it would drift by
 * an hour twice a year; stored as minutes-from-local-midnight and resolved per date,
 * it does not. These pin the actual UTC instants so a regression is unmissable.
 */
describe('daylight saving', () => {
  it('resolves 10:00 local to a different UTC instant in winter and summer', () => {
    // 2026-01-13 is a Tuesday in EST (UTC-5). `now` has to precede it, or every slot
    // is correctly rejected as being in the past.
    const winter = computeAvailability(
      makeInput({
        date: '2026-01-13',
        durationMinutes: 15,
        now: new Date('2026-01-01T12:00:00.000Z'),
      }),
    );
    expect(winter.slots[0]?.toISOString()).toBe('2026-01-13T15:00:00.000Z');

    // 2026-08-11 is a Tuesday in EDT (UTC-4).
    const summer = computeAvailability(makeInput({ durationMinutes: 15 }));
    expect(summer.slots[0]?.toISOString()).toBe('2026-08-11T14:00:00.000Z');

    // Same wall-clock time to the barber, an hour apart in UTC.
    expect(localTimes(winter)[0]).toBe('10:00');
    expect(localTimes(summer)[0]).toBe('10:00');
  });

  it('does not gain or lose slots on the spring-forward day', () => {
    // 2026-03-08 is a Sunday — clocks jump 02:00 to 03:00. Use it as a working day
    // so the 23-hour day is fully exercised.
    const springForward = computeAvailability(
      makeInput({
        date: '2026-03-08',
        durationMinutes: 15,
        // Sunday must also be given real hours: flipping isClosed alone leaves
        // openMinute and closeMinute both at 0, which is a zero-length day.
        shopHours: SHOP_HOURS.map((rule) =>
          rule.dayOfWeek === 0
            ? { dayOfWeek: 0, openMinute: 540, closeMinute: 1200, isClosed: false }
            : rule,
        ),
        barberSchedules: [{ dayOfWeek: 0, startMinute: 600, endMinute: 780 }],
        now: new Date('2026-03-01T12:00:00.000Z'),
      }),
    );

    const times = localTimes(springForward);
    // 10:00–13:00 is three hours either side of the transition: 12 slots of 15 min.
    expect(times).toHaveLength(12);
    expect(times[0]).toBe('10:00');
    expect(times.at(-1)).toBe('12:45');
    // 10:00 EDT on that date is 14:00Z — the clocks have already moved.
    expect(springForward.slots[0]?.toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('does not gain or lose slots on the fall-back day', () => {
    // 2026-11-01 is a Sunday — clocks repeat 01:00–02:00, making a 25-hour day.
    const fallBack = computeAvailability(
      makeInput({
        date: '2026-11-01',
        durationMinutes: 15,
        // Sunday must also be given real hours: flipping isClosed alone leaves
        // openMinute and closeMinute both at 0, which is a zero-length day.
        shopHours: SHOP_HOURS.map((rule) =>
          rule.dayOfWeek === 0
            ? { dayOfWeek: 0, openMinute: 540, closeMinute: 1200, isClosed: false }
            : rule,
        ),
        barberSchedules: [{ dayOfWeek: 0, startMinute: 600, endMinute: 780 }],
        // Inside the 30-day horizon: 1 October would be 31 days out and correctly
        // rejected before any DST logic ran.
        now: new Date('2026-10-25T12:00:00.000Z'),
      }),
    );

    const times = localTimes(fallBack);
    expect(times).toHaveLength(12);
    expect(times[0]).toBe('10:00');
    // 10:00 EST on that date is 15:00Z — the extra hour happened before opening.
    expect(fallBack.slots[0]?.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });
});
