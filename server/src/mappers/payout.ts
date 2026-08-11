/**
 * Payout DTO mapper.
 *
 * Named fields rather than a spread, like every other mapper here. `Payout` carries
 * `stripePayoutId` and `initiatedByUserId`, neither of which a barber's history needs —
 * and the mapper failing closed is what keeps a column added later off the wire until
 * somebody decides otherwise.
 */

import type { PayoutDto } from '@francis/shared';

import type { PayoutModel } from '../generated/prisma/models.js';

export function toPayoutDto(payout: PayoutModel): PayoutDto {
  return {
    id: payout.id,
    type: payout.type,
    status: payout.status,
    amountCents: payout.amountCents,
    feeCents: payout.feeCents,
    currency: payout.currency,
    arrivalDate: payout.arrivalDate?.toISOString() ?? null,
    failureReason: payout.failureReason,
    createdAt: payout.createdAt.toISOString(),
  };
}
