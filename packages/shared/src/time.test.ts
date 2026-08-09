import { describe, expect, it } from 'vitest';

import {
  dayName,
  formatDayMinute,
  formatDayMinuteRange,
  isLocalDate,
  isValidDayMinute,
  minutesToTimeString,
  timeStringToMinutes,
} from './time.js';

describe('minutesToTimeString', () => {
  it('zero-pads to 24-hour form', () => {
    expect(minutesToTimeString(0)).toBe('00:00');
    expect(minutesToTimeString(540)).toBe('09:00');
    expect(minutesToTimeString(570)).toBe('09:30');
    expect(minutesToTimeString(1200)).toBe('20:00');
  });

  it('handles both ends of the day', () => {
    expect(minutesToTimeString(1439)).toBe('23:59');
    // 1440 is a valid CLOSE time meaning midnight tomorrow.
    expect(minutesToTimeString(1440)).toBe('24:00');
  });

  it('rejects out-of-range and non-integer input', () => {
    expect(() => minutesToTimeString(-1)).toThrow(RangeError);
    expect(() => minutesToTimeString(1441)).toThrow(RangeError);
    expect(() => minutesToTimeString(90.5)).toThrow(RangeError);
  });
});

describe('timeStringToMinutes', () => {
  it('parses what a time input produces', () => {
    expect(timeStringToMinutes('00:00')).toBe(0);
    expect(timeStringToMinutes('09:00')).toBe(540);
    expect(timeStringToMinutes('9:00')).toBe(540);
    expect(timeStringToMinutes('17:30')).toBe(1050);
    expect(timeStringToMinutes(' 09:00 ')).toBe(540);
  });

  it('round-trips with minutesToTimeString', () => {
    for (const minutes of [0, 1, 540, 555, 1049, 1439, 1440]) {
      expect(timeStringToMinutes(minutesToTimeString(minutes))).toBe(minutes);
    }
  });

  it('returns null rather than guessing at junk', () => {
    expect(timeStringToMinutes('')).toBeNull();
    expect(timeStringToMinutes('9')).toBeNull();
    expect(timeStringToMinutes('09:60')).toBeNull();
    expect(timeStringToMinutes('25:00')).toBeNull();
    expect(timeStringToMinutes('nine')).toBeNull();
    expect(timeStringToMinutes('09:00:00')).toBeNull();
  });
});

describe('formatDayMinute', () => {
  it('renders 12-hour time for display', () => {
    expect(formatDayMinute(540)).toBe('9:00 AM');
    expect(formatDayMinute(1050)).toBe('5:30 PM');
    expect(formatDayMinute(720)).toBe('12:00 PM');
    expect(formatDayMinute(0)).toBe('12:00 AM');
  });

  it('does not depend on the host machine timezone', () => {
    // The conversion goes through UTC getters on a fixed date, so a developer in
    // Tokyo and a server in New York render the same string.
    expect(formatDayMinute(540)).toBe('9:00 AM');
  });
});

describe('formatDayMinuteRange', () => {
  it('joins with an en dash', () => {
    expect(formatDayMinuteRange(540, 1020)).toBe('9:00 AM – 5:00 PM');
  });
});

describe('isValidDayMinute', () => {
  it('accepts the full day inclusive of the 1440 end boundary', () => {
    expect(isValidDayMinute(0)).toBe(true);
    expect(isValidDayMinute(1440)).toBe(true);
    expect(isValidDayMinute(1441)).toBe(false);
    expect(isValidDayMinute(-1)).toBe(false);
    expect(isValidDayMinute(12.5)).toBe(false);
  });
});

describe('dayName', () => {
  it('is Sunday-indexed, matching Date.getDay() and the dayOfWeek column', () => {
    expect(dayName(0)).toBe('Sunday');
    expect(dayName(6)).toBe('Saturday');
  });
});

describe('isLocalDate', () => {
  it('accepts real calendar dates', () => {
    expect(isLocalDate('2026-12-25')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
  });

  it('rejects dates that match the shape but do not exist', () => {
    expect(isLocalDate('2026-02-31')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2027-02-29')).toBe(false);
  });

  it('rejects anything carrying a time or zone', () => {
    expect(isLocalDate('2026-12-25T00:00:00Z')).toBe(false);
    expect(isLocalDate('12/25/2026')).toBe(false);
    expect(isLocalDate('')).toBe(false);
  });
});
