/**
 * Taking payment.
 *
 * Two audiences, split by authentication. The staff routes are `requireBarberSelfOrAdmin`:
 * a barber settles their own tickets and reads their own takings, an admin may do either
 * for anyone, and one barber can never see another's day. Rent is settled off exactly
 * these numbers.
 *
 * The two `/payments/checkout/:token` routes are unauthenticated, because the person
 * paying has no account here — the token is the credential, exactly as it is on the
 * cancel link.
 *
 * There is no device path anywhere in this file. A kiosk stands unattended by the door —
 * it may join the queue and read the board, and it must never be able to record that
 * money changed hands.
 */

import {
  createCheckoutIntentRequestSchema,
  recordCashPaymentRequestSchema,
  startCardCheckoutRequestSchema,
  type CardCheckoutDto,
  type CheckoutIntentDto,
  type CheckoutViewDto,
  type PayableTicketDto,
  type PaymentDto,
} from '@francis/shared';
import { Router, type Request } from 'express';

import { env } from '../config/env.js';
import { InternalError, UnauthenticatedError } from '../lib/errors.js';
import { pathParam } from '../lib/http.js';
import { limiter } from '../lib/rate-limit.js';
import { toPaymentDto } from '../mappers/payment.js';
import { toPayableTicketDto } from '../mappers/ticket.js';
import {
  assertBarberSelfOrAdmin,
  requireBarberSelfOrAdmin,
  requireUser,
} from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  createCheckoutIntent,
  getCheckoutByToken,
  getPaymentOwner,
  listPayableTickets,
  listPaymentsForShopDay,
  recordCashPayment,
  startCardCheckout,
  voidPayment,
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
 * Opens a card checkout and hands back the URL the staff screen turns into a QR code.
 *
 * `POST` because it has side effects — it creates the pending payment that blocks the
 * ticket. The URL is built here from `env.BOOKING_ORIGIN` and never from anything the
 * client sent, the same rule the Connect onboarding links follow.
 */
paymentRouter.post(
  '/payments/card-checkout',
  recordLimit,
  requireBarberSelfOrAdmin(bodyBarberId),
  async (req, res) => {
    if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

    const input = startCardCheckoutRequestSchema.parse(req.body);

    const started = await startCardCheckout({
      barberId: input.barberId,
      appointmentId: input.appointmentId,
      queueEntryId: input.queueEntryId,
      startedByUserId: req.auth.userId,
    });

    await recordAudit(auditContext(req), {
      action: 'payment.checkout_started',
      entityType: 'Payment',
      entityId: started.paymentId,
      // Never the token. It is a live bearer credential for as long as the payment is
      // open, and the audit trail is not a place to keep one.
      after: {
        barberId: input.barberId,
        amountCents: started.amountCents,
        appointmentId: input.appointmentId ?? null,
        queueEntryId: input.queueEntryId ?? null,
      },
    });

    const body: CardCheckoutDto = {
      paymentId: started.paymentId,
      checkoutUrl: `${env.BOOKING_ORIGIN}/pay/${started.checkoutToken}`,
      amountCents: started.amountCents,
    };

    res.status(201).json(body);
  },
);

/**
 * Cancels a card checkout nobody completed, freeing the cut to be paid another way.
 *
 * The guard resolves the barber from the payment rather than the body — the caller is
 * naming a payment, and letting them also name whose it is would make the check circular.
 */
paymentRouter.post(
  '/payments/:paymentId/void',
  recordLimit,
  requireUser,
  async (req, res) => {
    const paymentId = pathParam(req, 'paymentId');

    // Whose chair this is, before deciding whether the caller may touch it.
    assertBarberSelfOrAdmin(req, await getPaymentOwner(paymentId));

    const payment = await voidPayment(paymentId);

    await recordAudit(auditContext(req), {
      action: 'payment.voided',
      entityType: 'Payment',
      entityId: paymentId,
      after: { barberId: payment.barberId, amountCents: payment.amountCents },
    });

    const body: PaymentDto = toPaymentDto(payment);
    res.json(body);
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

/**
 * The customer's half. Both routes are **unauthenticated** — the token is the credential,
 * exactly like the cancel link, and the person holding it has no account here.
 *
 * Rate-limited by IP because they are the only public write path in this file. Guessing a
 * 256-bit token is not the threat; hammering the endpoint is.
 */
const checkoutLimit = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: 'Too many attempts. Wait a moment and try again.',
});

paymentRouter.get('/payments/checkout/:token', checkoutLimit, async (req, res) => {
  const view = await getCheckoutByToken(pathParam(req, 'token'));

  if (env.STRIPE_PUBLISHABLE_KEY === undefined) {
    throw new InternalError('STRIPE_PUBLISHABLE_KEY is not set — checkout cannot render.');
  }

  const body: CheckoutViewDto = {
    ...view,
    // Travels with the account it must be initialised against: on a direct charge the
    // barber's account is the merchant, so Stripe.js has to be pointed at it.
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    stripeAccountId: view.stripeAccountId,
  };

  res.json(body);
});

paymentRouter.post('/payments/checkout/:token/intent', checkoutLimit, async (req, res) => {
  const { tipCents } = createCheckoutIntentRequestSchema.parse(req.body);

  const intent = await createCheckoutIntent(pathParam(req, 'token'), tipCents);

  const body: CheckoutIntentDto = intent;
  res.status(201).json(body);
});

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
