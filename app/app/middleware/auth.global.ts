/**
 * Global route guard.
 *
 * Public routes are an explicit ALLOWLIST rather than a `requiresAuth: true` opt-in.
 * That inversion matters: a new page added six months from now is protected because
 * nobody did anything, instead of exposed because somebody forgot something.
 */

import { ADMIN_ONLY_PATHS } from '../composables/useNavigation';

const PUBLIC_ROUTES = new Set(['/login']);

/** Reachable while `mustChangePassword` is set — everything else is not. */
const CHANGE_PASSWORD_ROUTE = '/change-password';

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore();

  // Resolve the session once per navigation cycle. On the server this runs before
  // the first render, so the correct page is sent rather than a signed-out flash.
  if (!auth.resolved) {
    await auth.fetchMe();
  }

  // The API is unreachable, which is not the same as being signed out. Redirecting
  // to /login here would send someone to a screen that cannot work either, and would
  // discard a session that is probably still valid. Let the shell show its banner.
  if (auth.connectionError) {
    return;
  }

  const isPublic = PUBLIC_ROUTES.has(to.path);

  if (!auth.isSignedIn && !isPublic) {
    // Remember where they were headed so sign-in can return them there.
    const redirect = to.fullPath !== '/' ? `?redirect=${encodeURIComponent(to.fullPath)}` : '';
    return navigateTo(`/login${redirect}`);
  }

  if (auth.isSignedIn && isPublic) {
    return navigateTo('/');
  }

  // An admin reset hands over a temporary password in person. Until it is replaced,
  // nothing else in the app is reachable — otherwise the barber simply keeps using
  // the password the admin knows.
  if (auth.isSignedIn && auth.mustChangePassword && to.path !== CHANGE_PASSWORD_ROUTE) {
    return navigateTo(CHANGE_PASSWORD_ROUTE);
  }

  // Equally, there is no reason to sit on that screen once it is done.
  if (auth.isSignedIn && !auth.mustChangePassword && to.path === CHANGE_PASSWORD_ROUTE) {
    return navigateTo('/');
  }

  // Hiding a nav link is presentation; this is the actual check. The API enforces
  // it a third time, because a client-side guard protects nothing on its own.
  if (auth.isSignedIn && !auth.isAdmin && ADMIN_ONLY_PATHS.includes(to.path)) {
    return navigateTo('/my-day');
  }
});
