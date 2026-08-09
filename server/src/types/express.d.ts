import type { AuthPrincipal } from '../middleware/authenticate.js';

/**
 * `requestId` — every request carries one, echoed in the error envelope and the
 * `x-request-id` response header, so a client reporting "it failed" maps to exactly
 * one log line. Deliberately NOT named `id`: pino-http augments
 * `http.IncomingMessage` with `id: ReqId` (which permits a number), and Express's
 * `Request` inherits it. Assigned by the `requestId` middleware, mounted first.
 *
 * `auth` — whoever is calling, or undefined for an anonymous request. Populated by
 * `authenticate`; enforced by the guards in `require-auth.ts`.
 */
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthPrincipal;
    }
  }
}

export {};
