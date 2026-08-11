/**
 * Booth rent — what a chair costs, and who has paid for it.
 *
 * The shop's whole economic model in one table: a barber keeps 100% of every cut and pays a
 * fixed sum for the chair. So nothing here divides anything. There is no commission to
 * compute, no relationship between a charge and what the barber took that week, and no
 * Stripe object anywhere near it — rent is settled offline in cash, Zelle or a cheque, and
 * this is the shop's record that it was.
 *
 * Two rules shape everything below:
 *
 * - **A charge snapshots its amount.** Copied from the plan when raised, exactly as
 *   `AppointmentService.priceCents` is copied at booking. Putting a chair's rent up must not
 *   rewrite what was owed last month.
 * - **Status is derived, never set.** Sum the payments against the charge. The single
 *   exception is `WAIVED`, which is somebody's decision and is never recomputed over.
 */

import {
  RENT_CADENCE,
  RENT_CHARGE_STATUS,
  sumCents,
  type RentCadence,
  type RentChargeStatus,
} from '@francis/shared';
import { DateTime } from 'luxon';

import type { RentPaymentMethod } from '../generated/prisma/enums.js';
import type { RentChargeModel, RentPlanModel } from '../generated/prisma/models.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getShopSettings } from './catalog.js';

/**
 * The most periods one call will raise.
 *
 * Lazy generation runs on a page load, and a plan backdated by two years would otherwise
 * turn that into a hundred inserts while somebody waits. Sixty is well over a year of weeks,
 * so in practice it only bites on a mistake — and when it does, it says so rather than
 * quietly stopping short.
 */
const MAX_PERIODS_PER_RUN = 60;

export interface RentPeriod {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
}

interface PeriodPlan {
  cadence: RentCadence;
  anchorDay: number;
  startDate: string;
  endDate: string | null;
}

/** One period forward from a start, by cadence. */
function advance(from: DateTime, cadence: RentCadence): DateTime {
  return cadence === RENT_CADENCE.WEEKLY ? from.plus({ weeks: 1 }) : from.plus({ months: 1 });
}

/**
 * The first period start on or after the plan's start date.
 *
 * On or *after*, deliberately. A barber who starts on a Wednesday under a Monday-anchored
 * plan is charged from the following Monday — billing them for the Monday before they were
 * here would be charging for a period that predates them.
 */
function firstPeriodStart(plan: PeriodPlan, zone: string): DateTime {
  const start = DateTime.fromISO(plan.startDate, { zone }).startOf('day');

  if (plan.cadence === RENT_CADENCE.WEEKLY) {
    // Luxon weekdays are 1–7 Monday-first; `anchorDay` is 0–6 Sunday-first, matching
    // `DAY_NAMES` and `Date.prototype.getDay()` everywhere else in this codebase.
    const target = plan.anchorDay === 0 ? 7 : plan.anchorDay;
    const ahead = (target - start.weekday + 7) % 7;
    return start.plus({ days: ahead });
  }

  const candidate = start.set({ day: plan.anchorDay });
  return candidate < start ? candidate.plus({ months: 1 }) : candidate;
}

/**
 * Every period from a plan's start up to and including the one containing `upTo`.
 *
 * Pure, and the piece most worth being sure about — an off-by-one here is a week of rent
 * either invented or forgotten. All arithmetic goes through Luxon in the shop's zone, so a
 * week spanning a daylight-saving change is still seven calendar days rather than 167 hours.
 *
 * `dueDate` is `periodStart`: rent is due at the start of the period it covers, so a charge
 * is overdue the moment its period is underway and unpaid.
 */
