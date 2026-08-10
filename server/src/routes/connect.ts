/**
 * Stripe Connect onboarding routes.
 *
 * Every route here is `requireBarberSelfOrAdmin`: a barber may onboard and inspect their
 * own chair, an admin may do it for anyone, and one barber can never see another's
 * account state. There is no device path — a kiosk must never reach payment setup.
 *
 * `POST` rather than `GET` for the onboarding link because it has a side effect: the
 * first call creates the connected account.
 */

import type { ConnectStatusDto, OnboardingLinkDto } from '@francis/shared';
import { Router, type Request } from 'express';

import { env } from '../config/env.js';
import { pathParam } from '../lib/http.js';
import { limiter } from '../lib/rate-limit.js';
import { requireBarberSelfOrAdmin } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import { createOnboardingLink, getConnectStatus, refreshConnectStatus } from '../services/connect.js';

export const connectRouter: Router = Router();

const barberIdOf = (req: Request): string => pathParam(req, 'barberId');

/**
 * Both write routes call Stripe. The limit is generous for a human tapping a button and
 * still caps a stuck client that retries in a loop — every one of those is a live API
 * call against the platform account's rate limit, shared with taking payment.
 */
const stripeCallLimit = limiter({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  message: 'Too many attempts. Wait a moment and try again.',
});

/**
 * Where Stripe sends the barber afterwards.
 *
 * Built here from the configured origin and **never accepted from the client** — a
 * caller-supplied `return_url` is an open redirect wearing a stripe.com onboarding flow,
 * which is precisely the shape a convincing phishing link wants.
 *
 * `refresh` is not an error page: Stripe sends someone there when they arrive on an
 * expired link, and the page's job is to mint a fresh one rather than apologise.
 */
function onboardingUrls(): { returnUrl: string; refreshUrl: string } {
  return {
    returnUrl: `${env.APP_ORIGIN}/earnings?connect=return`,
    refreshUrl: `${env.APP_ORIGIN}/earnings?connect=refresh`,
  };
}

connectRouter.get(
  '/barbers/:barberId/connect',
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    const status = await getConnectStatus(barberIdOf(req));
    const body: ConnectStatusDto = status;
    res.json(body);
  },
);

connectRouter.post(
  '/barbers/:barberId/connect/onboarding-link',
  stripeCallLimit,
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    const barberId = barberIdOf(req);

    const link = await createOnboardingLink(barberId, onboardingUrls());

    if (link.created) {
      await recordAudit(auditContext(req), {
        action: 'connect.account_created',
        entityType: 'Barber',
        entityId: barberId,
        // The account id only. No link URL — it is a live single-use credential for
        // resuming that account's onboarding, and the audit trail is not a place to
        // keep one.
        after: { stripeAccountId: link.stripeAccountId },
      });
    }

    const body: OnboardingLinkDto = {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
    };

    res.status(201).json(body);
  },
);

/**
 * Re-reads the account from Stripe and updates the mirror.
 *
 * The page calls this when the barber lands back from onboarding: `account.updated` has
 * usually not arrived yet, and a screen still offering "Set Up Payouts" to someone who
 * just finished it reads as though the whole thing failed.
 */
connectRouter.post(
  '/barbers/:barberId/connect/refresh',
  stripeCallLimit,
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    const barberId = barberIdOf(req);

    const { before, after, changed } = await refreshConnectStatus(barberId);

    if (changed) {
      await recordAudit(auditContext(req), {
        action: 'connect.status_changed',
        entityType: 'Barber',
        entityId: barberId,
        before,
        after,
      });
    }

    const body: ConnectStatusDto = after;
    res.json(body);
  },
);
