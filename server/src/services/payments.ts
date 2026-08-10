/**
 * Recording payment for a finished cut.
 *
 * Two methods, one set of guards. Cash is a row and nothing else — the money changed
 * hands in the shop and this records that it did. A card is a checkout link, a
 * PaymentIntent on the barber's own account, and a webhook that settles it. They diverge
 * only after `guardTicket`, which is why that lives here rather than in the routes.
 *
 * Two rules do all the work:
 *
 * - **The amount is never client-supplied.** It is summed from the price snapshots on
 *   `AppointmentService` / `QueueEntryService`, which were copied at booking time. A
 *   request that could name its own total could sell a $40 fade for $4.
 * - **One settled payment per ticket.** MySQL cannot express "unique among rows in these
 *   statuses", so it is enforced here — the same shape as the queue's one-active-entry
 *   rule, and for the same reason: a double-tap and a deliberate second charge look
 *   identical at the database.
 */

import {
  MAX_TIP_CENTS,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  TICKET_KIND,
  sumCents,
  type PaymentStatus as PaymentStatusValue,
  type TicketKind,
} from '@francis/shared';

import { DateTime } from 'luxon';

import type { AppointmentStatus, QueueStatus } from '../generated/prisma/enums.js';
import type { PaymentModel } from '../generated/prisma/models.js';
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { getShopSettings } from './catalog.js';

/**
 * Statuses that mean this ticket has already been paid for.
 *
 * A refunded payment still counts: the money moved and came back, and recording a second
 * one against the same cut would double the day's takings. Re-charging after a refund is
 * a deliberate act that should look like one, not something a second tap can do.
 *
 * `PENDING` is absent because cash never has one. The card path adds it — an unconfirmed
 * PaymentIntent must block a second attempt or a slow customer gets charged twice.
 */
const SETTLED: readonly PaymentStatusValue[] = [
  PAYMENT_STATUS.SUCCEEDED,
  PAYMENT_STATUS.PARTIALLY_REFUNDED,
  PAYMENT_STATUS.REFUNDED,
];

/**
 * Statuses that stop a *new* payment being started — `SETTLED` plus `PENDING`.
 *
 * Two sets rather than one, and the difference is deliberate. `SETTLED` answers "is this
 * cut done with", which is what removes it from the barber's list. `BLOCKING` answers
 * "may another payment begin", which has to include a card checkout nobody has completed
 * yet: otherwise a customer takes a second to find their phone and the barber, seeing the
 * ticket still listed, takes the cash as well.
 *
 * A `PENDING` row is released by `voidPayment`, never by a timer. Nothing expires on its
 * own here, so a ticket can only be freed by someone deciding to free it.
 */
const BLOCKING: readonly PaymentStatusValue[] = [...SETTLED, PAYMENT_STATUS.PENDING];

/**
 * When a ticket may be paid for.
 *
 * "Pay **after** service only" is a locked product decision — no deposits, no card on
 * file. So a `BOOKED` appointment or someone still `WAITING` in the line cannot be
 * charged: that is a deposit however it is labelled.
 *
 * It stops short of demanding `COMPLETED`, though. A barber takes the cash while the
 * client is standing up, a beat before anyone taps Complete, and refusing that would
 * teach everyone to mark cuts finished early — which quietly corrupts the queue
 * estimator, since a completed entry stops occupying the chair.
 */
const PAYABLE_APPOINTMENT_STATUSES: AppointmentStatus[] = ['IN_PROGRESS', 'COMPLETED'];
const PAYABLE_QUEUE_STATUSES: QueueStatus[] = ['IN_CHAIR', 'COMPLETED'];

export interface RecordCashPaymentInput {
  barberId: string;
  appointmentId?: string | undefined;
  queueEntryId?: string | undefined;
  tipCents: number;
  recordedByUserId: string;
}

interface ResolvedTicket {
  barberId: string;
  clientId: string;
  amountCents: number;
  /**
   * How to find other payments against this same ticket. Built in the branch that
   * already knows which kind it is, so the settled-payment check below does not have to
   * re-derive it — and cannot get it wrong for one of the two shapes.
   */
  ticketFilter: { appointmentId: string } | { queueEntryId: string };
}

/**
 * Loads whichever kind of ticket this is and reduces it to the three things a payment
 * needs, so the caller below has one shape to reason about instead of two.
 */
