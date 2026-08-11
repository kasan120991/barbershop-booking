/**
 * Development seed.
 *
 * Idempotent: every write is an upsert keyed on a natural unique column, so
 * running it repeatedly converges rather than duplicating. That matters because
 * `prisma migrate reset` and manual re-runs are routine during development.
 *
 * Passwords here are development-only. The auth phase replaces this hash with a
 * real argon2 one; until then no login path exists to use it.
 */

import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import 'dotenv/config';

import { parseDatabaseUrl } from '../src/config/database.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/services/passwords.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required to seed — copy server/.env.example to server/.env');
}

// timezone: 'Z' pins the session to UTC; the adapter takes discrete options, not a url.
const adapter = new PrismaMariaDb({ ...parseDatabaseUrl(DATABASE_URL), timezone: 'Z' });
const prisma = new PrismaClient({ adapter });

/**
 * Development-only password, shared by every seeded account.
 *
 * Safe to keep in the repo precisely because it is only ever written to a local
 * development database by this script. It must never be used to seed production —
 * production accounts get created by an admin with a real password.
 */
const DEV_PASSWORD = 'FrancisCutz!2026';

const MINUTES = (hours: number, minutes = 0) => hours * 60 + minutes;

async function seedShop() {
  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: 'Francis Cutz',
      timezone: 'America/New_York',
      slotGranularityMinutes: 15,
      bufferMinutes: 5,
      bookingHorizonDays: 30,
      minimumNoticeMinutes: 60,
    },
  });

  // Closed Sunday and Monday; open Tue–Sat.
  const hours = [
    { dayOfWeek: 0, openMinute: 0, closeMinute: 0, isClosed: true },
    { dayOfWeek: 1, openMinute: 0, closeMinute: 0, isClosed: true },
    { dayOfWeek: 2, openMinute: MINUTES(10), closeMinute: MINUTES(19), isClosed: false },
    { dayOfWeek: 3, openMinute: MINUTES(10), closeMinute: MINUTES(19), isClosed: false },
    { dayOfWeek: 4, openMinute: MINUTES(10), closeMinute: MINUTES(20), isClosed: false },
    { dayOfWeek: 5, openMinute: MINUTES(9), closeMinute: MINUTES(20), isClosed: false },
    { dayOfWeek: 6, openMinute: MINUTES(9), closeMinute: MINUTES(17), isClosed: false },
  ];

  /**
   * The week is REPLACED, not upserted row by row.
   *
   * The unique key is `(dayOfWeek, openMinute)`, so an upsert keyed on the opening time
   * cannot update a row whose opening time was changed. Edit Saturday to 08:30 in
   * Services & Hours, re-seed, and the 09:00 row comes back *beside* the 08:30 one —
   * the two merge into a single longer day and the shop reads as open half an hour
   * before anyone said it was. This is the same trap the barber schedules already fell
   * into, and it is fixed the same way.
   */
  await prisma.shopHours.deleteMany({});
  await prisma.shopHours.createMany({ data: hours });
}

const SERVICES = [
  { slug: 'haircut', name: 'Haircut', priceCents: 4500, durationMinutes: 45, sortOrder: 1 },
  { slug: 'beard-trim', name: 'Beard Trim', priceCents: 2000, durationMinutes: 20, sortOrder: 2 },
  { slug: 'line-up', name: 'Line-Up', priceCents: 1500, durationMinutes: 15, sortOrder: 3 },
  { slug: 'kids-cut', name: 'Kids Cut', priceCents: 3500, durationMinutes: 30, sortOrder: 4 },
  {
    slug: 'cut-and-beard',
    name: 'Cut & Beard',
    priceCents: 6000,
    durationMinutes: 60,
    sortOrder: 5,
  },
  {
    slug: 'hot-towel-shave',
    name: 'Hot Towel Shave',
    priceCents: 4000,
    durationMinutes: 40,
    sortOrder: 6,
  },
];

async function seedServices() {
  const services = [];
  for (const service of SERVICES) {
    // `name` is not unique in the schema, so find-then-write keeps this idempotent.
    const existing = await prisma.service.findFirst({ where: { name: service.name } });
    const record = existing
      ? await prisma.service.update({
          where: { id: existing.id },
          data: {
            priceCents: service.priceCents,
            durationMinutes: service.durationMinutes,
            sortOrder: service.sortOrder,
          },
        })
      : await prisma.service.create({
          data: {
            name: service.name,
            priceCents: service.priceCents,
            durationMinutes: service.durationMinutes,
            sortOrder: service.sortOrder,
            category: 'Cuts',
          },
        });
    services.push(record);
  }
  return services;
}

