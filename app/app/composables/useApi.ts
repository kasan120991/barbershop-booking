/**
 * The single HTTP client for the whole app.
 *
 * Two things happen here that must never be done ad hoc at a call site:
 *
 * 1. SSR cookie forwarding. On the client, `credentials: 'include'` is enough —
 *    the browser attaches `fc_session` itself. On the server there is no browser
 *    and no cookie jar, so Nitro has to copy the incoming request's `cookie` header
 *    onto the outgoing call. Without this, every page renders signed-out during SSR
 *    and then flips after hydration.
 *
 * 2. The CSRF header. The API rejects any non-GET from a cookie-authenticated caller
 *    unless `x-csrf-token` matches the session. Attaching it centrally is what stops
 *    a future mutation from mysteriously 403ing because someone forgot it.
 */

import type { ApiError } from '@francis/shared';
import type { FetchOptions } from 'ofetch';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Narrowed shape of a failed `$fetch`, which carries the parsed body on `data`. */
interface FetchErrorLike {
  status?: number;
  statusCode?: number;
  data?: ApiError;
}

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  fields: Record<string, string[]> | undefined;
}

/**
 * Normalizes any thrown fetch error into the shared `ApiError` envelope.
 *
 * A network failure has no envelope at all, so it gets a synthetic one — callers
 * should never have to distinguish "server said no" from "server unreachable" when
 * all they want to do is show a message.
 */
export function toApiFailure(error: unknown): ApiFailure {
  const candidate = error as FetchErrorLike;
  const status = candidate?.status ?? candidate?.statusCode ?? 0;
  const envelope = candidate?.data?.error;

  if (envelope) {
    return {
      status,
      code: envelope.code,
      message: envelope.message,
      fields: envelope.fields,
    };
  }

  return {
    status,
    code: 'NETWORK',
    message: 'Could not reach the server. Check your connection and try again.',
    fields: undefined,
  };
}

export function useApi() {
  const config = useRuntimeConfig();
  // Read lazily inside onRequest — the store may not be populated when this
  // composable is first called.
  const auth = useAuthStore();

  return $fetch.create({
    baseURL: config.public.apiBase,
    credentials: 'include',

    onRequest({ options }) {
      const headers = new Headers(options.headers);

      if (import.meta.server) {
        const cookie = useRequestHeaders(['cookie']).cookie;
        if (cookie) headers.set('cookie', cookie);
      }

      const method = (options.method ?? 'GET').toUpperCase();
      if (!SAFE_METHODS.has(method) && auth.csrfToken) {
        headers.set('x-csrf-token', auth.csrfToken);
      }

      options.headers = headers;
    },
  }) as <T>(request: string, options?: FetchOptions) => Promise<T>;
}
