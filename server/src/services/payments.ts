/**
 * Recording payment for a finished cut.
 *
 * Cash first, and cash is genuinely simple: it is a row. No Stripe object, no connected
 * account, nothing to reconcile — the money changed hands in the shop and this records
 * that it did. The card path lands next and shares every guard below, which is most of
 * why they live here rather than in the route.
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
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  sumCents,
  type PaymentStatus as PaymentStatusValue,
} from '@francis/shared';

import { DateTime } from 'luxon';

import type { PaymentModel } from '../generated/prisma/models.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
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
const PAYABLE_APPOINTMENT_STATUSES = ['IN_PROGRESS', 'COMPLETED'];
const PAYABLE_QUEUE_STATUSES = ['IN_CHAIR', 'COMPLETED'];

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

export async function recordCashPayment(input: RecordCashPaymentInput): Promise<PaymentModel> {
  const ticket = await resolveTicket(input);

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

  const alreadyPaid = await prisma.payment.findFirst({
    where: { status: { in: [...SETTLED] }, ...ticket.ticketFilter },
    select: { id: true },
  });

  if (alreadyPaid) {
    throw new ConflictError('This cut has already been paid for.');
  }

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

/**
 * A barber's payments for one shop day.
 *
 * The day boundary is the shop's, not UTC's and not the caller's. Every instant is
 * stored UTC, so "Saturday's takings" is a range that has to be computed in the shop
 * timezone — and it is not a fixed 24 hours twice a year. Naive arithmetic here puts an
 * evening cut on the wrong day's total, which is the number rent is settled against.
 */
export async function listPaymentsForShopDay(
  barberId: string,
  localDate: string,
): Promise<PaymentModel[]> {
  const { timezone } = await getShopSettings();

  const dayStart = DateTime.fromISO(localDate, { zone: timezone }).startOf('day');
  if (!dayStart.isValid) throw new ValidationError('Enter a valid date.');

  return prisma.payment.findMany({
    where: {
      barberId,
      paidAt: { gte: dayStart.toJSDate(), lt: dayStart.plus({ days: 1 }).toJSDate() },
    },
    orderBy: { paidAt: 'desc' },
  });
}
