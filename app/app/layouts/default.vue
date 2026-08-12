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
const { collapsed, toggle: toggleRail } = useRailState();

/**
 * The shell owns the one socket connection for the whole app.
 *
 * It lives here rather than on `/queue` because the count in the rail and the pill
 * above have to stay honest on every screen — a barber taking a payment still needs to
 * see the line growing.
 *
 * The poll has not gone away, it has slowed to a minute. Socket.IO reconnects by
 * itself, so this is not there for a connection that drops loudly; it is there for the
 * one that dies quietly and keeps reporting itself healthy, where a frozen board looks
 * exactly like a quiet morning.
 *
 * Deliberately NOT awaited. A top-level `await` here makes the whole layout an async
 * component, and `useTemplateRef` below then runs without an instance context and
 * throws — taking the entire shell down with it. The live count is rendered inside
 * `<ClientOnly>` instead, which is also what keeps the server and the client agreeing
 * on it: the page's own SSR fetch can populate the board *after* this template has
 * already rendered, so a server-rendered count would hydrate to a different number.
 */
const queue = useQueue();
const realtime = useRealtime();
realtime.connect();
queue.poll(60_000);

const drawerOpen = ref(false);
const signingOut = ref(false);
const retrying = ref(false);
const accountMenu = useTemplateRef<{ toggle: (event: Event) => void }>('accountMenu');

/** The nav label of the current route, used as the page title in the top strip. */
const currentLabel = computed(() => navLabelFor(route.path));

/**
 * The shop's date, not the browser's.
 *
 * This formatted `new Date()` with no zone, which is the one rule `useShopClock` exists
 * to enforce: a barber checking the book from another state was told the shop's day was
 * the one their own phone was on. It also disagreed with the server-rendered pass — the
 * Nuxt process runs in the machine's zone — so far enough west it hydrated as a Vue
 * mismatch and the strip changed date under the reader.
 *
 * Client-only for the same reason the queue pill below is: the value is derived from
 * this instant, and the server's instant and the browser's are not the same one. The
 * fallback holds the line's height so the strip does not jump when it fills in.
 */
const shop = useShopClock();
const today = computed(() => shop.longDate(shop.today()));

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
  // the mode they just left. `homeRouteFor` rather than the computed: the cookie has
  // only just been written, so the computed still answers for the mode being left.
  await navigateTo(homeRouteFor(next));
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
            <ClientOnly>
              <p class="page-sub">{{ today }}</p>
              <template #fallback>
                <p class="page-sub">&nbsp;</p>
              </template>
            </ClientOnly>
          </div>
        </div>

        <!-- Live from here on. Reads "Queue is clear" at zero rather than "0 waiting":
             an empty line is a state worth stating plainly, not a null value.

             Client-only, with the empty state as the fallback so the pill occupies its
             space from the first frame and the number fills in rather than the layout
             jumping. -->
        <ClientOnly>
          <NuxtLink
            to="/queue"
            class="queue-pill"
            :class="{ active: queue.waitingCount.value > 0 }"
            :title="
              queue.waitingCount.value > 0 ? 'Go to the walk-in queue' : 'Nobody is waiting'
            "
          >
            <i aria-hidden="true" />
            <span v-if="queue.waitingCount.value > 0">
              {{ queue.waitingCount.value }} waiting
            </span>
            <span v-else>Queue is clear</span>
          </NuxtLink>

          <template #fallback>
            <span class="queue-pill">
              <i aria-hidden="true" />
              <span>Queue is clear</span>
            </span>
          </template>
        </ClientOnly>
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

    <!-- Sized here rather than in CSS: the drawer is teleported to `<body>`, so a scoped
         rule would not reach it. PrimeVue's default 20rem leaves about 70px of page
         showing on a 390px phone, which reads as a broken overlay rather than a menu. -->
    <Drawer
      v-model:visible="drawerOpen"
      header="Menu"
      class="nav-drawer"
      :style="{ width: 'min(19rem, 84vw)' }"
    >
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
    <!-- One global confirm host, alongside Toast. `ConfirmationService` is already
         registered by the PrimeVue module; this is the surface it renders into. -->
    <ConfirmDialog />
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

/* The only way to reach navigation on a narrow screen, and a touch target — it needs
   to be findable at arm's length on the counter tablet, and big enough to hit. */
.mobile-bar .chev {
  width: 1.375rem;
  height: 1.375rem;
}

.mobile-bar button {
  min-width: 44px;
  min-height: 44px;
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
  width: 2.125rem;
  height: 2.125rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--fc-ink-faint);
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease;
}

/* `.chev` is sized for icons sitting inline with small text. This one stands alone
   beside a 17px title, so at that size it read as an afterthought — and was smaller
   than the nav icons it controls. */
.collapse .chev {
  width: 1.25rem;
  height: 1.25rem;
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

.queue-pill {
  text-decoration: none;
  transition: color 120ms ease, border-color 120ms ease;
}

.queue-pill:hover {
  color: var(--fc-ink-muted);
  border-color: var(--fc-ink-faint);
}

.queue-pill:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 2px;
}

/* Amber only when there is somebody to see. A pill that is always lit stops being a
   signal and becomes decoration, and amber has one job in this app. */
.queue-pill.active {
  color: var(--fc-accent);
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

.queue-pill.active i {
  background: var(--fc-accent);
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

  /**
   * The bar and the strip stay put while the page scrolls.
   *
   * On a phone the drawer button is the ONLY way to reach navigation, and it used to
   * scroll away with everything else — a barber working down their day lost the way out
   * of the screen they were on. The two stick together rather than only the bar, because
   * the strip carries the page's name and a title sliding out from under a bar that
   * stayed is worse than neither sticking.
   *
   * Low z-indexes on purpose: PrimeVue teleports the drawer, toasts and dialogs to
   * `<body>` and they must stay above these.
   */
  .mobile-bar {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 20;
  }

  .topstrip {
    position: sticky;
    /* The bar's own height: a 44px target plus its 0.5rem padding and 1px border. */
    top: calc(44px + 1rem + 1px);
    z-index: 19;
    /* The bar has a surface of its own; this one had none and content showed through. */
    background: var(--fc-ground);
  }

  /*
   * A thumb's target, not a pointer's. The type stays 11px — that is the eye's problem,
   * and the pill is deliberately quiet.
   */
  .queue-pill {
    min-height: 44px;
    padding-inline: 0.875rem;
  }
}

/*
 * The mode switch lives in the drawer on a phone, which is exactly where a target being
 * too small matters most. Scoped by pointer rather than width, the same way `AppNav` does
 * it, so a touch-screen till gets the same treatment at any size.
 */
@media (pointer: coarse) {
  .mode-switch button {
    min-height: 44px;
  }
}
</style>
