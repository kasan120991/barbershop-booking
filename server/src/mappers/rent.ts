/**
 * Rent DTO mappers.
 *
 * Fields named rather than spread, as everywhere else. `RentPayment` carries
 * `recordedByUserId` — which member of staff took the cash — and that belongs in the audit
 * trail rather than on a page the barber it concerns can read.
 *
 * Dates come out as plain `YYYY-MM-DD`. A rent period is a run of days, not an instant, and
 * sending an ISO timestamp would invite a browser to shift it a day either way.
 */

import {
  RENT_CHARGE_STATUS,
  sumCents,
  type RentChargeDto,
  type RentPlanDto,
} from '@francis/shared';

import type { RentPlanModel } from '../generated/prisma/models.js';
import type { RentCharge } from '../services/rent.js';

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function toRentPlanDto(plan: RentPlanModel): RentPlanDto {
  return {
    id: plan.id,
    amountCents: plan.amountCents,
    cadence: plan.cadence,
    anchorDay: plan.anchorDay,
    startDate: dateOnly(plan.startDate),
    endDate: plan.endDate === null ? null : dateOnly(plan.endDate),
    isActive: plan.isActive,
  };
}

export function toRentChargeDto(charge: RentCharge): RentChargeDto {
  const paidCents = sumCents(charge.payments.map((payment) => payment.amountCents));

  return {
    id: charge.id,
    periodStart: dateOnly(charge.periodStart),
    periodEnd: dateOnly(charge.periodEnd),
    amountCents: charge.amountCents,
    dueDate: dateOnly(charge.dueDate),
    status: charge.status,
    note: charge.note,
    /** True when the plan raised it, false when somebody did. */
    fromPlan: charge.rentPlanId !== null,
    paidCents,
    // Nobody is going to pay a waived charge, so it owes nothing — computed here rather
    // than left to each screen to remember.
    outstandingCents:
      charge.status === RENT_CHARGE_STATUS.WAIVED
        ? 0
        : Math.max(0, charge.amountCents - paidCents),
    payments: charge.payments.map((payment) => ({
      id: payment.id,
      amountCents: payment.amountCents,
      method: payment.method,
      paidAt: payment.paidAt.toISOString(),
      note: payment.note,
    })),
  };
}
