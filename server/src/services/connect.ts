/**
 * Stripe Connect onboarding for a barber's own account.
 *
 * The shop runs **direct charges with no application fee**: the barber is merchant of
 * record, their account bears Stripe's fee, and card money never lands in a shop
 * balance. So nothing in this module transfers, splits, or holds funds — it only gets a
 * barber onboarded far enough that Stripe will let their chair be paid.
 *
 * The four capability booleans on `Barber` are a **mirror, never a source**. Stripe owns
 * that truth; we copy it on the way back from onboarding and (from the next slice) on
 * `account.updated`. Nothing here ever accepts them from a client — a browser that could
 * set `chargesEnabled` could switch on payment collection for a chair Stripe has not
 * cleared, which is the one thing this gate exists to prevent.
 */

import { CONNECT_STATE, type ConnectState } from '@francis/shared';
import type Stripe from 'stripe';

import { NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';

/**
 * Barber shops and beauty salons. Set at creation so the barber is not asked to
 * classify their own business in the middle of onboarding.
 */
const BARBER_MCC = '7230';

/** Single location, USD only — see the locked product decisions. */
const ACCOUNT_COUNTRY = 'US';

export interface ConnectStatus {
  barberId: string;
  stripeAccountId: string | null;
  state: ConnectState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  instantPayoutEligible: boolean;
}

interface CapabilityMirror {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  instantPayoutEligible: boolean;
}

/**
 * Collapses the mirror into the single question a screen asks.
 *
 * `chargesEnabled` wins outright: once Stripe will take money for this chair, no
 * outstanding paperwork changes what the barber can do today. `payoutsEnabled` is
 * deliberately *not* part of this — it fails separately and is surfaced separately,
 * because "you're all set" to someone whose payout method is missing is a lie they
 * find out about at the end of the day.
 */
export function deriveConnectState(
  stripeAccountId: string | null,
  mirror: Pick<CapabilityMirror, 'chargesEnabled' | 'detailsSubmitted'>,
): ConnectState {
  if (stripeAccountId === null) return CONNECT_STATE.NOT_STARTED;
  if (mirror.chargesEnabled) return CONNECT_STATE.READY;
  if (mirror.detailsSubmitted) return CONNECT_STATE.PENDING;
  return CONNECT_STATE.INCOMPLETE;
}

async function getBarberOrThrow(barberId: string) {
  const barber = await prisma.barber.findUnique({
    where: { id: barberId },
    include: { user: { select: { email: true, firstName: true, lastName: true } } },
  });

  if (!barber) throw new NotFoundError('Barber not found.');
  return barber;
}

function toStatus(barber: {
  id: string;
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  instantPayoutEligible: boolean;
}): ConnectStatus {
  return {
    barberId: barber.id,
    stripeAccountId: barber.stripeAccountId,
    state: deriveConnectState(barber.stripeAccountId, barber),
    chargesEnabled: barber.chargesEnabled,
    payoutsEnabled: barber.payoutsEnabled,
    detailsSubmitted: barber.detailsSubmitted,
    instantPayoutEligible: barber.instantPayoutEligible,
  };
}

/** Reads the mirror. Never calls Stripe — this is the one every page load uses. */
export async function getConnectStatus(barberId: string): Promise<ConnectStatus> {
  return toStatus(await getBarberOrThrow(barberId));
}

/**
 * Instant Payout needs a **debit card** as an external account, not merely a bank.
 * Always show the exact fee before confirming one — a bank-only barber who is told
 * "instant available" finds out it is not at the moment they need the money.
 */
function hasDebitCardExternalAccount(account: Stripe.Account): boolean {
  return (account.external_accounts?.data ?? []).some((external) => external.object === 'card');
}

/**
 * Exported because the webhook has the account object already. `account.updated` carries
 * the full `Stripe.Account`, so re-fetching it to learn what Stripe just told us would be
 * a second API call that can also disagree with the payload that triggered it.
 */
export function mirrorOf(account: Stripe.Account): CapabilityMirror {
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    instantPayoutEligible: hasDebitCardExternalAccount(account),
  };
}

/**
 * Creates the connected account if this barber has none, and returns its id.
 *
 * **The idempotency key is the race guard.** Two taps on "Set Up Payouts" — or a
 * double-submitting tablet — would otherwise create two Express accounts, and the
 * second would silently become the one we store while the first is orphaned at Stripe
 * with no row pointing at it. Keying on the barber makes both calls return the same
 * account. The `stripeAccountId: null` guard on the write is the second half: whoever
 * loses the write has, by then, been handed the identical id anyway.
 */
