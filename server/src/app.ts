/**
 * Express application factory.
 *
 * Kept separate from `index.ts` (which owns the listening socket and shutdown) so
 * tests can build an app and drive it with supertest without binding a port.
 *
 * Middleware order is load-bearing:
 *   requestId -> logger        (so every log line carries the id)
 *   helmet, cors               (before anything reads a body)
 *   stripe webhook             (RAW body — must precede the JSON parser)
 *   json body                  (before authenticate, which reads cookies not body)
 *   cookieParser, authenticate (resolve the principal)
 *   verifyCsrf                 (needs req.auth to know if it applies)
 *   routes
 */

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { API_PREFIX, JSON_BODY_LIMIT } from './config/constants.js';
import { allowedOrigins, isProduction } from './config/env.js';
import { authenticate } from './middleware/authenticate.js';
import { verifyCsrf } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { apiRouter } from './routes/index.js';
import {
  STRIPE_WEBHOOK_PATH,
  stripeWebhookHandler,
  stripeWebhookParser,
} from './routes/stripe-webhook.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy in production, so req.ip reflects the client and not the load
  // balancer. Login throttling and public booking rate limits are keyed on IP, and
  // those limits are worthless if every request appears to come from one address.
  if (isProduction) {
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by');

  // requestId must precede the logger — the logger reuses the id it assigns.
  app.use(requestId);
  app.use(requestLogger);
  app.use(helmet());
  app.use(
    cors({
      origin: allowedOrigins as string[],
      // Required for the session cookie to be sent from the Nuxt apps.
      credentials: true,
    }),
  );

  /**
   * The Stripe webhook, and its position is the whole point.
   *
   * BEFORE `express.json` because signature verification hashes the exact bytes Stripe
   * sent — parse them and re-serialise and they are no longer those bytes, so every
   * delivery fails as forged. It therefore also lands before `cookieParser`,
   * `authenticate` and `verifyCsrf`, which is correct rather than incidental: the
   * signature is the authentication, no principal exists behind a Stripe POST, and CSRF
   * guards an ambient browser cookie this request does not have.
   *
   * Errors still reach `errorHandler` below — Express walks to the error middleware from
   * wherever `next(err)` is called, so mounting early costs nothing there.
   */
  app.post(STRIPE_WEBHOOK_PATH, stripeWebhookParser, stripeWebhookHandler);

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(cookieParser());
  app.use(authenticate);
  app.use(verifyCsrf);

  app.use(API_PREFIX, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
