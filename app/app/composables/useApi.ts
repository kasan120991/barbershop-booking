/**
 * The single HTTP client for the whole app.
 *
 * Three things happen here that must never be done ad hoc at a call site:
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
 *
 * 3. Expired sessions. A 401 anywhere means the session died — most likely the 12
 *    hour cap elapsed mid-shift. Handling it here means a barber gets a clean trip
 *    to the login screen and back, instead of a page whose buttons quietly stop
 *    working.
 */

import type { ApiError } from '@francis/shared';
import type { FetchOptions } from 'ofetch';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints where a 401 is a legitimate answer rather than an expired session.
 *
 * `/auth/me` returns 401 for "not signed in", which is exactly what the store asks
 * it. Letting the interceptor act on that would redirect to `/login` while the guard
 * is still resolving — a loop.
 *
 * `/auth/change-password` returns 401 for a wrong CURRENT password. Without this
 * exemption, mistyping it signs you out and throws away the form — and the page's own
 * "that is not your current password" message becomes unreachable, because the
 * interceptor runs before the caller's catch.
 */
const AUTH_EXEMPT = ['/auth/me', '/auth/login', '/auth/change-password'];

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

/** True when the request never reached the server — as opposed to being refused by it. */
export function isConnectionFailure(failure: ApiFailure): boolean {
  return failure.code === 'NETWORK';
}

/**
 * Normalizes any thrown fetch error into the shared `ApiError` envelope.
 *
 * A network failure has no envelope at all, so it gets a synthetic one — callers
 * should never have to distinguish "server said no" from "server unreachable" when
 * all they want to do is show a message. Code `NETWORK` preserves the difference for
 * the one caller that does care.
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

    onResponseError({ request, response }) {
      if (response.status !== 401) return;

      const url = typeof request === 'string' ? request : request.url;
      if (AUTH_EXEMPT.some((path) => url.includes(path))) return;

      auth.clear();

      // Only on the client: a server-side redirect here would fight the route
      // guard, which is already resolving the session for this same navigation.
      if (import.meta.client) {
        const current = useRoute().fullPath;
        const redirect = current && current !== '/' ? `?redirect=${encodeURIComponent(current)}` : '';
        void navigateTo(`/login${redirect}`);
      }
    },
  }) as <T>(request: string, options?: FetchOptions) => Promise<T>;
}
