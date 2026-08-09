<script setup lang="ts">
/**
 * The "Chair" layout — identity and shop information on the left, form on the right.
 *
 * The left pane is a SLOT, not fixed markup. Once the queue phase ships, the live
 * count ("3 waiting · next at 10:45") belongs there, turning this screen into the
 * shop's status board rather than just a door.
 *
 * It collapses below 720px, so it must never carry anything essential — everything
 * required to sign in lives on the right.
 */

// Placeholder until the shop-hours endpoint exists in the catalog phase.
const hours = [
  { days: 'Tue–Thu', time: '10:00 – 19:00' },
  { days: 'Friday', time: '09:00 – 20:00' },
  { days: 'Saturday', time: '09:00 – 17:00' },
  { days: 'Sun & Mon', time: 'Closed' },
];
</script>

<template>
  <div class="auth-shell">
    <aside class="brand-pane">
      <div class="brand">
        <span class="fc-pole" aria-hidden="true" />
        <p class="fc-wordmark">Francis Cutz</p>
      </div>

      <p class="display">
        Open the
        <em>shop</em>
      </p>

      <slot name="aside">
        <div class="hours">
          <div v-for="row in hours" :key="row.days" class="hours-row">
            <span>{{ row.days }}</span>
            <span>{{ row.time }}</span>
          </div>
        </div>
      </slot>
    </aside>

    <main class="form-pane">
      <div class="form-inner">
        <slot />
      </div>
    </main>

    <!-- Also mounted here: the change-password screen uses this layout and needs to
         confirm success before it navigates away. -->
    <Toast position="bottom-right" />
  </div>
</template>

<style scoped>
.auth-shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  background: var(--fc-ground);
}

.brand-pane {
  background: linear-gradient(180deg, var(--fc-accent-wash), transparent 60%), var(--fc-ground);
  border-right: 1px solid var(--fc-line);
  padding: clamp(1.5rem, 4vw, 3rem);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 2rem;
  position: relative;
  overflow: hidden;
}

/* Barber pole abstracted to a single edge stripe rather than a literal prop. */
.brand-pane::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: repeating-linear-gradient(-45deg, var(--fc-accent) 0 6px, transparent 6px 12px);
  opacity: 0.55;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.display {
  margin: 0;
  font-family: var(--fc-font-display);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: clamp(1.5rem, 3.4vw, 2.5rem);
  line-height: 1.15;
  text-wrap: balance;
}

.display em {
  font-style: normal;
  color: var(--fc-accent);
  display: block;
}

.hours {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.hours-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  border-bottom: 1px dotted var(--fc-line-soft);
  padding-bottom: 0.25rem;
}

.hours-row span:last-child {
  color: var(--fc-ink-muted);
}

.form-pane {
  background: var(--fc-surface);
  padding: clamp(1.5rem, 4vw, 3rem);
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.form-inner {
  width: min(24rem, 100%);
  margin-inline: auto;
}

@media (max-width: 720px) {
  .auth-shell {
    grid-template-columns: 1fr;
  }

  /* Nothing essential lives here, so hiding it costs nothing. */
  .brand-pane {
    display: none;
  }
}
</style>
