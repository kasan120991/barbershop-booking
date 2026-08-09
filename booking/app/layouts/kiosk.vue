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

const kiosk = useKiosk();
</script>

<template>
  <div class="kiosk-shell">
    <header class="bar">
      <div class="brand">
        <span class="pole" aria-hidden="true" />
        <span class="fcb-wordmark">Francis Cutz</span>
      </div>

      <!-- Deliberately quiet. It matters to whoever maintains the tablet and to nobody
           else, so it is a dot rather than a banner. -->
      <span
        class="link"
        :class="{ live: kiosk.connected.value }"
        :title="kiosk.connected.value ? 'Live' : 'Reconnecting'"
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
.kiosk-shell {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  /* The staff app's ground, not the booking site's bone. */
  background: var(--fcb-rail);
  color: var(--fcb-rail-ink);
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

<!--
  Unscoped, but every selector is under `.kiosk-shell`, which only this layout applies.

  The app is themed light because the booking site is read in a hand; the kiosk is dark
  because it sits in a room and is on all day. PrimeVue's form fields therefore arrive
  white-on-white here, which is the one place the two decisions collide. Restyling them
  from the rail tokens is cheaper and less brittle than running a second PrimeVue theme
  for one route.
-->
<style>
.kiosk-shell .p-inputtext {
  background: var(--fcb-rail-raised);
  border-color: var(--fcb-rail-line);
  color: var(--fcb-rail-ink);
}

.kiosk-shell .p-inputtext::placeholder {
  color: var(--fcb-rail-muted);
}

.kiosk-shell .p-inputtext:enabled:focus {
  border-color: var(--fcb-accent);
}

.kiosk-shell .p-inputtext.p-invalid {
  border-color: #d2645c;
}

/* Messages on this screen are refusals — "code expired", "already in the queue" — and
   have to be legible against charcoal rather than against the bone they were designed
   for. */
.kiosk-shell .p-message {
  background: var(--fcb-rail-raised);
  border-color: var(--fcb-rail-line);
  color: var(--fcb-rail-ink);
}

.kiosk-shell .p-message-error {
  border-color: rgba(210, 100, 92, 0.5);
  color: #eab8b3;
}
</style>
