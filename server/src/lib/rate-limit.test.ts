/**
 * A 429 has to speak the same error envelope as everything else.
 *
 * `express-rate-limit` answers with its own plain body by default, which never reaches
 * `errorHandler` and so never becomes `{ error: { code, message, requestId } }`. Both
 * frontends parse that envelope and fall through to `code: 'NETWORK'` when it is
 * missing — so a rate-limited client says *"Could not reach the shop"* while the server
 * is perfectly reachable and deliberately refusing it.
 *
 * The kiosk is where that lands: five joins an hour per phone, on a screen with nobody
 * standing next to it to explain what happened.
 *
 * Tested through a real express app with the real error handler, rather than by
 * inspecting the handler's argument — the whole point is the composition, and the piece
 * that was missing was the join between the two.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { errorHandler } from '../middleware/error-handler.js';
import { requestId } from '../middleware/request-id.js';
import { rateLimitHandler } from './rate-limit.js';

const MESSAGE = 'That number has joined the queue several times already today.';

/**
 * Deliberately built here rather than with `limiter()`: that helper skips under test,
 * which is correct for the suite and useless for this one assertion.
 */
const app = express();
app.use(requestId);
app.use(
  '/limited',
  rateLimit({
    windowMs: 60_000,
    limit: 1,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitHandler(MESSAGE),
  }),
);
app.get('/limited', (_req, res) => {
  res.json({ ok: true });
});
app.use(errorHandler);

const server = app.listen(0);
afterAll(() => {
  server.close();
});

describe('a rate-limited response', () => {
  it('answers the first request and refuses the second', async () => {
    await request(server).get('/limited').expect(200);
    await request(server).get('/limited').expect(429);
  });

  it('carries the shared error envelope rather than a bare body', async () => {
    await request(server).get('/limited');
    const response = await request(server).get('/limited').expect(429);

    expect(response.body.error.code).toBe('RATE_LIMITED');
    // The client shows this verbatim. A generic string here is how "too many attempts"
    // becomes "could not reach the shop".
    expect(response.body.error.message).toBe(MESSAGE);
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('sets the standard headers so a client can back off properly', async () => {
    const response = await request(server).get('/limited').expect(429);
    expect(response.headers['ratelimit-policy']).toBeTruthy();
  });
});
