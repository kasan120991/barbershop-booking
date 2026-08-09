/**
 * Weekly schedule validation.
 *
 * Pure functions over plain arrays, in `shared` rather than on the server, because
 * the editor wants to refuse an overlap before the round trip and the API has to
 * refuse it regardless. One implementation means the two cannot disagree about what
 * a valid week is.
 *
 * The database cannot express this: `@@unique([barberId, dayOfWeek, startMinute])`
 * catches two shifts starting at the same minute and nothing else, so `10:00–13:00`
 * and `11:00–14:00` would both insert happily.
 */

import { dayName, minutesToTimeString } from './time.js';

export interface ShiftRange {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface ScheduleProblem {
  dayOfWeek: number;
  message: string;
}

/**
 * Every reason a week is invalid, rather than just the first.
 *
 * Returning all of them lets the editor mark every bad row at once — being told about
 * Tuesday, fixing it, and then being told about Thursday is a worse experience than
 * seeing both.
 */
export function findScheduleProblems(shifts: readonly ShiftRange[]): ScheduleProblem[] {
  const problems: ScheduleProblem[] = [];

  const byDay = new Map<number, ShiftRange[]>();
  for (const shift of shifts) {
    const existing = byDay.get(shift.dayOfWeek);
    if (existing) existing.push(shift);
    else byDay.set(shift.dayOfWeek, [shift]);
  }

  for (const [dayOfWeek, dayShifts] of byDay) {
    for (const shift of dayShifts) {
      if (shift.endMinute <= shift.startMinute) {
        problems.push({
          dayOfWeek,
          message: `${dayName(dayOfWeek)}: ${minutesToTimeString(shift.startMinute)}–${minutesToTimeString(shift.endMinute)} ends before it starts.`,
        });
      }
    }

    // Sorted locally, so the caller may pass shifts in any order.
    const sorted = [...dayShifts].sort((a, b) => a.startMinute - b.startMinute);

    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;

      // Touching is fine — 09:00–12:00 followed by 12:00–17:00 is one continuous
      // stretch expressed as two rows, which is legal and common.
      if (current.startMinute < previous.endMinute) {
        problems.push({
          dayOfWeek,
          message: `${dayName(dayOfWeek)}: ${minutesToTimeString(current.startMinute)}–${minutesToTimeString(current.endMinute)} overlaps ${minutesToTimeString(previous.startMinute)}–${minutesToTimeString(previous.endMinute)}.`,
        });
      }
    }
  }

  return problems;
}

export function isScheduleValid(shifts: readonly ShiftRange[]): boolean {
  return findScheduleProblems(shifts).length === 0;
}

/** Total working minutes in the week, for showing an admin what they just built. */
export function totalWeeklyMinutes(shifts: readonly ShiftRange[]): number {
  return shifts.reduce((total, shift) => total + Math.max(0, shift.endMinute - shift.startMinute), 0);
}
