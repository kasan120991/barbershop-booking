<script setup lang="ts">
/**
 * The card inside a time-grid block — name on the first line, time and services
 * on the second. The shell (position, border, state colours) belongs to
 * `TimeGrid.vue`; this is only the words, so both calendar views say things the
 * same way.
 */

import type { CalendarBlockData } from '~/composables/useCalendarColumns';

const props = defineProps<{
  data: CalendarBlockData;
  /** Room for the second line — a 15-minute block keeps to its first. */
  showDetail: boolean;
}>();

const shop = useShopClock();

const tag = computed<{ kind: string; label: string } | null>(() => {
  const { status, projected, moving, next } = props.data;
  if (status === 'IN_CHAIR' || status === 'IN_PROGRESS') {
    return { kind: 'live', label: 'In the chair' };
  }
  if (projected && status === 'CALLED') return { kind: 'next', label: 'Called' };
  if (status === 'CANCELLED') return { kind: 'bad', label: 'Cancelled' };
  if (status === 'NO_SHOW') return { kind: 'bad', label: 'No-show' };
  if (moving) return { kind: '', label: 'Walk-in' };
  if (next) return { kind: 'next', label: 'Next' };
  return null;
});

const times = computed(() => {
  const start = new Date(props.data.startAt);
  const end =
    props.data.endAt !== null
      ? new Date(props.data.endAt)
      : new Date(start.getTime() + props.data.durationMinutes * 60_000);
  return `${shop.clock(start)}–${shop.clock(end)}`;
});
</script>

<template>
  <span class="l1" :class="{ struck: data.status === 'CANCELLED' || data.status === 'NO_SHOW' }">
    {{ data.clientName }}
    <span v-if="tag" class="tag" :class="tag.kind">{{ tag.label }}</span>
  </span>
  <span v-if="showDetail" class="l2">
    <template v-if="data.moving">≈ </template>{{ times }} · {{ data.services }}
  </span>
</template>

<style scoped>
.l1 {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.l1.struck {
  text-decoration: line-through;
}
.l2 {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.6875rem;
  line-height: 1.35;
  color: var(--fc-ink-muted);
  font-variant-numeric: tabular-nums;
}

.tag {
  display: inline-block;
  vertical-align: 1px;
  margin-left: 0.3rem;
  font-size: 0.5rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 660;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  border: 1px solid var(--fc-line);
  color: var(--fc-ink-faint);
}
.tag.live {
  background: var(--fc-accent);
  color: var(--fc-accent-ink);
  border-color: transparent;
}
.tag.next {
  color: var(--fc-accent);
  border-color: var(--fc-accent);
}
/* Red is failure only. A cancellation is the one thing here that qualifies. */
.tag.bad {
  color: var(--fc-danger-ink);
  border-color: var(--fc-danger-line);
}
</style>
