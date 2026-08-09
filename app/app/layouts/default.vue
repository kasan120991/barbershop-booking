<script setup lang="ts">
/**
 * The signed-in shell — the "Two hats" design.
 *
 * The owner runs the shop AND cuts hair, which are two jobs with two different
 * navigations. Rather than showing nine destinations to someone who needs four, the
 * rail asks which hat he is wearing and shows only that set. A barber-only account
 * has nothing to choose, so the switch is not rendered at all rather than disabled —
 * a greyed-out control still asks you to think about it.
 *
 * The known risk of this pattern is a user losing track of which mode they are in
 * and concluding a page has vanished. Three things guard against that: the switch
 * sits at the top of the rail, the current hat is named in words rather than implied
 * by an icon, and it survives collapsing (the collapsed rail still shows which hat
 * is on).
 */

import Bars from '@primeicons/vue/bars';
import Key from '@primeicons/vue/key';
import Refresh from '@primeicons/vue/refresh';
// Aliased deliberately: PrimeVue 5 ships its own `Sidebar` component, and an
// unaliased import would collide with the module's auto-import.
import SidebarIcon from '@primeicons/vue/sidebar';
import SignOut from '@primeicons/vue/sign-out';
import type { MenuItem } from 'primevue/menuitem';

const auth = useAuthStore();
const route = useRoute();
const { mode, canSwitch, setMode, homeRoute } = useShopMode();
const { items } = useNavigation();
const { collapsed, toggle: toggleRail } = useRailState();

const drawerOpen = ref(false);
const signingOut = ref(false);
const retrying = ref(false);
const accountMenu = useTemplateRef<{ toggle: (event: Event) => void }>('accountMenu');

/** The nav label of the current route, used as the page title in the top strip. */
const currentLabel = computed(
  () => items.value.find((item) => item.to === route.path)?.label ?? '',
);

const today = computed(() =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date()),
);

const accountItems = computed<MenuItem[]>(() => [
  {
    label: 'Change Password',
    // The forced-change screen's voluntary counterpart — same page, reached by
    // choice rather than by an admin reset.
    command: () => void navigateTo('/change-password?voluntary=1'),
  },
  {
    label: 'Sign Out',
    command: () => void onSignOut(),
  },
]);

async function onSignOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await auth.signOut();
    await navigateTo('/login');
  } finally {
    signingOut.value = false;
  }
}

async function onRetry() {
  retrying.value = true;
  try {
    await auth.retryConnection();
  } finally {
    retrying.value = false;
  }
}

async function onSwitchMode(next: 'shop' | 'chair') {
  if (next === mode.value) return;
  setMode(next);
  drawerOpen.value = false;
  // Land on the new hat's home rather than leaving them on a page that belongs to
  // the mode they just left.
  await navigateTo(next === 'shop' ? '/calendar' : '/my-day');
}
</script>

