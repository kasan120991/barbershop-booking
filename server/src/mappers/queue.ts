/**
 * Queue DTO mappers.
 *
 * There are two of these on purpose, and the difference between them is the whole
 * point. `toQueueBoardDto` feeds the staff screen; `toPublicQueueBoardDto` feeds the
 * kiosk and the wall display, which face the room.
 *
 * The public mapper is not the staff one with fields blanked out — it builds a
 * different shape from scratch, so there is nowhere for a phone number, a surname, a
 * price or a staff note to end up. Redacting by omission fails open the day someone
 * adds a field; redacting by construction cannot.
 *
 * The phone number is the one thing the staff board carries that no appointment DTO
 * does. It is there because a walk-in who has drifted to the deli has to be reachable
 * to be called, and it is the reason `/queue` is staff-only.
 */

import {
  publicDisplayName,
  type PublicQueueBoardDto,
  type QueueBoardDto,
  type QueueEntryDto,
} from '@francis/shared';

import type { QueueBoard } from '../services/queue.js';

type BoardRow = QueueBoard['entries'][number];

/** Minutes from now until the chair is ready, floored at zero — never a negative wait. */
function waitMinutes(readyAt: Date | null, from: Date): number | null {
  if (readyAt === null) return null;
  return Math.max(0, Math.round((readyAt.getTime() - from.getTime()) / 60_000));
}

function toQueueEntryDto(row: BoardRow, generatedAt: Date): QueueEntryDto {
  const { entry, assignment } = row;
  return {
    id: entry.id,
    position: assignment?.position ?? 0,
    status: entry.status,
    priority: entry.priority,

    clientId: entry.clientId,
    clientName: publicDisplayName(entry.client.firstName, entry.client.lastName),
    clientPhone: entry.client.phoneE164,

    requestedBarberId: entry.barberId,
    requestedBarberName: entry.barber?.displayName ?? null,
    assignedBarberId: assignment?.assignedBarberId ?? null,
    assignedBarberName: row.assignedBarberName,

    joinedAt: entry.joinedAt.toISOString(),
    calledAt: entry.calledAt?.toISOString() ?? null,
    startedAt: entry.startedAt?.toISOString() ?? null,
    estimatedReadyAt: assignment?.estimatedReadyAt?.toISOString() ?? null,
    estimatedWaitMinutes: waitMinutes(assignment?.estimatedReadyAt ?? null, generatedAt),
    unservableReason: assignment?.unservableReason ?? null,

    durationMinutes: entry.durationMinutes,
    priceCentsTotal: entry.priceCentsTotal,
    services: entry.services.map((service) => ({
      serviceId: service.serviceId,
      // The snapshot, not the live menu name.
      name: service.nameSnapshot,
      priceCents: service.priceCents,
      durationMinutes: service.durationMinutes,
    })),
    source: entry.source,
    notes: entry.notes,
  };
}

export function toQueueBoardDto(board: QueueBoard): QueueBoardDto {
  return {
    generatedAt: board.generatedAt.toISOString(),
    queueEnabled: board.queueEnabled,
    chairs: board.chairs.map((chair) => ({
      barberId: chair.barberId,
      displayName: chair.displayName,
      nowServingEntryId: chair.nowServingEntryId,
      freeFrom: chair.freeFrom?.toISOString() ?? null,
      waitingCount: chair.waitingCount,
    })),
    entries: board.entries.map((row) => toQueueEntryDto(row, board.generatedAt)),
  };
}

export function toPublicQueueBoardDto(board: QueueBoard): PublicQueueBoardDto {
  const nowServing = new Map(
    board.entries
      .filter((row) => row.entry.startedAt !== null)
      .map((row) => [row.entry.barberId, row.entry.client.firstName.trim()]),
  );

  return {
    generatedAt: board.generatedAt.toISOString(),
    queueEnabled: board.queueEnabled,
    /**
     * Through the same `waitMinutes` helper as every other wait on the board, so it is
     * floored at zero and rounded the same way. A screen that said "about -2 min" once
     * would be remembered longer than one that never quotes at all.
     */
    walkUp:
      board.walkUp === null
        ? null
        : {
            availableAt: board.walkUp.availableAt?.toISOString() ?? null,
            waitMinutes: waitMinutes(board.walkUp.availableAt, board.generatedAt),
          },
    chairs: board.chairs.map((chair) => ({
      barberId: chair.barberId,
      displayName: chair.displayName,
      // First name only in the headline — even an initial is more than the room needs.
      nowServing: nowServing.get(chair.barberId) ?? null,
      freeFrom: chair.freeFrom?.toISOString() ?? null,
    })),
    entries: board.entries.map((row) => ({
      id: row.entry.id,
      position: row.assignment?.position ?? 0,
      status: row.entry.status,
      displayName: publicDisplayName(row.entry.client.firstName, row.entry.client.lastName),
      barberName: row.assignedBarberName ?? row.entry.barber?.displayName ?? null,
      estimatedReadyAt: row.assignment?.estimatedReadyAt?.toISOString() ?? null,
      estimatedWaitMinutes: waitMinutes(
        row.assignment?.estimatedReadyAt ?? null,
        board.generatedAt,
      ),
    })),
  };
}
