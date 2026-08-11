<script setup lang="ts">
/**
 * The public shell: a summary rail beside the pane you are working in.
 *
 * The rail is the point. A booking is four decisions that each cost money and time, and
 * a form that hides the earlier ones behind a Back button makes people re-check by
 * going backwards — which loses the later ones. Keeping the whole answer on screen means
 * the running total is never a surprise at the end.
 *
 * It carries the staff app's charcoal deliberately, against the light working pane: the
 * two apps should look like the same shop, and the rail is where that shows.
 *
 * Below 900px it stops being a rail and becomes a strip above the content, because a
 * sidebar on a phone is just a screen you have to scroll past.
 */

import Clock from '@primeicons/vue/clock';
import Calendar from '@primeicons/vue/calendar';
import User from '@primeicons/vue/user';

import { formatCents, formatPhone } from '@francis/shared';

const booking = useBooking();
const route = useRoute();

/** The rail only makes sense mid-flow; a confirmation page is its own summary. */
const showSummary = computed(() => route.path === '/');

const dateTimeLabel = computed(() => {
  const chosen = booking.slot.value;
  if (!chosen) return null;

  const when = new Date(chosen.startAt);
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: booking.timezone.value,
  }).format(when);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: booking.timezone.value,
  }).format(when);

  return { day, time };
});

const shopPhone = computed(() => booking.settings.value?.phone ?? null);
</script>

<template>
  <!--
    `in-flow` marks the booking wizard, which is the only route that replaces the rail
    with its own phone shell. Every other page — a confirmation, a payment link — keeps
    the strip on a phone, because those have no top bar of their own and losing the
    wordmark would leave a customer on an unbranded page asking for their card.
  -->
  <div class="shell" :class="{ 'in-flow': showSummary }">
    <aside class="rail">
      <NuxtLink to="/" class="brand">
        <span class="fcb-pole" aria-hidden="true" />
        <span class="fcb-wordmark">Francis Cutz</span>
      </NuxtLink>

      <template v-if="showSummary">
        <p class="rail-label">Your booking</p>

        <div class="lines">
          <div class="line">
            <span class="tile" aria-hidden="true">
              <!-- No scissors in the icon set, so the shop's own mark stands in. -->
              <span class="mini-pole" />
            </span>
            <span class="text">
              <span class="k">Service</span>
              <span v-if="booking.service.value" class="v">{{ booking.service.value.name }}</span>
              <span v-else class="v empty">Not chosen</span>
              <span v-if="booking.service.value" class="p fcb-num">
                {{ formatCents(booking.service.value.priceCents) }}
              </span>
            </span>
          </div>

          <div class="line">
            <span class="tile" aria-hidden="true"><User class="ico" /></span>
            <span class="text">
              <span class="k">Barber</span>
              <span v-if="booking.resolvedBarber.value" class="v">
                {{ booking.resolvedBarber.value.displayName }}
              </span>
              <span v-else-if="booking.anyBarber.value" class="v">Any barber</span>
              <span v-else class="v empty">Not chosen</span>
            </span>
          </div>

          <div class="line">
            <span class="tile" aria-hidden="true"><Calendar class="ico" /></span>
            <span class="text">
              <span class="k">Date &amp; time</span>
              <template v-if="dateTimeLabel">
                <span class="v fcb-num">{{ dateTimeLabel.day }}</span>
                <span class="p fcb-num">{{ dateTimeLabel.time }}</span>
              </template>
              <span v-else class="v empty">Not chosen</span>
            </span>
          </div>
        </div>

        <div class="total">
          <div class="total-row">
            <span>Total</span>
            <span class="amount fcb-num">{{ formatCents(booking.totalCents.value) }}</span>
          </div>
          <p class="foot">
            <template v-if="booking.totalMinutes.value > 0">
              <span class="fcb-num">{{ booking.totalMinutes.value }} minutes</span> ·
            </template>
            Pay after your cut, in the shop.
          </p>
        </div>
      </template>

      <div class="rail-foot">
        <!-- Client-only, and not as a shortcut around a warning: the shop's number
             arrives with the settings the PAGE fetches, which can resolve after this
             template has already rendered on the server. A server-rendered number then
             disagrees with the payload the client hydrates from — the same mismatch the
             staff app's queue badge hit. Everything else in this rail starts empty on
             both sides, so only this line needs it. -->
        <ClientOnly>
          <p v-if="shopPhone" class="call">
            Rather talk to someone?
            <a :href="`tel:${shopPhone}`" class="fcb-num">{{ formatPhone(shopPhone) }}</a>
          </p>
        </ClientOnly>
        <p class="walkin">Walk-ins welcome — no appointment needed.</p>
      </div>
    </aside>

    <main class="pane">
      <slot />
    </main>

    <Toast position="bottom-right" />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 17.5rem 1fr;
  min-height: 100%;
}

