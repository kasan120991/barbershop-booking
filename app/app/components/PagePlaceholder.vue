<script setup lang="ts">
/**
 * Stands in for a screen that has not been built yet.
 *
 * These exist so the shell is real: nav items navigate, active states highlight, and
 * the mode switch demonstrably changes where you can go. Each is replaced wholesale
 * by its phase — none of this is scaffolding that has to be unpicked later.
 */

defineProps<{
  /** Which build phase fills this in, so the placeholder is honest about the plan. */
  phase: string;
  /** One line on what the finished screen does. */
  summary: string;
}>();
</script>

<template>
  <section class="placeholder">
    <p class="phase">{{ phase }}</p>
    <p class="summary">{{ summary }}</p>
    <ul v-if="$slots.default" class="points">
      <slot />
    </ul>
  </section>
</template>

<style scoped>
.placeholder {
  border: 1px dashed var(--fc-line);
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 46rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.phase {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fc-accent);
}

.summary {
  margin: 0;
  color: var(--fc-ink);
}

.points {
  margin: 0.25rem 0 0;
  padding-left: 1.125rem;
  color: var(--fc-ink-muted);
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
</style>
