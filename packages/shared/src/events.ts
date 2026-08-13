/**
 * The Socket.IO contract.
 *
 * This map is imported by the server emitters AND by both Nuxt apps, so renaming
 * an event or changing a payload breaks the build everywhere at once instead of
 * failing silently at runtime in the shop.
 *
 * The full event set lands with the realtime phase; this is the wiring plus the
 * connection handshake.
 */

import { z } from 'zod';

import type { PublicQueueBoardDto, QueueBoardDto } from './contracts/queue.js';

/** Fixed rooms. `shop` is staff-only; `kiosk` and `display` receive redacted payloads only. */
export const SOCKET_ROOM = {
  /** Every authenticated staff member — full payloads. */
  shop: 'shop',
  /** In-shop tablet: join queue, read the board. Redacted payloads. */
  kiosk: 'kiosk',
  /** Wall-mounted read-only board. Redacted payloads. */
  display: 'display',
} as const;

export type SocketRoom = (typeof SOCKET_ROOM)[keyof typeof SOCKET_ROOM];

/** Per-barber room, for events only that barber should receive. */
export function barberRoom(barberId: string): string {
  return `barber:${barberId}`;
}

/** What happened to an appointment. Mirrors the four mutations in `services/booking.ts`. */
export const APPOINTMENT_CHANGE = {
  CREATED: 'created',
  RESCHEDULED: 'rescheduled',
  CANCELLED: 'cancelled',
  STATUS_CHANGED: 'status_changed',
} as const;
export type AppointmentChange = (typeof APPOINTMENT_CHANGE)[keyof typeof APPOINTMENT_CHANGE];

/**
 * A calendar change, as a signal rather than a payload.
 *
 * Both fields are arrays because one move can touch two of everything: a cut going from
 * Dre's Tuesday to Rico's Thursday changes two chairs on two days, and a board showing
 * either of them has to refetch. Everything else sends one of each.
 */
export const appointmentChangedSchema = z.object({
  appointmentId: z.string(),
  action: z.enum(Object.values(APPOINTMENT_CHANGE) as [string, ...string[]]),
  /** Barbers whose day changed. TWO when a move crosses chairs. */
  barberIds: z.array(z.string()).min(1),
  /**
   * UTC instants touched. TWO when a move crosses days — the old one and the new.
   *
   * Instants, not local dates. The two mutations that do not load `ShopSettings` have no
   * timezone to convert with, and the client already holds the exact `{ from, to }` it
   * asked the range endpoint for — so both sides compare raw instants and neither does
   * timezone arithmetic.
   */
  startAts: z.array(z.iso.datetime()).min(1),
});
export type AppointmentChanged = z.infer<typeof appointmentChangedSchema>;

/** What one screen is currently showing — the range it passed to `GET /appointments`. */
export interface AppointmentView {
  /** ISO instant, inclusive. */
  from: string;
  /** ISO instant, exclusive. */
  to: string;
  /** A chair-scoped page names its barber; a shop-wide board passes null. */
  barberId?: string | null;
}

/**
 * Does this change touch what a screen is looking at?
 *
 * One implementation for three pages. Three hand-rolled copies of a boundary comparison
 * is how two screens come to disagree about one afternoon — the same argument that put
 * the day lineup in one composable.
 *
 * It lives here rather than in the staff app because it is a pure function over a payload
 * defined in this file, and `shared` is the package with a test runner: `app/` has no
 * `test` script at all. `calendar-lanes.ts` is the same shape and the same reason.
 *
 * **Half-open, `[from, to)`** — exactly what `listAppointments` does with
 * `startAt: { gte: from, lt: to }`, so midnight belongs to one day rather than to both.
 * Get that boundary wrong and a booking on the stroke of midnight refreshes yesterday.
 */
export function appointmentChangeTouches(
  change: AppointmentChanged,
  view: AppointmentView,
): boolean {
  if (view.barberId != null && !change.barberIds.includes(view.barberId)) return false;

  const from = Date.parse(view.from);
  const to = Date.parse(view.to);

  return change.startAts.some((at) => {
    const instant = Date.parse(at);
    return instant >= from && instant < to;
  });
}

export const connectionReadySchema = z.object({
  serverTime: z.iso.datetime(),
  /** Which rooms this connection was actually placed in — the client should not assume. */
  rooms: z.array(z.string()),
});

export type ConnectionReady = z.infer<typeof connectionReadySchema>;

/** Events the server broadcasts. Add new events here first, then emit them. */
export interface ServerToClientEvents {
  'connection:ready': (payload: ConnectionReady) => void;

  /**
   * The whole board, renumbered. Sent to `shop` only.
   *
   * The board rather than a delta, because moving one person renumbers everyone behind
   * them — the same reason the REST mutations return it. A delta would have the client
   * reimplementing the estimator to work out what it meant.
   */
  'queue:updated': (payload: QueueBoardDto) => void;

  /**
   * The same board, redacted, for `kiosk` and `display`.
   *
   * A separate event rather than one name carrying either shape, so the type map makes
   * it impossible to send a full board — phone numbers and all — to a screen that faces
   * the room. The mistake becomes a compile error instead of a privacy incident.
   */
  'queue:public': (payload: PublicQueueBoardDto) => void;

  /**
   * Something moved on the calendar. Sent to `shop` only.
   *
   * **A signal, not a payload** — unlike `queue:updated`, which ships the whole board.
   * That difference is not an inconsistency: the queue is one board every staff screen
   * shows identically, while appointments are read over three different ranges (the
   * calendar's day across all chairs, My Day's day or week for one chair, Today's single
   * day). No pushed shape can serve all three, so each refetches the range it actually
   * holds — which is also `useCatalog`'s standing rule that a refetch cannot disagree
   * with the server.
   *
   * **Not sent to `kiosk` or `display`.** Those screens show the queue, which already
   * updates itself, and an appointment event would tell them about chairs and times they
   * have no use for. The room stays the privacy boundary.
   */
  'appointment:changed': (payload: AppointmentChanged) => void;
}

/**
 * Intentionally empty, and it must stay that way.
 *
 * Sockets are broadcast-only: every mutation goes over authenticated REST and the
 * server emits afterward. Accepting a write here would mean re-implementing auth,
 * validation, and audit logging in a second place — which will drift from the first.
 */
export type ClientToServerEvents = Record<never, never>;
