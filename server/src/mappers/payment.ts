/**
 * Payment DTO mapper.
 *
 * Built by naming fields, never by spreading the row. `Payment` carries
 * `stripeAccountId`, `stripePaymentIntentId`, `stripeChargeId`, `failureReason` and
 * `recordedByUserId`, and a spread would put every one of them on the wire — including
 * the columns a future card-path change is most likely to add beside them.
 *
 * Nothing here is catastrophic to leak on its own. The point is that the mapper fails
 * closed: a new column is absent from responses until someone decides otherwise.
 */

import type { PaymentDto } from '@francis/shared';

import type { PaymentModel } from '../generated/prisma/models.js';

export function toPaymentDto(payment: PaymentModel): PaymentDto {
  return {
    id: payment.id,
    barberId: payment.barberId,
    appointmentId: payment.appointmentId,
    queueEntryId: payment.queueEntryId,
    method: payment.method,
    status: payment.status,
    amountCents: payment.amountCents,
    tipCents: payment.tipCents,
    totalCents: payment.totalCents,
    currency: payment.currency,
    paidAt: payment.paidAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
  };
}
