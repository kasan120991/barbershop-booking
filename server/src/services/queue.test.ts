/**
 * The walk-in estimator — pure, so every rule is exercised directly.
 *
 * No database and no clock. `now` is injected, which matters more here than anywhere
 * else in the system: "when will you be ready for me" is a question about the current
 * time, and a test that read the real clock could only be run during opening hours.
 *
 * Times are written as local shop time and converted once, because the interesting
 * assertions are all of the form "13:30, not 13:00" and nobody reads those in UTC.
 */

import { describe, expect, it } from 'vitest';

import {
  assignQueue,
  type AssignQueueInput,
  type QueueCandidate,
  type QueueChair,
} from './queue.js';

const TZ = 'America/New_York';
/** 2026-08-11 is a Tuesday in summer, so New York is UTC-4. */
const DAY = '2026-08-11';

/** Local shop time as a UTC instant — "10:00" is 14:00Z on this date. */
function at(time: string): Date {
  return new Date(`${DAY}T${time}:00.000-04:00`);
}

/** The instant formatted back as local "HH:mm", which is how a human reads a board. */
function local(instant: Date | null): string | null {
  if (instant === null) return null;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).format(instant);
}

const CUT = 'svc-cut';
const BEARD = 'svc-beard';

/** A full working day, 10:00–18:00, nothing booked. */
function chair(overrides: Partial<QueueChair> = {}): QueueChair {
  return {
    barberId: 'marcus',
    sortOrder: 0,
    serviceIds: [CUT, BEARD],
    free: [{ start: at('10:00'), end: at('18:00') }],
    ...overrides,
  };
}

function candidate(overrides: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    id: 'e1',
    barberId: null,
    serviceIds: [CUT],
    durationMinutes: 30,
    priority: 0,
    joinedAt: at('09:00'),
    status: 'WAITING',
    startedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<AssignQueueInput> = {}) {
  const estimate = assignQueue({
    now: at('10:00'),
    bufferMinutes: 0,
    chairs: [chair()],
    entries: [],
    ...overrides,
  });

  return {
    ...estimate,
    /** Board order, as `id -> "HH:mm"`, which is what every assertion below reads. */
    readyAt: Object.fromEntries(
      estimate.assignments.map((a) => [a.entryId, local(a.estimatedReadyAt)]),
    ),
    barberOf: Object.fromEntries(
      estimate.assignments.map((a) => [a.entryId, a.assignedBarberId]),
    ),
    order: estimate.assignments.map((a) => a.entryId),
    positionOf: Object.fromEntries(estimate.assignments.map((a) => [a.entryId, a.position])),
  };
}

describe('a plain line', () => {
  it('seats people back to back in the order they arrived', () => {
    const result = run({
      entries: [
        candidate({ id: 'first', joinedAt: at('09:00') }),
        candidate({ id: 'second', joinedAt: at('09:05') }),
        candidate({ id: 'third', joinedAt: at('09:10') }),
      ],
    });

    expect(result.order).toEqual(['first', 'second', 'third']);
    expect(result.readyAt).toEqual({ first: '10:00', second: '10:30', third: '11:00' });
    expect(result.positionOf).toEqual({ first: 1, second: 2, third: 3 });
  });

  it('never quotes a time in the past, however long ago the shift started', () => {
    // The barber's day began at 10:00 but it is now half past noon.
    const result = run({
      now: at('12:30'),
      entries: [candidate({ id: 'walkup' })],
    });

    expect(result.readyAt.walkup).toBe('12:30');
  });

  it('leaves the turnaround buffer between one client and the next', () => {
    const result = run({
      bufferMinutes: 10,
      entries: [
        candidate({ id: 'first', joinedAt: at('09:00') }),
        candidate({ id: 'second', joinedAt: at('09:05') }),
      ],
    });

    // 30 minutes of cutting, then ten to sweep up.
    expect(result.readyAt).toEqual({ first: '10:00', second: '10:40' });
  });
});

