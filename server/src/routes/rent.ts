/**
 * Booth rent — what the shop is owed and what it has been paid.
 *
 * Reads are self-or-admin; **every write is admin-only**, which is the same rule the barber
 * routes follow and is more pointed here. Rent is money owed *to the shop*, so a barber
 * saying they paid is not evidence the shop received it — recording that is the person who
 * took the money, not the person who handed it over.
 *
 * A barber can see their own ledger in full, which is the other half of the same principle:
 * being able to check what you are being charged is not the same as being able to change it.
 */

import {
  ROLE,
  allocateRentPaymentRequestSchema,
  createRentChargeRequestSchema,
  recordRentPaymentRequestSchema,
  saveRentPlanRequestSchema,
  waiveRentChargeRequestSchema,
  type AllocatedRentPaymentDto,
  type RentOverviewDto,
} from '@francis/shared';
import { Router } from 'express';

import type { RentCadence, RentPaymentMethod, Role } from '../generated/prisma/enums.js';
import { UnauthenticatedError } from '../lib/errors.js';
import { pathParam } from '../lib/http.js';
import { toRentChargeDto, toRentPlanDto } from '../mappers/rent.js';
import { requireBarberSelfOrAdmin, requireRole } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  addOneOffCharge,
  allocateRentPayment,
  getActiveRentPlan,
  getRentForBarber,
  recordRentPayment,
  saveRentPlan,
  waiveRentCharge,
} from '../services/rent.js';

export const rentRouter: Router = Router();

const adminOnly = requireRole(ROLE.ADMIN as Role);
const selfOrAdmin = requireBarberSelfOrAdmin((req) => pathParam(req, 'barberId'));

/**
 * Reading brings the ledger up to date first — see `getRentForBarber`. A read with a write
 * behind it is unusual enough to be worth saying out loud, and it is what keeps rent
 * accruing without a scheduler this app does not have.
 */
rentRouter.get('/barbers/:barberId/rent', selfOrAdmin, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const overview = await getRentForBarber(barberId);

  const body: RentOverviewDto = {
    barberId: overview.barberId,
    plan: overview.plan === null ? null : toRentPlanDto(overview.plan),
    charges: overview.charges.map(toRentChargeDto),
    summary: {
      ...overview.summary,
      oldestDueDate: overview.summary.oldestDueDate,
      nextDueDate: overview.summary.nextDueDate,
    },
  };

  res.json(body);
});

rentRouter.put('/barbers/:barberId/rent-plan', adminOnly, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const input = saveRentPlanRequestSchema.parse(req.body);

  /**
   * The plan alone, NOT `getRentForBarber` — which generates charges as a side effect.
   *
   * Using it here to capture an audit snapshot raised a month of charges under the plan
   * that was about to be replaced, on the way to replacing it. A read that writes is fine
   * where it is the point; reaching for it to answer "what did this used to be" is not.
   */
  const before = await getActiveRentPlan(barberId);

  const plan = await saveRentPlan(barberId, {
    ...input,
    // Same narrowing as the payment method: the schema already proved it is one of these.
    cadence: input.cadence as RentCadence,
  });

  await recordAudit(auditContext(req), {
    action: 'rent.plan_changed',
    entityType: 'RentPlan',
    entityId: plan.id,
    before: before === null ? undefined : toRentPlanDto(before),
    after: toRentPlanDto(plan),
  });

  res.status(201).json(toRentPlanDto(plan));
});

rentRouter.post('/barbers/:barberId/rent-charges', adminOnly, async (req, res) => {
  const barberId = pathParam(req, 'barberId');
  const input = createRentChargeRequestSchema.parse(req.body);

  const charge = await addOneOffCharge(barberId, input);

  await recordAudit(auditContext(req), {
    action: 'rent.charge_created',
    entityType: 'RentCharge',
    entityId: charge.id,
    after: {
      barberId,
      amountCents: charge.amountCents,
      periodStart: input.periodStart,
      note: charge.note,
    },
  });

  res.status(201).json({ id: charge.id });
});

/**
 * A payment against the chair, spread oldest-first across what is owed.
 *
 * The one the counter actually uses: somebody hands over a sum, and this works out which
 * weeks it clears. The per-charge route below still exists for correcting a specific week.
 */
rentRouter.post('/barbers/:barberId/rent-payments', adminOnly, async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

  const barberId = pathParam(req, 'barberId');
  const input = allocateRentPaymentRequestSchema.parse(req.body);

  const allocated = await allocateRentPayment(barberId, {
    amountCents: input.amountCents,
    method: input.method as RentPaymentMethod,
    paidAt: input.paidAt,
    note: input.note,
    recordedByUserId: req.auth.userId,
  });

  await recordAudit(auditContext(req), {
    action: 'rent.payment_recorded',
    entityType: 'Barber',
    entityId: barberId,
    after: {
      amountCents: input.amountCents,
      method: input.method,
      // Which weeks it actually cleared — the whole point of allocating rather than
      // attaching, and the thing anyone will ask about later.
      allocatedTo: allocated.map((slice) => ({
        periodStart: slice.periodStart,
        amountCents: slice.amountCents,
        statusAfter: slice.statusAfter,
      })),
    },
  });

  const body: AllocatedRentPaymentDto[] = allocated;
  res.status(201).json({ allocated: body });
});

rentRouter.post('/rent-charges/:chargeId/payments', adminOnly, async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

  const chargeId = pathParam(req, 'chargeId');
  const input = recordRentPaymentRequestSchema.parse(req.body);

  const charge = await recordRentPayment(chargeId, {
    amountCents: input.amountCents,
    // Validated by the schema as one of the enum's values; this only tells the compiler so.
    method: input.method as RentPaymentMethod,
    paidAt: input.paidAt,
    note: input.note,
    recordedByUserId: req.auth.userId,
  });

  // Money the shop was handed, with no external system holding a second copy of the story.
  await recordAudit(auditContext(req), {
    action: 'rent.payment_recorded',
    entityType: 'RentCharge',
    entityId: chargeId,
    after: {
      barberId: charge.barberId,
      amountCents: input.amountCents,
      method: input.method,
      statusAfter: charge.status,
    },
  });

  res.status(201).json({ status: charge.status });
});

/**
 * Writing off money that is owed.
 *
 * The reason is required by the contract rather than optional, because "why" is the entire
 * value of this record six months later — and refused outright once anything has been paid
 * against the charge, since a partly-paid debt being made to vanish is the shape of a
 * mistake rather than a decision.
 */
rentRouter.post('/rent-charges/:chargeId/waive', adminOnly, async (req, res) => {
  const chargeId = pathParam(req, 'chargeId');
  const { note } = waiveRentChargeRequestSchema.parse(req.body);

  const charge = await waiveRentCharge(chargeId, note);

  await recordAudit(auditContext(req), {
    action: 'rent.charge_waived',
    entityType: 'RentCharge',
    entityId: chargeId,
    after: { barberId: charge.barberId, amountCents: charge.amountCents, note },
  });

  res.json({ status: charge.status });
});
