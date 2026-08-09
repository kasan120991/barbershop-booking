/**
 * Session cookie helpers.
 *
 * The two cookies differ in exactly one property, and that difference is the whole
 * security model:
 *   - `fc_session` is httpOnly, so JavaScript (including injected script) cannot read
 *     the credential.
 *   - `fc_csrf` is deliberately readable, because the client has to echo it back in a
 *     header. It is not a credential on its own — it is only meaningful alongside the
 *     session cookie, and it is verified against the session row.
 *
 * The cookies are NOT signed. The value is a 256-bit random token checked against a
 * hash in the database, so a forged cookie simply fails lookup; a signing secret would
 * add a key to manage and protect nothing extra.
 */

import type { CookieOptions, Response } from 'express';

import { CSRF_COOKIE, SESSION_COOKIE } from '../config/constants.js';
import { isProduction } from '../config/env.js';

function baseCookieOptions(expiresAt: Date): CookieOptions {
  return {
    // Lax, not Strict: Strict would drop the cookie when a barber follows a link into
    // the app from anywhere else, logging them out for no security gain given CSRF
    // tokens are already enforced on every mutation.
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    expires: expiresAt,
  };
}

export function setSessionCookies(
  res: Response,
  tokens: { sessionToken: string; csrfToken: string; expiresAt: Date },
): void {
  res.cookie(SESSION_COOKIE, tokens.sessionToken, {
    ...baseCookieOptions(tokens.expiresAt),
    httpOnly: true,
  });

  res.cookie(CSRF_COOKIE, tokens.csrfToken, {
    ...baseCookieOptions(tokens.expiresAt),
    httpOnly: false,
  });
}

/**
 * Clearing must use the same attributes the cookie was set with — a mismatch on
 * path or sameSite leaves the original cookie in place and the user "logged out"
 * everywhere except where it counts.
 */
export function clearSessionCookies(res: Response): void {
  const options: CookieOptions = { sameSite: 'lax', secure: isProduction, path: '/' };
  res.clearCookie(SESSION_COOKIE, { ...options, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}
