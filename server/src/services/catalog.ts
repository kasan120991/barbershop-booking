/**
 * The service menu, shop settings, opening hours and closures.
 *
 * Plain functions over plain arguments per the standing rule — no `req`, no `res` —
 * so the Vapi receptionist can read the menu later through the same code the HTTP
 * routes use.
 *
 * This module owns the shop's only timezone conversion so far. Everything else in
 * the system stores UTC instants; closures are the first thing a human expresses as a
 * *local calendar date*, and turning "2026-12-25" into the right pair of instants is
 * exactly the arithmetic CLAUDE.md says must never be done with raw `Date` maths.
 */

import type {
  CreateClosureRequest,
  CreateServiceRequest,
  ShopClosureDto,
  UpdateServiceRequest,
  UpdateShopSettingsRequest,
} from '@francis/shared';
import { DateTime } from 'luxon';

import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import type { ServiceModel } from '../generated/prisma/models.js';

/** The singleton row, pinned to 1 in the schema so a second shop cannot exist. */
const SHOP_SETTINGS_ID = 1;

// --- Services ----------------------------------------------------------------

export function listServices(options: { includeArchived: boolean }): Promise<ServiceModel[]> {
  return prisma.service.findMany({
    where: options.includeArchived ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/** Service ids grouped by barber, for rendering the capability matrix in one query. */
export async function listServiceBarberIds(): Promise<Map<string, string[]>> {
  const rows = await prisma.barberService.findMany({
    select: { serviceId: true, barberId: true },
  });

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const existing = grouped.get(row.serviceId);
    if (existing) existing.push(row.barberId);
    else grouped.set(row.serviceId, [row.barberId]);
  }
  return grouped;
}

export async function getService(serviceId: string): Promise<ServiceModel> {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) throw new NotFoundError('Service not found.');
  return service;
}

export function createService(input: CreateServiceRequest): Promise<ServiceModel> {
  return prisma.service.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      priceCents: input.priceCents,
      durationMinutes: input.durationMinutes,
      sortOrder: input.sortOrder,
      bookableOnline: input.bookableOnline,
      bookableWalkIn: input.bookableWalkIn,
    },
  });
}

export async function updateService(
  serviceId: string,
  input: UpdateServiceRequest,
): Promise<ServiceModel> {
  await getService(serviceId);

  // Editing the menu must never rewrite history: AppointmentService carries its own
  // copy of price, duration and name, so changing them here affects future bookings
  // only. That is a property of the schema, not something to enforce here.
  return prisma.service.update({
    where: { id: serviceId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description ?? null }),
      ...(input.category === undefined ? {} : { category: input.category ?? null }),
      ...(input.priceCents === undefined ? {} : { priceCents: input.priceCents }),
      ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      ...(input.bookableOnline === undefined ? {} : { bookableOnline: input.bookableOnline }),
      ...(input.bookableWalkIn === undefined ? {} : { bookableWalkIn: input.bookableWalkIn }),
    },
  });
}

/** How many times this service has ever been booked, across appointments and the queue. */
export async function countServiceUsage(serviceId: string): Promise<number> {
  const [appointments, queueEntries] = await Promise.all([
    prisma.appointmentService.count({ where: { serviceId } }),
    prisma.queueEntryService.count({ where: { serviceId } }),
  ]);
  return appointments + queueEntries;
}

/**
 * Deletes a service that has never been booked — the "I typed the name wrong" case.
 *
 * Anything with history is refused, because `AppointmentService` holds a foreign key
 * to it and removing the row would break past appointments and the revenue they
 * represent. Archiving is the answer there, and the error says so.
 */
export async function deleteServiceIfUnused(serviceId: string): Promise<void> {
  await getService(serviceId);

  const usage = await countServiceUsage(serviceId);
  if (usage > 0) {
    throw new ConflictError(
      `This service has been booked ${String(usage)} ${usage === 1 ? 'time' : 'times'}, so deleting it would break those records. Archive it instead — it will disappear from booking but stay on past appointments.`,
    );
  }

  // The join row has no history of its own once the service is provably unused.
  await prisma.$transaction([
    prisma.barberService.deleteMany({ where: { serviceId } }),
    prisma.service.delete({ where: { id: serviceId } }),
  ]);
}

/** Replaces the whole set for one service, rather than applying a delta. */
export async function setServiceBarbers(serviceId: string, barberIds: string[]): Promise<void> {
  await getService(serviceId);

  const unique = [...new Set(barberIds)];

  if (unique.length > 0) {
    const found = await prisma.barber.count({ where: { id: { in: unique } } });
    if (found !== unique.length) {
      throw new ValidationError('One of those barbers no longer exists.');
    }
  }

  await prisma.$transaction([
    prisma.barberService.deleteMany({ where: { serviceId } }),
    ...(unique.length === 0
      ? []
      : [
          prisma.barberService.createMany({
            data: unique.map((barberId) => ({ serviceId, barberId })),
          }),
        ]),
  ]);
}

