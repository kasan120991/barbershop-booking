/**
 * Development demo data — a shop that looks like it is open right now.
 *
 * `seed.ts` builds the shop; this fills it with a day in progress. It exists because a
 * development database goes stale the moment the clock moves past it: every appointment
 * falls behind, the queue's estimates point at a morning that has gone, and the calendar
 * opens on an empty day that says nothing about whether any of it works. Run this and
 * the app reads as a shop mid-service.
 *
 * **The working day is placed around `now`, not around the seed's Tue–Sat hours.** Run at
 * two in the afternoon those agree; run at midnight, and a shop whose hours say 10–19 is
 * shut, so there is nothing live to look at — which is exactly the case this script is
 * for. So today's `ShopHours` row and every barber's schedule for today's weekday are
 * rewritten to a window containing the current moment. `db:seed` puts the real week back.
 *
 * Yesterday is written too, as a full day already finished and paid. Today alone gives
 * reporting and earnings nothing to add up before lunchtime.
 *
 * Everything it touches is REPLACED rather than added to, for the same reason the seed
 * replaces `ShopHours`: a second run must converge on the same day, not stack a third
 * copy of it beside the first two.
 */

import 'dotenv/config';
import { DateTime } from 'luxon';

// The application's own client, not a second one of its own. `seed.ts` builds itself one
// because it imports nothing from `src/services`; this script imports the estimator, and
// that brings the singleton and its pool up regardless. A local client alongside it means
// two pools, and the one nobody disconnects holds the event loop open — the script
// finishes its work, prints, and then hangs forever instead of exiting.
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';
import { refreshQueueEstimates } from '../src/services/queue.js';

/**
 * Deterministic pseudo-randomness.
 *
 * The variety is for the eye — which client, how big a tip. Two runs an hour apart should
 * still differ only by the clock, or a screenshot taken to compare a change against
 * yesterday's is comparing the dice as well.
 */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const DEMO_CLIENTS = [
  { phoneE164: '+14155550201', firstName: 'Marcus', lastName: 'Bell' },
  { phoneE164: '+14155550202', firstName: 'Tobias', lastName: 'Ferrer' },
  { phoneE164: '+14155550203', firstName: 'Ely', lastName: 'Nakamura' },
  { phoneE164: '+14155550204', firstName: 'Desmond', lastName: 'Ruiz' },
  { phoneE164: '+14155550205', firstName: 'Amari', lastName: 'Coleman' },
  { phoneE164: '+14155550206', firstName: 'Priya', lastName: 'Raghavan' },
  { phoneE164: '+14155550207', firstName: 'Owen', lastName: 'Mbeki' },
  { phoneE164: '+14155550208', firstName: 'Silas', lastName: 'Andersen' },
  { phoneE164: '+14155550209', firstName: 'Rashid', lastName: 'Haddad' },
  { phoneE164: '+14155550210', firstName: 'June', lastName: 'Whitfield' },
  { phoneE164: '+14155550211', firstName: 'Cal', lastName: 'Petrov' },
  { phoneE164: '+14155550212', firstName: 'Nadia', lastName: 'Osei' },
];

async function upsertClients() {
  const clients = [];
  for (const client of DEMO_CLIENTS) {
    clients.push(
      await prisma.client.upsert({
        where: { phoneE164: client.phoneE164 },
        update: { firstName: client.firstName, lastName: client.lastName },
        create: client,
      }),
    );
  }
  return clients;
}

/**
 * The window the shop is open, as minutes past local midnight.
 *
 * Four hours behind and five ahead, so there is a morning behind the current moment and
 * an afternoon in front of it. Clamped to the day, because `ShopHours` is minutes past
 * midnight and cannot express a day that starts yesterday — and then given back whatever
 * the clamp took, so a run at half past midnight still describes a full day's work rather
 * than the twenty minutes that happen to have elapsed.
 */
function tradingWindow(now: DateTime): { openMinute: number; closeMinute: number } {
  const minuteOfDay = now.hour * 60 + now.minute;
  const span = 9 * 60;

  let openMinute = Math.floor((minuteOfDay - 4 * 60) / 30) * 30;
  let closeMinute = openMinute + span;

  if (openMinute < 0) {
    openMinute = 0;
    closeMinute = Math.min(span, 24 * 60);
  }
  if (closeMinute > 24 * 60) {
    closeMinute = 24 * 60;
    openMinute = Math.max(0, closeMinute - span);
  }
  return { openMinute, closeMinute };
}