const STAFF = [
  {
    email: 'kasan@franciscutz.com',
    firstName: 'Kasan',
    lastName: 'Francis',
    displayName: 'Kasan',
    slug: 'kasan',
    // The owner cuts hair too — this is exactly why roles are a set.
    roles: ['ADMIN', 'BARBER'] as const,
    chair: 'Chair 1',
    sortOrder: 1,
  },
  {
    email: 'andre@franciscutz.com',
    firstName: 'Andre',
    lastName: 'Boateng',
    displayName: 'Andre',
    slug: 'andre',
    roles: ['BARBER'] as const,
    chair: 'Chair 2',
    sortOrder: 2,
  },
  {
    email: 'rico@franciscutz.com',
    firstName: 'Rico',
    lastName: 'Delgado',
    displayName: 'Rico',
    slug: 'rico',
    roles: ['BARBER'] as const,
    chair: 'Chair 3',
    sortOrder: 3,
  },
];

async function seedStaff(serviceIds: string[]) {
  // Hashed once rather than per user — argon2 is deliberately slow.
  const devPasswordHash = await hashPassword(DEV_PASSWORD);

  for (const person of STAFF) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      // Re-running the seed resets the dev password and clears any lockout hit while
      // testing, which is exactly what you want from a dev seed.
      update: {
        firstName: person.firstName,
        lastName: person.lastName,
        passwordHash: devPasswordHash,
        failedLoginAttempts: 0,
        lockedAt: null,
        mustChangePassword: false,
      },
      create: {
        email: person.email,
        passwordHash: devPasswordHash,
        firstName: person.firstName,
        lastName: person.lastName,
      },
    });

    for (const role of person.roles) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        update: {},
        create: { userId: user.id, role },
      });
    }

    const barber = await prisma.barber.upsert({
      where: { userId: user.id },
      update: { displayName: person.displayName, sortOrder: person.sortOrder },
      create: {
        userId: user.id,
        displayName: person.displayName,
        slug: person.slug,
        sortOrder: person.sortOrder,
      },
    });

    await prisma.chair.upsert({
      where: { label: person.chair },
      update: { barberId: barber.id },
      create: { label: person.chair, barberId: barber.id },
    });

    // Every barber offers every service — the admin narrows this later.
    for (const serviceId of serviceIds) {
      await prisma.barberService.upsert({
        where: { barberId_serviceId: { barberId: barber.id, serviceId } },
        update: {},
        create: { barberId: barber.id, serviceId },
      });
    }

    // Tue–Sat, 10:00–18:00 local, with a 13:00–13:30 lunch expressed as two blocks.
    const shifts = [2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
      { dayOfWeek, startMinute: MINUTES(10), endMinute: MINUTES(13) },
      { dayOfWeek, startMinute: MINUTES(13, 30), endMinute: MINUTES(18) },
    ]);

    // REPLACE the week rather than upserting row by row.
    //
    // Upserting keyed on startMinute only matches a shift that still begins at the
    // same minute, so once a schedule has been edited the seeded rows get ADDED
    // alongside the edited ones — leaving overlapping shifts that violate the app's
    // own validation. A seed exists to restore a known state, so it replaces.
    await prisma.$transaction([
      prisma.barberSchedule.deleteMany({ where: { barberId: barber.id } }),
      prisma.barberSchedule.createMany({
        data: shifts.map((shift) => ({ barberId: barber.id, ...shift })),
      }),
    ]);

    /**
     * Booth rent: $250/week, anchored to Monday — and the ledger wiped back to nothing.
     *
     * The plan alone is not the state worth restoring. Charges and payments accumulate
     * from using the app, so a dev database that has had rent recorded against it stays
     * that way through a reseed, and "reseed it" stops meaning what it says.
     *
     * Clearing them is safe precisely because nothing here recreates them: charges are
     * raised lazily on the next read of the chair's rent, so the plan below is enough to
     * put every week back. Same reasoning as the queue and `ShopHours` — replace, do not
     * add beside.
     */
    await prisma.rentPayment.deleteMany({ where: { rentCharge: { barberId: barber.id } } });
    await prisma.rentCharge.deleteMany({ where: { barberId: barber.id } });
    await prisma.rentPlan.deleteMany({ where: { barberId: barber.id } });

    await prisma.rentPlan.create({
      data: {
        barberId: barber.id,
        amountCents: 25_000,
        cadence: 'WEEKLY',
        anchorDay: 1,
        startDate: new Date('2026-01-05T00:00:00.000Z'),
      },
    });
  }
}

