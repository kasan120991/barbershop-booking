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
 * and concluding a page has vanished. Two things guard against that: the switch sits
 * at the top of the rail where it cannot be missed, and the current hat is named in
 * words rather than implied by an icon.
 */

const auth = useAuthStore();
const route = useRoute();
const { mode, canSwitch, setMode, homeRoute } = useShopMode();
const { items } = useNavigation();

const signingOut = ref(false);

const initials = computed(() => {
  const user = auth.user;
  if (!user) return '';
  return `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase();
});

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

async function onSwitchMode(next: 'shop' | 'chair') {
  if (next === mode.value) return;
  setMode(next);
  // Land on the new hat's home rather than leaving them on a page that belongs to
  // the mode they just left.
  await navigateTo(next === 'shop' ? '/calendar' : '/my-day');
}
</script>

<template>
  <div class="shell">
    <aside class="rail">
      <NuxtLink :to="homeRoute" class="brand">
        <span class="fc-pole" aria-hidden="true" />
        <p class="fc-wordmark">Francis Cutz</p>
      </NuxtLink>

      <div v-if="canSwitch" class="mode">
        <div class="mode-switch" role="group" aria-label="Switch between running the shop and your own chair">
          <button
            type="button"
            :class="{ on: mode === 'shop' }"
            :aria-pressed="mode === 'shop'"
            @click="onSwitchMode('shop')"
          >
            Shop
          </button>
          <button
            type="button"
            :class="{ on: mode === 'chair' }"
            :aria-pressed="mode === 'chair'"
            @click="onSwitchMode('chair')"
          >
            My chair
          </button>
        </div>
        <p class="mode-hint">You run the shop and cut hair.</p>
      </div>

      <nav aria-label="Main">
        <NuxtLink
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ 'is-active': route.path === item.to }"
        >
          <span class="dot" aria-hidden="true" />
          <span class="nav-label">{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="rail-foot">
        <span class="avatar" aria-hidden="true">{{ initials }}</span>
        <div class="who">
          <p class="name">{{ auth.displayName }}</p>
          <button type="button" class="signout" :disabled="signingOut" @click="onSignOut">
            {{ signingOut ? 'Signing out…' : 'Sign out' }}
          </button>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topstrip">
        <div>
          <h1 class="page-title">{{ currentLabel }}</h1>
          <p class="page-sub">{{ today }}</p>
        </div>

        <!-- Placement reserved for the live queue count. Deliberately shows no
             number until the queue phase ships — a fabricated "3 waiting" on a
             screen barbers trust would be worse than an obvious placeholder. -->
        <span class="queue-pill" title="Goes live with the walk-in queue">
          <i aria-hidden="true" />
          <span>Queue not live yet</span>
        </span>
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 13.5rem 1fr;
  background: var(--fc-ground);
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

.brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0 0.25rem;
  text-decoration: none;
}

.mode {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
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

.mode-hint {
  margin: 0;
  padding: 0 0.25rem;
  font-size: 0.625rem;
  color: var(--fc-ink-faint);
}

nav {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4375rem 0.625rem;
  border-radius: 5px;
  color: var(--fc-ink-muted);
  text-decoration: none;
  font-size: 0.8125rem;
}

.nav-item:hover {
  color: var(--fc-ink);
  background: rgba(255, 255, 255, 0.03);
}

.nav-item .dot {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 3px;
  background: var(--fc-line);
  flex: none;
}

.nav-item.is-active {
  background: var(--fc-accent-wash);
  color: var(--fc-ink);
}

.nav-item.is-active .dot {
  background: var(--fc-accent);
}

.rail-foot {
  margin-top: auto;
  border-top: 1px solid var(--fc-line);
  padding-top: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
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

.who {
  min-width: 0;
}

.name {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.signout {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.signout:hover:not(:disabled) {
  color: var(--fc-accent);
}

.signout:disabled {
  cursor: default;
  opacity: 0.6;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.topstrip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem clamp(1rem, 3vw, 1.75rem);
  border-bottom: 1px solid var(--fc-line);
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

.content {
  flex: 1;
  padding: clamp(1.25rem, 3vw, 1.75rem);
  min-width: 0;
}

@media (max-width: 760px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .rail {
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    border-right: 0;
    border-bottom: 1px solid var(--fc-line);
    overflow-x: auto;
  }

  .rail nav {
    flex-direction: row;
  }

  .mode-hint,
  .who {
    display: none;
  }

  .rail-foot {
    margin-top: 0;
    margin-left: auto;
    border-top: 0;
    padding-top: 0;
  }
}
</style>