async function resolveTicket(input: RecordCashPaymentInput): Promise<ResolvedTicket> {
  if (input.appointmentId !== undefined) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: input.appointmentId },
      include: { services: { select: { priceCents: true } } },
    });

    if (!appointment) throw new NotFoundError('Appointment not found.');

    if (!PAYABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
      throw new ConflictError('This appointment cannot be paid for yet.');
    }

    return {
      barberId: appointment.barberId,
      clientId: appointment.clientId,
      amountCents: sumCents(appointment.services.map((service) => service.priceCents)),
      ticketFilter: { appointmentId: input.appointmentId },
    };
  }

  if (input.queueEntryId !== undefined) {
    const entry = await prisma.queueEntry.findUnique({
      where: { id: input.queueEntryId },
      include: { services: { select: { priceCents: true } } },
    });

    if (!entry) throw new NotFoundError('Queue entry not found.');

    if (!PAYABLE_QUEUE_STATUSES.includes(entry.status)) {
      throw new ConflictError('This walk-in cannot be paid for yet.');
    }

    // Unreachable in practice — `updateQueueStatus` refuses IN_CHAIR without a barber —
    // but `Payment.barberId` is non-nullable and a thrown error beats a cast.
    if (entry.barberId === null) {
      throw new ValidationError('Assign a barber before taking payment.');
    }

    return {
      barberId: entry.barberId,
      clientId: entry.clientId,
      amountCents: sumCents(entry.services.map((service) => service.priceCents)),
      ticketFilter: { queueEntryId: input.queueEntryId },
    };
  }

  // The zod schema already refuses this; belt and braces, because the service is also
  // reachable from the Vapi path later without going through that parse.
  throw new ValidationError('Provide exactly one of appointmentId or queueEntryId.');
}

/**
 * The guards both payment methods share.
 *
 * Cash and card differ only in what happens after this point, so keeping the checks in
 * one place is what stops the card path quietly growing a weaker version of them.
 */
async function guardTicket(input: {
  barberId: string;
  appointmentId?: string | undefined;
  queueEntryId?: string | undefined;
}): Promise<ResolvedTicket> {
  const ticket = await resolveTicket(input as RecordCashPaymentInput);

  /**
   * The requested barber must be the ticket's barber.
   *
   * The route already checked that the caller may act for `input.barberId`. This is the
   * other half: that the barber they are allowed to act for is the one who did the cut.
   * Without it an admin — or a barber passing their own id — could book another chair's
   * takings onto themselves, and rent is settled off exactly these numbers.
   */
  if (ticket.barberId !== input.barberId) {
    throw new ValidationError('That ticket belongs to a different barber.');
  }

  const existing = await prisma.payment.findFirst({
    where: { status: { in: [...BLOCKING] }, ...ticket.ticketFilter },
    select: { id: true, status: true },
  });

  if (existing?.status === PAYMENT_STATUS.PENDING) {
    // Named separately from "already paid" because the fix is different: the barber
    // cancels the card checkout, and only then can they take the money another way.
    throw new ConflictError('A card payment is already waiting for this cut. Cancel it first.');
  }

  if (existing) {
    throw new ConflictError('This cut has already been paid for.');
  }

  return ticket;
}

export async function recordCashPayment(input: RecordCashPaymentInput): Promise<PaymentModel> {
  const ticket = await guardTicket(input);

  const now = new Date();

  return prisma.payment.create({
    data: {
      barberId: ticket.barberId,
      clientId: ticket.clientId,
      appointmentId: input.appointmentId ?? null,
      queueEntryId: input.queueEntryId ?? null,
      method: PAYMENT_METHOD.CASH,
      // Cash has no intermediate state. It is either in the drawer or it is not.
      status: PAYMENT_STATUS.SUCCEEDED,
      amountCents: ticket.amountCents,
      tipCents: input.tipCents,
      totalCents: ticket.amountCents + input.tipCents,
      // No Stripe ids and no fee: nothing was processed, so the barber keeps all of it.
      paidAt: now,
      recordedByUserId: input.recordedByUserId,
    },
  });
}

// --- Card ---------------------------------------------------------------------------

export interface StartedCheckout {
  paymentId: string;
  /** Plaintext, returned exactly once. Only its hash is stored. */
  checkoutToken: string;
  amountCents: number;
}

/**
 * Opens a card checkout for a finished cut.
 *
 * No PaymentIntent yet, and no tip. The tip belongs to whoever is holding the card, so it
 * is chosen on the customer's own phone, and the intent is created at that point with the
 * final amount — see `createCheckoutIntent`. Creating one here instead would mean amending
 * its amount on every tip tap, which is more calls and a real race against a customer who
 * submits mid-update.
 */
