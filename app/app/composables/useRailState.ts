/**
 * Whether the nav rail is collapsed to icons.
 *
 * Cookie-backed for the same reason as `useShopMode`: the rail is rendered during
 * SSR, and a localStorage-backed preference would send the expanded rail from the
 * server and then visibly snap shut after hydration.
 *
 * Collapsing buys back ~10rem of width, which only really matters on the calendar —
 * but that is the screen a barber stares at all day.
 */

const RAIL_COOKIE = 'fc_rail';

export function useRailState() {
  const stored = useCookie<'collapsed' | 'expanded' | null>(RAIL_COOKIE, {
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });

  const collapsed = computed(() => stored.value === 'collapsed');

  function toggle() {
    stored.value = collapsed.value ? 'expanded' : 'collapsed';
  }

  return { collapsed, toggle };
}