/* --- The rail -------------------------------------------------------------- */

.rail {
  background: var(--fcb-rail);
  color: var(--fcb-rail-ink);
  padding: 1.75rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  text-decoration: none;
  color: inherit;
}

.rail-label {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fcb-rail-muted);
  font-weight: 600;
}

.lines {
  display: flex;
  flex-direction: column;
  gap: 1.125rem;
  margin-top: -1rem;
}

.line {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.tile {
  width: 2rem;
  height: 2rem;
  flex: none;
  border-radius: 8px;
  background: var(--fcb-rail-raised);
  display: grid;
  place-items: center;
}

.ico {
  width: 0.875rem;
  height: 0.875rem;
  color: var(--fcb-rail-muted);
}

/* The barber pole again, at badge size — the one decorative mark in the design. */
.mini-pole {
  width: 0.375rem;
  height: 1rem;
  border-radius: 1px;
  background: repeating-linear-gradient(
    -45deg,
    var(--fcb-accent) 0 2px,
    var(--fcb-rail-raised) 2px 4px
  );
}

.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.k {
  font-size: 0.75rem;
  color: var(--fcb-rail-muted);
}

.v {
  font-size: 0.9375rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}

.v.empty {
  font-weight: 400;
  color: var(--fcb-rail-muted);
}

.p {
  font-size: 0.8125rem;
  color: var(--fcb-accent);
  font-weight: 600;
}

.total {
  border-top: 1px solid var(--fcb-rail-line);
  padding-top: 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.total-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.875rem;
  color: var(--fcb-rail-muted);
}

.amount {
  font-family: var(--fcb-font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--fcb-rail-ink);
}

.foot {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fcb-rail-muted);
}

.rail-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--fcb-rail-muted);
}

.rail-foot p {
  margin: 0;
}

.rail-foot a {
  color: var(--fcb-accent);
  text-decoration: none;
}

.rail-foot a:hover {
  text-decoration: underline;
}

/* --- The working pane ------------------------------------------------------ */

.pane {
  padding: 2.5rem clamp(1.25rem, 4vw, 3.5rem) 4rem;
  min-width: 0;
}

/* A rail on a phone is a screen you scroll past, so it becomes a strip on top. */
@media (max-width: 900px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .rail {
    padding: 1.25rem;
    gap: 1.25rem;
  }

  .lines {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 1rem 1.5rem;
    margin-top: 0;
  }

  .rail-foot {
    margin-top: 0;
  }

  .pane {
    padding: 1.75rem 1.25rem 3rem;
  }
}

/**
 * On a phone the booking flow drops the rail entirely.
 *
 * The strip was costing four summary lines and a wordmark above the question on every
 * step; the flow's own top bar and bottom sheet carry the same information in a fraction
 * of the room. Scoped to `.in-flow` so a confirmation or payment page — which has no top
 * bar to inherit and genuinely needs the brand on it — keeps the strip.
 */
@media (max-width: 620px) {
  .shell.in-flow .rail {
    display: none;
  }
}
</style>
