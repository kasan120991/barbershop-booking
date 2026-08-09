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

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required to seed — copy server/.env.example to server/.env');
}

// timezone: 'Z' pins the session to UTC; the adapter takes discrete options, not a url.
const adapter = new PrismaMariaDb({ ...parseDatabaseUrl(DATABASE_URL), timezone: 'Z' });
const prisma = new PrismaClient({ adapter });

/** Placeholder — replaced with a real argon2 hash in the auth phase. */
const DEV_PASSWORD_HASH = 'dev-only-not-a-real-hash';

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

  for (const row of hours) {
    await prisma.shopHours.upsert({
      where: { dayOfWeek_openMinute: { dayOfWeek: row.dayOfWeek, openMinute: row.openMinute } },
      update: { closeMinute: row.closeMinute, isClosed: row.isClosed },
      create: row,
    });
  }
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
  for (const person of STAFF) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { firstName: person.firstName, lastName: person.lastName },
      create: {
        email: person.email,
        passwordHash: DEV_PASSWORD_HASH,
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

    for (const shift of shifts) {
      await prisma.barberSchedule.upsert({
        where: {
          barberId_dayOfWeek_startMinute: {
            barberId: barber.id,
            dayOfWeek: shift.dayOfWeek,
            startMinute: shift.startMinute,
          },
        },
        update: { endMinute: shift.endMinute },
        create: { barberId: barber.id, ...shift },
      });
    }

    // Booth rent: $250/week, anchored to Monday.
    const existingPlan = await prisma.rentPlan.findFirst({
      where: { barberId: barber.id, isActive: true },
    });
    if (!existingPlan) {
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

async function main() {
  await seedShop();
  const services = await seedServices();
  await seedStaff(services.map((s) => s.id));
  await seedClients();

  const counts = {
    services: await prisma.service.count(),
    users: await prisma.user.count(),
    barbers: await prisma.barber.count(),
    chairs: await prisma.chair.count(),
    schedules: await prisma.barberSchedule.count(),
    clients: await prisma.client.count(),
    rentPlans: await prisma.rentPlan.count(),
  };

  console.log('Seed complete:', counts);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
