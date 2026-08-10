/**
 * Payments contracts — Stripe Connect onboarding.
 *
 * The shop takes **direct charges on the barber's own connected account** with no
 * application fee, so nothing here describes a shop balance, a commission, or a
 * transfer. A barber is the merchant of record for their own cuts.
 *
 * Nothing here carries a Stripe secret. `stripeAccountId` is an identifier, not a
 * credential, and it is surfaced only to that barber and to an admin — never on the
 * public booking site, and never to a kiosk.
 */

import { z } from 'zod';

import { PAYMENT_METHOD, PAYMENT_STATUS } from '../enums.js';

/**
 * The four booleans Stripe reports, collapsed into the one question a screen actually
 * asks: *can this chair take money yet, and if not, whose move is it?*
 *
 * Derived on the server so the staff app and the barber view cannot disagree about
 * what `detailsSubmitted && !chargesEnabled` means.
 */
export const CONNECT_STATE = {
  /** No connected account exists yet. The button says "Set Up Payouts". */
  NOT_STARTED: 'NOT_STARTED',
  /** Account exists, onboarding not finished. The barber's move — resume the link. */
  INCOMPLETE: 'INCOMPLETE',
  /** Everything submitted, Stripe has not enabled charges yet. Nobody's move; wait. */
  PENDING: 'PENDING',
  /** `charges_enabled` — this chair can be paid. */
  READY: 'READY',
} as const;

export type ConnectState = (typeof CONNECT_STATE)[keyof typeof CONNECT_STATE];

export const connectStateSchema = z.enum(
  Object.values(CONNECT_STATE) as [ConnectState, ...ConnectState[]],
);

export const connectStatusDtoSchema = z.object({
  barberId: z.string(),
  /**
   * `acct_…`. Null until onboarding starts. An identifier rather than a secret, but it
   * still only goes to that barber and to an admin.
   */
  stripeAccountId: z.string().nullable(),
  state: connectStateSchema,
  /**
   * Gates taking payment. Mirrored from `account.updated`, never trusted from a client
   * — a browser that could set this could turn on payment collection for a chair Stripe
   * has not cleared.
   */
  chargesEnabled: z.boolean(),
  /**
   * Surfaced separately because it fails separately: a barber can be cleared to charge
   * while their payout method is still missing, and telling them "you're all set" then
   * would be a lie they discover at the end of the day.
   */
  payoutsEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  /** Instant Payout needs a debit card as external account, not merely a bank. */
  instantPayoutEligible: z.boolean(),
});
export type ConnectStatusDto = z.infer<typeof connectStatusDtoSchema>;

/**
 * The hosted onboarding link.
 *
 * Deliberately has **no request body**: `return_url` and `refresh_url` are built on the
 * server from the configured app origin. Accepting them from the client would make this
 * an open redirect wearing a Stripe URL, which is exactly the shape a phishing link wants.
 */
