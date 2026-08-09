/**
 * The single error envelope every API route returns on failure.
 *
 * One shape means the frontends write one error handler instead of guessing per
 * endpoint, and `code` (not the human message) is what UI branches on — messages
 * get reworded, codes do not.
 */

import { z } from 'zod';

export const ERROR_CODE = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** Per-field validation messages, keyed by field path. Mirrors `z.flattenError().fieldErrors`. */
export const fieldErrorsSchema = z.record(z.string(), z.array(z.string()));

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(Object.values(ERROR_CODE) as [ErrorCode, ...ErrorCode[]]),
    /** Safe to show a user. Never contains a stack trace or a DB message. */
    message: z.string(),
    /** Present on VALIDATION_FAILED so a form can highlight the offending inputs. */
    fields: fieldErrorsSchema.optional(),
    /** Correlates this response with a server log line. */
    requestId: z.string().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type FieldErrors = z.infer<typeof fieldErrorsSchema>;
