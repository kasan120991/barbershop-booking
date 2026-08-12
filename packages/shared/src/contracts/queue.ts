/**
 * The walk-in queue contract.
 *
 * Two things are load-bearing here and neither is obvious from the field lists.
 *
 * **There is no `position` in the join request, and no way to set one anywhere.**
 * Order is derived from `(priority DESC, joinedAt ASC)` and computed on read. A
 * position that a client could send — or that the server could store — is a number
 * two requests can disagree about.
 *
 * **The staff shape and the public shape are separate schemas, not one schema with
 * optional fields.** `publicQueueEntryDto` has nowhere to put a phone number, so the
 * kiosk and the wall display cannot render one even by accident. That screen faces
 * the whole shop.
 */

import { z } from 'zod';

import { APPOINTMENT_SOURCE, QUEUE_STATUS } from '../enums.js';

const queueStatus = z.enum(Object.values(QUEUE_STATUS) as [string, ...string[]]);

/** Snapshotted at join time — editing the menu later must not rewrite a waiting client's price. */
export const queueServiceDtoSchema = z.object({
  serviceId: z.string(),
  name: z.string(),
  priceCents: z.int(),
  durationMinutes: z.int(),
});
export type QueueServiceDto = z.infer<typeof queueServiceDtoSchema>;

// --- Joining -----------------------------------------------------------------

export const joinQueueRequestSchema = z.object({
  phone: z.string().min(1, { error: 'Enter a phone number.' }),
  firstName: z.string().trim().min(1, { error: 'Enter a first name.' }).max(60),
  lastName: z.string().trim().max(60).nullish(),
  /** Null or absent means "anyone" — the estimator sends them to whoever frees up first. */
  barberId: z.string().min(1).nullish(),
  serviceIds: z.array(z.string().min(1)).min(1, { error: 'Choose at least one service.' }),
  notes: z.string().trim().max(500).nullish(),
});
export type JoinQueueRequest = z.infer<typeof joinQueueRequestSchema>;

// --- Staff view --------------------------------------------------------------

export const queueEntryDtoSchema = z.object({
  id: z.string(),
  /** 1-based, derived on read. Only meaningful for entries still in the line. */
  position: z.int(),
  status: queueStatus,
  priority: z.int(),

  clientId: z.string(),
  clientName: z.string(),
  clientPhone: z.string(),

  /** What the client asked for. Null means they did not mind. */
  requestedBarberId: z.string().nullable(),
  requestedBarberName: z.string().nullable(),
  /**
   * Which chair the estimator actually put them in. For a client who asked for
   * someone specific these match; for "anyone" this is a projection that can move as
   * the board changes, which is why it is a separate field rather than a mutation.
   */
  assignedBarberId: z.string().nullable(),
  assignedBarberName: z.string().nullable(),

  joinedAt: z.iso.datetime(),
  calledAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  /** When the chair is expected to be ready for them — the seat time, not the finish time. */
  estimatedReadyAt: z.iso.datetime().nullable(),
  estimatedWaitMinutes: z.int().nullable(),
  /** Set when no chair can fit them before closing, so the board can say so. */
  unservableReason: z.string().nullable(),

  durationMinutes: z.int(),
  priceCentsTotal: z.int(),
  services: z.array(queueServiceDtoSchema),
  source: z.enum(Object.values(APPOINTMENT_SOURCE) as [string, ...string[]]),
  notes: z.string().nullable(),
});
export type QueueEntryDto = z.infer<typeof queueEntryDtoSchema>;

export const queueChairDtoSchema = z.object({
  barberId: z.string(),
  displayName: z.string(),
  /** The entry currently in this chair, if any. */
  nowServingEntryId: z.string().nullable(),
  /** When this barber next has time, or null if they are done for the day. */
  freeFrom: z.iso.datetime().nullable(),
  waitingCount: z.int(),
});
export type QueueChairDto = z.infer<typeof queueChairDtoSchema>;

export const queueBoardDtoSchema = z.object({
  generatedAt: z.iso.datetime(),
  /** Mirrors `ShopSettings.walkInQueueEnabled` — the board still renders when off. */
  queueEnabled: z.boolean(),
  chairs: z.array(queueChairDtoSchema),
  entries: z.array(queueEntryDtoSchema),
});
export type QueueBoardDto = z.infer<typeof queueBoardDtoSchema>;

// --- Kiosk and wall display --------------------------------------------------

export const publicQueueEntryDtoSchema = z.object({
  id: z.string(),
  position: z.int(),
  status: queueStatus,
  /** "Darnell W." — enough to recognise your own name, not someone else's. */
  displayName: z.string(),
  barberName: z.string().nullable(),
  estimatedReadyAt: z.iso.datetime().nullable(),
  estimatedWaitMinutes: z.int().nullable(),
});
export type PublicQueueEntryDto = z.infer<typeof publicQueueEntryDtoSchema>;