const CLIENTS = [
  { phoneE164: '+14155550101', firstName: 'Darnell', lastName: 'Whitaker' },
  { phoneE164: '+14155550102', firstName: 'Jay', lastName: 'Moreno' },
  { phoneE164: '+14155550103', firstName: 'Chris', lastName: 'Okafor' },
];

async function seedClients() {
  for (const client of CLIENTS) {
    await prisma.client.upsert({
      where: { phoneE164: client.phoneE164 },
      update: { firstName: client.firstName, lastName: client.lastName },
      create: client,
    });
  }
}

/**
 * A short line at the door, so `/queue` opens with something to read.
 *
 * Deliberately mixed: one client who asked for a specific barber and one who did not,
 * which is the difference the estimator exists to handle. Both are WAITING rather than
 * mid-cut, because a seeded IN_CHAIR would claim someone sat down at a time that has
 * already passed by the time anyone looks.
 *
 * Replaced rather than added to, so re-seeding does not stack up a queue of ghosts.
 */
async function seedQueue(services: { id: string; name: string }[]) {
  const haircut = services.find((service) => service.name === 'Haircut') ?? services[0];
  const beard = services.find((service) => service.name.includes('Beard')) ?? services[0];
  if (!haircut || !beard) return;

  const barbers = await prisma.barber.findMany({
    where: { acceptsWalkIns: true, status: 'ACTIVE' },
    orderBy: { sortOrder: 'asc' },
  });
  const clients = await prisma.client.findMany({
    where: { phoneE164: { in: CLIENTS.map((client) => client.phoneE164) } },
    orderBy: { phoneE164: 'asc' },
  });
  if (barbers.length === 0 || clients.length < 2) return;

  await prisma.queueEntryService.deleteMany({
    where: { queueEntry: { clientId: { in: clients.map((client) => client.id) } } },
  });
  await prisma.queueEntry.deleteMany({
    where: { clientId: { in: clients.map((client) => client.id) } },
  });

  const now = new Date();
  const waiting = [
    // Asked for a specific barber: they wait for that chair however long it takes.
    { client: clients[0]!, barberId: barbers[0]!.id, picks: [haircut, beard], minutesAgo: 22 },
    // Happy with anyone: the estimator sends them to whoever frees up first.
    { client: clients[1]!, barberId: null, picks: [haircut], minutesAgo: 9 },
  ];

  for (const entry of waiting) {
    await prisma.queueEntry.create({
      data: {
        clientId: entry.client.id,
        barberId: entry.barberId,
        source: 'KIOSK',
        joinedAt: new Date(now.getTime() - entry.minutesAgo * 60_000),
        durationMinutes: entry.picks.reduce((total, s) => total + s.durationMinutes, 0),
        priceCentsTotal: entry.picks.reduce((total, s) => total + s.priceCents, 0),
        services: {
          create: entry.picks.map((service) => ({
            serviceId: service.id,
            priceCents: service.priceCents,
            durationMinutes: service.durationMinutes,
            nameSnapshot: service.name,
          })),
        },
      },
    });
  }
}

async function main() {
  await seedShop();
  const services = await seedServices();
  await seedStaff(services.map((s) => s.id));
  await seedClients();
  await seedQueue(services);

  const counts = {
    services: await prisma.service.count(),
    users: await prisma.user.count(),
    barbers: await prisma.barber.count(),
    chairs: await prisma.chair.count(),
    schedules: await prisma.barberSchedule.count(),
    clients: await prisma.client.count(),
    queueEntries: await prisma.queueEntry.count(),
    rentPlans: await prisma.rentPlan.count(),
  };

  console.log('Seed complete:', counts);
  console.log('\nDevelopment sign-in:');
  for (const person of STAFF) {
    console.log(`  ${person.email.padEnd(28)} ${person.roles.join(', ')}`);
  }
  console.log(`  password: ${DEV_PASSWORD}   (development only)\n`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
