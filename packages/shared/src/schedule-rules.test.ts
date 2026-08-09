import { describe, expect, it } from 'vitest';

import {
  findScheduleProblems,
  isScheduleValid,
  totalWeeklyMinutes,
  type ShiftRange,
} from './schedule-rules.js';

/** 10:00–13:00 and 13:30–18:00 — the shape every seeded barber actually works. */
const SPLIT_DAY: ShiftRange[] = [
  { dayOfWeek: 2, startMinute: 600, endMinute: 780 },
  { dayOfWeek: 2, startMinute: 810, endMinute: 1080 },
];

describe('findScheduleProblems', () => {
  it('accepts an empty week', () => {
    expect(findScheduleProblems([])).toEqual([]);
  });

  it('accepts a split shift, which is the normal case here', () => {
    expect(findScheduleProblems(SPLIT_DAY)).toEqual([]);
  });

  it('accepts touching shifts — one stretch expressed as two rows', () => {
    const touching: ShiftRange[] = [
      { dayOfWeek: 3, startMinute: 540, endMinute: 720 },
      { dayOfWeek: 3, startMinute: 720, endMinute: 1020 },
    ];
    expect(findScheduleProblems(touching)).toEqual([]);
  });

  it('rejects an overlap the database cannot catch', () => {
    // Different start minutes, so the unique constraint permits both.
    const overlapping: ShiftRange[] = [
      { dayOfWeek: 2, startMinute: 600, endMinute: 780 },
      { dayOfWeek: 2, startMinute: 660, endMinute: 840 },
    ];
    const problems = findScheduleProblems(overlapping);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.dayOfWeek).toBe(2);
    expect(problems[0]?.message).toMatch(/overlaps/);
  });

  it('detects an overlap regardless of input order', () => {
    const unsorted: ShiftRange[] = [
      { dayOfWeek: 4, startMinute: 660, endMinute: 840 },
      { dayOfWeek: 4, startMinute: 600, endMinute: 780 },
    ];
    expect(isScheduleValid(unsorted)).toBe(false);
  });

  it('rejects a zero-length or inverted shift', () => {
    expect(findScheduleProblems([{ dayOfWeek: 1, startMinute: 600, endMinute: 600 }])).toHaveLength(1);
    expect(findScheduleProblems([{ dayOfWeek: 1, startMinute: 800, endMinute: 600 }])).toHaveLength(1);
  });

  it('treats days independently — same times on different days never collide', () => {
    const week: ShiftRange[] = [
      { dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
      { dayOfWeek: 3, startMinute: 600, endMinute: 1080 },
      { dayOfWeek: 4, startMinute: 600, endMinute: 1080 },
    ];
    expect(findScheduleProblems(week)).toEqual([]);
  });

  it('reports every bad day, not just the first', () => {
    const week: ShiftRange[] = [
      { dayOfWeek: 2, startMinute: 600, endMinute: 780 },
      { dayOfWeek: 2, startMinute: 660, endMinute: 840 },
      { dayOfWeek: 4, startMinute: 600, endMinute: 780 },
      { dayOfWeek: 4, startMinute: 700, endMinute: 900 },
    ];
    const problems = findScheduleProblems(week);
    expect(problems).toHaveLength(2);
    expect(problems.map((p) => p.dayOfWeek).sort()).toEqual([2, 4]);
  });

  it('names the day and the times, so the message is actionable', () => {
    const problems = findScheduleProblems([
      { dayOfWeek: 6, startMinute: 540, endMinute: 720 },
      { dayOfWeek: 6, startMinute: 600, endMinute: 780 },
    ]);
    expect(problems[0]?.message).toContain('Saturday');
    expect(problems[0]?.message).toContain('10:00');
    expect(problems[0]?.message).toContain('09:00');
  });
});

describe('totalWeeklyMinutes', () => {
  it('sums the shifts', () => {
    // 180 + 270 minutes.
    expect(totalWeeklyMinutes(SPLIT_DAY)).toBe(450);
    expect(totalWeeklyMinutes([])).toBe(0);
  });

  it('ignores an inverted shift rather than subtracting from the total', () => {
    expect(totalWeeklyMinutes([{ dayOfWeek: 1, startMinute: 800, endMinute: 600 }])).toBe(0);
  });
});
