<script setup lang="ts">
/**
 * The numbered step rail.
 *
 * A finished step is filled with the accent and shows a tick; the current one is filled
 * charcoal and shows its number; the rest are outlined. Deliberately **not** a green
 * tick: this palette gives red exactly one job — failure — and amber one job — the
 * accent. Adding a third semantic colour for "done" would cost more than it buys.
 *
 * Finished steps are clickable, because the whole reason the summary rail exists is that
 * people change their minds; steps ahead are not, because they would open onto a screen
 * with nothing to show.
 */

import Check from '@primeicons/vue/check';

import { STEPS, type StepIndex } from '../composables/useBooking';

const booking = useBooking();

const items = computed(() =>
  STEPS.map((label, index) => {
    const number = (index + 1) as StepIndex;
    return {
      number,
      label,
      current: booking.step.value === number,
      done: number < booking.step.value && booking.completed.value[number],
      reachable: number <= booking.step.value,
    };
  }),
);
</script>

<template>
  <ol class="steps">
    <li v-for="item in items" :key="item.number" class="step">
      <button
        type="button"
        class="marker"
        :class="{ current: item.current, done: item.done }"
        :disabled="!item.reachable"
        :aria-current="item.current ? 'step' : undefined"
        :aria-label="`Step ${item.number}: ${item.label}`"
        @click="booking.goTo(item.number)"
      >
        <Check v-if="item.done" class="tick" aria-hidden="true" />
        <template v-else>{{ item.number }}</template>
      </button>
      <span class="label" :class="{ on: item.current || item.done }">{{ item.label }}</span>
    </li>
  </ol>
</template>

<style scoped>
.steps {
  list-style: none;
  margin: 0 0 2rem;
  padding: 0;
  display: flex;
  gap: 0.5rem;
}

.step {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4375rem;
  position: relative;
  min-width: 0;
}

/* The connecting line, drawn behind the markers rather than between them so it does
   not have to know how wide anything is. */
.step:not(:first-child)::before {
  content: '';
  position: absolute;
  top: 1rem;
  right: 50%;
  left: -50%;
  height: 1px;
  background: var(--fcb-line);
  z-index: 0;
}

.marker {
  position: relative;
  z-index: 1;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  border: 1px solid var(--fcb-line-strong);
  background: var(--fcb-surface);
  color: var(--fcb-ink-faint);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.marker:disabled {
  cursor: default;
}

.marker.current {
  background: var(--fcb-rail);
  border-color: var(--fcb-rail);
  color: var(--fcb-rail-ink);
}

.marker.done {
  background: var(--fcb-accent);
  border-color: var(--fcb-accent-line);
  color: var(--fcb-accent-ink);
}

.tick {
  width: 0.75rem;
  height: 0.75rem;
}

.label {
  font-size: 0.6875rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fcb-ink-faint);
  font-weight: 600;
  white-space: nowrap;
}

.label.on {
  color: var(--fcb-ink);
}

@media (max-width: 640px) {
  .steps {
    gap: 0.25rem;
  }

  /* The numbers still carry the position; the words are what has to go. */
  .label {
    display: none;
  }
}
</style>
