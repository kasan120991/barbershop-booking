/**
 * Express application factory.
 *
 * Kept separate from `index.ts` (which owns the listening socket and shutdown) so
 * tests can build an app and drive it with supertest without binding a port.
 */

import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { API_PREFIX, JSON_BODY_LIMIT } from './config/constants.js';
import { allowedOrigins, isProduction } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { apiRouter } from './routes/index.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy in production, so req.ip reflects the client and not the load
  // balancer. Public booking is rate-limited by IP, and that limit is worthless if
  // every request appears to come from the same address.
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
      credentials: true,
    }),
  );

  // NOTE: the Stripe webhook route must be mounted BEFORE this with `express.raw`,
  // because signature verification needs the unparsed body. See the payments phase.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(API_PREFIX, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
