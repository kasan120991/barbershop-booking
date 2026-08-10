export const SERVICE_NAME = 'francis-cutz-api';

/** Bumped by release tooling later; for now it tracks the workspace version. */
export const SERVICE_VERSION = '0.0.0';

/** All API routes live under this prefix. */
export const API_PREFIX = '/api';

/** Request bodies are small (a booking, a payment). A low cap is a cheap DoS guard. */
export const JSON_BODY_LIMIT = '100kb';

/**
 * The webhook body gets its own, larger cap.
 *
 * A connected-account event embeds the whole `Account` object — capabilities,
 * requirements, external accounts — and clears 100kb without being unusual. A body the
 * parser truncates fails signature verification, which reads as an attack rather than as
 * a limit set too low.
 */
export const WEBHOOK_BODY_LIMIT = '1mb';

/** httpOnly — JavaScript must never be able to read the session token. */
export const SESSION_COOKIE = 'fc_session';

/** Readable by JavaScript on purpose: the client echoes it back as a header. */
export const CSRF_COOKIE = 'fc_csrf';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * Kiosk devices authenticate with a header rather than a cookie. That is what makes
 * them immune to CSRF: a cross-site form can make the browser attach a cookie, but it
 * cannot make it attach a custom header.
 */
export const DEVICE_TOKEN_HEADER = 'x-device-token';