/** Today's opening hours and every barber's schedule, rewritten to hold `window`. */
async function openTheShop(
  jsDay: number,
  window: { openMinute: number; closeMinute: number },
  barberIds: string[],
) {
  await prisma.shopHours.deleteMany({ where: { dayOfWeek: jsDay } });
  await prisma.shopHours.create({
    data: {
      dayOfWeek: jsDay,
      openMinute: window.openMinute,
      closeMinute: window.closeMinute,
      isClosed: false,
    },
  });

  for (const barberId of barberIds) {
    await prisma.barberSchedule.deleteMany({ where: { barberId, dayOfWeek: jsDay } });
    await prisma.barberSchedule.create({
      data: {
        barberId,
        dayOfWeek: jsDay,
        startMinute: window.openMinute,
        endMinute: window.closeMinute,
      },
    });
  }
}

/**
 * Yesterday's hours as they already stand — never rewritten.
 *
 * Today is opened around the current moment because that is the point of the script.
 * Yesterday is only there to give reporting something to add up, and forcing it open
 * would quietly write the shop a trading day it does not have: run this on a Monday
 * and Sunday, which the shop is closed on, would be left open every week thereafter.
 * Closed yesterday simply means no yesterday.
 */
async function yesterdaysHours(jsDay: number): Promise<{ openMinute: number; closeMinute: number } | null> {
  const rows = await prisma.shopHours.findMany({ where: { dayOfWeek: jsDay, isClosed: false } });
  if (rows.length === 0) return null;

  const openMinute = Math.min(...rows.map((row) => row.openMinute));
  const closeMinute = Math.max(...rows.map((row) => row.closeMinute));
  return closeMinute > openMinute ? { openMinute, closeMinute } : null;
}