export const onboardingLinkDtoSchema = z.object({
  /** Single-use and short-lived — Stripe expires these in minutes. Never persist it. */
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type OnboardingLinkDto = z.infer<typeof onboardingLinkDtoSchema>;

// --- Taking payment ----------------------------------------------------------

export const paymentMethodSchema = z.enum(
  Object.values(PAYMENT_METHOD) as [string, ...string[]],
);
export const paymentStatusSchema = z.enum(
  Object.values(PAYMENT_STATUS) as [string, ...string[]],
);

/**
 * A recorded payment.
 *
 * Carries no Stripe object ids and no `stripeAccountId`. A barber's connected account
 * identifier is not a secret, but it is also not something a payment list needs, and the
 * mapper dropping it by construction is what stops it appearing in a response the day
 * someone adds a field beside it.
 */
export const paymentDtoSchema = z.object({
  id: z.string(),
  barberId: z.string(),
  /** Exactly one of these is set — a payment settles either a booking or a walk-in. */
  appointmentId: z.string().nullable(),
  queueEntryId: z.string().nullable(),
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  /** Service subtotal. Always recomputed server-side from the snapshotted line items. */
  amountCents: z.int().nonnegative(),
  tipCents: z.int().nonnegative(),
  totalCents: z.int().nonnegative(),
  currency: z.string(),
  paidAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PaymentDto = z.infer<typeof paymentDtoSchema>;

/**
 * The two kinds of thing that can be paid for. A booking and a walk-in settle
 * identically, but they are different rows and the client has to say which.
 */
export const TICKET_KIND = {
  APPOINTMENT: 'APPOINTMENT',
  WALK_IN: 'WALK_IN',
} as const;
export type TicketKind = (typeof TICKET_KIND)[keyof typeof TICKET_KIND];

/**
 * A finished cut with no payment against it yet.
 *
 * Deliberately not "every appointment today" — a screen whose job is *what still owes
 * money* must not also show what has already been settled, or the barber is left doing
 * the reconciliation the list was supposed to do.
 */
export const payableTicketDtoSchema = z.object({
  kind: z.enum(Object.values(TICKET_KIND) as [TicketKind, ...TicketKind[]]),
  /** The appointment id or the queue entry id, depending on `kind`. */
  id: z.string(),
  /** First name + last initial, matching the queue board and the calendar. */
  clientName: z.string(),
  serviceNames: z.array(z.string()),
  /** Summed from the price snapshots — the same figure the server will recompute. */
  amountCents: z.int().nonnegative(),
  /** Null while they are still in the chair. */
  finishedAt: z.iso.datetime().nullable(),
  /** `COMPLETED`, or the still-in-progress status. Drives the row's chip. */
  status: z.string(),
  /**
   * Present when a card checkout is open on this cut.
   *
   * The ticket deliberately stays on the barber's list while this is set — it is the one
   * state they may need to act on, by cancelling and taking the money another way.
   */
  pendingPayment: z
    .object({ id: z.string(), totalCents: z.int().nonnegative() })
    .nullable(),
});
export type PayableTicketDto = z.infer<typeof payableTicketDtoSchema>;

/**
 * A tip ceiling, not a fraud control.
 *
 * The realistic failure is a fat-fingered entry on a tablet — $2000 typed where $20.00
 * was meant — and a barber discovering it after the money has moved. Cash can simply be
 * re-counted; on a card it cannot, which is why the same ceiling governs both and why it
 * is declared before the schemas that reference it.
 */
export const MAX_TIP_CENTS = 50_000;

// --- Card checkout -----------------------------------------------------------


export const startCardCheckoutRequestSchema = z
  .object({
    barberId: z.string().min(1),
    appointmentId: z.string().min(1).optional(),
    queueEntryId: z.string().min(1).optional(),
  })
  .refine(
    (value) => (value.appointmentId === undefined) !== (value.queueEntryId === undefined),
    { error: 'Provide exactly one of appointmentId or queueEntryId.', path: ['appointmentId'] },
  );
export type StartCardCheckoutRequest = z.infer<typeof startCardCheckoutRequestSchema>;

/**
 * What the staff screen gets back — a URL to put in a QR code, and the payment id so the
 * same screen can cancel it. The token itself is only ever inside that URL.
 */
export const cardCheckoutDtoSchema = z.object({
  paymentId: z.string(),
  checkoutUrl: z.url(),
  amountCents: z.int().nonnegative(),
});
export type CardCheckoutDto = z.infer<typeof cardCheckoutDtoSchema>;

/**
 * What the customer holding the link is shown.
 *
 * No client name and no phone number — a payment link gets forwarded, and everything here
 * is something the payer is being asked to pay for. `publishableKey` and `stripeAccountId`
 * travel together because Stripe.js has to be initialised against the barber's own
 * account: on direct charges that account, not the platform, is the merchant.
 */
export const checkoutViewDtoSchema = z.object({
  status: paymentStatusSchema,
  barberName: z.string(),
  serviceNames: z.array(z.string()),
  amountCents: z.int().nonnegative(),
  tipCents: z.int().nonnegative(),
  totalCents: z.int().nonnegative(),
  publishableKey: z.string(),
  stripeAccountId: z.string(),
});
export type CheckoutViewDto = z.infer<typeof checkoutViewDtoSchema>;

export const createCheckoutIntentRequestSchema = z.object({
  tipCents: z.int().nonnegative().max(MAX_TIP_CENTS).default(0),
});
export type CreateCheckoutIntentRequest = z.infer<typeof createCheckoutIntentRequestSchema>;

export const checkoutIntentDtoSchema = z.object({
  /** Scoped to one PaymentIntent. Never logged, never persisted. */
  clientSecret: z.string(),
  totalCents: z.int().nonnegative(),
});
export type CheckoutIntentDto = z.infer<typeof checkoutIntentDtoSchema>;

/**
 * Recording cash.
 *
 * Note what is absent: **no amount**. The service subtotal is recomputed from the
 * `AppointmentService` / `QueueEntryService` price snapshots, because a client-supplied
 * total is the one thing that must never decide what a cut cost. The tip is the single
 * figure that genuinely originates with the customer, so it is validated rather than
 * derived.
 */
export const recordCashPaymentRequestSchema = z
  .object({
    barberId: z.string().min(1),
    appointmentId: z.string().min(1).optional(),
    queueEntryId: z.string().min(1).optional(),
    tipCents: z.int().nonnegative().max(MAX_TIP_CENTS).default(0),
  })
  .refine(
    (value) => (value.appointmentId === undefined) !== (value.queueEntryId === undefined),
    { error: 'Provide exactly one of appointmentId or queueEntryId.', path: ['appointmentId'] },
  );
export type RecordCashPaymentRequest = z.infer<typeof recordCashPaymentRequestSchema>;
