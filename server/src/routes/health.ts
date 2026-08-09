/**
 * Health check.
 *
 * Also the end-to-end proof that the workspace contract is wired: the response is
 * parsed against `healthResponseSchema` from `@francis/shared` before it is sent,
 * so a drift between what the server returns and what the frontends expect fails
 * here rather than in the browser.
 *
 * A database outage returns 503 with `status: 'degraded'` rather than throwing —
 * the point of a health check is to report the failure, not to become one.
 */

import { healthResponseSchema, type HealthResponse } from '@francis/shared';
import { Router } from 'express';

import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';

export const healthRouter: Router = Router();

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

healthRouter.get('/health', async (_req, res) => {
  const databaseUp = await isDatabaseReachable();

  const payload: HealthResponse = {
    status: databaseUp ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    database: databaseUp ? 'up' : 'down',
  };

  res.status(databaseUp ? 200 : 503).json(healthResponseSchema.parse(payload));
});
