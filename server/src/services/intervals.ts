/**
 * Interval arithmetic over UTC instants.
 *
 * Availability is an intersection of six different sources, and every one of them is
 * expressed as "these stretches of time". Getting merge/subtract/intersect subtly
 * wrong produces slots that look plausible and are not bookable — the worst kind of
 * bug in this system — so this is kept small, pure, and tested on its own rather than
 * only through the engine that uses it.
 *
 * Convention throughout: **half-open** intervals, `[start, end)`. Touching intervals
 * do not overlap, which is what makes 10:00–13:00 and 13:00–17:00 one continuous
 * stretch rather than a conflict.
 */

export interface Interval {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

const ms = (date: Date): number => date.getTime();

/** Drops empty and inverted intervals; everything here assumes start < end. */
function valid(intervals: readonly Interval[]): Interval[] {
  return intervals.filter((interval) => ms(interval.start) < ms(interval.end));
}

function byStart(a: Interval, b: Interval): number {
  return ms(a.start) - ms(b.start);
}

/** Sorts, drops empties, and joins anything overlapping or touching into one run. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = valid(intervals).sort(byStart);
  if (sorted.length === 0) return [];

  const merged: Interval[] = [{ ...sorted[0]! }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    // `<=` joins touching runs: 09:00–12:00 and 12:00–17:00 become 09:00–17:00.
    if (ms(interval.start) <= ms(last.end)) {
      if (ms(interval.end) > ms(last.end)) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

/**
 * Everything in `base` that is not in `cuts`.
 *
 * A cut through the middle of an interval splits it in two, which is exactly how a
 * lunch break or a mid-day appointment produces a morning and an afternoon.
 */
export function subtractIntervals(
  base: readonly Interval[],
  cuts: readonly Interval[],
): Interval[] {
  const merged = mergeIntervals(base);
  const holes = mergeIntervals(cuts);
  if (holes.length === 0) return merged;

  const result: Interval[] = [];

  for (const interval of merged) {
    let cursor = ms(interval.start);
    const end = ms(interval.end);

    for (const hole of holes) {
      const holeStart = ms(hole.start);
      const holeEnd = ms(hole.end);

      if (holeEnd <= cursor) continue;
      if (holeStart >= end) break;

      if (holeStart > cursor) {
        result.push({ start: new Date(cursor), end: new Date(Math.min(holeStart, end)) });
      }
      cursor = Math.max(cursor, holeEnd);
      if (cursor >= end) break;
    }

    if (cursor < end) {
      result.push({ start: new Date(cursor), end: new Date(end) });
    }
  }

  return result;
}

/** Only the time present in both sets — how "barber is working" meets "shop is open". */
export function intersectIntervals(
  a: readonly Interval[],
  b: readonly Interval[],
): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const result: Interval[] = [];

  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const start = Math.max(ms(left[i]!.start), ms(right[j]!.start));
    const end = Math.min(ms(left[i]!.end), ms(right[j]!.end));

    if (start < end) result.push({ start: new Date(start), end: new Date(end) });

    // Advance whichever ends first; the other may still overlap what comes next.
    if (ms(left[i]!.end) < ms(right[j]!.end)) i += 1;
    else j += 1;
  }

  return result;
}

export function totalMinutes(intervals: readonly Interval[]): number {
  return intervals.reduce(
    (total, interval) => total + (ms(interval.end) - ms(interval.start)) / 60_000,
    0,
  );
}

/** Half-open, so touching is not overlapping. */
export function overlaps(a: Interval, b: Interval): boolean {
  return ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
}

/** Grows each interval by `minutes` at the end — how a turnaround buffer is applied. */
export function padEnd(intervals: readonly Interval[], minutes: number): Interval[] {
  if (minutes <= 0) return intervals.map((interval) => ({ ...interval }));
  return intervals.map((interval) => ({
    start: interval.start,
    end: new Date(ms(interval.end) + minutes * 60_000),
  }));
}
