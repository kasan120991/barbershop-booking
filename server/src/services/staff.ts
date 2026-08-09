/**
 * Staff onboarding.
 *
 * Until now the only way a barber existed was the seed, which meant hiring someone
 * could not be represented in the app at all.
 *
 * Creating a barber is three rows that must all exist or none of them: the `User`
 * they sign in as, their `UserRole` entries, and the `Barber` profile clients see. A
 * user without a barber profile would be a staff account that cannot be booked; a
 * barber without a user would be a profile nobody can sign in to.
 */

import type { CreateBarberRequest, UpdateBarberRequest } from '@francis/shared';

import type { BarberStatus, Role } from '../generated/prisma/enums.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { generateTemporaryPassword, hashPassword } from './passwords.js';

export interface CreatedBarber {
  barberId: string;
  userId: string;
  email: string;
  displayName: string;
  roles: Role[];
  /** Plaintext, returned once. Read to them in person — v1 sends no email. */
  temporaryPassword: string;
}

/** URL-safe, and unique-checked below rather than assumed. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function uniqueSlug(base: string): Promise<string> {
  const root = base || 'barber';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${String(attempt + 1)}`;
    const taken = await prisma.barber.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  throw new ConflictError('Could not find a free profile URL for that name.');
}

export async function createBarber(input: CreateBarberRequest): Promise<CreatedBarber> {
  const email = input.email.trim().toLowerCase();

  // Checked explicitly so a duplicate is a clear 409 rather than a unique-constraint
  // 500 that reads like a bug.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new ConflictError('Someone already has an account with that email.');
  }

  const displayName = input.displayName?.trim() || input.firstName.trim();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const slug = await uniqueSlug(slugify(displayName));

  const roles: Role[] = input.alsoAdmin ? (['BARBER', 'ADMIN'] as Role[]) : (['BARBER'] as Role[]);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        // They sign in with a password an admin knows, so the app pins them to the
        // change-password screen until they replace it.
        mustChangePassword: true,
        roles: { create: roles.map((role) => ({ role })) },
      },
    });

    const barber = await tx.barber.create({
      data: {
        userId: user.id,
        displayName,
        slug,
        sortOrder: input.sortOrder,
        acceptsOnline: input.acceptsOnline,
        acceptsWalkIns: input.acceptsWalkIns,
      },
    });

    return { user, barber };
  });

  return {
    barberId: result.barber.id,
    userId: result.user.id,
    email: result.user.email,
    displayName: result.barber.displayName,
    roles,
    temporaryPassword,
  };
}

export async function getBarber(barberId: string) {
  const barber = await prisma.barber.findUnique({
    where: { id: barberId },
    include: { user: { select: { email: true, firstName: true, lastName: true } } },
  });
  if (!barber) throw new NotFoundError('Barber not found.');
  return barber;
}

/**
 * Profile fields only.
 *
 * Deactivating (status INACTIVE) hides a barber from booking and the public roster
 * but touches nothing they have already done — their past appointments, payments and
 * rent history stay exactly as they were.
 */
export async function updateBarber(barberId: string, input: UpdateBarberRequest) {
  await getBarber(barberId);

  return prisma.barber.update({
    where: { id: barberId },
    data: {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.bio === undefined ? {} : { bio: input.bio ?? null }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.status === undefined ? {} : { status: input.status as BarberStatus }),
      ...(input.acceptsOnline === undefined ? {} : { acceptsOnline: input.acceptsOnline }),
      ...(input.acceptsWalkIns === undefined ? {} : { acceptsWalkIns: input.acceptsWalkIns }),
    },
  });
}
