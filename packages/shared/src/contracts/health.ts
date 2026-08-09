/**
 * Health check contract.
 *
 * Small, but it is the end-to-end proof that the workspace wiring works: the
 * server parses its response against this schema before sending, and both Nuxt
 * apps will type their fetch against the same inferred type.
 */

import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
  /**
   * `degraded` means the API is up but the database is unreachable — worth
   * distinguishing, because a load balancer should pull the instance while an
   * uptime monitor should page rather than report a hard outage.
   */
  database: z.enum(['up', 'down']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
