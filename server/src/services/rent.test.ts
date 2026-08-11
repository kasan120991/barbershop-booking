/**
 * Rent periods and the rent ledger.
 *
 * `rentPeriods` is pure and gets the most attention here, because an off-by-one in it either
 * invents a week of rent or forgets one — and both are the kind of error a barber notices
 * before the shop does. Everything below the first block needs a database.
 */

import { RENT_CADENCE, RENT_CHARGE_STATUS } from '@francis/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../lib/prisma.js';
import { hashPassword } from './passwords.js';
import {
  addOneOffCharge,
  allocateRentPayment,
  generateRentCharges,
  getRentForBarber,
  nextDueDateFor,
  recordRentPayment,
  rentPeriods,
  saveRentPlan,
  waiveRentCharge,
} from './rent.js';

const ZONE = 'America/New_York';

const weekly = (startDate: string, anchorDay: number, endDate: string | null = null) => ({
  cadence: RENT_CADENCE.WEEKLY,
  anchorDay,
  startDate,
  endDate,
});

const monthly = (startDate: string, anchorDay: number, endDate: string | null = null) => ({
  cadence: RENT_CADENCE.MONTHLY,
  anchorDay,
  startDate,
  endDate,
});

describe('rentPeriods', () => {
  /** 2026-08-03 is a Monday. anchorDay 1 = Monday, Sunday-first like `DAY_NAMES`. */
  it('walks consecutive weeks from the anchor', () => {
    const periods = rentPeriods(weekly('2026-08-03', 1), '2026-08-24', ZONE);

    expect(periods.map((period) => period.periodStart)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
    ]);
    // Periods abut without overlapping.
    expect(periods[0]?.periodEnd).toBe('2026-08-09');
    expect(periods[1]?.periodEnd).toBe('2026-08-16');
  });

  /**
   * The rule that stops a barber being billed for time before they arrived: a plan starting
   * mid-week runs from the NEXT anchor, not the one that already passed.
   */
  it('starts at the first anchor on or after the start date', () => {
    // Wednesday the 5th, anchored on Monday → first charge is Monday the 10th.
    const periods = rentPeriods(weekly('2026-08-05', 1), '2026-08-12', ZONE);
    expect(periods.map((period) => period.periodStart)).toEqual(['2026-08-10']);
  });

  it('starts on the start date itself when that is already the anchor', () => {
    const periods = rentPeriods(weekly('2026-08-03', 1), '2026-08-03', ZONE);
    expect(periods.map((period) => period.periodStart)).toEqual(['2026-08-03']);
  });

  /** anchorDay 0 is Sunday, and 0 is falsy — an easy thing to get wrong. */
  it('handles a Sunday anchor', () => {
    const periods = rentPeriods(weekly('2026-08-03', 0), '2026-08-17', ZONE);
    expect(periods.map((period) => period.periodStart)).toEqual([
      '2026-08-09',
      '2026-08-16',
    ]);
  });

  it('raises nothing before the plan has started', () => {
    expect(rentPeriods(weekly('2026-09-07', 1), '2026-08-24', ZONE)).toEqual([]);
  });

  it('stops at the plan end date', () => {
    const periods = rentPeriods(weekly('2026-08-03', 1, '2026-08-16'), '2026-09-30', ZONE);
    expect(periods.map((period) => period.periodStart)).toEqual(['2026-08-03', '2026-08-10']);
  });

  it('walks months from the anchor day', () => {
    const periods = rentPeriods(monthly('2026-01-01', 1), '2026-04-01', ZONE);

    expect(periods.map((period) => period.periodStart)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ]);
    // January's period runs to the last day of January, February's to the last of February.
    expect(periods[0]?.periodEnd).toBe('2026-01-31');
    expect(periods[1]?.periodEnd).toBe('2026-02-28');
  });

  /**
   * The 28th is the highest anchor the contract allows precisely so this cannot drift: a
   * plan on the 28th must land on the 28th of February too, not the 2nd of March.
   */
  it('does not skip February on a 28th anchor', () => {
    const periods = rentPeriods(monthly('2026-01-28', 28), '2026-03-28', ZONE);
    expect(periods.map((period) => period.periodStart)).toEqual([
      '2026-01-28',
      '2026-02-28',
      '2026-03-28',
    ]);
  });

  /**
   * The US spring-forward is 8 March 2026. A week across it is still seven calendar days —
   * naive millisecond arithmetic would land an hour short and roll the date back.
   */
  it('keeps weeks seven calendar days across a daylight-saving change', () => {
    const periods = rentPeriods(weekly('2026-03-02', 1), '2026-03-16', ZONE);
    expect(periods.map((period) => period.periodStart)).toEqual([
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
    ]);
  });

  /** A plan backdated years must not turn one page load into hundreds of inserts. */
  it('truncates at the per-run cap', () => {
    const periods = rentPeriods(weekly('2020-01-06', 1), '2026-08-24', ZONE);
    expect(periods).toHaveLength(60);
    expect(periods[0]?.periodStart).toBe('2020-01-06');
  });

  it('due date is the start of the period it covers', () => {
    const [first] = rentPeriods(weekly('2026-08-03', 1), '2026-08-03', ZONE);
    expect(first?.dueDate).toBe(first?.periodStart);
  });
});

