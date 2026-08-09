/**
 * Per-request logging.
 *
 * Health checks are logged at `trace` so an uptime monitor polling every 10s does
 * not bury real traffic. Everything else follows status: 5xx errors, 4xx warns.
 */

import type { Request } from 'express';
import { pinoHttp } from 'pino-http';

import { logger } from '../lib/logger.js';

export const requestLogger = pinoHttp({
  logger,

  // Reuse the id already assigned by the `requestId` middleware so the log line
  // and the error response the client sees carry the same value.
  genReqId: (req) => (req as Request).requestId,

  customLogLevel: (req, res, error) => {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (req.url === '/api/health') return 'trace';
    return 'info';
  },

  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, error) =>
    `${req.method} ${req.url} ${res.statusCode} — ${error.message}`,
});
