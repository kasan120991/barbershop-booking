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
  type ChairOccupant,
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
      {
        barberId: 'marcus',
        nowServingEntryId: 'seated',
        // Null, and asserted rather than omitted: a walk-in is not an appointment, and
        // the two ids come from different tables.
        nowServingAppointmentId: null,
        freeFrom: at('10:45'),
        waitingCount: 0,
      },
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

/**
 * The walk-up probe — what the kiosk's front door puts on the glass.
 *
 * Every test here is really about *when* the measurement is taken. The probe and
 * `QueueChairState.freeFrom` read the same chairs through the same intervals and give
 * different answers, and the only difference between them is that one runs before the
 * waiting line is allocated and the other runs after. The first test below is that pair,
 * and it is the reason this block exists.
 */
describe('the next opening for a walk-up', () => {
  /** The probe as local "HH:mm", read the same way as every other assertion here. */
  function opening(result: ReturnType<typeof run>): string | null {
    return local(result.walkUp?.availableAt ?? null);
  }

  const PROBE = { durationMinutes: 30, serviceIds: [CUT] };

  it('is measured after the line, where freeFrom is measured before it', () => {
    const result = run({
      walkUp: PROBE,
      entries: [
        candidate({ id: 'first', durationMinutes: 30, joinedAt: at('09:00') }),
        candidate({ id: 'second', durationMinutes: 30, joinedAt: at('09:05') }),
      ],
    });

    // The line runs 10:00–11:00, so a new arrival sits down at 11:00.
    expect(opening(result)).toBe('11:00');

    // And the chair still reports itself available at 10:00, because that is a different
    // question: the barber is free, it is the waiting area that is not.
    expect(local(result.chairs[0]?.freeFrom ?? null)).toBe('10:00');
  });

  it('claims nothing — asking does not move the board', () => {
    const entries = [
      candidate({ id: 'first', durationMinutes: 30, joinedAt: at('09:00') }),
      candidate({ id: 'second', durationMinutes: 45, joinedAt: at('09:05') }),
    ];

    const asked = run({ walkUp: PROBE, entries });
    const unasked = run({ entries });

    expect(asked.assignments).toEqual(unasked.assignments);
    expect(asked.chairs).toEqual(unasked.chairs);
  });

  it('can use a gap the waiting cut in front of it could not', () => {
    const result = run({
      // Twenty free minutes, then a booked hour, then the rest of the day.
      chairs: [
        chair({
          free: [
            { start: at('10:00'), end: at('10:20') },
            { start: at('11:00'), end: at('18:00') },
          ],
        }),
      ],
      walkUp: { durationMinutes: 20, serviceIds: [CUT] },
      entries: [candidate({ id: 'long', durationMinutes: 30 })],
    });

    // The 30-minute cut cannot fit before the appointment and takes 11:00.
    expect(result.readyAt.long).toBe('11:00');
    // A 20-minute one still can, and that costs the longer cut nothing.
    expect(opening(result)).toBe('10:00');
  });

  it('takes the soonest chair, not the first one', () => {
    const result = run({
      chairs: [chair({ barberId: 'marcus', sortOrder: 0 }), chair({ barberId: 'dre', sortOrder: 1 })],
      walkUp: PROBE,
      entries: [candidate({ id: 'held', barberId: 'marcus', durationMinutes: 60 })],
    });

    // Marcus is taken until 11:00; Dre is free now and that is the answer.
    expect(opening(result)).toBe('10:00');
  });

  it('says there is no opening rather than inventing one', () => {
    const result = run({ now: at('17:40'), walkUp: PROBE });

    expect(result.walkUp).toEqual({
      durationMinutes: 30,
      availableAt: null,
      byChair: [{ barberId: 'marcus', availableAt: null }],
    });
  });

  it('has no answer at all when nobody on today does that service', () => {
    const result = run({
      chairs: [chair({ serviceIds: [BEARD] })],
      walkUp: PROBE,
    });

    // Null, not "no opening" — the shop is not full, it just does not sell this today.
    expect(result.walkUp).toBeNull();
  });

  it('is absent unless the caller asks for it', () => {
    expect(run({ entries: [candidate()] }).walkUp).toBeNull();
  });

  /**
   * The same probe, asked of each chair rather than of the shop.
   *
   * `availableAt` above is the best of these, which is the right answer for a front door
   * and the wrong one for somebody choosing between people: it is precisely the
   * difference between two barbers that a shortest-of collapses away.
   */
  describe('per barber', () => {
    /** Each chair's own answer, as `barberId -> "HH:mm"`. */
    function openings(result: ReturnType<typeof run>): Record<string, string | null> {
      return Object.fromEntries(
        (result.walkUp?.byChair ?? []).map((row) => [row.barberId, local(row.availableAt)]),
      );
    }

    it('answers about the basket that was picked, not the shortest thing on the menu', () => {
      const chairs = [
        chair({
          free: [
            { start: at('10:00'), end: at('10:45') },
            { start: at('12:00'), end: at('18:00') },
          ],
        }),
      ];

      // Same board, same instant, two baskets. A short cut fits the gap in front of the
      // booking; an hour-long one does not and waits for the far side of it.
      expect(opening(run({ chairs, walkUp: PROBE }))).toBe('10:00');
      expect(opening(run({ chairs, walkUp: { durationMinutes: 60, serviceIds: [CUT] } }))).toBe(
        '12:00',
      );
    });

    it('gives every capable chair its own answer, not just the best one', () => {
      const result = run({
        chairs: [
          chair({ barberId: 'marcus', sortOrder: 0 }),
          chair({ barberId: 'dre', sortOrder: 1 }),
        ],
        walkUp: PROBE,
        entries: [candidate({ id: 'held', barberId: 'marcus', durationMinutes: 60 })],
      });

      expect(openings(result)).toEqual({ marcus: '11:00', dre: '10:00' });
      // And the shop's own figure is the better of the two, not an average of them.
      expect(opening(result)).toBe('10:00');
    });

    it('keeps a chair with nothing left today rather than dropping it', () => {
      const result = run({
        now: at('17:40'),
        chairs: [
          chair({ barberId: 'marcus', sortOrder: 0 }),
          chair({ barberId: 'late', sortOrder: 1, free: [{ start: at('10:00'), end: at('22:00') }] }),
        ],
        walkUp: PROBE,
      });

      // Present with a null, not absent. "This barber, not today" is an answer; a missing
      // row is indistinguishable from a barber who does not do the work at all.
      expect(openings(result)).toEqual({ marcus: null, late: '17:40' });
    });

    it('leaves out a chair that cannot do every service asked for', () => {
      const result = run({
        chairs: [
          chair({ barberId: 'cuts-only', sortOrder: 0, serviceIds: [CUT] }),
          chair({ barberId: 'does-both', sortOrder: 1 }),
        ],
        walkUp: { durationMinutes: 30, serviceIds: [CUT, BEARD] },
      });

      expect(Object.keys(openings(result))).toEqual(['does-both']);
    });

    it('lists chairs in board order, so the picker cannot reshuffle', () => {
      const result = run({
        chairs: [
          chair({ barberId: 'third', sortOrder: 2 }),
          chair({ barberId: 'first', sortOrder: 0 }),
          chair({ barberId: 'second', sortOrder: 1 }),
        ],
        walkUp: PROBE,
      });

      expect(result.walkUp?.byChair.map((row) => row.barberId)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('claims nothing per chair either, and leaves freeFrom alone', () => {
      const chairs = [
        chair({ barberId: 'marcus', sortOrder: 0 }),
        chair({ barberId: 'dre', sortOrder: 1 }),
      ];
      const entries = [
        candidate({ id: 'first', durationMinutes: 30, joinedAt: at('09:00') }),
        candidate({ id: 'second', durationMinutes: 45, joinedAt: at('09:05') }),
      ];

      const asked = run({ chairs, walkUp: PROBE, entries });
      const unasked = run({ chairs, entries });

      expect(asked.assignments).toEqual(unasked.assignments);
      expect(asked.chairs).toEqual(unasked.chairs);
      // Pinned separately: `freeFrom` is snapshotted between the two passes and the probe
      // runs after both, so reading one barber's opening must not move anybody's chair.
      expect(asked.chairs.map((c) => local(c.freeFrom))).toEqual(
        unasked.chairs.map((c) => local(c.freeFrom)),
      );
    });

    it('answers the same thing twice', () => {
      const input = {
        chairs: [chair({ barberId: 'marcus' })],
        walkUp: PROBE,
        entries: [candidate({ id: 'held', durationMinutes: 60 })],
      };

      expect(run(input).walkUp).toEqual(run(input).walkUp);
    });
  });
});

describe('a booked client in the chair', () => {
  /** A client actually sitting down, as opposed to a slot on the timetable. */
  function occupant(overrides: Partial<ChairOccupant> = {}): ChairOccupant {
    return {
      appointmentId: 'appt-1',
      firstName: 'Marcus',
      startedAt: at('10:00'),
      durationMinutes: 30,
      ...overrides,
    };
  }

  /**
   * The reported bug, reduced.
   *
   * An appointment booked for 13:30 whose client sat down at 10:20. The timetable says the
   * chair is free until 13:30, so the wall display read "Free now" at a barber who was
   * visibly cutting hair. Only `startedAt` knows otherwise.
   *
   * This test fails on the code that shipped the bug.
   */
  it('is busy when the client sat down early, whatever the timetable says', () => {
    const estimate = assignQueue({
      now: at('10:20'),
      bufferMinutes: 5,
      // 13:30–14:00 is booked, so `free` has a hole there — and a wide gap before it.
      chairs: [
        chair({
          free: [
            { start: at('10:00'), end: at('13:30') },
            { start: at('14:05'), end: at('18:00') },
          ],
          occupant: occupant({ startedAt: at('10:20') }),
        }),
      ],
      entries: [],
    });

    const state = estimate.chairs[0];
    // 10:20 + 30 minutes + a 5 minute turnaround.
    expect(local(state?.freeFrom ?? null)).toBe('10:55');
    expect(state?.nowServingAppointmentId).toBe('appt-1');
    // Not a walk-in, and it must never be mistaken for one.
    expect(state?.nowServingEntryId).toBeNull();
  });

  /**
   * The decision taken with the shop: a cut still going is still going.
   *
   * Freeing the chair at the scheduled finish would put "Free now" on the glass while the
   * barber is mid-cut — the same lie the whole fix exists to remove, arriving thirty
   * minutes later.
   */
  it('stays busy past the expected finish, until somebody presses Finish', () => {
    const estimate = assignQueue({
      now: at('14:20'),
      bufferMinutes: 5,
      chairs: [
        chair({
          free: [{ start: at('10:00'), end: at('18:00') }],
          occupant: occupant({ startedAt: at('13:30'), durationMinutes: 30 }),
        }),
      ],
      entries: [],
    });

    // 14:00 came and went; the chair is held to now plus the turnaround, not to 14:00.
    expect(local(estimate.chairs[0]?.freeFrom ?? null)).toBe('14:25');
  });

  it('frees the chair the moment the appointment is no longer in progress', () => {
    // No occupant is what "somebody pressed Finish" looks like to this function.
    const estimate = assignQueue({
      now: at('14:20'),
      bufferMinutes: 5,
      chairs: [chair({ free: [{ start: at('10:00'), end: at('18:00') }] })],
      entries: [],
    });

    expect(local(estimate.chairs[0]?.freeFrom ?? null)).toBe('14:20');
    expect(estimate.chairs[0]?.nowServingAppointmentId).toBeNull();
  });

  it('makes a waiting walk-in queue behind the booked client', () => {
    const estimate = assignQueue({
      now: at('10:20'),
      bufferMinutes: 5,
      chairs: [chair({ occupant: occupant({ startedAt: at('10:20') }) })],
      entries: [candidate({ id: 'w1', barberId: 'marcus' })],
    });

    // The chair is held to 10:55, so the walk-in is seated then rather than immediately.
    expect(local(estimate.assignments[0]?.estimatedReadyAt ?? null)).toBe('10:55');
  });

  it('never puts the booked client in the line', () => {
    const estimate = assignQueue({
      now: at('10:20'),
      bufferMinutes: 0,
      chairs: [chair({ occupant: occupant() })],
      entries: [candidate({ id: 'w1', barberId: 'marcus' })],
    });

    // One assignment, and it is the walk-in's. A client who booked weeks ago must never
    // be numbered into today's walk-in queue.
    expect(estimate.assignments).toHaveLength(1);
    expect(estimate.assignments[0]?.entryId).toBe('w1');
    expect(estimate.assignments[0]?.position).toBe(1);
  });

  it('tracks a walk-in and a booked client on the same chair independently', () => {
    const estimate = assignQueue({
      now: at('10:20'),
      bufferMinutes: 0,
      chairs: [chair({ occupant: occupant() })],
      entries: [
        candidate({ id: 'seated', barberId: 'marcus', status: 'IN_CHAIR', startedAt: at('10:10') }),
      ],
    });

    const state = estimate.chairs[0];
    expect(state?.nowServingEntryId).toBe('seated');
    expect(state?.nowServingAppointmentId).toBe('appt-1');
  });
});

describe('a walk-in who has overrun', () => {
  /**
   * The same rule as a booked client, in the other table.
   *
   * Left alone, a seated walk-in freed its chair at `startedAt + duration` whether or not
   * anybody had finished them — so an overrunning cut read as free on exactly the screen
   * the shop is looking at.
   */
  it('holds the chair until they are actually finished', () => {
    const estimate = assignQueue({
      now: at('11:00'),
      bufferMinutes: 5,
      chairs: [chair()],
      entries: [
        candidate({ id: 'slow', barberId: 'marcus', status: 'IN_CHAIR', startedAt: at('10:00') }),
      ],
    });

    // A 30-minute cut that began at 10:00 is an hour old. The chair is held to now.
    expect(local(estimate.chairs[0]?.freeFrom ?? null)).toBe('11:05');
  });

  it('still frees on time when the cut is running to plan', () => {
    const estimate = assignQueue({
      now: at('10:10'),
      bufferMinutes: 5,
      chairs: [chair()],
      entries: [
        candidate({ id: 'ontime', barberId: 'marcus', status: 'IN_CHAIR', startedAt: at('10:00') }),
      ],
    });

    // Ten minutes into a thirty minute cut: unchanged from before, 10:30 plus turnaround.
    expect(local(estimate.chairs[0]?.freeFrom ?? null)).toBe('10:35');
  });
});
