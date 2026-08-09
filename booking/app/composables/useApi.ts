/**
 * The API client for the public site.
 *
 * Deliberately much smaller than the staff app's. There is no session here, so there is
 * no CSRF header to attach, no cookie to forward through SSR, and — the important one —
 * **no 401 interceptor**. On the staff app a 401 means "your session expired, go and
 * sign in"; here it would mean a public endpoint has stopped being public, which is a
 * bug to surface rather than a redirect to perform.
 *
 * `toApiFailure` is the same shape as the staff app's, because the server speaks one
 * error envelope to everyone and the UI branches on `code`, never on `message`.
 */

import type { ApiError } from '@francis/shared';
import type { FetchOptions } from 'ofetch';

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

/** True when the request never reached the server, as opposed to being refused by it. */
export function isConnectionFailure(failure: ApiFailure): boolean {
  return failure.code === 'NETWORK';
}

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
    message: 'Could not reach the shop. Check your connection and try again.',
    fields: undefined,
  };
}

export function useApi() {
  const config = useRuntimeConfig();

  return $fetch.create({
    baseURL: config.public.apiBase,
  }) as <T>(request: string, options?: FetchOptions) => Promise<T>;
}
