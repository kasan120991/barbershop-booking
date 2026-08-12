/**
 * The boundary at 60 is the whole point of this file, so it gets tested from both sides.
 */

import { describe, expect, it } from 'vitest';

import { formatDuration, walkInOpeningLabel } from './duration.js';

describe('formatDuration', () => {
  it('leaves anything under an hour in minutes', () => {
    expect(formatDuration(45)).toBe('45 mins');
    expect(formatDuration(59)).toBe('59 mins');
  });

  /** The reason this module exists: 130 was rendering as "130 min" on the wall display. */
  it('rolls over into hours', () => {
    expect(formatDuration(130)).toBe('2 hours 10 mins');
    expect(formatDuration(61)).toBe('1 hour 1 min');
    expect(formatDuration(90)).toBe('1 hour 30 mins');
  });

  /** An exact hour says "2 hours", never "2 hours 0 mins". */
  it('drops the minutes on an exact hour', () => {
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(120)).toBe('2 hours');
    expect(formatDuration(480)).toBe('8 hours');
  });

  it('is singular at one', () => {
    expect(formatDuration(1)).toBe('1 min');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(61)).toBe('1 hour 1 min');
  });

  it('says nothing alarming for zero', () => {
    expect(formatDuration(0)).toBe('0 mins');
  });

  /**
   * Callers own their own "less than a minute" copy and should never reach here with these.
   * Rendering "-5 mins" or "NaN mins" on a screen facing the shop is worse than rounding to
   * nothing, so the helper clamps rather than trusting.
   */
  it('treats a negative or unusable number as zero', () => {
    expect(formatDuration(-5)).toBe('0 mins');
    expect(formatDuration(Number.NaN)).toBe('0 mins');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0 mins');
  });

  it('rounds a fractional minute rather than printing it', () => {
    expect(formatDuration(45.4)).toBe('45 mins');
    expect(formatDuration(59.6)).toBe('1 hour');
  });
});

/**
 * One decision, two screens. The kiosk and the staff dialog quote the same person from
 * opposite sides of the counter, so the three answers live here rather than in either.
 */
describe('walkInOpeningLabel', () => {
  it('says nothing when there is no answer for this barber', () => {
    // Not "fully booked" — an absent row means we were told nothing about them.
    expect(walkInOpeningLabel(undefined)).toBe('');
  });

  it('separates "nothing left today" from "no answer"', () => {
    expect(walkInOpeningLabel(null)).toBe('Not today');
  });

  it('reads as free under a minute', () => {
    expect(walkInOpeningLabel(0)).toBe('Free now');
    expect(walkInOpeningLabel(0.4)).toBe('Free now');
  });

  it('spells a wait the same way every other duration in the app is spelled', () => {
    expect(walkInOpeningLabel(12)).toBe('12 mins');
    expect(walkInOpeningLabel(70)).toBe('1 hour 10 mins');
  });

  /** The kiosk's label has no heading over it, so it names the quantity. The desk's does. */
  it('takes a suffix for the screen that needs one', () => {
    expect(walkInOpeningLabel(12, { suffix: 'wait' })).toBe('12 mins wait');
    // The suffix never turns up on the two answers that are not a duration.
    expect(walkInOpeningLabel(null, { suffix: 'wait' })).toBe('Not today');
    expect(walkInOpeningLabel(0, { suffix: 'wait' })).toBe('Free now');
  });
});