// --- Shop settings and hours -------------------------------------------------

export async function getShopSettings() {
  const settings = await prisma.shopSettings.findUnique({ where: { id: SHOP_SETTINGS_ID } });
  if (!settings) throw new NotFoundError('Shop settings have not been set up.');
  return settings;
}

export function getShopHours() {
  return prisma.shopHours.findMany({ orderBy: [{ dayOfWeek: 'asc' }, { openMinute: 'asc' }] });
}

export async function updateShopSettings(input: UpdateShopSettingsRequest) {
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new ValidationError(`"${input.timezone}" is not a recognised timezone.`);
  }

  await getShopSettings();

  return prisma.shopSettings.update({
    where: { id: SHOP_SETTINGS_ID },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.phone === undefined ? {} : { phone: input.phone ?? null }),
      ...(input.slotGranularityMinutes === undefined
        ? {}
        : { slotGranularityMinutes: input.slotGranularityMinutes }),
      ...(input.bookingHorizonDays === undefined
        ? {}
        : { bookingHorizonDays: input.bookingHorizonDays }),
      ...(input.minimumNoticeMinutes === undefined
        ? {}
        : { minimumNoticeMinutes: input.minimumNoticeMinutes }),
      ...(input.walkInQueueEnabled === undefined
        ? {}
        : { walkInQueueEnabled: input.walkInQueueEnabled }),
      ...(input.onlineBookingEnabled === undefined
        ? {}
        : { onlineBookingEnabled: input.onlineBookingEnabled }),
    },
  });
}

/**
 * Replaces all seven days atomically.
 *
 * Delete-then-insert inside one transaction, so there is never a moment where the
 * shop has three days of hours — a partially applied week would silently make the
 * slot engine treat missing days as closed.
 */
export async function replaceShopHours(
  rows: { dayOfWeek: number; openMinute: number; closeMinute: number; isClosed: boolean }[],
): Promise<void> {
  const days = new Set(rows.map((row) => row.dayOfWeek));
  if (days.size !== 7) {
    throw new ValidationError('Send exactly one row for each day of the week.');
  }

  await prisma.$transaction([
    prisma.shopHours.deleteMany({}),
    prisma.shopHours.createMany({ data: rows }),
  ]);
}

/** Node ships the full IANA database, so this is a real check rather than a regex. */
function isValidTimezone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid;
}

// --- Closures ----------------------------------------------------------------

/**
 * Turns a local calendar date range into UTC instants.
 *
 * "Closed 2026-12-25" means from midnight at the START of that day to midnight at the
 * END of the last day, *in the shop's zone*. Doing this with `new Date('2026-12-25')`
 * would parse as UTC midnight and be several hours wrong — and wrong by a different
 * amount in summer than in winter.
 */
export async function createClosure(input: CreateClosureRequest): Promise<ShopClosureDto> {
  const { timezone } = await getShopSettings();

  const start = DateTime.fromISO(input.startDate, { zone: timezone }).startOf('day');
  // Exclusive end: the day after the last closed day, so a single-day closure covers
  // exactly 24 hours (23 or 25 across a DST boundary, which is the point of using a
  // zone-aware library).
  const end = DateTime.fromISO(input.endDate, { zone: timezone }).plus({ days: 1 }).startOf('day');

  if (!start.isValid || !end.isValid) {
    throw new ValidationError('That date could not be understood.');
  }

  const closure = await prisma.shopClosure.create({
    data: {
      startAt: start.toUTC().toJSDate(),
      endAt: end.toUTC().toJSDate(),
      reason: input.reason ?? null,
    },
  });

  return toClosureDto(closure, timezone);
}

export async function listClosures(): Promise<ShopClosureDto[]> {
  const { timezone } = await getShopSettings();
  const closures = await prisma.shopClosure.findMany({ orderBy: { startAt: 'asc' } });
  return closures.map((closure) => toClosureDto(closure, timezone));
}

export async function deleteClosure(closureId: string): Promise<void> {
  const closure = await prisma.shopClosure.findUnique({ where: { id: closureId } });
  if (!closure) throw new NotFoundError('Closure not found.');
  await prisma.shopClosure.delete({ where: { id: closureId } });
}

/** Back to local dates for display; `endAt` is exclusive, so the last closed day is the day before. */
function toClosureDto(
  closure: { id: string; startAt: Date; endAt: Date; reason: string | null },
  timezone: string,
): ShopClosureDto {
  return {
    id: closure.id,
    startDate: DateTime.fromJSDate(closure.startAt).setZone(timezone).toFormat('yyyy-MM-dd'),
    endDate: DateTime.fromJSDate(closure.endAt)
      .setZone(timezone)
      .minus({ days: 1 })
      .toFormat('yyyy-MM-dd'),
    reason: closure.reason,
  };
}
