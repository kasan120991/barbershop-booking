/**
 * Health check.
 *
 * Also the end-to-end proof that the workspace contract is wired: the response is
 * parsed against `healthResponseSchema` from `@francis/shared` before it is sent,
 * so a drift between what the server returns and what the frontends expect fails
 * here rather than in the browser.
 */

import { healthResponseSchema, type HealthResponse } from '@francis/shared';
import { Router } from 'express';

import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  const payload: HealthResponse = {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  res.json(healthResponseSchema.parse(payload));
});
