/**
 * The one interpretation of an `appointment:changed` signal.
 *
 * Pure, and worth testing precisely because it is a boundary comparison that fails
 * silently: a screen that decides a change is not its business simply does not refresh,
 * and nobody sees an error — they see a booking that is not there.
 */

import { describe, expect, it } from 'vitest';

import { appointmentChangeTouches, type AppointmentChanged } from './events.js';

/** The shop's Tuesday, in instants — what `dayRange('2026-08-11')` returns in EDT. */
const TUESDAY = { from: '2026-08-11T04:00:00.000Z', to: '2026-08-12T04:00:00.000Z' };

const DRE = 'barber_dre';
const RICO = 'barber_rico';

function change(overrides: Partial<AppointmentChanged> = {}): AppointmentChanged {
  return {
    appointmentId: 'appt_1',
    action: 'created',
    barberIds: [DRE],
    startAts: ['2026-08-11T14:00:00.000Z'],
    ...overrides,
  };
}

describe('appointmentChangeTouches', () => {
  it('matches a change inside the viewed range', () => {
    expect(appointmentChangeTouches(change(), TUESDAY)).toBe(true);
  });

  it('ignores a change on another day', () => {
    expect(
      appointmentChangeTouches(change({ startAts: ['2026-08-14T14:00:00.000Z'] }), TUESDAY),
    ).toBe(false);
  });

  /**
   * Half-open, matching `listAppointments`' `gte` / `lt`.
   *
   * If `to` were inclusive, a booking at the stroke of midnight would belong to two days
   * and refresh the wrong one as well as the right one.
   */
  it('treats the range as [from, to)', () => {
    expect(appointmentChangeTouches(change({ startAts: [TUESDAY.from] }), TUESDAY)).toBe(true);
    expect(appointmentChangeTouches(change({ startAts: [TUESDAY.to] }), TUESDAY)).toBe(false);
  });

  it('ignores another chair on a barber-scoped screen', () => {
    const view = { ...TUESDAY, barberId: RICO };
    expect(appointmentChangeTouches(change({ barberIds: [DRE] }), view)).toBe(false);
  });

  it('matches any chair on a shop-wide board', () => {
    // `barberId` absent, and explicitly null, both mean "every chair".
    expect(appointmentChangeTouches(change({ barberIds: [RICO] }), TUESDAY)).toBe(true);
    expect(
      appointmentChangeTouches(change({ barberIds: [RICO] }), { ...TUESDAY, barberId: null }),
    ).toBe(true);
  });

  /**
   * The case the arrays exist for, from the losing side.
   *
   * A cut moves from Dre's Tuesday to Rico's Thursday. Dre's screen has to refetch or it
   * goes on rendering a booking that is now somebody else's — so the OLD chair and the
   * OLD instant both have to be in the payload, and either alone must be enough to match.
   */
  it('tells the chair that LOST a booking, not just the one that gained it', () => {
    const moved = change({
      action: 'rescheduled',
      barberIds: [DRE, RICO],
      startAts: ['2026-08-11T14:00:00.000Z', '2026-08-13T18:00:00.000Z'],
    });

    expect(appointmentChangeTouches(moved, { ...TUESDAY, barberId: DRE })).toBe(true);
  });

  it('tells the chair that gained it, on the day it landed', () => {
    const thursday = { from: '2026-08-13T04:00:00.000Z', to: '2026-08-14T04:00:00.000Z' };
    const moved = change({
      action: 'rescheduled',
      barberIds: [DRE, RICO],
      startAts: ['2026-08-11T14:00:00.000Z', '2026-08-13T18:00:00.000Z'],
    });

    expect(appointmentChangeTouches(moved, { ...thursday, barberId: RICO })).toBe(true);
  });

  it('needs BOTH the chair and the day to match on a scoped screen', () => {
    // Rico is named, but only on an instant outside this view — so Rico's Tuesday is
    // genuinely unaffected and must not refetch.
    const moved = change({
      action: 'rescheduled',
      barberIds: [DRE, RICO],
      startAts: ['2026-08-13T18:00:00.000Z'],
    });

    expect(appointmentChangeTouches(moved, { ...TUESDAY, barberId: RICO })).toBe(false);
  });

  it('matches across a week-long range, for the week view', () => {
    const week = { from: '2026-08-10T04:00:00.000Z', to: '2026-08-17T04:00:00.000Z' };
    expect(
      appointmentChangeTouches(change({ startAts: ['2026-08-14T14:00:00.000Z'] }), week),
    ).toBe(true);
  });
});
