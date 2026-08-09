/**
 * CSRF protection via double-submit, bound to the session row.
 *
 * The attack this stops: a malicious page makes the browser POST to our API, and the
 * browser helpfully attaches the session cookie. SameSite=Lax already blocks most of
 * it, but "most" is not a security boundary — Lax still permits top-level navigations,
 * and it depends on the browser honouring it.
 *
 * The defence: a token the attacker cannot read. It arrives in a JS-readable cookie,
 * the client echoes it back as a header, and we compare it against the hash stored on
 * the SESSION. Comparing against the cookie alone would prove nothing — an attacker
 * who can set cookies could set both halves. Binding to the session row is the part
 * that matters.
 *
 * Exemptions, both principled rather than convenient:
 *   - Safe methods (GET/HEAD/OPTIONS) mutate nothing.
 *   - Device-token requests carry no ambient cookie credential, so a cross-site form
 *     cannot authenticate as them at all; a custom header cannot be forged cross-origin.
 */

import type { NextFunction, Request, Response } from 'express';

import { CSRF_HEADER } from '../config/constants.js';
import { ForbiddenError } from '../lib/errors.js';
import { hashToken, safeCompareHashes } from '../lib/tokens.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function verifyCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Only cookie-authenticated principals are vulnerable.
  if (req.auth?.kind !== 'user') {
    next();
    return;
  }

  const header = req.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;

  if (typeof provided !== 'string' || provided.length === 0) {
    next(new ForbiddenError('Missing CSRF token.'));
    return;
  }

  if (!safeCompareHashes(hashToken(provided), req.auth.csrfTokenHash)) {
    next(new ForbiddenError('Invalid CSRF token.'));
    return;
  }

  next();
}
