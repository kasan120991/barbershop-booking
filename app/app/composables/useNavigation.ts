/**
 * The navigation model, keyed by mode.
 *
 * Data rather than markup, so the layout stays a renderer and adding a destination
 * is a one-line change in one place.
 *
 * `adminOnly` here drives what is *shown*. It is not the access control — the route
 * guard enforces it, and the API enforces it again. Hiding a link is a courtesy, not
 * a boundary.
 */

export interface NavItem {
  label: string;
  to: string;
  adminOnly: boolean;
  /** Renders the live queue count beside the label. */
  showsQueueCount?: boolean;
}

const SHOP_NAV: NavItem[] = [
  { label: 'Calendar', to: '/calendar', adminOnly: true },
  { label: 'Walk-in Queue', to: '/queue', adminOnly: false, showsQueueCount: true },
  { label: 'Clients', to: '/clients', adminOnly: true },
  { label: 'Services & Hours', to: '/services', adminOnly: true },
  { label: 'Barbers & Rent', to: '/barbers', adminOnly: true },
  { label: 'Reports', to: '/reports', adminOnly: true },
];

const CHAIR_NAV: NavItem[] = [
  { label: 'My Day', to: '/my-day', adminOnly: false },
  { label: 'Walk-in Queue', to: '/queue', adminOnly: false, showsQueueCount: true },
  { label: 'Take Payment', to: '/take-payment', adminOnly: false },
  { label: 'Earnings', to: '/earnings', adminOnly: false },
  { label: 'My Rent', to: '/my-rent', adminOnly: false },
];

export function useNavigation() {
  const { mode } = useShopMode();
  const auth = useAuthStore();

  const items = computed<NavItem[]>(() => {
    const source = mode.value === 'shop' ? SHOP_NAV : CHAIR_NAV;
    return source.filter((item) => !item.adminOnly || auth.isAdmin);
  });

  return { items };
}

/** Every admin-only path, for the route guard. Derived so the two cannot drift. */
export const ADMIN_ONLY_PATHS: string[] = [...SHOP_NAV, ...CHAIR_NAV]
  .filter((item) => item.adminOnly)
  .map((item) => item.to);
