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
import { env, isProduction } from '../config/env.js';

function baseCookieOptions(expiresAt: Date): CookieOptions {
  return {
    // Lax, not Strict: Strict would drop the cookie when a barber follows a link into
    // the app from anywhere else, logging them out for no security gain given CSRF
    // tokens are already enforced on every mutation.
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    expires: expiresAt,
    // Unset in development (host-only is correct when ports share a host). In
    // production this must be the parent domain, or the staff app's SSR pass never
    // receives the cookie and cannot forward it to the API. See config/env.ts.
    ...(env.COOKIE_DOMAIN === undefined ? {} : { domain: env.COOKIE_DOMAIN }),
  };
}

/**
 * Reads a raw `Cookie` header into a map.
 *
 * `cookie-parser` only exists as Express middleware, and a Socket.IO handshake has no
 * `req`/`res` pair to run it against — `socket.handshake.headers.cookie` is a bare
 * string. The `cookie` package would do this, but it is only a transitive dependency
 * here and pnpm's strict layout makes it unimportable without declaring it, which is a
 * dependency to maintain for fifteen lines.
 *
 * Values are `decodeURIComponent`d to match what `cookie-parser` hands the HTTP path,
 * so the same token resolves identically over both transports.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};

  const jar: Record<string, string> = {};

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    // No `=` at all is not a cookie; an empty name is not one either.
    if (separator < 1) continue;

    const name = part.slice(0, separator).trim();
    if (name === '') continue;

    const raw = part.slice(separator + 1).trim();
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      // A malformed escape must not take down the handshake — keep it verbatim and
      // let the token lookup fail on its own terms.
      jar[name] = raw;
    }
  }

  return jar;
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
  const options: CookieOptions = {
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    ...(env.COOKIE_DOMAIN === undefined ? {} : { domain: env.COOKIE_DOMAIN }),
  };
  res.clearCookie(SESSION_COOKIE, { ...options, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}
