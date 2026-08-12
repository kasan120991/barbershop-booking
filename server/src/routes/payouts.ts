/**
 * A barber's own money — what they took, what Stripe holds, and getting at it.
 *
 * Every route is `requireBarberSelfOrAdmin`. A balance is the most private number a chair
 * has, and rent is settled against these same figures, so one barber reading another's
 * would be worse than merely untidy.
 *
 * No device path, for the same reason payments have none: a screen standing by the door
 * must never be able to move money.
 */

import {
  createInstantPayoutRequestSchema,
  type BalanceDto,
  type EarningsSummaryDto,
  type PayoutDto,
} from '@francis/shared';
import { Router, type Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { UnauthenticatedError } from '../lib/errors.js';
import { limiter } from '../lib/rate-limit.js';
import { toPayoutDto } from '../mappers/payout.js';
import { requireBarberSelfOrAdmin } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  createInstantPayout,
  getBalance,
  getEarningsSummary,
  listPayouts,
  quoteInstantPayout,
} from '../services/payouts.js';

export const payoutRouter: Router = Router();

const barberIdOf = (req: Request): string => String(req.params.barberId ?? '');

/**
 * Balance reads hit Stripe live, so this caps a stuck client without getting in the way
 * of somebody checking twice.
 *
 * Keyed on the chair being read, not the address asking. Every phone and tablet in the
 * shop shares one public IP, so the default key made sixty-per-five-minutes a *shop-wide*
 * budget — one barber refreshing could lock the rest of the floor out of their own
 * money. It was sized for a page somebody opens occasionally; `/today` is the screen a
 * barber opens between cuts, which is what turned a generous cap into a shared one.
 *
 * Same reasoning as the kiosk's quote limiter keying on the device: behind one router,
 * an address identifies the building rather than the person.
 */
const balanceLimit = limiter({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  message: 'Too many requests. Wait a moment and try again.',
  keyGenerator: (req) => {
    const barberId = barberIdOf(req);
    // The IP fallback goes through `ipKeyGenerator`, which normalises IPv6 to its /56
    // prefix — keying on the raw address would hand one person a bucket per address in
    // their own allocation.
    return barberId === '' ? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}` : `barber:${barberId}`;
  },
});

/** Moving money deserves a tighter one than reading about it. */
const cashOutLimit = limiter({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  message: 'Too many cash-out attempts. Wait a few minutes and try again.',
});

payoutRouter.get(
  '/barbers/:barberId/balance',
  balanceLimit,
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    const balance = await getBalance(barberIdOf(req));
    const body: BalanceDto = balance;
    res.json(body);
  },
);

payoutRouter.get(
  '/barbers/:barberId/earnings',
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    // Omitted means today in the shop's timezone, resolved server-side.
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;

    const summary = await getEarningsSummary(barberIdOf(req), date);
    const body: EarningsSummaryDto = summary;
    res.json(body);
  },
);

payoutRouter.get(
  '/barbers/:barberId/payouts',
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    const payouts = await listPayouts(barberIdOf(req));
    const body: PayoutDto[] = payouts.map(toPayoutDto);
    res.json({ payouts: body });
  },
);

/**
 * Cash out now, for a fee.
 *
 * The amount is checked against the live instant balance inside the service rather than
 * against anything the client sent, and the fee written to the row is the same quote the
 * confirm dialog showed — the webhook replaces it with Stripe's actual figure once one
 * exists.
 */
payoutRouter.post(
  '/barbers/:barberId/payouts/instant',
  cashOutLimit,
  requireBarberSelfOrAdmin(barberIdOf),
  async (req, res) => {
    if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

    const barberId = barberIdOf(req);
    const { amountCents } = createInstantPayoutRequestSchema.parse(req.body);

    const payout = await createInstantPayout({
      barberId,
      amountCents,
      initiatedByUserId: req.auth.userId,
    });

    const quote = quoteInstantPayout(amountCents);

    await recordAudit(auditContext(req), {
      action: 'payout.requested',
      entityType: 'Payout',
      entityId: payout.id,
      after: {
        barberId,
        amountCents: payout.amountCents,
        // The quote, explicitly labelled — Stripe's real figure is not knowable yet, and
        // a later `payout.paid` audit carries what was actually taken.
        quotedFeeCents: quote.feeCents,
        quotedNetCents: quote.netCents,
      },
    });

    const body: PayoutDto = toPayoutDto(payout);
    res.status(201).json(body);
  },
);