/**
 * Charges only exist up to today, so "when is the next one due" cannot be answered from the
 * ledger — it would be null forever. It is answered from the plan instead.
 */
describe('nextDueDateFor', () => {
  it('is the next anchor after today', () => {
    // Tuesday the 11th, weekly on Mondays → next is Monday the 17th.
    expect(nextDueDateFor(weekly('2026-07-06', 1), '2026-08-11', ZONE)).toBe('2026-08-17');
  });

  it('is next week when today is the anchor itself', () => {
    expect(nextDueDateFor(weekly('2026-07-06', 1), '2026-08-10', ZONE)).toBe('2026-08-17');
  });

  it('is the first period when the plan has not started', () => {
    expect(nextDueDateFor(weekly('2026-09-07', 1), '2026-08-11', ZONE)).toBe('2026-09-07');
  });

  it('is null once the plan has ended', () => {
    expect(nextDueDateFor(weekly('2026-07-06', 1, '2026-08-09'), '2026-08-11', ZONE)).toBeNull();
  });

  it('walks months too', () => {
    expect(nextDueDateFor(monthly('2026-01-01', 1), '2026-08-11', ZONE)).toBe('2026-09-01');
  });
});

// --- The ledger ---------------------------------------------------------------

const DOMAIN = '@rent.test';
const passwordHash = await hashPassword('FrancisCutz!2026');

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId: string;
let otherBarberId: string;
let staffUserId: string;

async function cleanup() {
  const scope = { barber: { user: { email: { contains: DOMAIN } } } };
  await prisma.rentPayment.deleteMany({ where: { rentCharge: scope } });
  await prisma.rentCharge.deleteMany({ where: scope });
  await prisma.rentPlan.deleteMany({ where: scope });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { contains: DOMAIN } } });
}

