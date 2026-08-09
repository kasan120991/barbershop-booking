<script setup lang="ts">
/**
 * The confirmation.
 *
 * The URL carries the cancel token, which makes this page the whole self-service story:
 * bookmark it, or keep the tab, and it still works tomorrow. That is only possible
 * because the token can now be read back — until this phase it was write-only, and a
 * confirmation could only ever be a screen you saw once and lost.
 *
 * The token IS the credential, so this page is careful about what it shows. It carries
 * nothing the holder did not type in themselves: no phone number, no surname.
 */

import Check from '@primeicons/vue/check';
import { formatCents, type BookingConfirmationDto } from '@francis/shared';

const route = useRoute();
const api = useApi();
const booking = useBooking();

const token = computed(() => String(route.params.token ?? ''));

await booking.load();

const { data, error } = await useAsyncData(`booked:${token.value}`, () =>
  api<{ booking: BookingConfirmationDto; status: string }>(`/appointments/token/${token.value}`),
);

useHead({ title: 'Your appointment — Francis Cutz' });

const cancelled = computed(() => data.value?.status === 'CANCELLED');

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
</script>

<template>
  <div class="page">
    <div v-if="error" class="empty">
      <h1>That link is not valid.</h1>
      <p>It may have been mistyped, or the appointment may have been removed.</p>
      <NuxtLink to="/"><Button label="Book an Appointment" /></NuxtLink>
    </div>

    <template v-else-if="data">
      <header class="head">
        <span class="mark" :class="{ off: cancelled }" aria-hidden="true">
          <Check v-if="!cancelled" class="tick" />
          <span v-else class="dash" />
        </span>
        <div>
          <h1>{{ cancelled ? 'Cancelled' : "You're booked" }}</h1>
          <p class="sub">
            <template v-if="cancelled">
              This appointment has been cancelled. Nothing is owed.
            </template>
            <template v-else>
              We'll see you then. There is nothing to pay until after your cut.
            </template>
          </p>
        </div>
      </header>

      <div class="card" :class="{ off: cancelled }">
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
        <div class="row total">
          <span class="k">To pay in the shop</span>
          <span class="v fcb-num">{{ formatCents(data.booking.priceCentsTotal) }}</span>
        </div>
      </div>

      <div v-if="!cancelled" class="actions">
        <NuxtLink :to="`/cancel/${token}`" class="cancel-link">Cancel this appointment</NuxtLink>
        <p class="keep">
          Keep this page — it is the only link back to your booking, and it works later too.
        </p>
      </div>

      <NuxtLink v-else to="/"><Button label="Book Another" /></NuxtLink>
    </template>
  </div>
</template>

<style scoped>
.page {
  max-width: 34rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
}

.mark {
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--fcb-accent);
  color: var(--fcb-accent-ink);
}

.mark.off {
  background: var(--fcb-line);
  color: var(--fcb-ink-muted);
}

.tick {
  width: 1.125rem;
  height: 1.125rem;
}

.dash {
  width: 0.875rem;
  height: 2px;
  background: currentColor;
  border-radius: 1px;
}

h1 {
  margin: 0;
  font-family: var(--fcb-font-display);
  font-size: clamp(1.5rem, 3vw, 1.875rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.sub {
  margin: 0.25rem 0 0;
  color: var(--fcb-ink-muted);
}

.card {
  border: 1px solid var(--fcb-line);
  border-radius: var(--fcb-radius);
  background: var(--fcb-surface);
  padding: 0.5rem 1.125rem;
}

.card.off {
  opacity: 0.6;
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

.row.total .v {
  font-family: var(--fcb-font-display);
  font-size: 1.25rem;
  font-weight: 700;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cancel-link {
  color: var(--fcb-ink-muted);
  font-size: 0.875rem;
  text-decoration: underline;
  text-underline-offset: 3px;
  align-self: flex-start;
}

.cancel-link:hover {
  color: var(--fcb-danger);
}

.keep {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--fcb-ink-faint);
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