<template>
  <div class="shell" :class="{ 'is-collapsed': collapsed }">
    <!-- Desktop rail -->
    <aside class="rail">
      <NuxtLink :to="homeRoute" class="brand" :title="collapsed ? 'Francis Cutz' : undefined">
        <span class="fc-pole" aria-hidden="true" />
        <p v-if="!collapsed" class="fc-wordmark">Francis Cutz</p>
      </NuxtLink>

      <div
        v-if="canSwitch"
        class="mode-switch"
        :class="{ stacked: collapsed }"
        role="group"
        aria-label="Switch between running the shop and your own chair"
      >
        <button
          type="button"
          :class="{ on: mode === 'shop' }"
          :aria-pressed="mode === 'shop'"
          :title="collapsed ? 'Shop' : undefined"
          @click="onSwitchMode('shop')"
        >
          {{ collapsed ? 'S' : 'Shop' }}
        </button>
        <button
          type="button"
          :class="{ on: mode === 'chair' }"
          :aria-pressed="mode === 'chair'"
          :title="collapsed ? 'My Chair' : undefined"
          @click="onSwitchMode('chair')"
        >
          {{ collapsed ? 'C' : 'My Chair' }}
        </button>
      </div>

      <AppNav :collapsed="collapsed" />

      <div class="rail-foot">
        <button
          type="button"
          class="account"
          aria-haspopup="true"
          :title="auth.displayName"
          @click="accountMenu?.toggle($event)"
        >
          <span class="avatar" aria-hidden="true">{{ auth.initials }}</span>
          <span v-if="!collapsed" class="name">{{ auth.displayName }}</span>
        </button>
        <Menu ref="accountMenu" :model="accountItems" :popup="true" />
      </div>
    </aside>

    <div class="main">
      <!-- Narrow-screen bar. The rail is hidden below 760px; this replaces it. -->
      <div class="mobile-bar">
        <Button
          severity="secondary"
          variant="text"
          aria-label="Open navigation"
          @click="drawerOpen = true"
        >
          <Bars class="chev" aria-hidden="true" />
        </Button>
        <p class="fc-wordmark">Francis Cutz</p>
      </div>

      <header class="topstrip">
        <div class="lead">
          <!-- Lives here rather than in the rail: it is the control that acts ON the
               rail, so it stays put whether the rail is open or shut instead of
               shifting with the thing it toggles. The icon does not flip direction —
               the rail's own state already shows that, and aria-pressed carries it
               for anyone who cannot see it. -->
          <button
            type="button"
            class="collapse"
            :aria-label="collapsed ? 'Expand navigation' : 'Collapse navigation'"
            :aria-pressed="collapsed"
            :title="collapsed ? 'Expand navigation' : 'Collapse navigation'"
            @click="toggleRail"
          >
            <SidebarIcon class="chev" aria-hidden="true" />
          </button>

          <div class="titles">
            <h1 class="page-title">{{ currentLabel }}</h1>
            <p class="page-sub">{{ today }}</p>
          </div>
        </div>

        <!-- Placement reserved for the live queue count. Deliberately shows no
             number until the queue phase ships — a fabricated "3 waiting" on a
             screen barbers trust would be worse than an obvious placeholder. -->
        <span class="queue-pill" title="Goes live with the walk-in queue">
          <i aria-hidden="true" />
          <span>Queue not live yet</span>
        </span>
      </header>

      <!-- An outage is not a sign-out. The session is untouched and the user stays
           where they are; this says so and offers a way back. -->
      <div v-if="auth.connectionError" class="offline" role="alert">
        <span>Can't reach the server. Your session is still active.</span>
        <button type="button" :disabled="retrying" @click="onRetry">
          <Refresh class="chev" aria-hidden="true" />
          {{ retrying ? 'Retrying…' : 'Retry' }}
        </button>
      </div>

      <main class="content">
        <slot />
      </main>
    </div>

    <Drawer v-model:visible="drawerOpen" header="Menu" class="nav-drawer">
      <div class="drawer-inner">
        <div v-if="canSwitch" class="mode-switch">
          <button type="button" :class="{ on: mode === 'shop' }" @click="onSwitchMode('shop')">
            Shop
          </button>
          <button type="button" :class="{ on: mode === 'chair' }" @click="onSwitchMode('chair')">
            My Chair
          </button>
        </div>

        <AppNav touch @navigate="drawerOpen = false" />

        <div class="drawer-foot">
          <span class="avatar" aria-hidden="true">{{ auth.initials }}</span>
          <span class="name">{{ auth.displayName }}</span>
        </div>
        <Button severity="secondary" variant="outlined" fluid @click="onSignOut">
          <SignOut class="chev" aria-hidden="true" />
          Sign Out
        </Button>
        <Button severity="secondary" variant="text" fluid @click="navigateTo('/change-password?voluntary=1')">
          <Key class="chev" aria-hidden="true" />
          Change Password
        </Button>
      </div>
    </Drawer>

    <Toast position="bottom-right" />
  </div>
</template>

<style scoped>
.shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 13.5rem 1fr;
  background: var(--fc-ground);
  transition: grid-template-columns 140ms ease;
}

.shell.is-collapsed {
  grid-template-columns: 3.75rem 1fr;
}