async function makeBarber(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${name.toLowerCase()}${DOMAIN}`,
      passwordHash,
      firstName: name,
      lastName: 'Rent',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName: name, slug: `${name.toLowerCase()}-${user.id}` },
  });

  staffUserId = user.id;
  return barber.id;
}

async function seed() {
  await cleanup();
  barberId = await makeBarber('Ana');
  otherBarberId = await makeBarber('Ben');
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('rent charges', () => {
  beforeEach(seed);

  /** A plan a month old raises the weeks that have passed, and running it again adds none. */
  it('raises charges once, however many times it runs', async () => {
    await saveRentPlan(barberId, {
      amountCents: 25_000,
      cadence: RENT_CADENCE.WEEKLY,
      anchorDay: 1,
      startDate: '2026-07-06',
    });

    const first = await generateRentCharges(barberId, '2026-07-27');
    expect(first).toBe(4);

    const second = await generateRentCharges(barberId, '2026-07-27');
    expect(second).toBe(0);
    expect(await prisma.rentCharge.count({ where: { barberId } })).toBe(4);
  });

  /**
   * The reason charges snapshot their amount: putting the rent up must not rewrite what was
   * owed for a week that has already been charged.
   */
  it('keeps the amount a charge was raised at when the plan changes', async () => {
    await saveRentPlan(barberId, {
      amountCents: 25_000,
      cadence: RENT_CADENCE.WEEKLY,
      anchorDay: 1,
      startDate: '2026-07-06',
    });
    await generateRentCharges(barberId, '2026-07-13');

    await saveRentPlan(barberId, {
      amountCents: 30_000,
      cadence: RENT_CADENCE.WEEKLY,
      anchorDay: 1,
      startDate: '2026-07-20',
    });
    await generateRentCharges(barberId, '2026-07-27');

    const charges = await prisma.rentCharge.findMany({
      where: { barberId },
      orderBy: { periodStart: 'asc' },
      select: { amountCents: true },
    });

    expect(charges.map((charge) => charge.amountCents)).toEqual([25_000, 25_000, 30_000, 30_000]);
  });

  it('moves a charge to PARTIAL and then PAID as money comes in', async () => {
    const charge = await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    });

    let updated = await recordRentPayment(charge.id, {
      amountCents: 10_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });
    expect(updated.status).toBe(RENT_CHARGE_STATUS.PARTIAL);

    updated = await recordRentPayment(charge.id, {
      amountCents: 15_000,
      method: 'ZELLE',
      recordedByUserId: staffUserId,
    });
    expect(updated.status).toBe(RENT_CHARGE_STATUS.PAID);
  });

  /** Somebody paying two weeks at once against one charge is a counter reality, not an error. */
  it('accepts an overpayment rather than refusing it', async () => {
    const charge = await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    });

    const updated = await recordRentPayment(charge.id, {
      amountCents: 50_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    expect(updated.status).toBe(RENT_CHARGE_STATUS.PAID);
  });

  /** A decision somebody made, which arithmetic must never quietly undo. */
  it('leaves a waived charge waived through a regeneration', async () => {
    await saveRentPlan(barberId, {
      amountCents: 25_000,
      cadence: RENT_CADENCE.WEEKLY,
      anchorDay: 1,
      startDate: '2026-07-06',
    });
    await generateRentCharges(barberId, '2026-07-13');

    const charge = await prisma.rentCharge.findFirstOrThrow({ where: { barberId } });
    await waiveRentCharge(charge.id, 'Chair was out of action that week.');

    await generateRentCharges(barberId, '2026-07-27');

    const after = await prisma.rentCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(after.status).toBe(RENT_CHARGE_STATUS.WAIVED);
    expect(after.note).toBe('Chair was out of action that week.');
  });

  it('refuses to waive a charge that has been part paid', async () => {
    const charge = await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    });
    await recordRentPayment(charge.id, {
      amountCents: 5_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    await expect(waiveRentCharge(charge.id, 'nope')).rejects.toThrow(/has payments against it/i);
  });

  it('refuses a payment against a waived charge', async () => {
    const charge = await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    });
    await waiveRentCharge(charge.id, 'Written off.');

    await expect(
      recordRentPayment(charge.id, {
        amountCents: 1_000,
        method: 'CASH',
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow(/was waived/i);
  });

  it('refuses a one-off that collides with a period already charged', async () => {
    const input = {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    };
    await addOneOffCharge(barberId, input);

    await expect(addOneOffCharge(barberId, input)).rejects.toThrow(/already has a rent charge/i);
  });

  it("never mixes one chair's charges into another's", async () => {
    await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    });

    const mine = await getRentForBarber(barberId);
    const theirs = await getRentForBarber(otherBarberId);

    expect(mine.charges).toHaveLength(1);
    expect(theirs.charges).toHaveLength(0);
    expect(theirs.summary.outstandingCents).toBe(0);
  });

  it('sums what is still owed and ignores what is waived', async () => {
    const owed = await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-03',
    });
    const written = await addOneOffCharge(barberId, {
      amountCents: 25_000,
      periodStart: '2026-08-10',
      periodEnd: '2026-08-16',
      dueDate: '2026-08-10',
    });

    await recordRentPayment(owed.id, {
      amountCents: 5_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });
    await waiveRentCharge(written.id, 'Covered by the shop.');

    const overview = await getRentForBarber(barberId);

    // $250 owed less the $50 paid; the waived week contributes nothing.
    expect(overview.summary.outstandingCents).toBe(20_000);
    expect(overview.summary.unpaidCount).toBe(1);
  });
});

/**
 * Allocation — one sum of money spread across the weeks it settles.
 *
 * The arithmetic is what matters: a payment that clears two weeks and leaves a third part
 * paid must land as three facts, not one, or a ledger read afterwards cannot say which
 * weeks are square. Every case here is a sum somebody could actually hand over.
 */
describe.skipIf(!reachable)('allocateRentPayment', () => {
  beforeEach(seed);

  /** Three weeks at $250, oldest first — the shape every other case is a variation of. */
  async function threeWeeksOwed() {
    for (const [start, end] of [
      ['2026-08-03', '2026-08-09'],
      ['2026-08-10', '2026-08-16'],
      ['2026-08-17', '2026-08-23'],
    ] as const) {
      await addOneOffCharge(barberId, {
        amountCents: 25_000,
        periodStart: start,
        periodEnd: end,
        dueDate: start,
      });
    }
  }

  it('clears the oldest week first', async () => {
    await threeWeeksOwed();

    const allocated = await allocateRentPayment(barberId, {
      amountCents: 25_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    expect(allocated).toEqual([
      expect.objectContaining({
        periodStart: '2026-08-03',
        amountCents: 25_000,
        statusAfter: RENT_CHARGE_STATUS.PAID,
      }),
    ]);
  });

  /**
   * The case the per-charge endpoint could not do, and the reason this exists: $600 handed
   * over against three $250 weeks clears two and part-pays the third.
   */
  it('spans several weeks and part-pays the one it runs out on', async () => {
    await threeWeeksOwed();

    const allocated = await allocateRentPayment(barberId, {
      amountCents: 60_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    expect(allocated).toEqual([
      expect.objectContaining({ periodStart: '2026-08-03', amountCents: 25_000 }),
      expect.objectContaining({ periodStart: '2026-08-10', amountCents: 25_000 }),
      expect.objectContaining({ periodStart: '2026-08-17', amountCents: 10_000 }),
    ]);
    expect(allocated.map((slice) => slice.statusAfter)).toEqual([
      RENT_CHARGE_STATUS.PAID,
      RENT_CHARGE_STATUS.PAID,
      RENT_CHARGE_STATUS.PARTIAL,
    ]);

    const overview = await getRentForBarber(barberId);
    expect(overview.summary.outstandingCents).toBe(15_000);
    expect(overview.summary.unpaidCount).toBe(1);
  });

  /** Each slice is its own row, so a charge's payments still sum to what it received. */
  it('writes one payment row per week it touched', async () => {
    await threeWeeksOwed();
    await allocateRentPayment(barberId, {
      amountCents: 60_000,
      method: 'ZELLE',
      recordedByUserId: staffUserId,
    });

    const rows = await prisma.rentPayment.findMany({
      where: { rentCharge: { barberId } },
      select: { amountCents: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.reduce((total, row) => total + row.amountCents, 0)).toBe(60_000);
  });

  /** It picks up where the last one stopped, rather than starting at the oldest week again. */
  it('continues from a week that is already part paid', async () => {
    await threeWeeksOwed();
    await allocateRentPayment(barberId, {
      amountCents: 30_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    const second = await allocateRentPayment(barberId, {
      amountCents: 30_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    // The first left week two owing $200. The second clears that and starts on week three.
    expect(second).toEqual([
      expect.objectContaining({ periodStart: '2026-08-10', amountCents: 20_000 }),
      expect.objectContaining({ periodStart: '2026-08-17', amountCents: 10_000 }),
    ]);
  });

  /** Nowhere honest to keep a surplus, so it is refused with the number that would work. */
  it('refuses more than is outstanding', async () => {
    await threeWeeksOwed();

    await expect(
      allocateRentPayment(barberId, {
        amountCents: 80_000,
        method: 'CASH',
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow('750.00');

    expect(await prisma.rentPayment.count({ where: { rentCharge: { barberId } } })).toBe(0);
  });

  it('refuses a payment when nothing is owed', async () => {
    await expect(
      allocateRentPayment(barberId, {
        amountCents: 25_000,
        method: 'CASH',
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow('nothing outstanding');
  });

  /** A waived week is not a debt, so money must skip past it rather than settle it. */
  it('skips a waived week', async () => {
    await threeWeeksOwed();
    const charges = await prisma.rentCharge.findMany({
      where: { barberId },
      orderBy: { periodStart: 'asc' },
    });
    await waiveRentCharge(charges[0]!.id, 'First week on the house.');

    const allocated = await allocateRentPayment(barberId, {
      amountCents: 25_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    expect(allocated).toEqual([
      expect.objectContaining({ periodStart: '2026-08-10', amountCents: 25_000 }),
    ]);
  });

  /** One chair's money never lands on another's ledger. */
  it("never touches another chair's charges", async () => {
    await threeWeeksOwed();
    await addOneOffCharge(otherBarberId, {
      amountCents: 25_000,
      periodStart: '2026-07-27',
      periodEnd: '2026-08-02',
      dueDate: '2026-07-27',
    });

    await allocateRentPayment(barberId, {
      amountCents: 25_000,
      method: 'CASH',
      recordedByUserId: staffUserId,
    });

    const theirs = await getRentForBarber(otherBarberId);
    expect(theirs.summary.outstandingCents).toBe(25_000);
  });
});
