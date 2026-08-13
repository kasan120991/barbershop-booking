/**
 * Domain enums, mirroring the Prisma schema.
 *
 * These are hand-maintained rather than generated, because `shared` is bundled
 * into the browser and must never import Prisma. The risk that creates is drift —
 * so `server/src/generated-enums.test.ts` asserts these match the generated Prisma
 * enums exactly, and fails the build if either side changes alone.
 *
 * Declared as const objects plus a union type rather than TS `enum`, so the values
 * survive `isolatedModules` and are usable as plain strings in zod schemas.
 */

export const ROLE = {
  ADMIN: 'ADMIN',
  BARBER: 'BARBER',
} as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

export const BARBER_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;
export type BarberStatus = (typeof BARBER_STATUS)[keyof typeof BARBER_STATUS];

export const DEVICE_TYPE = {
  KIOSK: 'KIOSK',
  DISPLAY: 'DISPLAY',
  /**
   * The Vapi phone receptionist. A permission, not a label, exactly as the other two
   * are — only a KIOSK may join the queue, only a VOICE device may reach the voice
   * webhook, and the discriminated union refuses the rest at the type level.
   */
  VOICE: 'VOICE',
} as const;
export type DeviceType = (typeof DEVICE_TYPE)[keyof typeof DEVICE_TYPE];

export const SCHEDULE_EXCEPTION_TYPE = {
  TIME_OFF: 'TIME_OFF',
  BLOCK: 'BLOCK',
  EXTRA_HOURS: 'EXTRA_HOURS',
} as const;
export type ScheduleExceptionType =
  (typeof SCHEDULE_EXCEPTION_TYPE)[keyof typeof SCHEDULE_EXCEPTION_TYPE];

export const APPOINTMENT_STATUS = {
  BOOKED: 'BOOKED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
} as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[keyof typeof APPOINTMENT_STATUS];

export const APPOINTMENT_SOURCE = {
  ONLINE: 'ONLINE',
  KIOSK: 'KIOSK',
  STAFF: 'STAFF',
  WALK_IN: 'WALK_IN',
  /** Reserved for the post-MVP Vapi receptionist. */
  VOICE: 'VOICE',
} as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCE)[keyof typeof APPOINTMENT_SOURCE];

export const QUEUE_STATUS = {
  WAITING: 'WAITING',
  CALLED: 'CALLED',
  IN_CHAIR: 'IN_CHAIR',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
} as const;
export type QueueStatus = (typeof QUEUE_STATUS)[keyof typeof QUEUE_STATUS];

/** Statuses that still occupy a barber's time and therefore feed the estimator. */
export const ACTIVE_QUEUE_STATUSES: readonly QueueStatus[] = [
  QUEUE_STATUS.WAITING,
  QUEUE_STATUS.CALLED,
  QUEUE_STATUS.IN_CHAIR,
];

/** Statuses that still occupy a slot and therefore block a booking overlap. */
export const BLOCKING_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  APPOINTMENT_STATUS.BOOKED,
  APPOINTMENT_STATUS.IN_PROGRESS,
];

export const PAYMENT_METHOD = {
  CARD_ONLINE: 'CARD_ONLINE',
  CARD_TERMINAL: 'CARD_TERMINAL',
  CASH: 'CASH',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  VOIDED: 'VOIDED',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const PAYOUT_TYPE = {
  STANDARD_AUTO: 'STANDARD_AUTO',
  INSTANT: 'INSTANT',
} as const;
export type PayoutType = (typeof PAYOUT_TYPE)[keyof typeof PAYOUT_TYPE];

export const PAYOUT_STATUS = {
  PENDING: 'PENDING',
  IN_TRANSIT: 'IN_TRANSIT',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
} as const;
export type PayoutStatus = (typeof PAYOUT_STATUS)[keyof typeof PAYOUT_STATUS];

export const RENT_CADENCE = {
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
} as const;
export type RentCadence = (typeof RENT_CADENCE)[keyof typeof RENT_CADENCE];

export const RENT_CHARGE_STATUS = {
  DUE: 'DUE',
  PAID: 'PAID',
  PARTIAL: 'PARTIAL',
  WAIVED: 'WAIVED',
} as const;
export type RentChargeStatus = (typeof RENT_CHARGE_STATUS)[keyof typeof RENT_CHARGE_STATUS];

export const RENT_PAYMENT_METHOD = {
  CASH: 'CASH',
  ZELLE: 'ZELLE',
  CHECK: 'CHECK',
  CARD_MANUAL: 'CARD_MANUAL',
  OTHER: 'OTHER',
} as const;
export type RentPaymentMethod = (typeof RENT_PAYMENT_METHOD)[keyof typeof RENT_PAYMENT_METHOD];

/** 0 = Sunday .. 6 = Saturday, matching `Date.prototype.getDay()`. */
export const DAY_OF_WEEK = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
} as const;
export type DayOfWeek = (typeof DAY_OF_WEEK)[keyof typeof DAY_OF_WEEK];