export function rentPeriods(plan: PeriodPlan, upTo: string, zone: string): RentPeriod[] {
  const limit = DateTime.fromISO(upTo, { zone }).startOf('day');
  const planEnd =
    plan.endDate === null ? null : DateTime.fromISO(plan.endDate, { zone }).startOf('day');

  if (!limit.isValid) throw new ValidationError('Enter a valid date.');

  const periods: RentPeriod[] = [];
  let cursor = firstPeriodStart(plan, zone);

  while (cursor <= limit && periods.length < MAX_PERIODS_PER_RUN) {
    if (planEnd !== null && cursor > planEnd) break;

    const next = advance(cursor, plan.cadence);
    const iso = cursor.toFormat('yyyy-MM-dd');

    periods.push({
      periodStart: iso,
      // The day before the next period begins — so periods abut without overlapping,
      // whatever the month length.
      periodEnd: next.minus({ days: 1 }).toFormat('yyyy-MM-dd'),
      dueDate: iso,
    });

    cursor = next;
  }

  return periods;
}

async function shopZone(): Promise<string> {
  const { timezone } = await getShopSettings();
  return timezone;
}

/** A plain `YYYY-MM-DD` for a `@db.Date` column, free of any timezone. */
function toDateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function toIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function getActiveRentPlan(barberId: string): Promise<RentPlanModel | null> {
  return prisma.rentPlan.findFirst({
    where: { barberId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Raises any charges the active plan is owed and has not had.
 *
 * Called on read, which is what keeps the ledger current without a scheduler. Safe to run as
 * often as anyone likes: `@@unique([barberId, periodStart])` plus `skipDuplicates` means a
 * second run inserts nothing, and the constraint — not this code — is what guarantees it.
 */
export async function generateRentCharges(barberId: string, today?: string): Promise<number> {
  const plan = await getActiveRentPlan(barberId);
  if (plan === null) return 0;

  const zone = await shopZone();
  const upTo = today ?? DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');

  const periods = rentPeriods(
    {
      cadence: plan.cadence,
      anchorDay: plan.anchorDay,
      startDate: toIso(plan.startDate),
      endDate: plan.endDate === null ? null : toIso(plan.endDate),
    },
    upTo,
    zone,
  );

  if (periods.length === MAX_PERIODS_PER_RUN) {
    logger.warn(
      { barberId, planId: plan.id, cap: MAX_PERIODS_PER_RUN },
      'Rent generation hit its per-run cap — the plan may be backdated further than expected',
    );
  }

  if (periods.length === 0) return 0;

  const result = await prisma.rentCharge.createMany({
    data: periods.map((period) => ({
      barberId,
      rentPlanId: plan.id,
      periodStart: toDateOnly(period.periodStart),
      periodEnd: toDateOnly(period.periodEnd),
      dueDate: toDateOnly(period.dueDate),
      // Snapshotted here, and never touched again by a later plan change.
      amountCents: plan.amountCents,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Re-derives one charge's status from its payments.
 *
 * The single place status is decided, so "part paid" can never mean two different things in
 * two different code paths. A waived charge is left exactly as it is — somebody decided that,
 * and a later payment or regeneration must not quietly undo it.
 */
export async function recomputeChargeStatus(chargeId: string): Promise<RentChargeStatus> {
  const charge = await prisma.rentCharge.findUnique({
    where: { id: chargeId },
    include: { payments: { select: { amountCents: true } } },
  });

  if (!charge) throw new NotFoundError('Rent charge not found.');
  if (charge.status === RENT_CHARGE_STATUS.WAIVED) return RENT_CHARGE_STATUS.WAIVED;

  const paid = sumCents(charge.payments.map((payment) => payment.amountCents));

  const status: RentChargeStatus =
    paid >= charge.amountCents
      ? RENT_CHARGE_STATUS.PAID
      : paid > 0
        ? RENT_CHARGE_STATUS.PARTIAL
        : RENT_CHARGE_STATUS.DUE;

  if (status !== charge.status) {
    await prisma.rentCharge.update({ where: { id: chargeId }, data: { status } });
  }

  return status;
}

export interface SaveRentPlanInput {
  amountCents: number;
  cadence: RentCadence;
  anchorDay: number;
  startDate: string;
  endDate?: string | null | undefined;
}

/**
 * Replaces the chair's plan rather than editing it.
 *
 * The old row is deactivated and a new one written, in one transaction. Charges already
 * raised keep pointing at the plan they were raised under, so the record still says what the
 * terms were at the time — which an in-place edit of the amount or the anchor day would
 * quietly destroy.
 */
export async function saveRentPlan(
  barberId: string,
  input: SaveRentPlanInput,
): Promise<RentPlanModel> {
  const barber = await prisma.barber.findUnique({ where: { id: barberId }, select: { id: true } });
  if (!barber) throw new NotFoundError('Barber not found.');

  return prisma.$transaction(async (tx) => {
    await tx.rentPlan.updateMany({ where: { barberId, isActive: true }, data: { isActive: false } });

    return tx.rentPlan.create({
      data: {
        barberId,
        amountCents: input.amountCents,
        cadence: input.cadence,
        anchorDay: input.anchorDay,
        startDate: toDateOnly(input.startDate),
        endDate: input.endDate == null ? null : toDateOnly(input.endDate),
        isActive: true,
      },
    });
  });
}

export interface CreateRentChargeInput {
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  note?: string | null | undefined;
}

/**
 * A charge nobody's plan raised — a late fee, a month at a different rate, a one-off.
 *
 * `rentPlanId` stays null, which is how the ledger later distinguishes "the plan said so"
 * from "somebody decided this". The period still has to be unique for the chair, so a one-off
 * cannot silently shadow a generated charge for the same week.
 */
export async function addOneOffCharge(
  barberId: string,
  input: CreateRentChargeInput,
): Promise<RentChargeModel> {
  const existing = await prisma.rentCharge.findUnique({
    where: { barberId_periodStart: { barberId, periodStart: toDateOnly(input.periodStart) } },
    select: { id: true },
  });

  if (existing) {
    throw new ConflictError('This chair already has a rent charge starting on that date.');
  }

  return prisma.rentCharge.create({
    data: {
      barberId,
      rentPlanId: null,
      amountCents: input.amountCents,
      periodStart: toDateOnly(input.periodStart),
      periodEnd: toDateOnly(input.periodEnd),
      dueDate: toDateOnly(input.dueDate),
      note: input.note ?? null,
    },
  });
}

export interface RecordRentPaymentInput {
  amountCents: number;
  method: RentPaymentMethod;
  paidAt?: string | null | undefined;
  note?: string | null | undefined;
  recordedByUserId: string;
}

/**
 * Records that the shop was handed money.
 *
 * Overpayment is allowed rather than refused: a barber paying two weeks at once against the
 * older charge is a real thing that happens at a counter, and refusing it would push the shop
 * back to paper. The surplus shows as a charge that is more than paid, which is visible and
 * correctable, where a rejected payment is neither.
 */
export async function recordRentPayment(
  chargeId: string,
  input: RecordRentPaymentInput,
): Promise<RentChargeModel> {
  const charge = await prisma.rentCharge.findUnique({ where: { id: chargeId } });
  if (!charge) throw new NotFoundError('Rent charge not found.');

  if (charge.status === RENT_CHARGE_STATUS.WAIVED) {
    throw new ConflictError('This charge was waived. Un-waive it before recording a payment.');
  }

  await prisma.rentPayment.create({
    data: {
      rentChargeId: chargeId,
      amountCents: input.amountCents,
      method: input.method,
      paidAt: input.paidAt == null ? new Date() : new Date(input.paidAt),
      note: input.note ?? null,
      recordedByUserId: input.recordedByUserId,
    },
  });

  await recomputeChargeStatus(chargeId);

  const updated = await prisma.rentCharge.findUnique({ where: { id: chargeId } });
  if (!updated) throw new NotFoundError('Rent charge not found.');
  return updated;
}

/** Money owed that will not be collected. The reason is required — see the contract. */
export async function waiveRentCharge(chargeId: string, note: string): Promise<RentChargeModel> {
  const charge = await prisma.rentCharge.findUnique({
    where: { id: chargeId },
    include: { payments: { select: { id: true } } },
  });

  if (!charge) throw new NotFoundError('Rent charge not found.');

  if (charge.payments.length > 0) {
    throw new ConflictError('This charge has payments against it and cannot be waived.');
  }

  return prisma.rentCharge.update({
    where: { id: chargeId },
    data: { status: RENT_CHARGE_STATUS.WAIVED, note },
  });
}

export interface RentCharge extends RentChargeModel {
  payments: { id: string; amountCents: number; method: string; paidAt: Date; note: string | null }[];
}

export interface RentOverview {
  barberId: string;
  plan: RentPlanModel | null;
  charges: RentCharge[];
  summary: {
    outstandingCents: number;
    unpaidCount: number;
    oldestDueDate: string | null;
    nextDueDate: string | null;
  };
}

/**
 * The whole picture for one chair, with the ledger brought up to date first.
 *
 * Generating on read is what keeps rent current without a scheduler — and it is why this is
 * the only function the pages call.
 */
/**
 * When the next charge will fall due, without raising it.
 *
 * Charges are only generated up to today, so there is never a future one to read a date off
 * — asking the ledger would answer "never", permanently. This asks the plan instead, which
 * is the honest source for a question about something that has not happened yet.
 *
 * Returns null once a plan has ended: there is no next one.
 */
export function nextDueDateFor(plan: PeriodPlan, today: string, zone: string): string | null {
  const limit = DateTime.fromISO(today, { zone }).startOf('day');
  const planEnd =
    plan.endDate === null ? null : DateTime.fromISO(plan.endDate, { zone }).startOf('day');

  let cursor = firstPeriodStart(plan, zone);

  // Walk to the first period that has not started yet. Bounded by the same cap as
  // generation, so a wildly backdated plan cannot spin here either.
  for (let step = 0; step < MAX_PERIODS_PER_RUN && cursor <= limit; step += 1) {
    cursor = advance(cursor, plan.cadence);
  }

  if (cursor <= limit) return null;
  if (planEnd !== null && cursor > planEnd) return null;

  return cursor.toFormat('yyyy-MM-dd');
}

export async function getRentForBarber(barberId: string): Promise<RentOverview> {
  await generateRentCharges(barberId);

  const [plan, charges] = await Promise.all([
    getActiveRentPlan(barberId),
    prisma.rentCharge.findMany({
      where: { barberId },
      orderBy: { periodStart: 'desc' },
      include: {
        payments: {
          orderBy: { paidAt: 'asc' },
          select: { id: true, amountCents: true, method: true, paidAt: true, note: true },
        },
      },
    }),
  ]);

  let outstandingCents = 0;
  let unpaidCount = 0;
  let oldestDueDate: string | null = null;

  const zone = await shopZone();
  const today = DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');

  for (const charge of charges) {
    // Nobody is going to pay a waived charge, so it owes nothing by definition.
    if (charge.status === RENT_CHARGE_STATUS.WAIVED) continue;

    const paid = sumCents(charge.payments.map((payment) => payment.amountCents));
    const owed = Math.max(0, charge.amountCents - paid);
    if (owed === 0) continue;

    outstandingCents += owed;
    unpaidCount += 1;

    const due = toIso(charge.dueDate);
    if (oldestDueDate === null || due < oldestDueDate) oldestDueDate = due;
  }

  const nextDueDate =
    plan === null
      ? null
      : nextDueDateFor(
          {
            cadence: plan.cadence,
            anchorDay: plan.anchorDay,
            startDate: toIso(plan.startDate),
            endDate: plan.endDate === null ? null : toIso(plan.endDate),
          },
          today,
          zone,
        );

  return {
    barberId,
    plan,
    charges,
    summary: { outstandingCents, unpaidCount, oldestDueDate, nextDueDate },
  };
}
