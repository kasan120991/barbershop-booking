/**
 * The service menu, the barber roster, and the shop's own hours.
 *
 * The GET routes are deliberately **public**: the booking site and the kiosk both
 * need the menu and the roster before anyone has signed in to anything. They return
 * the public DTO by default and upgrade to the staff DTO for a signed-in user, which
 * is precisely why `toBarberPublicDto` and `toBarberStaffDto` were split apart back
 * in Phase 2 rather than one DTO with optional fields.
 *
 * Every write is admin-only, and audited.
 */

import {
  createClosureRequestSchema,
  createServiceRequestSchema,
  replaceShopHoursRequestSchema,
  ROLE,
  setServiceBarbersRequestSchema,
  updateServiceRequestSchema,
  updateShopSettingsRequestSchema,
  type BarberPublicDto,
  type BarberStaffDto,
  type ServiceDto,
} from '@francis/shared';
import { Router } from 'express';

import type { Role } from '../generated/prisma/enums.js';
import { pathParam } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import {
  toBarberPublicDto,
  toBarberStaffDto,
  toServiceDto,
  toShopSettingsDto,
} from '../mappers/catalog.js';
import { requireRole } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  countServiceUsage,
  createClosure,
  createService,
  deleteClosure,
  deleteServiceIfUnused,
  getService,
  getShopHours,
  getShopSettings,
  listClosures,
  listServiceBarberIds,
  listServices,
  replaceShopHours,
  setServiceBarbers,
  updateService,
  updateShopSettings,
} from '../services/catalog.js';

export const catalogRouter: Router = Router();

const adminOnly = requireRole(ROLE.ADMIN as Role);

// --- Services ----------------------------------------------------------------

/**
 * Staff see everything including archived services and the `usageCount` that decides
 * whether Delete is offered. The public sees active services only.
 */
catalogRouter.get('/services', async (req, res) => {
  const isStaff = req.auth?.kind === 'user';
  const services = await listServices({ includeArchived: isStaff });
  const barbersByService = await listServiceBarberIds();

  const body = services.map((service) => ({
    ...toServiceDto(service),
    barberIds: barbersByService.get(service.id) ?? [],
  }));

  res.json({ services: body satisfies (ServiceDto & { barberIds: string[] })[] });
});

catalogRouter.post('/services', adminOnly, async (req, res) => {
  const input = createServiceRequestSchema.parse(req.body);
  const service = await createService(input);

  await recordAudit(auditContext(req), {
    action: 'service.created',
    entityType: 'Service',
    entityId: service.id,
    after: service,
  });

  res.status(201).json({ service: toServiceDto(service) });
});

catalogRouter.patch('/services/:serviceId', adminOnly, async (req, res) => {
  const serviceId = pathParam(req, 'serviceId');
  const input = updateServiceRequestSchema.parse(req.body);

  const before = await getService(serviceId);
  const after = await updateService(serviceId, input);

  // Archiving reads differently from an edit in the log, and it is the change most
  // likely to prompt "who took this off the menu?".
  const action =
    before.isActive && after.isActive === false
      ? 'service.archived'
      : !before.isActive && after.isActive
        ? 'service.restored'
        : 'service.updated';

  await recordAudit(auditContext(req), {
    action,
    entityType: 'Service',
    entityId: serviceId,
    before,
    after,
  });

  res.json({ service: toServiceDto(after) });
});

catalogRouter.delete('/services/:serviceId', adminOnly, async (req, res) => {
  const serviceId = pathParam(req, 'serviceId');
  const before = await getService(serviceId);

  // Throws ConflictError with an explanation when the service has history.
  await deleteServiceIfUnused(serviceId);

  await recordAudit(auditContext(req), {
    action: 'service.deleted',
    entityType: 'Service',
    entityId: serviceId,
    before,
  });

  res.status(204).send();
});

catalogRouter.put('/services/:serviceId/barbers', adminOnly, async (req, res) => {
  const serviceId = pathParam(req, 'serviceId');
  const { barberIds } = setServiceBarbersRequestSchema.parse(req.body);

  await setServiceBarbers(serviceId, barberIds);

  await recordAudit(auditContext(req), {
    action: 'service.barbers_changed',
    entityType: 'Service',
    entityId: serviceId,
    after: { barberIds },
  });

  res.status(204).send();
});

// --- Barbers -----------------------------------------------------------------

catalogRouter.get('/barbers', async (req, res) => {
  const isStaff = req.auth?.kind === 'user';

  const barbers = await prisma.barber.findMany({
    where: isStaff ? {} : { status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    include: {
      services: { select: { serviceId: true } },
      user: { select: { email: true, firstName: true, lastName: true } },
    },
  });

  const body = barbers.map((barber) => {
    const serviceIds = barber.services.map((row) => row.serviceId);
    return isStaff
      ? (toBarberStaffDto(barber, barber.user, serviceIds) satisfies BarberStaffDto)
      : (toBarberPublicDto(barber, serviceIds) satisfies BarberPublicDto);
  });

  res.json({ barbers: body });
});

// --- Shop settings and hours -------------------------------------------------

catalogRouter.get('/shop-settings', async (_req, res) => {
  const [settings, hours] = await Promise.all([getShopSettings(), getShopHours()]);
  res.json({ settings: toShopSettingsDto(settings, hours) });
});

catalogRouter.patch('/shop-settings', adminOnly, async (req, res) => {
  const input = updateShopSettingsRequestSchema.parse(req.body);

  const before = await getShopSettings();
  const after = await updateShopSettings(input);
  const hours = await getShopHours();

  await recordAudit(auditContext(req), {
    action: 'shop_settings.updated',
    entityType: 'ShopSettings',
    entityId: String(after.id),
    before,
    after,
  });

  res.json({ settings: toShopSettingsDto(after, hours) });
});

catalogRouter.put('/shop-hours', adminOnly, async (req, res) => {
  const { hours } = replaceShopHoursRequestSchema.parse(req.body);

  const before = await getShopHours();
  await replaceShopHours(hours);
  const [settings, after] = await Promise.all([getShopSettings(), getShopHours()]);

  await recordAudit(auditContext(req), {
    action: 'shop_hours.replaced',
    entityType: 'ShopHours',
    entityId: 'week',
    before,
    after,
  });

  res.json({ settings: toShopSettingsDto(settings, after) });
});

// --- Closures ----------------------------------------------------------------

catalogRouter.get('/shop-closures', adminOnly, async (_req, res) => {
  res.json({ closures: await listClosures() });
});

catalogRouter.post('/shop-closures', adminOnly, async (req, res) => {
  const input = createClosureRequestSchema.parse(req.body);
  const closure = await createClosure(input);

  await recordAudit(auditContext(req), {
    action: 'shop_closure.created',
    entityType: 'ShopClosure',
    entityId: closure.id,
    after: closure,
  });

  res.status(201).json({ closure });
});

catalogRouter.delete('/shop-closures/:closureId', adminOnly, async (req, res) => {
  const closureId = pathParam(req, 'closureId');
  await deleteClosure(closureId);

  await recordAudit(auditContext(req), {
    action: 'shop_closure.deleted',
    entityType: 'ShopClosure',
    entityId: closureId,
  });

  res.status(204).send();
});

// --- Usage check, for the delete affordance ----------------------------------

/** Lets the UI hide Delete on a service that has history, rather than offering a 409. */
catalogRouter.get('/services/:serviceId/usage', adminOnly, async (req, res) => {
  const serviceId = pathParam(req, 'serviceId');
  await getService(serviceId);
  res.json({ usageCount: await countServiceUsage(serviceId) });
});
