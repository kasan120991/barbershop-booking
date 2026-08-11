/**
 * The boundary at 60 is the whole point of this file, so it gets tested from both sides.
 */

import { describe, expect, it } from 'vitest';

import { formatDuration } from './duration.js';

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