export const publicQueueBoardDtoSchema = z.object({
  generatedAt: z.iso.datetime(),
  queueEnabled: z.boolean(),
  /**
   * The next opening for somebody walking in right now — the kiosk's headline figure.
   *
   * Measured AFTER the waiting line is allocated, which is what separates it from
   * `chairs[].freeFrom` above: that one is taken before, and means "is this barber
   * available". Neither is a substitute for the other and the kiosk needs this one, or a
   * front door reads *free now* with four people sitting in the waiting area.
   *
   * Public shape only. The staff board has the real line and can read it directly.
   *
   * Null when the shop has no walk-in menu to measure against, or no chair can perform the
   * service measured. `waitMinutes` is null within that when nothing fits before closing.
   */
  walkUp: z
    .object({
      availableAt: z.iso.datetime().nullable(),
      waitMinutes: z.int().nullable(),
    })
    .nullable(),
  chairs: z.array(
    z.object({
      barberId: z.string(),
      displayName: z.string(),
      nowServing: z.string().nullable(),
      /**
       * Whoever has been called up to this chair and has not sat down yet.
       *
       * Separate from `nowServing` because they are a different fact: one is a cut
       * happening, the other is a person being summoned across a room. The wall board
       * names them under the barber they are walking to, which is the one thing a called
       * customer needs and the board could not previously say — `nowServing` covers only
       * somebody already seated, and the entry rows carry a barber's NAME rather than an
       * id, so the screen had nothing reliable to match a chair on.
       *
       * First name only, like everything else that faces the room.
       */
      calledUp: z.string().nullable(),
      freeFrom: z.iso.datetime().nullable(),
    }),
  ),
  entries: z.array(publicQueueEntryDtoSchema),
});
export type PublicQueueBoardDto = z.infer<typeof publicQueueBoardDtoSchema>;

// --- The kiosk's quote ---------------------------------------------------------

/**
 * A third shape, and deliberately not a fourth field on the public board.
 *
 * The board is one payload broadcast to every screen. This is an answer to one tablet's
 * current selection — it changes with every tap, no other screen shares it, and the
 * broadcast cannot see it, because `ClientToServerEvents` is empty on purpose.
 *
 * It carries ids and instants and nothing else: no names, no prices, no entries. There is
 * nowhere in this shape for anything about a person to end up.
 */

export const walkInQuoteQuerySchema = z.object({
  serviceIds: z
    .array(z.string().min(1))
    .min(1, { error: 'Choose at least one service.' }),
});
export type WalkInQuoteQuery = z.infer<typeof walkInQuoteQuerySchema>;

/** `availableAt` null means nothing that long is left today; `waitMinutes` follows it. */
export const walkInOpeningDtoSchema = z.object({
  availableAt: z.iso.datetime().nullable(),
  waitMinutes: z.int().nullable(),
});
export type WalkInOpeningDto = z.infer<typeof walkInOpeningDtoSchema>;

export const walkInQuoteDtoSchema = z.object({
  generatedAt: z.iso.datetime(),
  /**
   * Echoed back from the Service rows the answer was computed from.
   *
   * The kiosk fires a fresh quote on every tap, so two can be in flight for two different
   * baskets at once. This is how it tells the answer it is holding from the one it asked
   * for, and refuses to print a 30-minute figure under a 45-minute basket.
   */
  serviceIds: z.array(z.string()),
  /** Summed server-side from those rows, never taken from the request. */
  durationMinutes: z.int(),
  /**
   * The best of `barbers` — what the "Anyone" button is quoted.
   *
   * Null exactly when `barbers` is empty: nobody working today does the whole set, which
   * is a different answer from "no opening left" and reads differently on the glass.
   */
  soonest: walkInOpeningDtoSchema.nullable(),
  /**
   * One row per barber who can perform every service asked for, in the roster's order.
   *
   * A barber with nothing long enough left today is present with a null `availableAt`
   * rather than dropped — "this barber, not today" is an answer, and an absent row is
   * indistinguishable from a barber who does not do the work at all.
   */
  barbers: z.array(walkInOpeningDtoSchema.extend({ barberId: z.string() })),
});
export type WalkInQuoteDto = z.infer<typeof walkInQuoteDtoSchema>;

// --- Staff actions -----------------------------------------------------------

export const updateQueueStatusRequestSchema = z.object({
  status: queueStatus,
});
export type UpdateQueueStatusRequest = z.infer<typeof updateQueueStatusRequestSchema>;

/**
 * Higher wins. Bounded because it is a nudge, not an ordering scheme — an unbounded
 * integer invites someone to encode a whole hand-made order into it, which is the
 * stored-position problem wearing a different hat.
 */
export const setQueuePriorityRequestSchema = z.object({
  priority: z.int().min(0).max(10),
});
export type SetQueuePriorityRequest = z.infer<typeof setQueuePriorityRequestSchema>;

export const assignQueueBarberRequestSchema = z.object({
  /** Null hands them back to "anyone". */
  barberId: z.string().min(1).nullable(),
});
export type AssignQueueBarberRequest = z.infer<typeof assignQueueBarberRequestSchema>;

export const callNextRequestSchema = z.object({
  barberId: z.string().min(1),
});
export type CallNextRequest = z.infer<typeof callNextRequestSchema>;
