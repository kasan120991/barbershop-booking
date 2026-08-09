/**
 * Health check contract.
 *
 * Small, but it is the end-to-end proof that the workspace wiring works: the
 * server parses its response against this schema before sending, and both Nuxt
 * apps will type their fetch against the same inferred type.
 */

import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
