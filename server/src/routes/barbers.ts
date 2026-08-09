/**
 * Barber onboarding, weekly schedules, and time off.
 *
 * Reads of a barber's own schedule use `requireBarberSelfOrAdmin`, so a barber can
 * check their own hours without being able to see anyone else's. Every write is
 * admin-only — hours and time off are shop-controlled, which is a locked product
 * decision, not an oversight.
 */

import {
  createBarberRequestSchema,
  createScheduleExceptionRequestSchema,
  replaceBarberScheduleRequestSchema,
  ROLE,
  updateBarberRequestSchema,
  type BarberScheduleDto,
  type CreatedBarberDto,
} from '@francis/shared';
import { Router } from 'express';

import type { Role } from '../generated/prisma/enums.js';
import { pathParam } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { toBarberStaffDto } from '../mappers/catalog.js';
import { requireBarberSelfOrAdmin, requireRole } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  createScheduleException,
  deleteScheduleException,
  listBarberSchedule,
  listScheduleExceptions,
  replaceBarberSchedule,
} from '../services/schedules.js';
import { createBarber, getBarber, updateBarber } from '../services/staff.js';

export const barberRouter: Router = Router();

const adminOnly = requireRole(ROLE.ADMIN as Role);
const selfOrAdmin = requireBarberSelfOrAdmin((req) => pathParam(req, 'barberId'));

// --- Onboarding and profile --------------------------------------------------

barberRouter.post('/barbers', adminOnly, async (req, res) => {
  const input = createBarberRequestSchema.parse(req.body);
  const created = await createBarber(input);

  await recordAudit(auditContext(req), {
    action: 'barber.created',
    entityType: 'Barber',
    entityId: created.barberId,
    // Deliberately not the temporary password — an audit row is not the place for a
    // live credential, even a short-lived one.
    after: { email: created.email, displayName: created.displayName, roles: created.roles },
  });

  const body: CreatedBarberDto = {
    barberId: created.barberId,
    userId: created.userId,
    email: created.email,
    displayName: created.displayName,
    roles: created.roles,
    temporaryPassword: created.temporaryPassword,
  };

  res.status(201).json({ barber: body });
});

barberRouter.patch('/barbers/:barberId', adminOnly, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const input = updateBarberRequestSchema.parse(req.body);

  const before = await getBarber(barberId);
  await updateBarber(barberId, input);
  const after = await getBarber(barberId);

  await recordAudit(auditContext(req), {
    action: 'barber.updated',
    entityType: 'Barber',
    entityId: barberId,
    before,
    after,
  });

  const serviceIds = await listServiceIds(barberId);
  res.json({ barber: toBarberStaffDto(after, after.user, serviceIds) });
});

// --- Weekly schedule ---------------------------------------------------------

barberRouter.get('/barbers/:barberId/schedule', selfOrAdmin, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const shifts = await listBarberSchedule(barberId);

  const body: BarberScheduleDto[] = shifts.map((shift) => ({
    id: shift.id,
    dayOfWeek: shift.dayOfWeek,
    startMinute: shift.startMinute,
    endMinute: shift.endMinute,
  }));

  res.json({ shifts: body });
});

barberRouter.put('/barbers/:barberId/schedule', adminOnly, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const { shifts } = replaceBarberScheduleRequestSchema.parse(req.body);

  const before = await listBarberSchedule(barberId);
  // Throws ValidationError listing every overlapping or inverted shift.
  await replaceBarberSchedule(barberId, shifts);
  const after = await listBarberSchedule(barberId);

  await recordAudit(auditContext(req), {
    action: 'barber_schedule.replaced',
    entityType: 'BarberSchedule',
    entityId: barberId,
    before,
    after,
  });

  res.json({
    shifts: after.map((shift) => ({
      id: shift.id,
      dayOfWeek: shift.dayOfWeek,
      startMinute: shift.startMinute,
      endMinute: shift.endMinute,
    })),
  });
});

// --- Time off ----------------------------------------------------------------

barberRouter.get('/barbers/:barberId/exceptions', selfOrAdmin, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  // Anything still running counts as upcoming, so today's day off stays listed.
  const exceptions = await listScheduleExceptions(barberId, { from: new Date() });
  res.json({ exceptions });
});

barberRouter.post('/barbers/:barberId/exceptions', adminOnly, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const input = createScheduleExceptionRequestSchema.parse(req.body);

  const exception = await createScheduleException(barberId, input);

  await recordAudit(auditContext(req), {
    action: 'schedule_exception.created',
    entityType: 'ScheduleException',
    entityId: exception.id,
    after: exception,
  });

  res.status(201).json({ exception });
});

barberRouter.delete('/schedule-exceptions/:exceptionId', adminOnly, async (req, res) => {
  const exceptionId = pathParam(req, 'exceptionId');
  const { barberId } = await deleteScheduleException(exceptionId);

  await recordAudit(auditContext(req), {
    action: 'schedule_exception.deleted',
    entityType: 'ScheduleException',
    entityId: exceptionId,
    before: { barberId },
  });

  res.status(204).send();
});

/** The barber's service ids, for rebuilding the staff DTO after a profile edit. */
async function listServiceIds(barberId: string): Promise<string[]> {
  const rows = await prisma.barberService.findMany({
    where: { barberId },
    select: { serviceId: true },
  });
  return rows.map((row) => row.serviceId);
}
