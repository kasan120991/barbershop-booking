/**
 * Global route guard.
 *
 * Public routes are an explicit ALLOWLIST rather than a `requiresAuth: true` opt-in.
 * That inversion matters: a new page added six months from now is protected because
 * nobody did anything, instead of exposed because somebody forgot something.
 */

const PUBLIC_ROUTES = new Set(['/login']);

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore();

  // Resolve the session once per navigation cycle. On the server this runs before
  // the first render, so the correct page is sent rather than a signed-out flash.
  if (!auth.resolved) {
    await auth.fetchMe();
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
});