export async function startCardCheckout(input: {
  barberId: string;
  appointmentId?: string | undefined;
  queueEntryId?: string | undefined;
  startedByUserId: string;
}): Promise<StartedCheckout> {
  const ticket = await guardTicket(input);

  const barber = await prisma.barber.findUnique({
    where: { id: input.barberId },
    select: { stripeAccountId: true, chargesEnabled: true },
  });

  /**
   * A chair Stripe has not cleared must not be handed a QR code.
   *
   * `chargesEnabled` is the mirror maintained by `account.updated`, and this is the gate
   * it exists for. Without it the customer scans, waits, types a card number and only
   * then discovers the account cannot take it — with the barber standing there having no
   * idea why.
   */
  if (barber?.stripeAccountId == null || !barber.chargesEnabled) {
    throw new ConflictError(
      'This chair cannot take card payments yet. Finish payout setup, or take cash.',
    );
  }

  const checkoutToken = generateToken();

  const payment = await prisma.payment.create({
    data: {
      barberId: ticket.barberId,
      clientId: ticket.clientId,
      appointmentId: input.appointmentId ?? null,
      queueEntryId: input.queueEntryId ?? null,
      method: PAYMENT_METHOD.CARD_ONLINE,
      // Pending until Stripe says otherwise. The webhook is what settles it, never the
      // browser coming back — a customer can close the tab on a successful payment.
      status: PAYMENT_STATUS.PENDING,
      amountCents: ticket.amountCents,
      tipCents: 0,
      totalCents: ticket.amountCents,
      stripeAccountId: barber.stripeAccountId,
      checkoutTokenHash: hashToken(checkoutToken),
      recordedByUserId: input.startedByUserId,
    },
  });

  return { paymentId: payment.id, checkoutToken, amountCents: payment.amountCents };
}

export interface CheckoutView {
  status: PaymentStatusValue;
  barberName: string;
  serviceNames: string[];
  amountCents: number;
  tipCents: number;
  totalCents: number;
  /** Stripe.js must be initialised against this account — the barber is the merchant. */
  stripeAccountId: string;
}

async function findByCheckoutToken(token: string) {
  const payment = await prisma.payment.findUnique({
    where: { checkoutTokenHash: hashToken(token) },
    include: {
      barber: { select: { displayName: true, stripeAccountId: true } },
      appointment: { select: { services: { select: { nameSnapshot: true } } } },
      queueEntry: { select: { services: { select: { nameSnapshot: true } } } },
    },
  });

  // The same opaque answer the cancel link gives. A wrong token reveals nothing about
  // whether a payment exists, and a spent one has had its hash cleared.
  if (!payment) throw new NotFoundError('That link is not valid.');
  return payment;
}

/**
 * What the person holding the link is shown.
 *
 * Carries no client name and no phone number — the same rule as
 * `GET /appointments/token/:token`. A payment link gets forwarded, and the only things
 * here are what the payer is being asked to pay for.
 */
export async function getCheckoutByToken(token: string): Promise<CheckoutView> {
  const payment = await findByCheckoutToken(token);

  if (payment.barber.stripeAccountId === null) {
    throw new ConflictError('This chair cannot take card payments.');
  }

  return {
    status: payment.status,
    stripeAccountId: payment.barber.stripeAccountId,
    barberName: payment.barber.displayName,
    serviceNames: (payment.appointment ?? payment.queueEntry)?.services.map(
      (service) => service.nameSnapshot,
    ) ?? [],
    amountCents: payment.amountCents,
    tipCents: payment.tipCents,
    totalCents: payment.totalCents,
  };
}

/**
 * Creates the PaymentIntent on the barber's own account, with the tip included.
 *
 * `amountCents` is re-read from the row — which came from the price snapshots — and the
 * tip is the only figure taken from the request. A client that could name its own total
 * could pay four dollars for a forty dollar fade.
 *
 * **No `application_fee_amount`.** The shop takes nothing; the barber is merchant of
 * record and their account bears Stripe's fee. That is the whole charge model.
 */
