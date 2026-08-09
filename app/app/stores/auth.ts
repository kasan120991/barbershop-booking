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
   * The API could not be reached — as distinct from refusing us.
   *
   * These must not be conflated: treating an outage as "signed out" sends someone to
   * a login screen that cannot possibly work, and throws away a session that is
   * still perfectly valid.
   */
  const connectionError = ref(false);

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
  /** Set by an admin password reset. Nothing else is reachable until it is cleared. */
  const mustChangePassword = computed(() => user.value?.mustChangePassword ?? false);

  const displayName = computed(() =>
    user.value ? `${user.value.firstName} ${user.value.lastName}`.trim() : '',
  );

  const initials = computed(() => {
    const current = user.value;
    if (!current) return '';
    return `${current.firstName[0] ?? ''}${current.lastName[0] ?? ''}`.toUpperCase();
  });

  /** Drops local state without calling the API. Used by the 401 interceptor. */
  function clear(): void {
    user.value = null;
    csrfToken.value = null;
  }

  /**
   * Resolves the current session. A 401 is the expected signed-out answer, not an
   * error, so it clears state. A network failure is neither — it leaves the user
   * alone and raises `connectionError` for the shell to surface.
   */
  async function fetchMe(): Promise<void> {
    const api = useApi();
    try {
      const response = await api<MeResponse>('/auth/me');
      user.value = response.user;
      // Restore the token the login response gave us, which this store instance
      // never saw if the page was reloaded.
      csrfToken.value = csrfCookie.value ?? null;
      connectionError.value = false;
    } catch (error) {
      if (isConnectionFailure(toApiFailure(error))) {
        connectionError.value = true;
      } else {
        connectionError.value = false;
        clear();
      }
    } finally {
      resolved.value = true;
    }
  }

  /** Re-runs the session check after an outage, for the shell's Retry control. */
  async function retryConnection(): Promise<void> {
    resolved.value = false;
    await fetchMe();
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
    connectionError.value = false;
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
      clear();
    }
  }

  return {
    user,
    csrfToken,
    resolved,
    connectionError,
    isSignedIn,
    isAdmin,
    isBarber,
    mustChangePassword,
    displayName,
    initials,
    clear,
    fetchMe,
    retryConnection,
    signIn,
    signOut,
  };
});
