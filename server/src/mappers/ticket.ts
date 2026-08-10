/**
 * Payable-ticket DTO mapper.
 *
 * The client name goes through `publicDisplayName`, matching the queue board and the
 * calendar — every staff surface in this app shows "Marcus T.", so the payment screen
 * showing a full surname would be the odd one out rather than the thorough one.
 */

import { publicDisplayName, type PayableTicketDto } from '@francis/shared';

import type { PayableTicket } from '../services/payments.js';

export function toPayableTicketDto(ticket: PayableTicket): PayableTicketDto {
  return {
    kind: ticket.kind,
    id: ticket.id,
    clientName: publicDisplayName(ticket.clientFirstName, ticket.clientLastName),
    serviceNames: ticket.serviceNames,
    amountCents: ticket.amountCents,
    finishedAt: ticket.finishedAt?.toISOString() ?? null,
    status: ticket.status,
    pendingPayment: ticket.pendingPayment,
  };
}
