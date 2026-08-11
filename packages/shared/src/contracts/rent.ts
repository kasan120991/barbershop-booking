/**
 * Rent contracts — what a chair costs and who has paid for it.
 *
 * The shop runs on booth rent: the barber keeps every penny of every cut and pays a fixed
 * amount for the chair. So nothing here is a share of anything — no commission, no
 * percentage, no relationship to what a barber took that week. A charge is a fixed sum for
 * a period, and either it has been paid or it has not.
 *
 * Rent is also settled **offline** — cash, Zelle, a cheque — which is why a payment records
 * a method and a date somebody types in rather than anything Stripe knows about.
 */

import { z } from 'zod';

import { RENT_CADENCE, RENT_CHARGE_STATUS, RENT_PAYMENT_METHOD } from '../enums.js';

export const rentCadenceSchema = z.enum(Object.values(RENT_CADENCE) as [string, ...string[]]);
export const rentChargeStatusSchema = z.enum(
  Object.values(RENT_CHARGE_STATUS) as [string, ...string[]],
);
export const rentPaymentMethodSchema = z.enum(
  Object.values(RENT_PAYMENT_METHOD) as [string, ...string[]],
);

/** Dates here are plain `YYYY-MM-DD` — a rent period is a run of days, not an instant. */
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  error: 'Enter a date as YYYY-MM-DD.',
});

export const rentPlanDtoSchema = z.object({
  id: z.string(),
  amountCents: z.int().nonnegative(),
  cadence: rentCadenceSchema,
  /**
   * Weekly: 0–6, Sunday first, matching `Date.prototype.getDay()` and `DAY_NAMES`.
   * Monthly: 1–28, capped so a plan cannot land on a day February does not have.
   */
  anchorDay: z.int().min(0).max(28),
  startDate: localDateSchema,
  endDate: localDateSchema.nullable(),
  isActive: z.boolean(),
});
export type RentPlanDto = z.infer<typeof rentPlanDtoSchema>;

export const rentPaymentDtoSchema = z.object({
  id: z.string(),
  amountCents: z.int().nonnegative(),
  method: rentPaymentMethodSchema,
  paidAt: z.iso.datetime(),
  note: z.string().nullable(),
});
export type RentPaymentDto = z.infer<typeof rentPaymentDtoSchema>;

export const rentChargeDtoSchema = z.object({
  id: z.string(),
  periodStart: localDateSchema,
  periodEnd: localDateSchema,
  /** Copied from the plan when the charge was raised. Editing the plan never rewrites it. */
  amountCents: z.int().nonnegative(),
  dueDate: localDateSchema,
  status: rentChargeStatusSchema,
  note: z.string().nullable(),
  /** Null on a one-off an admin raised by hand. */
  fromPlan: z.boolean(),
  paidCents: z.int().nonnegative(),
  /** What is still owed. Zero on a waived charge — nobody is going to pay it. */
  outstandingCents: z.int().nonnegative(),
  payments: z.array(rentPaymentDtoSchema),
});
export type RentChargeDto = z.infer<typeof rentChargeDtoSchema>;

export const rentSummaryDtoSchema = z.object({
  outstandingCents: z.int().nonnegative(),
  /** How many charges are unpaid or part-paid — "three weeks behind" is the useful shape. */
  unpaidCount: z.int().nonnegative(),
  /** The oldest thing still owed, which is what a conversation about arrears starts from. */
  oldestDueDate: localDateSchema.nullable(),
  nextDueDate: localDateSchema.nullable(),
});
export type RentSummaryDto = z.infer<typeof rentSummaryDtoSchema>;

export const rentOverviewDtoSchema = z.object({
  barberId: z.string(),
  plan: rentPlanDtoSchema.nullable(),
  charges: z.array(rentChargeDtoSchema),
  summary: rentSummaryDtoSchema,
});
export type RentOverviewDto = z.infer<typeof rentOverviewDtoSchema>;

// --- Writes ------------------------------------------------------------------

/**
 * `anchorDay` is validated against the cadence rather than by one loose range, because 0 is
 * a real answer for a weekly plan (Sunday) and a meaningless one for a monthly plan.
 */
export const saveRentPlanRequestSchema = z
  .object({
    amountCents: z.int().positive({ error: 'Enter what the chair costs.' }),
    cadence: rentCadenceSchema,
    anchorDay: z.int().min(0).max(28),
    startDate: localDateSchema,
    endDate: localDateSchema.nullish(),
  })
  .refine(
    (value) =>
      value.cadence === RENT_CADENCE.WEEKLY
        ? value.anchorDay >= 0 && value.anchorDay <= 6
        : value.anchorDay >= 1 && value.anchorDay <= 28,
    { error: 'Pick a day that exists for this cadence.', path: ['anchorDay'] },
  )
  .refine(
    (value) => value.endDate == null || value.endDate >= value.startDate,
    { error: 'The end date cannot be before the start date.', path: ['endDate'] },
  );
export type SaveRentPlanRequest = z.infer<typeof saveRentPlanRequestSchema>;

export const createRentChargeRequestSchema = z
  .object({
    amountCents: z.int().positive(),
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    dueDate: localDateSchema,
    note: z.string().trim().max(300).nullish(),
  })
  .refine((value) => value.periodEnd >= value.periodStart, {
    error: 'The period cannot end before it starts.',
    path: ['periodEnd'],
  });
export type CreateRentChargeRequest = z.infer<typeof createRentChargeRequestSchema>;

export const recordRentPaymentRequestSchema = z.object({
  amountCents: z.int().positive({ error: 'Enter how much was paid.' }),
  method: rentPaymentMethodSchema,
  /** Defaults to now on the server. Backdating a Sunday cash payment is normal. */
  paidAt: z.iso.datetime().nullish(),
  note: z.string().trim().max(300).nullish(),
});
export type RecordRentPaymentRequest = z.infer<typeof recordRentPaymentRequestSchema>;

/**
 * A payment against the chair rather than against one week.
 *
 * The server spreads it oldest-first across whatever is outstanding, which is how money is
 * actually handed over — nobody says "this is for the week of the fifth". More than is owed
 * is refused rather than held as credit; there is nowhere honest to keep a surplus.
 */
export const allocateRentPaymentRequestSchema = z.object({
  amountCents: z.int().positive({ error: 'Enter how much was paid.' }),
  method: rentPaymentMethodSchema,
  paidAt: z.iso.datetime().nullish(),
  note: z.string().trim().max(300).nullish(),
});
export type AllocateRentPaymentRequest = z.infer<typeof allocateRentPaymentRequestSchema>;

/** What one handed-over sum actually settled, so the confirmation can say. */
export const allocatedRentPaymentDtoSchema = z.object({
  chargeId: z.string(),
  periodStart: localDateSchema,
  amountCents: z.int().nonnegative(),
  statusAfter: rentChargeStatusSchema,
});
export type AllocatedRentPaymentDto = z.infer<typeof allocatedRentPaymentDtoSchema>;

export const waiveRentChargeRequestSchema = z.object({
  /**
   * Required, unlike most notes. Waiving is the one action here that makes money owed stop
   * being owed, and "why" is the whole value of the record afterwards.
   */
  note: z.string().trim().min(1, { error: 'Say why this is being waived.' }).max(300),
});
export type WaiveRentChargeRequest = z.infer<typeof waiveRentChargeRequestSchema>;