export async function createCheckoutIntent(
  token: string,
  tipCents: number,
): Promise<{ clientSecret: string; totalCents: number }> {
  if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > MAX_TIP_CENTS) {
    throw new ValidationError('That tip amount is not valid.');
  }

  const payment = await findByCheckoutToken(token);

  if (payment.status !== PAYMENT_STATUS.PENDING) {
    throw new ConflictError('This payment is no longer open.');
  }

  if (payment.stripeAccountId === null) {
    throw new ConflictError('This chair cannot take card payments.');
  }

  const totalCents = payment.amountCents + tipCents;

  /**
   * Reuses the intent if the customer changes their mind about the tip and submits again.
   *
   * Keyed on the payment, so a second submit at the same total is the same intent rather
   * than a second charge. A *different* total is a genuinely different request, hence the
   * amount in the key.
   */
  const intent = await stripe().paymentIntents.create(
    {
      amount: totalCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { paymentId: payment.id, barberId: payment.barberId },
    },
    {
      stripeAccount: payment.stripeAccountId,
      idempotencyKey: `checkout-${payment.id}-${String(totalCents)}`,
    },
  );

  if (intent.client_secret === null) {
    throw new InternalError('Stripe returned an intent with no client secret.');
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { tipCents, totalCents, stripePaymentIntentId: intent.id },
  });

  return { clientSecret: intent.client_secret, totalCents };
}

/**
 * Cancels a card checkout nobody completed, so the cut can be paid for another way.
 *
 * This is the only thing that releases a `PENDING` row — there is no expiry — which is
 * why the barber's list keeps showing it rather than hiding it. The Stripe cancel is
 * best-effort: an intent that already succeeded cannot be cancelled, and in that case the
 * webhook is about to mark the row `SUCCEEDED` anyway, so refusing here is correct.
 */
/** Whose chair a payment belongs to, for the authorization check on routes that name one. */
export async function getPaymentOwner(paymentId: string): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { barberId: true },
  });

  if (!payment) throw new NotFoundError('Payment not found.');
  return payment.barberId;
}

export async function voidPayment(paymentId: string): Promise<PaymentModel> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundError('Payment not found.');

  if (payment.status !== PAYMENT_STATUS.PENDING) {
    throw new ConflictError('Only a payment still waiting on a card can be cancelled.');
  }

  if (payment.stripePaymentIntentId !== null && payment.stripeAccountId !== null) {
    try {
      await stripe().paymentIntents.cancel(payment.stripePaymentIntentId, undefined, {
        stripeAccount: payment.stripeAccountId,
      });
    } catch (error) {
      // Already succeeded, already cancelled, or Stripe is unreachable. Logged rather
      // than thrown: leaving the row PENDING would block the ticket forever over a
      // failure that the webhook or a human can still resolve.
      logger.warn(
        { err: error, paymentId, intent: payment.stripePaymentIntentId },
        'Could not cancel PaymentIntent while voiding',
      );
    }
  }

  return prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: PAYMENT_STATUS.VOIDED,
      // A dead link must stop resolving.
      checkoutTokenHash: null,
    },
  });
}

/**
 * A barber's payments for one shop day.
 *
 * The day boundary is the shop's, not UTC's and not the caller's. Every instant is
 * stored UTC, so "Saturday's takings" is a range that has to be computed in the shop
 * timezone — and it is not a fixed 24 hours twice a year. Naive arithmetic here puts an
 * evening cut on the wrong day's total, which is the number rent is settled against.
 */

/**
 * Resolves a shop day to a UTC range.
 *
 * `localDate` is optional and omitting it means **today in the shop's timezone** — which
 * is the only sensible default and, more to the point, one the client must not compute.
 * A browser sends whatever its own machine thinks the date is; at 00:20 on a tablet left
 * on UTC that is already tomorrow, and the barber's takings vanish from a screen that
 * looks like it is working.
 */
async function shopDayRange(localDate?: string): Promise<{ from: Date; to: Date }> {
  const { timezone } = await getShopSettings();

  const dayStart =
    localDate === undefined
      ? DateTime.now().setZone(timezone).startOf('day')
      : DateTime.fromISO(localDate, { zone: timezone }).startOf('day');

  if (!dayStart.isValid) throw new ValidationError('Enter a valid date.');

  return { from: dayStart.toJSDate(), to: dayStart.plus({ days: 1 }).toJSDate() };
}

export async function listPaymentsForShopDay(
  barberId: string,
  localDate?: string,
): Promise<PaymentModel[]> {
  const { from, to } = await shopDayRange(localDate);

  return prisma.payment.findMany({
    where: { barberId, paidAt: { gte: from, lt: to } },
    orderBy: { paidAt: 'desc' },
  });
}