describe('priority', () => {
  it('puts a bumped client ahead of someone who arrived first', () => {
    const result = run({
      entries: [
        candidate({ id: 'early', joinedAt: at('09:00') }),
        candidate({ id: 'bumped', joinedAt: at('09:30'), priority: 5 }),
      ],
    });

    expect(result.order).toEqual(['bumped', 'early']);
    expect(result.readyAt).toEqual({ bumped: '10:00', early: '10:30' });
    expect(result.positionOf).toEqual({ bumped: 1, early: 2 });
  });

  it('falls back to arrival time between two clients at the same priority', () => {
    const result = run({
      entries: [
        candidate({ id: 'later', joinedAt: at('09:30'), priority: 5 }),
        candidate({ id: 'earlier', joinedAt: at('09:00'), priority: 5 }),
      ],
    });

    expect(result.order).toEqual(['earlier', 'later']);
  });

  it('still produces one answer when two people joined in the same millisecond', () => {
    const sameInstant = at('09:00');
    const entries = [
      candidate({ id: 'bbb', joinedAt: sameInstant }),
      candidate({ id: 'aaa', joinedAt: sameInstant }),
    ];

    // Whatever the tie-break is, it must not depend on the order they were loaded in.
    expect(run({ entries }).order).toEqual(run({ entries: [...entries].reverse() }).order);
  });
});

describe('booked appointments', () => {
  /** 10:00–18:00 with a 45-minute appointment already booked at 11:00. */
  const withBooking = chair({
    free: [
      { start: at('10:00'), end: at('11:00') },
      { start: at('11:45'), end: at('18:00') },
    ],
  });

  it('will not seat a walk-in over a slot somebody booked online', () => {
    const result = run({
      chairs: [withBooking],
      entries: [
        candidate({ id: 'first', durationMinutes: 30, joinedAt: at('09:00') }),
        candidate({ id: 'second', durationMinutes: 30, joinedAt: at('09:05') }),
      ],
    });

    // 10:00 and 10:30 fit before the appointment; the second is not pushed into it.
    expect(result.readyAt).toEqual({ first: '10:00', second: '10:30' });
  });

  it('pushes a walk-in past the appointment when it cannot fit in front of it', () => {
    const result = run({
      chairs: [withBooking],
      entries: [candidate({ id: 'long', durationMinutes: 90 })],
    });

    expect(result.readyAt.long).toBe('11:45');
  });

  it('lets a short cut use a gap a longer one could not', () => {
    const result = run({
      chairs: [withBooking],
      entries: [
        candidate({ id: 'long', durationMinutes: 90, joinedAt: at('09:00') }),
        candidate({ id: 'short', durationMinutes: 30, joinedAt: at('09:05') }),
      ],
    });

    /**
     * The short cut lands at 10:00, ahead of the client who joined before it — and
     * that is correct rather than queue-jumping: the longer cut could never have used
     * the hour before the appointment, and its own time is unchanged by the decision.
     */
    expect(result.readyAt).toEqual({ long: '11:45', short: '10:00' });
  });
});

describe('"anyone will do"', () => {
  const marcus = chair({ barberId: 'marcus', sortOrder: 0 });
  const dee = chair({ barberId: 'dee', sortOrder: 1 });

  it('sends each waiting client to whichever chair frees up first', () => {
    const result = run({
      chairs: [marcus, dee],
      entries: [
        candidate({ id: 'first', joinedAt: at('09:00') }),
        candidate({ id: 'second', joinedAt: at('09:05') }),
        candidate({ id: 'third', joinedAt: at('09:10') }),
      ],
    });

    // Two chairs open at 10:00, so the first two go straight in and the third waits.
    expect(result.barberOf).toEqual({ first: 'marcus', second: 'dee', third: 'marcus' });
    expect(result.readyAt).toEqual({ first: '10:00', second: '10:00', third: '10:30' });
  });

  it('skips a barber who does not do every service asked for', () => {
    const result = run({
      chairs: [chair({ barberId: 'cuts-only', sortOrder: 0, serviceIds: [CUT] }), dee],
      entries: [candidate({ id: 'beard', serviceIds: [CUT, BEARD] })],
    });

    expect(result.barberOf.beard).toBe('dee');
  });

  it('says so plainly when nobody on today does the whole set', () => {
    const result = run({
      chairs: [chair({ barberId: 'cuts-only', serviceIds: [CUT] })],
      entries: [candidate({ id: 'beard', serviceIds: [CUT, BEARD] })],
    });

    expect(result.readyAt.beard).toBeNull();
    expect(result.assignments[0]?.unservableReason).toBe(
      'No barber on today does all of those services.',
    );
  });

  it('holds a named barber to that chair even when another is free sooner', () => {
    const result = run({
      chairs: [chair({ barberId: 'marcus', free: [{ start: at('14:00'), end: at('18:00') }] }), dee],
      entries: [candidate({ id: 'regular', barberId: 'marcus' })],
    });

    expect(result.barberOf.regular).toBe('marcus');
    expect(result.readyAt.regular).toBe('14:00');
  });
});

