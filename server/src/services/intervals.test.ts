import { describe, expect, it } from 'vitest';

import {
  intersectIntervals,
  mergeIntervals,
  overlaps,
  padEnd,
  subtractIntervals,
  totalMinutes,
  type Interval,
} from './intervals.js';

/** Terse fixtures: `at('09:00', '12:00')` on a fixed arbitrary date. */
function at(start: string, end: string): Interval {
  return {
    start: new Date(`2026-08-11T${start}:00.000Z`),
    end: new Date(`2026-08-11T${end}:00.000Z`),
  };
}

function show(intervals: Interval[]): string[] {
  return intervals.map(
    (interval) =>
      `${interval.start.toISOString().slice(11, 16)}-${interval.end.toISOString().slice(11, 16)}`,
  );
}

describe('mergeIntervals', () => {
  it('sorts and joins overlapping runs', () => {
    expect(show(mergeIntervals([at('12:00', '15:00'), at('09:00', '13:00')]))).toEqual([
      '09:00-15:00',
    ]);
  });

  it('joins touching runs — half-open intervals do not conflict at the seam', () => {
    expect(show(mergeIntervals([at('09:00', '12:00'), at('12:00', '17:00')]))).toEqual([
      '09:00-17:00',
    ]);
  });

  it('keeps genuinely separate runs apart', () => {
    expect(show(mergeIntervals([at('09:00', '12:00'), at('13:00', '17:00')]))).toEqual([
      '09:00-12:00',
      '13:00-17:00',
    ]);
  });

  it('drops empty and inverted intervals', () => {
    expect(mergeIntervals([at('12:00', '12:00'), at('15:00', '13:00')])).toEqual([]);
  });

  it('handles an empty input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('subtractIntervals', () => {
  it('splits an interval when the cut is in the middle — this is a lunch break', () => {
    expect(show(subtractIntervals([at('09:00', '17:00')], [at('13:00', '14:00')]))).toEqual([
      '09:00-13:00',
      '14:00-17:00',
    ]);
  });

  it('trims from the front and the back', () => {
    expect(show(subtractIntervals([at('09:00', '17:00')], [at('08:00', '10:00')]))).toEqual([
      '10:00-17:00',
    ]);
    expect(show(subtractIntervals([at('09:00', '17:00')], [at('16:00', '18:00')]))).toEqual([
      '09:00-16:00',
    ]);
  });

  it('removes an interval entirely when covered — an all-day day off', () => {
    expect(subtractIntervals([at('09:00', '17:00')], [at('00:00', '23:59')])).toEqual([]);
  });

  it('applies several cuts at once', () => {
    expect(
      show(
        subtractIntervals(
          [at('09:00', '18:00')],
          [at('10:00', '11:00'), at('13:00', '13:30'), at('16:00', '17:00')],
        ),
      ),
    ).toEqual(['09:00-10:00', '11:00-13:00', '13:30-16:00', '17:00-18:00']);
  });

  it('ignores cuts that miss entirely', () => {
    expect(show(subtractIntervals([at('09:00', '12:00')], [at('14:00', '15:00')]))).toEqual([
      '09:00-12:00',
    ]);
  });

  it('leaves the base untouched when there is nothing to cut', () => {
    expect(show(subtractIntervals([at('09:00', '12:00')], []))).toEqual(['09:00-12:00']);
  });

  it('does not cut at a touching boundary', () => {
    // The cut starts exactly where the base ends, so nothing is removed.
    expect(show(subtractIntervals([at('09:00', '12:00')], [at('12:00', '13:00')]))).toEqual([
      '09:00-12:00',
    ]);
  });
});

describe('intersectIntervals', () => {
  it('keeps only shared time — barber working AND shop open', () => {
    expect(show(intersectIntervals([at('09:00', '18:00')], [at('10:00', '17:00')]))).toEqual([
      '10:00-17:00',
    ]);
  });

  it('returns nothing when the two never meet', () => {
    expect(intersectIntervals([at('09:00', '12:00')], [at('13:00', '17:00')])).toEqual([]);
  });

  it('handles many-to-many overlap', () => {
    expect(
      show(
        intersectIntervals(
          [at('09:00', '12:00'), at('13:00', '18:00')],
          [at('11:00', '14:00'), at('16:00', '20:00')],
        ),
      ),
    ).toEqual(['11:00-12:00', '13:00-14:00', '16:00-18:00']);
  });

  it('treats a touching boundary as no overlap', () => {
    expect(intersectIntervals([at('09:00', '12:00')], [at('12:00', '17:00')])).toEqual([]);
  });
});

describe('padEnd', () => {
  it('extends each interval by the buffer', () => {
    expect(show(padEnd([at('10:00', '10:45')], 5))).toEqual(['10:00-10:50']);
  });

  it('is a no-op at zero', () => {
    expect(show(padEnd([at('10:00', '10:45')], 0))).toEqual(['10:00-10:45']);
  });
});

describe('overlaps', () => {
  it('is false for touching intervals', () => {
    expect(overlaps(at('09:00', '12:00'), at('12:00', '13:00'))).toBe(false);
  });

  it('is true for any genuine intersection', () => {
    expect(overlaps(at('09:00', '12:00'), at('11:00', '13:00'))).toBe(true);
    expect(overlaps(at('09:00', '18:00'), at('11:00', '12:00'))).toBe(true);
  });
});

describe('totalMinutes', () => {
  it('sums the durations', () => {
    expect(totalMinutes([at('09:00', '12:00'), at('13:00', '13:30')])).toBe(210);
    expect(totalMinutes([])).toBe(0);
  });
});