.rail {
  background: var(--fc-surface);
  border-right: 1px solid var(--fc-line);
  padding: 1rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: hidden;
}

.shell.is-collapsed .rail {
  padding-inline: 0.5rem;
  align-items: stretch;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0 0.25rem;
  text-decoration: none;
}

.shell.is-collapsed .brand {
  justify-content: center;
  padding: 0;
}

.mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.1875rem;
  background: var(--fc-input);
  border: 1px solid var(--fc-line);
  border-radius: 6px;
  padding: 0.1875rem;
}

.mode-switch.stacked {
  grid-template-columns: 1fr;
}

.mode-switch button {
  font: inherit;
  font-size: 0.6875rem;
  padding: 0.3125rem 0.25rem;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--fc-ink-faint);
  cursor: pointer;
}

.mode-switch button.on {
  background: var(--fc-accent);
  color: var(--fc-accent-ink);
  font-weight: 650;
}

.mode-switch button:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.rail-foot {
  margin-top: auto;
  border-top: 1px solid var(--fc-line);
  padding-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-width: 0;
}

.account {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: 0;
  padding: 0.375rem 0.5rem;
  border-radius: 5px;
  font: inherit;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  cursor: pointer;
  min-width: 0;
}

.account:hover {
  color: var(--fc-ink);
  background: rgba(255, 255, 255, 0.03);
}

.account:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: -2px;
}

.shell.is-collapsed .account {
  justify-content: center;
  padding-inline: 0;
}

.chev {
  width: 0.875rem;
  height: 0.875rem;
  flex: none;
  color: inherit;
}

.avatar {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  background: var(--fc-input);
  border: 1px solid var(--fc-line);
  display: grid;
  place-items: center;
  font-size: 0.6875rem;
  color: var(--fc-ink-muted);
  font-weight: 650;
  flex: none;
}

.name {
  color: var(--fc-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.mobile-bar {
  display: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--fc-line);
  background: var(--fc-surface);
}

.topstrip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem clamp(1rem, 3vw, 1.75rem);
  border-bottom: 1px solid var(--fc-line);
}

.lead {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.collapse {
  display: grid;
  place-items: center;
  flex: none;
  width: 2rem;
  height: 2rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--fc-ink-faint);
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease;
}

.collapse:hover {
  color: var(--fc-ink);
  background: rgba(255, 255, 255, 0.04);
}

.collapse:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

/* Pressed = the rail is shut. Reads as "this is doing something right now". */
.collapse[aria-pressed='true'] {
  color: var(--fc-accent);
}

.titles {
  min-width: 0;
}

.page-title {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 1.0625rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.page-sub {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.queue-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4375rem;
  border: 1px solid var(--fc-line);
  border-radius: 999px;
  padding: 0.1875rem 0.625rem;
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  white-space: nowrap;
}

.queue-pill i {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: var(--fc-line);
  flex: none;
}

.offline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.625rem clamp(1rem, 3vw, 1.75rem);
  background: var(--fc-danger-bg);
  border-bottom: 1px solid var(--fc-danger-line);
  color: var(--fc-danger-ink);
  font-size: 0.8125rem;
}

.offline button {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  background: none;
  border: 1px solid var(--fc-danger-line);
  border-radius: 5px;
  padding: 0.25rem 0.625rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--fc-danger-ink);
  cursor: pointer;
}

.offline button:disabled {
  opacity: 0.6;
  cursor: default;
}

.content {
  flex: 1;
  padding: clamp(1.25rem, 3vw, 1.75rem);
  min-width: 0;
}

.drawer-inner {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.drawer-foot {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-top: 1px solid var(--fc-line);
  padding-top: 0.75rem;
  font-size: 0.8125rem;
}

@media (max-width: 760px) {
  .shell,
  .shell.is-collapsed {
    grid-template-columns: 1fr;
  }

  /* Replaced by the drawer rather than squeezed into a horizontal scroller. */
  .rail {
    display: none;
  }

  /* Nothing to collapse once the rail is gone — the drawer button replaces it. */
  .collapse {
    display: none;
  }

  .mobile-bar {
    display: flex;
  }
}
</style>
