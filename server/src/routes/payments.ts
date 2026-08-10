/**
 * Taking payment.
 *
 * Both routes are `requireBarberSelfOrAdmin`: a barber settles their own tickets and
 * reads their own takings, an admin may do either for anyone, and one barber can never
 * see another's day. Rent is settled off exactly these numbers.
 *
 * There is no device path. A kiosk stands unattended by the door — it may join the queue
 * and read the board, and it must never be able to record that money changed hands.
 */

import {
  recordCashPaymentRequestSchema,
  type PayableTicketDto,
  type PaymentDto,
} from '@francis/shared';
import { Router, type Request } from 'express';

import { UnauthenticatedError } from '../lib/errors.js';
import { limiter } from '../lib/rate-limit.js';
import { toPaymentDto } from '../mappers/payment.js';
import { toPayableTicketDto } from '../mappers/ticket.js';
import { requireBarberSelfOrAdmin } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  listPayableTickets,
  listPaymentsForShopDay,
  recordCashPayment,
} from '../services/payments.js';

export const paymentRouter: Router = Router();

/**
 * A tablet that resubmits in a loop would otherwise hammer the settled-payment check.
 * The check itself refuses the duplicates; this stops them being free.
 */
const recordLimit = limiter({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  message: 'Too many payment attempts. Wait a moment and try again.',
});

/**
 * The barber is read from the body here rather than the path, because a payment is
 * created rather than addressed. It is checked twice: this guard says the caller may act
 * for that barber, and the service then refuses a ticket belonging to a different one.
 */
const bodyBarberId = (req: Request): string => {
  const value: unknown = (req.body as { barberId?: unknown } | undefined)?.barberId;
  return typeof value === 'string' ? value : '';
};

paymentRouter.post(
  '/payments/cash',
  recordLimit,
  requireBarberSelfOrAdmin(bodyBarberId),
  async (req, res) => {
    if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

    const input = recordCashPaymentRequestSchema.parse(req.body);

    const payment = await recordCashPayment({
      barberId: input.barberId,
      appointmentId: input.appointmentId,
      queueEntryId: input.queueEntryId,
      tipCents: input.tipCents,
      recordedByUserId: req.auth.userId,
    });

    // Money moved. The standing rule is that every movement is recorded, and cash is the
    // one with no external system holding a second copy of the story.
    await recordAudit(auditContext(req), {
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      after: {
        barberId: payment.barberId,
        method: payment.method,
        amountCents: payment.amountCents,
        tipCents: payment.tipCents,
        totalCents: payment.totalCents,
        appointmentId: payment.appointmentId,
        queueEntryId: payment.queueEntryId,
      },
    });

    const body: PaymentDto = toPaymentDto(payment);
    res.status(201).json(body);
  },
);

/**
 * What still owes money on this chair today.
 *
 * Separate from `GET .../payments` on purpose: that one answers "what have I taken", this
 * one answers "what have I not taken yet", and a screen that had to derive the second
 * from the first would be doing the subtraction the barber came here to avoid.
 */
paymentRouter.get(
  '/barbers/:barberId/payable-tickets',
  requireBarberSelfOrAdmin((req) => String(req.params.barberId ?? '')),
  async (req, res) => {
    const barberId = String(req.params.barberId ?? '');
    // Omitted means today in the shop's timezone, resolved server-side — see shopDayRange.
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;

    const tickets = await listPayableTickets(barberId, date);
    const body: PayableTicketDto[] = tickets.map(toPayableTicketDto);

    res.json({ tickets: body });
  },
);

paymentRouter.get(
  '/barbers/:barberId/payments',
  requireBarberSelfOrAdmin((req) => String(req.params.barberId ?? '')),
  async (req, res) => {
    const barberId = String(req.params.barberId ?? '');
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;

    const payments = await listPaymentsForShopDay(barberId, date);
    const body: PaymentDto[] = payments.map(toPaymentDto);

    res.json({ payments: body });
  },
);
