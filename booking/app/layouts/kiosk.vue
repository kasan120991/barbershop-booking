<script setup lang="ts">
/**
 * The kiosk shell.
 *
 * Shares nothing with the booking shell on purpose: no summary rail, no navigation, and
 * **no link out of here**. A tablet left on a counter should have nowhere to go — the
 * booking site, the confirmation pages and the cancel flow are all one tap away in a
 * browser that has an address bar, and none of them are things a stranger should reach
 * from the shop's own screen.
 *
 * Dark, unlike the rest of this app. It sits in a room rather than in a hand: a bright
 * white slab by the door at eight in the morning is a lamp, and this one is on for
 * twelve hours a day.
 */

/** The dot only needs the device, not the kiosk's menu. */
const screen = useDeviceScreen();
</script>

<template>
  <div class="kiosk-shell fcb-screen">
    <header class="bar">
      <div class="brand">
        <span class="pole" aria-hidden="true" />
        <span class="fcb-wordmark">Francis Cutz</span>
      </div>

      <!-- Deliberately quiet. It matters to whoever maintains the tablet and to nobody
           else, so it is a dot rather than a banner. -->
      <span
        class="link"
        :class="{ live: screen.connected.value }"
        :title="screen.connected.value ? 'Live' : 'Reconnecting'"
      >
        <i aria-hidden="true" />
      </span>
    </header>

    <main class="stage">
      <slot />
    </main>

    <Toast position="top-center" />
  </div>
</template>

<style scoped>
/* The ground and the field overrides come from `.fcb-screen` in main.css, shared with
   the wall display. Only the shape is local. */
.kiosk-shell {
  display: flex;
  flex-direction: column;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem clamp(1.25rem, 4vw, 2.5rem);
  border-bottom: 1px solid var(--fcb-rail-line);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.pole {
  width: 0.625rem;
  height: 1.75rem;
  border-radius: 1px;
  flex: none;
  background: repeating-linear-gradient(
    -45deg,
    var(--fcb-accent) 0 3px,
    var(--fcb-rail) 3px 6px
  );
}

.bar .fcb-wordmark {
  font-size: 0.9375rem;
  letter-spacing: 0.22em;
}

.link i {
  display: block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--fcb-rail-line);
}

.link.live i {
  background: var(--fcb-accent);
}

.stage {
  flex: 1;
  padding: clamp(1.5rem, 4vw, 3rem);
  display: flex;
  flex-direction: column;
}
</style>
