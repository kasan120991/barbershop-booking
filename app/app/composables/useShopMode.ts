/**
 * Which hat the signed-in user is wearing.
 *
 * The owner is both an ADMIN and a BARBER, and those are two different jobs with
 * two different navigations. Rather than flatten nine destinations into one list,
 * the shell asks which job you are doing and shows only that one.
 *
 * Persisted in a COOKIE rather than localStorage on purpose: the nav is rendered
 * during SSR, and localStorage does not exist there. A cookie is readable on both
 * sides, so the server sends the correct nav instead of a default that visibly
 * swaps after hydration.
 *
 * Someone who only holds BARBER has no choice to make — they are pinned to `chair`
 * and never see the switch.
 */

export type ShopMode = 'shop' | 'chair';

const MODE_COOKIE = 'fc_mode';

export function useShopMode() {
  const auth = useAuthStore();

  const stored = useCookie<ShopMode | null>(MODE_COOKIE, {
    sameSite: 'lax',
    path: '/',
    // A UI preference, not a credential — but it still has no business being sent
    // anywhere except this app.
    maxAge: 60 * 60 * 24 * 365,
  });

  /** Only the owner (ADMIN who also cuts) is ever offered the switch. */
  const canSwitch = computed(() => auth.isAdmin && auth.isBarber);

  const mode = computed<ShopMode>(() => {
    if (!auth.isAdmin) return 'chair';
    if (!auth.isBarber) return 'shop';
    return stored.value === 'chair' ? 'chair' : 'shop';
  });

  function setMode(next: ShopMode) {
    if (!canSwitch.value) return;
    stored.value = next;
  }

  const homeRoute = computed(() => homeRouteFor(mode.value));

  return { mode, canSwitch, setMode, homeRoute };
}

/**
 * Where "home" is depends on the hat.
 *
 * Exported as a function as well as a computed because the mode switch needs the home of
 * the mode it is switching *to*, before the cookie it just wrote has propagated — reading
 * the computed there returns the mode being left. It was a second hardcoded '/my-day',
 * which is how the two came to disagree the moment one of them moved.
 */
export function homeRouteFor(mode: ShopMode): string {
  return mode === 'shop' ? '/calendar' : '/today';
}