describe('chairs that are already busy', () => {
  it('counts someone in the chair against their barber, from when they sat down', () => {
    const result = run({
      now: at('10:20'),
      entries: [
        candidate({
          id: 'seated',
          barberId: 'marcus',
          status: 'IN_CHAIR',
          startedAt: at('10:00'),
          durationMinutes: 45,
        }),
        candidate({ id: 'waiting', joinedAt: at('10:10') }),
      ],
    });

    // Started at 10:00 for 45 minutes, so the next client is up at 10:45 — not 10:20.
    expect(result.readyAt.waiting).toBe('10:45');
  });

  it('counts someone already called as on their way to the chair', () => {
    const result = run({
      now: at('10:00'),
      entries: [
        candidate({ id: 'called', barberId: 'marcus', status: 'CALLED', durationMinutes: 30 }),
        candidate({ id: 'waiting', joinedAt: at('09:30') }),
      ],
    });

    expect(result.readyAt.waiting).toBe('10:30');
  });

  it('takes people out of the numbered line once they are called or seated', () => {
    const result = run({
      entries: [
        candidate({ id: 'seated', barberId: 'marcus', status: 'IN_CHAIR', startedAt: at('10:00') }),
        candidate({ id: 'waiting', joinedAt: at('09:30') }),
      ],
    });

    // "Position 1" has to mean "next", so it belongs to whoever is still waiting.
    expect(result.positionOf).toEqual({ seated: 0, waiting: 1 });
  });

  /**
   * The distinction a chair card lives or dies on. A barber with an empty chair and
   * three people pencilled in for later is available RIGHT NOW — reporting when their
   * line runs out would leave them standing idle beside a card reading "free from
   * 1:44" while the person it means is still sitting in the waiting area.
   */
  it('reports the chair as free now even with a queue pencilled into it', () => {
    const result = run({
      now: at('10:00'),
      entries: [
        candidate({ id: 'first', joinedAt: at('09:00'), durationMinutes: 60 }),
        candidate({ id: 'second', joinedAt: at('09:05'), durationMinutes: 60 }),
      ],
    });

    expect(result.chairs[0]?.freeFrom).toEqual(at('10:00'));
    expect(result.chairs[0]?.waitingCount).toBe(2);
  });

  it('reports who is in each chair and when it next frees up', () => {
    const result = run({
      now: at('10:20'),
      entries: [
        candidate({
          id: 'seated',
          barberId: 'marcus',
          status: 'IN_CHAIR',
          startedAt: at('10:00'),
          durationMinutes: 45,
        }),
      ],
    });

    expect(result.chairs).toEqual([
      { barberId: 'marcus', nowServingEntryId: 'seated', freeFrom: at('10:45'), waitingCount: 0 },
    ]);
  });
});

describe('the end of the day', () => {
  it('admits it cannot fit someone rather than inventing a time', () => {
    const result = run({
      now: at('17:40'),
      entries: [candidate({ id: 'toolate', durationMinutes: 30 })],
    });

    expect(result.readyAt.toolate).toBeNull();
    expect(result.assignments[0]?.unservableReason).toBe('No opening left before closing.');
    // Still in the line, and still numbered — they may yet be squeezed in by hand.
    expect(result.positionOf.toolate).toBe(1);
  });

  it('keeps going down the line after someone who does not fit', () => {
    const result = run({
      now: at('17:30'),
      entries: [
        candidate({ id: 'long', durationMinutes: 60, joinedAt: at('09:00') }),
        candidate({ id: 'quick', durationMinutes: 20, joinedAt: at('09:05') }),
      ],
    });

    expect(result.readyAt).toEqual({ long: null, quick: '17:30' });
  });
});
