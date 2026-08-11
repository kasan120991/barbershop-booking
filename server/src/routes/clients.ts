/**
 * Looking a client up by their number.
 *
 * Two routes that answer the same question at two very different volumes, because the
 * phone number is an **unverified** identity and who is asking decides what they may know.
 *
 * `GET /clients/lookup` is the desk. It returns the whole client and is behind
 * `requireUser` — which a device token can never satisfy, because `req.auth` is a
 * discriminated union and a kiosk is `{ kind: 'device' }` with no roles at all. That is
 * the difference between this and a route a kiosk could reach, and it is the whole reason
 * the union exists.
 *
 * `POST /clients/recognise` is the kiosk and the booking site. It takes a number **and** a
 * first name and returns one boolean. It cannot be used to find out who a number belongs
 * to, because the caller has to already believe they know.
 */

import {
  lookupClientQuerySchema,
  normalizePhone,
  recogniseClientRequestSchema,
  type ClientDto,
  type RecogniseClientResponse,
} from '@francis/shared';
import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { limiter } from '../lib/rate-limit.js';
import { toClientDto } from '../mappers/client.js';
import { requireUser } from '../middleware/require-auth.js';
import { lookupClientByPhone, recogniseClient } from '../services/clients.js';

export const clientRouter: Router = Router();

/**
 * Tighter than the booking and queue limits, and for a different reason.
 *
 * Those bound how often somebody may *do* something. This bounds how fast somebody may
 * guess: the one attack on `recognise` is running first names against a number until one
 * comes back true. Twenty an hour per number makes that useless while leaving room for a
 * customer who mistypes their own name a few times.
 */
const recogniseLimit = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  message: 'Too many tries just now. Please fill the form in as normal.',
  keyGenerator: (req) => {
    const body = req.body as { phone?: unknown };
    const phone = typeof body?.phone === 'string' ? normalizePhone(body.phone) : null;
    return phone ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

/** The desk. Everything about the number, because staff already hold client records. */
clientRouter.get('/clients/lookup', requireUser, async (req, res) => {
  const { phone } = lookupClientQuerySchema.parse(req.query);

  const client = await lookupClientByPhone(phone);
  const body: { client: ClientDto | null } = {
    client: client === null ? null : toClientDto(client),
  };

  res.json(body);
});

/**
 * The public half. One boolean, and never a name.
 *
 * A `false` deliberately does not distinguish "we do not know that number" from "we know
 * it under a different name" — telling them apart is precisely the leak, and the client
 * has nothing useful to do with the difference either way. It shows a greeting or it shows
 * nothing.
 */
clientRouter.post('/clients/recognise', recogniseLimit, async (req, res) => {
  const { phone, firstName } = recogniseClientRequestSchema.parse(req.body);

  const body: RecogniseClientResponse = {
    recognised: await recogniseClient(phone, firstName),
  };

  res.json(body);
});
