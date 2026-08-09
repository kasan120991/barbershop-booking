export const SERVICE_NAME = 'francis-cutz-api';

/** Bumped by release tooling later; for now it tracks the workspace version. */
export const SERVICE_VERSION = '0.0.0';

/** All API routes live under this prefix. */
export const API_PREFIX = '/api';

/** Request bodies are small (a booking, a payment). A low cap is a cheap DoS guard. */
export const JSON_BODY_LIMIT = '100kb';
