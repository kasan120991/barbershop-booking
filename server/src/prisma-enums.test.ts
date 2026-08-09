/**
 * Guards the one unavoidable duplication in the system.
 *
 * `@francis/shared` cannot import Prisma — it ships to the browser — so its domain
 * enums are hand-written copies of the Prisma ones. This test is what keeps the
 * copy honest: it lives in `server`, where BOTH are importable, and fails the
 * moment either side gains, loses, or renames a value.
 *
 * If this fails, fix the mismatch. Do not "fix" it by loosening the assertion.
 */

import {
  APPOINTMENT_SOURCE,
  APPOINTMENT_STATUS,
  BARBER_STATUS,
  DEVICE_TYPE,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  PAYOUT_STATUS,
  PAYOUT_TYPE,
  QUEUE_STATUS,
  RENT_CADENCE,
  RENT_CHARGE_STATUS,
  RENT_PAYMENT_METHOD,
  ROLE,
  SCHEDULE_EXCEPTION_TYPE,
} from '@francis/shared';
import { describe, expect, it } from 'vitest';

import * as PrismaEnums from './generated/prisma/enums.js';

const CASES: ReadonlyArray<{
  name: string;
  shared: Record<string, string>;
  prisma: Record<string, string>;
}> = [
  { name: 'Role', shared: ROLE, prisma: PrismaEnums.Role },
  { name: 'BarberStatus', shared: BARBER_STATUS, prisma: PrismaEnums.BarberStatus },
  { name: 'DeviceType', shared: DEVICE_TYPE, prisma: PrismaEnums.DeviceType },
  {
    name: 'ScheduleExceptionType',
    shared: SCHEDULE_EXCEPTION_TYPE,
    prisma: PrismaEnums.ScheduleExceptionType,
  },
  { name: 'AppointmentStatus', shared: APPOINTMENT_STATUS, prisma: PrismaEnums.AppointmentStatus },
  { name: 'AppointmentSource', shared: APPOINTMENT_SOURCE, prisma: PrismaEnums.AppointmentSource },
  { name: 'QueueStatus', shared: QUEUE_STATUS, prisma: PrismaEnums.QueueStatus },
  { name: 'PaymentMethod', shared: PAYMENT_METHOD, prisma: PrismaEnums.PaymentMethod },
  { name: 'PaymentStatus', shared: PAYMENT_STATUS, prisma: PrismaEnums.PaymentStatus },
  { name: 'PayoutType', shared: PAYOUT_TYPE, prisma: PrismaEnums.PayoutType },
  { name: 'PayoutStatus', shared: PAYOUT_STATUS, prisma: PrismaEnums.PayoutStatus },
  { name: 'RentCadence', shared: RENT_CADENCE, prisma: PrismaEnums.RentCadence },
  { name: 'RentChargeStatus', shared: RENT_CHARGE_STATUS, prisma: PrismaEnums.RentChargeStatus },
  {
    name: 'RentPaymentMethod',
    shared: RENT_PAYMENT_METHOD,
    prisma: PrismaEnums.RentPaymentMethod,
  },
];

describe('shared enums mirror the Prisma schema', () => {
  it.each(CASES)('$name has identical members', ({ shared, prisma }) => {
    expect(Object.values(shared).sort()).toEqual(Object.values(prisma).sort());
  });

  it.each(CASES)('$name keys map to their own value', ({ shared }) => {
    for (const [key, value] of Object.entries(shared)) {
      expect(value).toBe(key);
    }
  });

  it('covers every enum the Prisma schema defines', () => {
    const prismaEnumNames = Object.keys(PrismaEnums).sort();
    const covered = CASES.map((c) => c.name).sort();
    expect(covered).toEqual(prismaEnumNames);
  });
});