export async function ensureConnectedAccount(barberId: string): Promise<string> {
  const barber = await getBarberOrThrow(barberId);
  if (barber.stripeAccountId !== null) return barber.stripeAccountId;

  const account = await stripe().accounts.create(
    {
      type: 'express',
      country: ACCOUNT_COUNTRY,
      email: barber.user.email,
      // Requested rather than assumed — Stripe decides when they are actually granted,
      // and `chargesEnabled` is how we learn the answer.
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        mcc: BARBER_MCC,
        name: barber.displayName,
      },
      // Daily automatic payout at creation, per the locked decision. The manual Instant
      // Payout button in the next slice is an addition to this, not a replacement.
      settings: { payouts: { schedule: { interval: 'daily' } } },
      // The only durable link from a Stripe object back to a row here. Webhooks arrive
      // with `event.account` and this is what makes that id resolvable.
      metadata: { barberId },
    },
    { idempotencyKey: `connect-account-${barberId}` },
  );

  const claimed = await prisma.barber.updateMany({
    where: { id: barberId, stripeAccountId: null },
    data: { stripeAccountId: account.id, ...mirrorOf(account) },
  });

  if (claimed.count === 0) {
    // A concurrent call stored one first. Thanks to the idempotency key that is the
    // same account, so there is nothing to reconcile — but log it, because if this ever
    // appears with two *different* ids the key stopped working and money is at stake.
    const current = await getBarberOrThrow(barberId);
    logger.warn(
      { barberId, created: account.id, stored: current.stripeAccountId },
      'Connected account was stored concurrently',
    );
    return current.stripeAccountId ?? account.id;
  }

  return account.id;
}

/**
 * A hosted onboarding link for the barber to finish (or resume) their account.
 *
 * Single-use and short-lived — Stripe expires these in minutes, which is why the URL is
 * never persisted and a fresh one is minted on every click. `refreshUrl` is where Stripe
 * sends someone who arrives on an expired link; it must lead somewhere that mints
 * another one rather than to a dead end.
 */
export async function createOnboardingLink(
  barberId: string,
  urls: { returnUrl: string; refreshUrl: string },
): Promise<{ url: string; expiresAt: Date; stripeAccountId: string; created: boolean }> {
  const before = await getBarberOrThrow(barberId);
  const stripeAccountId = await ensureConnectedAccount(barberId);

  const link = await stripe().accountLinks.create({
    account: stripeAccountId,
    refresh_url: urls.refreshUrl,
    return_url: urls.returnUrl,
    type: 'account_onboarding',
  });

  return {
    url: link.url,
    expiresAt: new Date(link.expires_at * 1000),
    stripeAccountId,
    created: before.stripeAccountId === null,
  };
}

/**
 * Pulls the live account from Stripe and updates the mirror.
 *
 * Called when a barber lands back from onboarding, because the `account.updated`
 * webhook has usually not arrived yet and a page that still says "Set Up Payouts" after
 * they just finished reads as though the whole thing failed.
 *
 * Returns both sides so the caller can audit only a real change — this runs on every
 * return trip, and logging a no-op each time would bury the transitions that matter.
 */
export async function refreshConnectStatus(barberId: string): Promise<{
  before: ConnectStatus;
  after: ConnectStatus;
  changed: boolean;
}> {
  const barber = await getBarberOrThrow(barberId);
  const before = toStatus(barber);

  if (barber.stripeAccountId === null) {
    return { before, after: before, changed: false };
  }

  const account = await stripe().accounts.retrieve(barber.stripeAccountId);
  const mirror = mirrorOf(account);

  const updated = await prisma.barber.update({ where: { id: barberId }, data: mirror });
  const after = toStatus(updated);

  return { before, after, changed: didChange(before, after) };
}

function didChange(before: ConnectStatus, after: ConnectStatus): boolean {
  return (
    before.chargesEnabled !== after.chargesEnabled ||
    before.payoutsEnabled !== after.payoutsEnabled ||
    before.detailsSubmitted !== after.detailsSubmitted ||
    before.instantPayoutEligible !== after.instantPayoutEligible
  );
}

/**
 * Applies an `account.updated` payload to the mirror.
 *
 * This is what makes the mirror maintain itself. Without it the four booleans only move
 * when a barber happens to land back from onboarding — and Stripe typically clears an
 * account minutes or hours later, long after anyone is looking at the page.
 *
 * Returns `null` for an account we hold no barber for. That is not an error worth
 * retrying: a platform sandbox accumulates accounts from `stripe trigger` and from other
 * experiments, and every one of them delivers here.
 */
export async function applyAccountUpdate(account: Stripe.Account): Promise<{
  barberId: string;
  before: ConnectStatus;
  after: ConnectStatus;
  changed: boolean;
} | null> {
  const barber = await prisma.barber.findUnique({ where: { stripeAccountId: account.id } });
  if (!barber) return null;

  const before = toStatus(barber);
  const updated = await prisma.barber.update({
    where: { id: barber.id },
    data: mirrorOf(account),
  });
  const after = toStatus(updated);

  return { barberId: barber.id, before, after, changed: didChange(before, after) };
}
