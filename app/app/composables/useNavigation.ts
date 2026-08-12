/**
 * The navigation model, keyed by mode.
 *
 * Data rather than markup, so the layout stays a renderer and adding a destination
 * is a one-line change in one place. The rail and the mobile drawer both render this
 * same list through `AppNav`, so they cannot drift apart.
 *
 * `adminOnly` here drives what is *shown*. It is not the access control — the route
 * guard enforces it, and the API enforces it again. Hiding a link is a courtesy, not
 * a boundary.
 */

import AddressBook from '@primeicons/vue/address-book';
import CalendarClock from '@primeicons/vue/calendar-clock';
import Calendar from '@primeicons/vue/calendar';
import ChartBar from '@primeicons/vue/chart-bar';
import Clock from '@primeicons/vue/clock';
import CreditCard from '@primeicons/vue/credit-card';
import Dollar from '@primeicons/vue/dollar';
import Home from '@primeicons/vue/home';
import Sun from '@primeicons/vue/sun';
import Tablet from '@primeicons/vue/tablet';
import Users from '@primeicons/vue/users';
import Wallet from '@primeicons/vue/wallet';
import type { Component } from 'vue';

export interface NavItem {
  label: string;
  to: string;
  icon: Component;
  adminOnly: boolean;
  /** Renders the live queue count beside the label. */
  showsQueueCount?: boolean;
}

const SHOP_NAV: NavItem[] = [
  { label: 'Calendar', to: '/calendar', icon: Calendar, adminOnly: true },
  { label: 'Walk-in Queue', to: '/queue', icon: Users, adminOnly: false, showsQueueCount: true },
  { label: 'Clients', to: '/clients', icon: AddressBook, adminOnly: true },
  { label: 'Services & Hours', to: '/services', icon: Clock, adminOnly: true },
  { label: 'Barbers & Rent', to: '/barbers', icon: Wallet, adminOnly: true },
  { label: 'Screens', to: '/devices', icon: Tablet, adminOnly: true },
  { label: 'Reports', to: '/reports', icon: ChartBar, adminOnly: true },
];

const CHAIR_NAV: NavItem[] = [
  /**
   * "Today" is the chair right now — free or not, who is next, what has been taken.
   * "Schedule" is the book. They were one screen called My Day, and a barber signing in
   * on a phone needed the first without scrolling past the second.
   */
  { label: 'Today', to: '/today', icon: Sun, adminOnly: false },
  { label: 'Schedule', to: '/my-day', icon: CalendarClock, adminOnly: false },
  { label: 'Walk-in Queue', to: '/queue', icon: Users, adminOnly: false, showsQueueCount: true },
  { label: 'Take Payment', to: '/take-payment', icon: CreditCard, adminOnly: false },
  { label: 'Earnings', to: '/earnings', icon: Dollar, adminOnly: false },
  { label: 'My Rent', to: '/my-rent', icon: Home, adminOnly: false },
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

/**
 * What to call a page, whichever hat is on.
 *
 * The top strip names the current screen from the nav model, and looking it up in only
 * the *current* mode's list leaves the strip blank whenever the two disagree — an admin
 * in shop mode opening a chair page, which is exactly what the mode switch does on the
 * way through. Both lists, one answer.
 */
export function navLabelFor(path: string): string {
  return [...SHOP_NAV, ...CHAIR_NAV].find((item) => item.to === path)?.label ?? '';
}

/** Every admin-only path, for the route guard. Derived so the two cannot drift. */
export const ADMIN_ONLY_PATHS: string[] = [...SHOP_NAV, ...CHAIR_NAV]
  .filter((item) => item.adminOnly)
  .map((item) => item.to);