interface Service {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

/**
 * The line at the door: one in the chair, one just called, two still waiting.
 *
 * Every state a barber acts on, rather than a pair of rows that only exercise the empty
 * case. One of the waiting two asked for a particular barber and one did not — the
 * difference the estimator exists to handle.
 */
const WALK_INS = [
  { minutesAgo: 38, want: 'IN_CHAIR' as const, asksFor: true },
  { minutesAgo: 24, want: 'CALLED' as const, asksFor: true },
  { minutesAgo: 13, want: 'WAITING' as const, asksFor: false },
  { minutesAgo: 4, want: 'WAITING' as const, asksFor: true },
];

/**
 * One barber's run of cuts through a day, back to back with the odd gap.
 *
 * Status is read off the clock rather than assigned: anything finished is COMPLETED, the
 * one straddling this minute is IN_PROGRESS, the rest are still BOOKED. That is what makes
 * the board honest at whatever moment somebody opens it.
 */
function layDay(input: {
  from: DateTime;
  to: DateTime;
  now: DateTime;
  services: Service[];
  random: () => number;
  /** A finished day: everything completed, nothing left standing. */
  closed: boolean;
  /**
   * Keep the cut straddling this minute, whatever the dice say.
   *
   * Set for one chair only. Whether anybody is mid-cut is otherwise left to chance, and
   * a demo of a shop that is open right now should not be able to open on three empty
   * chairs — while forcing it for every barber puts the whole shop mid-cut and leaves
   * the walk-in queue with nowhere to seat anyone.
   */
  keepNowSlot: boolean;
}) {
  type Status = 'COMPLETED' | 'IN_PROGRESS' | 'BOOKED';
  const cuts: { startAt: Date; endAt: Date; service: Service; status: Status }[] = [];
  let cursor = input.from;

  while (cursor < input.to) {
    const service = input.services[Math.floor(input.random() * input.services.length)]!;
    const end = cursor.plus({ minutes: service.durationMinutes });
    if (end > input.to) break;

    const straddlesNow = cursor <= input.now && end > input.now;

    // A chair is not booked solid; a third of the slots are left as air. Fill them and
    // every walk-in's estimate lands hours out, which makes the queue read as a backlog
    // rather than a line.
    if (input.random() > 0.35 || (input.keepNowSlot && straddlesNow)) {
      const status = input.closed
        ? 'COMPLETED'
        : end <= input.now
          ? 'COMPLETED'
          : cursor <= input.now
            ? 'IN_PROGRESS'
            : 'BOOKED';
      cuts.push({ startAt: cursor.toJSDate(), endAt: end.toJSDate(), service, status });
    }

    cursor = end.plus({ minutes: input.random() > 0.6 ? 15 : 5 });
  }

  return cuts;
}

async function main() {
  const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error('No ShopSettings — run `pnpm --filter @francis/server db:seed` first.');

  const zone = settings.timezone;
  const now = DateTime.now().setZone(zone);
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });

  const services = await prisma.service.findMany({ where: { isActive: true } });
  const barbers = await prisma.barber.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { sortOrder: 'asc' },
  });
  if (services.length === 0 || barbers.length === 0) {
    throw new Error('No services or barbers — run `pnpm --filter @francis/server db:seed` first.');
  }

  const clients = await upsertClients();
  const walkInCount = WALK_INS.length;
  const random = rng(Math.floor(today.toMillis() / 86_400_000));

  // Luxon counts Monday as 1; the schema follows `Date.prototype.getDay()`, Sunday as 0.
  const jsDay = (day: DateTime) => day.weekday % 7;

  const window = tradingWindow(now);
  const yesterdayWindow = await yesterdaysHours(jsDay(yesterday));

  await openTheShop(jsDay(today), window, barbers.map((barber) => barber.id));

  // --- Clear the two days being rewritten ------------------------------------
  //
  // Scoped to the window, never `deleteMany({})`: a dev database also holds whatever was
  // staged by hand for something else, and on a future date at that.
  const from = yesterday.toJSDate();
  const to = today.plus({ days: 1 }).toJSDate();

  const doomed = await prisma.appointment.findMany({
    where: { startAt: { gte: from, lt: to } },
    select: { id: true },
  });
  const doomedIds = doomed.map((appointment) => appointment.id);
  await prisma.payment.deleteMany({ where: { appointmentId: { in: doomedIds } } });
  await prisma.appointmentService.deleteMany({ where: { appointmentId: { in: doomedIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: doomedIds } } });

  // The whole line goes, not just the demo clients': a queue is a snapshot of this
  // minute, and yesterday's leftovers would sit at the top of it forever.
  await prisma.queueEntryService.deleteMany({});
  await prisma.payment.deleteMany({ where: { queueEntryId: { not: null } } });
  await prisma.queueEntry.deleteMany({});

  // --- The two days -----------------------------------------------------------

  let created = 0;
  let completed = 0;
  let inProgress = 0;

  const days = [{ start: today, window, closed: false }];
  if (yesterdayWindow) days.unshift({ start: yesterday, window: yesterdayWindow, closed: true });

  // The last few names are held back for the queue, so nobody is a walk-in and a
  // booking on the same morning — true of a real client, confusing on a demo board.
  const walkInClients = clients.slice(-walkInCount);
  const bookingClients = clients.slice(0, -walkInCount);

  /**
   * Nobody is in two chairs at once.
   *
   * Picking a client at random per cut put the same name in two columns at the same
   * minute, which is the first thing the eye catches on the day board and reads as a
   * bug in the calendar rather than in the data behind it.
   */
  const booked = new Map<string, { start: number; end: number }[]>();
  const pickClient = (startAt: Date, endAt: Date) => {
    const offset = Math.floor(random() * bookingClients.length);
    for (let step = 0; step < bookingClients.length; step++) {
      const client = bookingClients[(offset + step) % bookingClients.length]!;
      const theirs = booked.get(client.id) ?? [];
      const clash = theirs.some(
        (slot) => slot.start < endAt.getTime() && slot.end > startAt.getTime(),
      );
      if (!clash) {
        booked.set(client.id, [...theirs, { start: startAt.getTime(), end: endAt.getTime() }]);
        return client;
      }
    }
    return null;
  };

  /** Chairs with somebody in them right now — the walk-ins below must not double them up. */
  const busyNow = new Set<string>();

  for (const day of days) {
    for (const [chair, barber] of barbers.entries()) {
      const cuts = layDay({
        from: day.start.plus({ minutes: day.window.openMinute }),
        to: day.start.plus({ minutes: day.window.closeMinute }),
        now,
        services,
        random,
        closed: day.closed,
        keepNowSlot: !day.closed && chair === 0,
      });

      for (const cut of cuts) {
        const client = pickClient(cut.startAt, cut.endAt);
        if (!client) continue;
        if (cut.status === 'IN_PROGRESS') busyNow.add(barber.id);

        const appointment = await prisma.appointment.create({
          data: {
            clientId: client.id,
            barberId: barber.id,
            startAt: cut.startAt,
            endAt: cut.endAt,
            durationMinutes: cut.service.durationMinutes,
            priceCentsTotal: cut.service.priceCents,
            status: cut.status,
            /**
             * Stamped for the cut in progress, exactly as pressing Start would.
             *
             * Without it the demo data recreates the bug it was seeded to demonstrate the
             * absence of: the estimator would know only the scheduled window, and the wall
             * board would announce a barber as free with a client in the chair. Mirrors the
             * `startedAt` given to the seeded IN_CHAIR queue entries further down.
             */
            startedAt: cut.status === 'IN_PROGRESS' ? cut.startAt : null,
            source: random() > 0.5 ? 'ONLINE' : 'STAFF',
            services: {
              create: {
                serviceId: cut.service.id,
                priceCents: cut.service.priceCents,
                durationMinutes: cut.service.durationMinutes,
                nameSnapshot: cut.service.name,
              },
            },
          },
        });
        created++;
        if (cut.status === 'IN_PROGRESS') inProgress++;

        // A finished cut has been paid for — otherwise takings, earnings and rent all
        // read as a shop that works for nothing.
        if (cut.status === 'COMPLETED') {
          completed++;
          const card = random() > 0.35;
          const tipCents = Math.round((cut.service.priceCents * (random() * 0.2)) / 100) * 100;
          await prisma.payment.create({
            data: {
              barberId: barber.id,
              clientId: client.id,
              appointmentId: appointment.id,
              method: card ? 'CARD_ONLINE' : 'CASH',
              status: 'SUCCEEDED',
              amountCents: cut.service.priceCents,
              tipCents,
              totalCents: cut.service.priceCents + tipCents,
              paidAt: cut.endAt,
            },
          });
        }
      }
    }
  }

  // --- The line at the door ----------------------------------------------------
  //
  // The seated and called pair go to chairs that are free, and both fall back to
  // WAITING when every barber is mid-cut. A walk-in drawn in a chair that already has
  // an appointment running in it is two people in one seat, which is the one thing the
  // day board must never be able to show.
  const free = barbers.filter((barber) => !busyNow.has(barber.id));

  const walkIns = WALK_INS.map((walkIn, index) => ({
    ...walkIn,
    chair:
      walkIn.want === 'IN_CHAIR'
        ? (free[0] ?? null)
        : walkIn.want === 'CALLED'
          ? (free[1] ?? null)
          : // A waiting client may ask for a barber who is busy; that is what waiting is.
            (walkIn.asksFor ? (barbers[index % barbers.length] ?? null) : null),
  }));

  for (const [index, walkIn] of walkIns.entries()) {
    const service = services[Math.floor(random() * services.length)]!;
    const client = walkInClients[index]!;
    const joinedAt = now.minus({ minutes: walkIn.minutesAgo });
    // Nobody is seated or called without a chair to be seated in.
    const status = walkIn.want !== 'WAITING' && !walkIn.chair ? 'WAITING' : walkIn.want;
    const barber = walkIn.chair;

    await prisma.queueEntry.create({
      data: {
        clientId: client.id,
        barberId: barber?.id ?? null,
        status,
        joinedAt: joinedAt.toJSDate(),
        calledAt: status === 'WAITING' ? null : joinedAt.plus({ minutes: 6 }).toJSDate(),
        startedAt: status === 'IN_CHAIR' ? joinedAt.plus({ minutes: 9 }).toJSDate() : null,
        durationMinutes: service.durationMinutes,
        priceCentsTotal: service.priceCents,
        source: 'KIOSK',
        services: {
          create: {
            serviceId: service.id,
            priceCents: service.priceCents,
            durationMinutes: service.durationMinutes,
            nameSnapshot: service.name,
          },
        },
      },
    });
  }

  // The estimator owns `estimatedReadyAt`; writing it here by hand would be a second
  // implementation of the one piece of queue logic that has to stay single.
  const board = await refreshQueueEstimates(now.toJSDate());

  const fmt = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

  console.log('Demo day written:', {
    shopNow: now.toFormat('cccc d LLLL, h:mm a'),
    todayOpen: `${fmt(window.openMinute)}–${fmt(window.closeMinute)}`,
    appointments: created,
    completed,
    inProgress,
    booked: created - completed - inProgress,
    queue: board.entries.length,
  });
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // Awaited, unlike the seed's fire-and-forget: the pool is what holds the event loop
  // open, so a script that does not wait for it to close never exits.
  await disconnectPrisma();
}
