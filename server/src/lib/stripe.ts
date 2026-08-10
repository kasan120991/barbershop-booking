/**
 * The Stripe platform client.
 *
 * **Lazy on purpose.** Constructing this at import time would make `STRIPE_SECRET_KEY`
 * a hard requirement for booting the server at all, and every phase before this one —
 * the queue, the calendar, the kiosk, the whole test suite — runs perfectly well
 * without a Stripe account. Instead the first call that actually needs Stripe throws an
 * error that names the missing variable, rather than a `TypeError` from inside the SDK
 * three frames deep.
 *
 * This module owns the *platform* handle only. Every connected-account call passes
 * `{ stripeAccount }` at the call site, because on direct charges the barber's account
 * is the one that matters and making that explicit each time is what stops a charge
 * being created on the platform by omission.
 */

import Stripe from 'stripe';

import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { ERROR_CODE } from '@francis/shared';

/**
 * Not an `InternalError` subclass by accident: this is a deployment fault, not a bug in
 * a request, and the message is deliberately not exposed to a client. A barber tapping
 * "Set Up Payouts" should see "Something went wrong", while the log says exactly which
 * environment variable is missing.
 */
export class StripeNotConfiguredError extends AppError {
  constructor() {
    super(
      ERROR_CODE.INTERNAL,
      500,
      'STRIPE_SECRET_KEY is not set — payments are unavailable. See server/.env.example.',
      { expose: false },
    );
  }
}

let client: Stripe | null = null;

/** Throws `StripeNotConfiguredError` when no key is configured. */
export function stripe(): Stripe {
  if (env.STRIPE_SECRET_KEY === undefined) throw new StripeNotConfiguredError();

  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    // No `apiVersion` override: the SDK's bundled default is the one its TypeScript
    // types describe, and pinning a different string here makes the types lie.
    appInfo: { name: 'Francis Cutz Shop OS' },
  });

  return client;
}

/** True when payments are configured at all. Lets a view degrade instead of erroring. */
export function isStripeConfigured(): boolean {
  return env.STRIPE_SECRET_KEY !== undefined;
}
