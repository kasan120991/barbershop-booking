/**
 * The Vapi client, built lazily.
 *
 * Mirrors `lib/stripe.ts` exactly, and for the same reason: nobody should need a Vapi
 * account to work on the queue or the calendar. The key is optional in `config/env.ts`,
 * the server boots without it, the whole suite passes without it, and the failure — when
 * it comes — names the variable rather than surfacing as an undefined property.
 *
 * Note that only the **provisioning script** ever reaches this. The runtime webhook never
 * calls Vapi at all; it only receives, and it authenticates the caller with a device
 * token, which is a database row. So an unset key disables `vapi:provision` and nothing
 * else.
 */

import { VapiClient } from '@vapi-ai/server-sdk';

import { env } from '../config/env.js';
import { InternalError } from './errors.js';

let client: VapiClient | undefined;

export class VapiNotConfiguredError extends InternalError {
  constructor() {
    super('VAPI_API_KEY is not set — the Vapi API cannot be reached.');
  }
}

export function isVapiConfigured(): boolean {
  return env.VAPI_API_KEY !== undefined;
}

export function vapi(): VapiClient {
  if (!env.VAPI_API_KEY) throw new VapiNotConfiguredError();
  client ??= new VapiClient({ token: env.VAPI_API_KEY });
  return client;
}
