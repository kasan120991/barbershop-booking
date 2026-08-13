/**
 * What a chair card is saying, as a state rather than as words.
 *
 * Three screens ask this question — the wall board, the desk board, and a barber's own
 * Today — and they disagreed about the most important answer. `freeFrom === null` means
 * "nothing left in this chair today" on the server and on both staff screens; the wall
 * display read the same field as **"Free now"**, printing the exact inverse of the truth
 * across a room full of customers.
 *
 * The states are shared so that cannot drift again. The words are not, because the
 * audiences differ: a barber reads "Done for the day", a room reads something shorter.
 * Same split as `walkInOpeningLabel` in `duration.ts`, and for the same reason.
 *
 * It lives here rather than in either app because neither Nuxt package has a test runner
 * at all — `app/` and `booking/` have no `test` script — and an inverted label is half of
 * a real incident. `shared` is where a pure rule can be pinned.
 */

export const CHAIR_STATE = {
  /** Somebody is in it — a seated walk-in or a started booking. */
  OCCUPIED: 'OCCUPIED',
  /** Nothing left today: booked solid, or off shift. NOT free. */
  DONE_FOR_THE_DAY: 'DONE_FOR_THE_DAY',
  /** Empty and available right now. */
  OPEN_NOW: 'OPEN_NOW',
  /** Empty, but not until later. */
  FREE_LATER: 'FREE_LATER',
} as const;

export type ChairState = (typeof CHAIR_STATE)[keyof typeof CHAIR_STATE];

export interface ChairStateInput {
  /** Somebody is in the chair this moment, from either table. */
  occupied: boolean;
  /** ISO instant, or null meaning nothing is left in this chair today. */
  freeFrom: string | null;
  /**
   * The board's clock in milliseconds, never the browser's.
   *
   * Null before it has ticked, which must not be read as "free now" — a screen that has
   * not learned the time yet knows less than nothing about whether a chair is open.
   */
  asOf: number | null;
  /** How close counts as now. A screen redrawing every ten seconds needs some slack. */
  slackMs?: number;
}

/**
 * A chair with somebody in it is not free, whatever the arithmetic says.
 *
 * Occupancy is checked first and wins outright — including over `freeFrom === null`,
 * because a barber mid-cut on the last booking of the day is occupied now and finished
 * later, and the first of those is what the room is looking at.
 */
export function chairState(input: ChairStateInput): ChairState {
  if (input.occupied) return CHAIR_STATE.OCCUPIED;
  if (input.freeFrom === null) return CHAIR_STATE.DONE_FOR_THE_DAY;
  if (input.asOf === null) return CHAIR_STATE.FREE_LATER;

  const at = new Date(input.freeFrom).getTime();
  if (Number.isNaN(at)) return CHAIR_STATE.FREE_LATER;

  return at <= input.asOf + (input.slackMs ?? 60_000)
    ? CHAIR_STATE.OPEN_NOW
    : CHAIR_STATE.FREE_LATER;
}
