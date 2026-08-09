/**
 * Leak tests for the DTO boundary.
 *
 * These assert on what is ABSENT, not just what is present. A mapper that starts
 * spreading a Prisma model would still satisfy "has the right fields" — only an
 * absence check catches it. The public barber DTO is served unauthenticated, so a
 * Stripe account id appearing there would be a real disclosure.
 */

import { barberPublicDtoSchema, barberStaffDtoSchema, serviceDtoSchema } from '@francis/shared';
import { describe, expect, it } from 'vitest';

import type { BarberModel, ServiceModel, UserModel } from '../generated/prisma/models.js';
import { toBarberPublicDto, toBarberStaffDto, toServiceDto } from './catalog.js';

const barber = {
  id: 'brb_1',
  userId: 'usr_1',
  displayName: 'Andre',
  slug: 'andre',
  bio: null,
  avatarUrl: null,
  sortOrder: 2,
  status: 'ACTIVE',
  acceptsWalkIns: true,
  acceptsOnline: true,
  stripeAccountId: 'acct_SECRET123',
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  instantPayoutEligible: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as BarberModel;

const user = {
  email: 'andre@franciscutz.com',
  firstName: 'Andre',
  lastName: 'Boateng',
  passwordHash: 'argon2id$SECRET',
} as unknown as UserModel;

const service = {
  id: 'svc_1',
  name: 'Haircut',
  description: null,
  category: 'Cuts',
  priceCents: 4500,
  durationMinutes: 45,
  isActive: true,
  sortOrder: 1,
  bookableOnline: true,
  bookableWalkIn: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as ServiceModel;

describe('toServiceDto', () => {
  it('matches the shared contract', () => {
    expect(serviceDtoSchema.safeParse(toServiceDto(service)).success).toBe(true);
  });

  it('keeps money as integer cents', () => {
    expect(toServiceDto(service).priceCents).toBe(4500);
    expect(Number.isInteger(toServiceDto(service).priceCents)).toBe(true);
  });
});

describe('toBarberPublicDto', () => {
  const dto = toBarberPublicDto(barber, ['svc_1']);

  it('matches the shared contract', () => {
    expect(barberPublicDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('never exposes Stripe details to an unauthenticated surface', () => {
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('acct_SECRET123');
    expect(serialized).not.toContain('stripe');
    expect(dto).not.toHaveProperty('stripeAccountId');
    expect(dto).not.toHaveProperty('chargesEnabled');
  });

  it('never exposes the linked user account', () => {
    expect(dto).not.toHaveProperty('userId');
    expect(dto).not.toHaveProperty('email');
    expect(JSON.stringify(dto)).not.toContain('argon2id');
  });

  it('emits exactly the contract keys and nothing more', () => {
    expect(Object.keys(dto).sort()).toEqual(Object.keys(barberPublicDtoSchema.shape).sort());
  });
});

describe('toBarberStaffDto', () => {
  const dto = toBarberStaffDto(barber, user, ['svc_1']);

  it('matches the shared contract', () => {
    expect(barberStaffDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('reports Stripe state as a boolean, never the account id', () => {
    expect(dto.stripeConnected).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('acct_SECRET123');
  });

  it('never carries the password hash even for staff', () => {
    expect(dto).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(dto)).not.toContain('argon2id');
  });

  it('emits exactly the contract keys and nothing more', () => {
    expect(Object.keys(dto).sort()).toEqual(Object.keys(barberStaffDtoSchema.shape).sort());
  });
});
