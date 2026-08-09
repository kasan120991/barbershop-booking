<script setup lang="ts">
/**
 * Cancelling, by opaque token.
 *
 * It shows what is about to be cancelled before offering the button. A page that just
 * says "cancel your appointment?" is asking somebody to take an irreversible action on
 * trust — and it was the only page possible until the token could be read back.
 *
 * The API refuses a cancellation inside the notice window with a sentence written to be
 * read ("It is too close to your appointment to cancel online. Please call the shop.").
 * That message is surfaced verbatim rather than flattened into a generic failure, and
 * the shop's number is put next to it, because at that point calling is the only thing
 * left to do.
 */

import { formatCents, type BookingConfirmationDto } from '@francis/shared';

const route = useRoute();
const api = useApi();
const booking = useBooking();

const token = computed(() => String(route.params.token ?? ''));

await booking.load();

const { data, error } = await useAsyncData(`cancel:${token.value}`, () =>
  api<{ booking: BookingConfirmationDto; status: string }>(`/appointments/token/${token.value}`),
);

useHead({ title: 'Cancel your appointment — Francis Cutz' });

const working = ref(false);
const refusal = ref<string | null>(null);
const done = ref(false);

const alreadyGone = computed(
  () => data.value?.status === 'CANCELLED' || data.value?.status === 'COMPLETED',
);

const when = computed(() => {
  const startAt = data.value?.booking.startAt;
  if (!startAt) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: booking.timezone.value,
  }).format(new Date(startAt));
});

const shopPhone = computed(() => booking.settings.value?.phone ?? null);

async function cancel(): Promise<void> {
  if (working.value) return;
  working.value = true;
  refusal.value = null;

  try {
    await api(`/appointments/cancel/${token.value}`, { method: 'POST' });
    done.value = true;
  } catch (caught) {
    refusal.value = toApiFailure(caught).message;
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div v-if="error" class="empty">
      <h1>That link is not valid.</h1>
      <p>It may have been mistyped, or the appointment may already be gone.</p>
      <NuxtLink to="/"><Button label="Book an Appointment" /></NuxtLink>
    </div>

    <template v-else-if="data">
      <template v-if="done">
        <h1>Cancelled.</h1>
        <p class="sub">That time is free again. Nothing is owed.</p>
        <NuxtLink to="/"><Button label="Book Another" /></NuxtLink>
      </template>

      <template v-else-if="alreadyGone">
        <h1>Nothing to cancel.</h1>
        <p class="sub">This appointment is already {{ data.status.toLowerCase() }}.</p>
        <NuxtLink to="/"><Button label="Book an Appointment" /></NuxtLink>
      </template>

      <template v-else>
        <h1>Cancel this appointment?</h1>
        <p class="sub">This cannot be undone, but you can always book again.</p>

        <div class="card">
          <div class="row">
            <span class="k">When</span>
            <span class="v fcb-num">{{ when }}</span>
          </div>
          <div class="row">
            <span class="k">With</span>
            <span class="v">{{ data.booking.barberName }}</span>
          </div>
          <div class="row">
            <span class="k">Service</span>
            <span class="v">
              {{ data.booking.services.map((service) => service.name).join(' + ') }}
            </span>
          </div>
          <div class="row">
            <span class="k">Price</span>
            <span class="v fcb-num">{{ formatCents(data.booking.priceCentsTotal) }}</span>
          </div>
        </div>

        <!-- The server's own sentence, not a generic failure. -->
        <Message v-if="refusal" severity="warn" :closable="false">
          {{ refusal }}
          <template v-if="shopPhone">
            <a :href="`tel:${shopPhone}`" class="fcb-num call">{{ shopPhone }}</a>
          </template>
        </Message>

        <div class="actions">
          <Button
            label="Yes, Cancel It"
            severity="danger"
            :loading="working"
            @click="cancel"
          />
          <NuxtLink :to="`/booked/${token}`" class="keep-link">Keep my appointment</NuxtLink>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.page {
  max-width: 34rem;
  /* Centred, matching the flow — the column must not shift between steps. */
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  align-items: flex-start;
}

h1 {
  margin: 0;
  font-family: var(--fcb-font-display);
  font-size: clamp(1.5rem, 3vw, 1.875rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.sub {
  margin: 0;
  color: var(--fcb-ink-muted);
}

.card {
  align-self: stretch;
  border: 1px solid var(--fcb-line);
  border-radius: var(--fcb-radius);
  background: var(--fcb-surface);
  padding: 0.5rem 1.125rem;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--fcb-line);
}

.row:last-child {
  border-bottom: none;
}

.k {
  font-size: 0.875rem;
  color: var(--fcb-ink-muted);
  flex: none;
}

.v {
  font-weight: 600;
  text-align: right;
}

.actions {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.keep-link {
  color: var(--fcb-ink-muted);
  font-size: 0.875rem;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.keep-link:hover {
  color: var(--fcb-ink);
}

.call {
  margin-left: 0.375rem;
  color: inherit;
  font-weight: 650;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: flex-start;
}

.empty p {
  margin: 0;
  color: var(--fcb-ink-muted);
}
</style>