export interface PayableTicket {
  kind: TicketKind;
  id: string;
  clientFirstName: string;
  clientLastName: string | null;
  serviceNames: string[];
  amountCents: number;
  finishedAt: Date | null;
  status: string;
  /**
   * Set when a card checkout is open on this cut and nobody has completed it.
   *
   * The row stays on the barber's list precisely so this can be shown — it is the only
   * thing they may need to act on, by cancelling it and taking the money another way.
   */
  pendingPayment: { id: string; totalCents: number } | null;
}

/**
 * Finished cuts on this chair today that nobody has been paid for.
 *
 * The subtraction is the entire point. A list of everything finished today would leave
 * the barber comparing it against their own memory of what has been settled — which is
 * the job the screen exists to do, handed back to them. So anything already carrying a
 * settled payment is gone from the list, and a row disappearing is the confirmation that
 * the payment landed.
 *
 * Both halves of the day are here because the shop runs both: a booked appointment and a
 * walk-in are the same transaction to the person holding the notes.
 */
export async function listPayableTickets(
  barberId: string,
  localDate?: string,
): Promise<PayableTicket[]> {
  const { from, to } = await shopDayRange(localDate);

  const [appointments, entries] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        barberId,
        status: { in: PAYABLE_APPOINTMENT_STATUSES },
        startAt: { gte: from, lt: to },
      },
      include: {
        client: { select: { firstName: true, lastName: true } },
        services: { select: { priceCents: true, nameSnapshot: true } },
      },
    }),
    prisma.queueEntry.findMany({
      where: {
        barberId,
        status: { in: PAYABLE_QUEUE_STATUSES },
        joinedAt: { gte: from, lt: to },
      },
      include: {
        client: { select: { firstName: true, lastName: true } },
        services: { select: { priceCents: true, nameSnapshot: true } },
      },
    }),
  ]);

  // One query for both kinds rather than one per row: a busy Saturday is dozens of
  // tickets, and this screen is opened after every single cut.
  const relevant = await prisma.payment.findMany({
    where: {
      status: { in: [...BLOCKING] },
      OR: [
        { appointmentId: { in: appointments.map((appointment) => appointment.id) } },
        { queueEntryId: { in: entries.map((entry) => entry.id) } },
      ],
    },
    select: { id: true, status: true, totalCents: true, appointmentId: true, queueEntryId: true },
  });

  /**
   * Settled tickets leave the list; pending ones stay and get annotated.
   *
   * A card checkout the customer has not completed is the one thing the barber may need
   * to act on — cancel it and take cash — so hiding it would remove the only route to
   * fixing it. Everything else here is finished business.
   */
  const paid = new Set<string>();
  const pending = new Map<string, { id: string; totalCents: number }>();

  for (const payment of relevant) {
    const ticketId = payment.appointmentId ?? payment.queueEntryId;
    if (ticketId === null) continue;

    if (payment.status === PAYMENT_STATUS.PENDING) {
      pending.set(ticketId, { id: payment.id, totalCents: payment.totalCents });
    } else {
      paid.add(ticketId);
    }
  }

  const tickets: PayableTicket[] = [
    ...appointments.map((appointment) => ({
      kind: TICKET_KIND.APPOINTMENT,
      id: appointment.id,
      clientFirstName: appointment.client.firstName,
      clientLastName: appointment.client.lastName,
      serviceNames: appointment.services.map((service) => service.nameSnapshot),
      amountCents: sumCents(appointment.services.map((service) => service.priceCents)),
      // `Appointment` has no completedAt column, so the booked end is the best available
      // answer to "when did this finish" — and it is the one the barber will recognise.
      finishedAt: appointment.status === 'COMPLETED' ? appointment.endAt : null,
      status: appointment.status,
      pendingPayment: pending.get(appointment.id) ?? null,
    })),
    ...entries.map((entry) => ({
      kind: TICKET_KIND.WALK_IN,
      id: entry.id,
      clientFirstName: entry.client.firstName,
      clientLastName: entry.client.lastName,
      serviceNames: entry.services.map((service) => service.nameSnapshot),
      amountCents: sumCents(entry.services.map((service) => service.priceCents)),
      finishedAt: entry.completedAt,
      status: entry.status,
      pendingPayment: pending.get(entry.id) ?? null,
    })),
  ].filter((ticket) => !paid.has(ticket.id));

  /**
   * Most recently finished first, and anyone still in the chair at the very top — that
   * is the cut the barber is about to be handed money for.
   */
  return tickets.sort((a, b) => {
    if (a.finishedAt === null && b.finishedAt === null) return 0;
    if (a.finishedAt === null) return -1;
    if (b.finishedAt === null) return 1;
    return b.finishedAt.getTime() - a.finishedAt.getTime();
  });
}
