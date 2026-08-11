<script setup lang="ts">
/**
 * Calendar — for now, a read-only window onto the availability engine.
 *
 * The full calendar is Phase 9. This exists because the slot engine is the most
 * intricate logic in the system and "the tests pass" is a lot to take on trust: pick
 * a barber, a date and a service, and see exactly what a client would be offered.
 *
 * It also surfaces the engine's own explanation when a day is empty, so "no slots"
 * is never a shrug — closed, fully booked, or too far ahead all read differently.
 */

import { formatDuration, type AvailabilityResponse } from '@francis/shared';

useHead({ title: 'Calendar — Francis Cutz' });

const api = useApi();
const catalog = useCatalog();
const shop = useShopClock();
const { notifyApiFailure } = useNotify();

await catalog.refresh();
await shop.ensureLoaded();

const barberId = ref<string | null>(null);
const serviceIds = ref<string[]>([]);
const date = ref('');
const result = ref<AvailabilityResponse | null>(null);
const loading = ref(false);

/** Defaults that show something useful immediately rather than an empty form. */
onMounted(() => {
  barberId.value ??= catalog.barbers.value[0]?.id ?? null;
  const firstBookable = catalog.services.value.find((service) => service.isActive);
  if (serviceIds.value.length === 0 && firstBookable) serviceIds.value = [firstBookable.id];
  if (!date.value) date.value = new Date().toISOString().slice(0, 10);
});

const activeServices = computed(() => catalog.services.value.filter((service) => service.isActive));

const totalDuration = computed(() =>
  activeServices.value
    .filter((service) => serviceIds.value.includes(service.id))
    .reduce((total, service) => total + service.durationMinutes, 0),
);

/**
 * Slots arrive as UTC instants and are rendered in the SHOP's zone, not the browser's.
 * That helper used to live here and identically in `queue.vue`; it is `useShopClock`
 * now, which is also what turns a date into the instants a range endpoint wants.
 */
const shopTimezone = shop.timezone;
const localTime = shop.clock;

async function load() {
  if (!barberId.value || serviceIds.value.length === 0 || !date.value) return;

  loading.value = true;
  try {
    result.value = await api<AvailabilityResponse>('/availability', {
      query: {
        barberId: barberId.value,
        date: date.value,
        serviceIds: serviceIds.value.join(','),
      },
    });
  } catch (error) {
    result.value = null;
    notifyApiFailure(error);
  } finally {
    loading.value = false;
  }
}

// Re-query whenever any input changes — the whole point is to poke at it.
watch([barberId, serviceIds, date], load, { deep: true });
onMounted(load);

const dayLabel = computed(() => {
  if (!date.value) return '';
  // Parsed as UTC then rendered in the shop zone would shift the day, so the parts
  // are read directly from the string.
  const [year, month, day] = date.value.split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
});
</script>

<template>
  <div class="calendar">
    <section class="controls">
      <div class="field">
        <label for="cal-barber" class="fc-label">Barber</label>
        <Select
          id="cal-barber"
          v-model="barberId"
          :options="catalog.barbers.value"
          option-label="displayName"
          option-value="id"
          placeholder="Pick a barber"
          fluid
        />
      </div>

      <div class="field">
        <label for="cal-date" class="fc-label">Date</label>
        <input id="cal-date" v-model="date" type="date" class="fc-input">
      </div>

      <div class="field grow">
        <label for="cal-services" class="fc-label">Services</label>
        <MultiSelect
          id="cal-services"
          v-model="serviceIds"
          :options="activeServices"
          option-label="name"
          option-value="id"
          display="chip"
          placeholder="Pick at least one"
          fluid
        />
      </div>
    </section>

    <section class="results">
      <header class="results-head">
        <div>
          <h2>{{ dayLabel }}</h2>
          <p class="sub">
            {{ formatDuration(totalDuration) }}
            <template v-if="result"> · {{ result.slots.length }} openings</template>
            · times shown in {{ shopTimezone }}
          </p>
        </div>
        <ProgressSpinner v-if="loading" style="width: 1.25rem; height: 1.25rem" :stroke-width="6" />
      </header>

      <div v-if="result && result.slots.length" class="slots">
        <span v-for="slot in result.slots" :key="slot" class="slot">{{ localTime(slot) }}</span>
      </div>

      <!-- The engine explains itself: closed, booked out, or beyond the horizon each
           read differently, which is what makes this reviewable rather than opaque. -->
      <Message v-else-if="result" severity="secondary" :closable="false">
        {{ result.reason ?? 'Nothing available.' }}
      </Message>

      <p v-else class="sub">Pick a barber, a date and at least one service.</p>
    </section>

    <p class="footnote">
      Read-only for now — booking from the calendar arrives with the admin views. Availability
      already accounts for shop hours, closures, this barber's shifts and time off, existing
      appointments, the turnaround buffer, and the minimum notice window.
    </p>
  </div>
</template>

<style scoped>
.calendar {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  max-width: 60rem;
}

.controls {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: flex-end;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 12rem;
}

.field.grow {
  flex: 1;
  min-width: 16rem;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 1.25rem;
}

.results-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.results-head h2 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 1rem;
  font-weight: 650;
}

.sub {
  margin: 0.125rem 0 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
}

.slots {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.slot {
  border: 1px solid var(--fc-line);
  background: var(--fc-input);
  border-radius: 5px;
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  color: var(--fc-ink-muted);
}

.footnote {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  max-width: 62ch;
}
</style>
