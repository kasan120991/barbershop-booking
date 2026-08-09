/**
 * Authentication state.
 *
 * Types come from `@francis/shared`, so a change to the API contract breaks this at
 * build time rather than at runtime in the shop.
 *
 * The CSRF token is held in memory rather than read from `document.cookie` on each
 * request: it is also delivered in the login response, memory is available during
 * SSR where `document` is not, and it keeps the read path identical on both sides.
 */

import type { LoginRequest, LoginResponse, SessionUserDto } from '@francis/shared';
import { defineStore } from 'pinia';

interface MeResponse {
  user: SessionUserDto;
}

/** Must match CSRF_COOKIE in server/src/config/constants.ts. */
const CSRF_COOKIE_NAME = 'fc_csrf';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<SessionUserDto | null>(null);
  const csrfToken = ref<string | null>(null);
  /** True once `fetchMe` has settled, so the route guard never acts on unknown state. */
  const resolved = ref(false);

  /**
   * The CSRF token is also delivered as a deliberately readable cookie, and that is
   * the only copy that survives a page reload — a fresh store starts empty, and
   * `/auth/me` does not re-issue the token.
   *
   * Without reading it back here, every mutation after a reload fails with 403. That
   * is worst for sign-out, which catches its own errors: the UI would return to the
   * login page looking successful while the server session stayed valid for another
   * twelve hours.
   */
  const csrfCookie = useCookie<string | null>(CSRF_COOKIE_NAME, { readonly: true });

  const isSignedIn = computed(() => user.value !== null);
  const isAdmin = computed(() => user.value?.roles.includes('ADMIN') ?? false);
  const isBarber = computed(() => user.value?.roles.includes('BARBER') ?? false);

  const displayName = computed(() =>
    user.value ? `${user.value.firstName} ${user.value.lastName}`.trim() : '',
  );

  /**
   * Resolves the current session. A 401 is the expected signed-out answer, not an
   * error, so it clears state rather than propagating.
   */
  async function fetchMe(): Promise<void> {
    const api = useApi();
    try {
      const response = await api<MeResponse>('/auth/me');
      user.value = response.user;
      // Restore the token the login response gave us, which this store instance
      // never saw if the page was reloaded.
      csrfToken.value = csrfCookie.value ?? null;
    } catch {
      user.value = null;
      csrfToken.value = null;
    } finally {
      resolved.value = true;
    }
  }

  /** Throws on failure; the login page maps the error to a message. */
  async function signIn(credentials: LoginRequest): Promise<SessionUserDto> {
    const api = useApi();
    const response = await api<LoginResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
    });

    user.value = response.user;
    csrfToken.value = response.csrfToken;
    resolved.value = true;

    return response.user;
  }

  /**
   * Clears local state even if the request fails. A logout that leaves the UI
   * signed-in because the network blipped is worse than one that over-clears —
   * the server session is already revoked or was never valid.
   */
  async function signOut(): Promise<void> {
    const api = useApi();
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Intentionally ignored — see above.
    } finally {
      user.value = null;
      csrfToken.value = null;
    }
  }

  return {
    user,
    csrfToken,
    resolved,
    isSignedIn,
    isAdmin,
    isBarber,
    displayName,
    fetchMe,
    signIn,
    signOut,
  };
});
