/**
 * The chair card's four states.
 *
 * Half of a real incident lived here: the wall display read `freeFrom === null` as
 * "Free now" while the server, the desk board and a barber's own Today all read the same
 * field as "Done for the day". Nothing errored — a screen simply said the opposite of the
 * truth to a room full of customers, which is why these states are pinned in one place.
 */

import { describe, expect, it } from 'vitest';

import { CHAIR_STATE, chairState } from './chair.js';

const NOON = Date.parse('2026-08-11T16:00:00.000Z');
const free = (iso: string | null) => ({ occupied: false, freeFrom: iso, asOf: NOON });

describe('chairState', () => {
  it('never calls a chair with somebody in it free', () => {
    // Occupancy wins over everything, including a `freeFrom` in the past.
    expect(
      chairState({ occupied: true, freeFrom: '2026-08-11T15:00:00.000Z', asOf: NOON }),
    ).toBe(CHAIR_STATE.OCCUPIED);
  });

  /**
   * The bug, pinned.
   *
   * `null` is the server saying it found no free interval left today — booked solid, or
   * off shift. It is the opposite of free, and the wall display used to print exactly
   * that inverse.
   */
  it('reads a null freeFrom as done for the day, never as free', () => {
    expect(chairState(free(null))).toBe(CHAIR_STATE.DONE_FOR_THE_DAY);
    expect(chairState(free(null))).not.toBe(CHAIR_STATE.OPEN_NOW);
  });

  it('still says occupied when the chair is both busy and finished for the day', () => {
    // A barber mid-cut on the last booking of the day. What the room is looking at is
    // the cut, not the end of the shift.
    expect(chairState({ occupied: true, freeFrom: null, asOf: NOON })).toBe(
      CHAIR_STATE.OCCUPIED,
    );
  });

  it('treats a chair free within the slack window as open now', () => {
    expect(chairState(free(new Date(NOON + 30_000).toISOString()))).toBe(CHAIR_STATE.OPEN_NOW);
    expect(chairState(free(new Date(NOON - 60_000).toISOString()))).toBe(CHAIR_STATE.OPEN_NOW);
  });

  it('treats a chair free later as free later', () => {
    expect(chairState(free(new Date(NOON + 5 * 60_000).toISOString()))).toBe(
      CHAIR_STATE.FREE_LATER,
    );
  });

  it('honours a caller who wants a tighter or looser window', () => {
    const soon = new Date(NOON + 90_000).toISOString();
    expect(chairState({ ...free(soon), slackMs: 30_000 })).toBe(CHAIR_STATE.FREE_LATER);
    expect(chairState({ ...free(soon), slackMs: 120_000 })).toBe(CHAIR_STATE.OPEN_NOW);
  });

  it('never claims a chair is open before the clock has ticked', () => {
    // A screen that has not learned the time knows less than nothing about whether a
    // chair is free, and must not guess in the optimistic direction.
    expect(
      chairState({ occupied: false, freeFrom: new Date(NOON).toISOString(), asOf: null }),
    ).toBe(CHAIR_STATE.FREE_LATER);
  });

  it('does not claim open now on an unparseable instant', () => {
    expect(chairState(free('not a date'))).toBe(CHAIR_STATE.FREE_LATER);
  });
});
