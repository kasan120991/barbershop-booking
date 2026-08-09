<script setup lang="ts">
/**
 * The booking flow — service, barber, time, details, confirm.
 *
 * Five steps rather than one page, because these are decisions that constrain each other
 * and showing them all at once means showing times before anyone has said what they are
 * having. The summary rail is what makes a stepper safe: nothing chosen ever leaves the
 * screen, so going back is a correction rather than an excavation.
 *
 * Two rules carried from the staff app, both worth not undoing:
 *
 * - **Times render in the SHOP's timezone**, never the browser's. Somebody booking from
 *   an airport should see the time they will be standing in the shop.
 * - **No price or duration is ever sent.** They are computed server-side from the
 *   `Service` rows at write time; what is shown here is a quote, and the confirmation
 *   is what the server actually charged.
 */

import AngleLeft from '@primeicons/vue/angle-left';
import ClockIcon from '@primeicons/vue/clock';
import Sparkles from '@primeicons/vue/sparkles';
import {
  formatCents,
  formatPhone,
  normalizePhone,
  type BookingConfirmationDto,
} from '@francis/shared';

import type { Slot, StepIndex } from '../composables/useBooking';

useHead({ title: 'Book an appointment — Francis Cutz' });

const booking = useBooking();
const { notifyApiFailure } = useNotify();
const api = useApi();

await booking.load();

const submitting = ref(false);
const fieldErrors = ref<Record<string, string[]>>({});

const bookingOpen = computed(() => booking.settings.value?.onlineBookingEnabled ?? true);

// --- Step 1: service ----------------------------------------------------------

function chooseService(id: string): void {
  const changed = booking.serviceId.value !== id;
  booking.serviceId.value = id;

  // A different service means a different duration, so every slot previously offered
  // was computed against the wrong length. Clearing is the honest move.
  if (changed) {
    booking.slot.value = null;
    if (booking.barberId.value !== null) {
      const stillEligible = booking.eligibleBarbers.value.some(
        (barber) => barber.id === booking.barberId.value,
      );
      if (!stillEligible) booking.barberId.value = null;
    }
  }
  booking.goTo(2);
}

// --- Step 2: barber -----------------------------------------------------------

function chooseBarber(id: string | null): void {
  booking.barberId.value = id;
  booking.anyBarber.value = id === null;
  booking.slot.value = null;
  booking.goTo(3);
  void booking.loadSlots();
}

// --- Step 3: date and time ----------------------------------------------------

/** A rolling week from the offset, bounded by the shop's booking horizon. */
const weekOffset = ref(0);

const days = computed(() => {
  const zone = booking.timezone.value;
  const horizon = booking.settings.value?.bookingHorizonDays ?? 30;
  const start = new Date();

  return Array.from({ length: 7 }, (_, index) => {
    const when = new Date(start);
    when.setDate(when.getDate() + weekOffset.value * 7 + index);

    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(when);

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
    }).formatToParts(when);

    const daysAhead = weekOffset.value * 7 + index;

    return {
      iso,
      weekday: parts.find((part) => part.type === 'weekday')?.value ?? '',
      dayNumber: parts.find((part) => part.type === 'day')?.value ?? '',
      // Beyond the horizon the engine returns nothing, so the strip says so first.
      beyondHorizon: daysAhead > horizon,
    };
  });
});

function chooseDay(iso: string): void {
  booking.date.value = iso;
  void booking.loadSlots();
}

function chooseSlot(slot: Slot): void {
  booking.slot.value = slot;
}

function slotTime(startAt: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: booking.timezone.value,
  }).format(new Date(startAt));
}

/** Who a given slot would actually be with — the honest answer under "any barber". */
function slotBarberName(slot: Slot): string {
  const id = slot.barberIds[0];
  return booking.barbers.value.find((barber) => barber.id === id)?.displayName ?? '';
}

// --- Step 5: confirm ----------------------------------------------------------

async function confirm(): Promise<void> {
  if (submitting.value) return;
  const chosen = booking.slot.value;
  const chosenService = booking.service.value;
  const barber = booking.resolvedBarber.value;

  if (!chosen || !chosenService || !barber) return;

  submitting.value = true;
  fieldErrors.value = {};

  try {
    const response = await api<{ booking: BookingConfirmationDto }>('/appointments', {
      method: 'POST',
      body: {
        barberId: barber.id,
        serviceIds: [chosenService.id],
        startAt: chosen.startAt,
        phone: booking.details.value.phone,
        firstName: booking.details.value.firstName.trim(),
        lastName: booking.details.value.lastName.trim() || null,
      },
    });

    // The token is the only way back to this booking, and it is shown exactly once —
    // so the confirmation page owns the URL rather than a piece of client state.
    const token = response.booking.cancelToken;
    booking.reset();
    await navigateTo(`/booked/${token}`);
  } catch (error) {
    const failure = toApiFailure(error);
    if (failure.fields) fieldErrors.value = failure.fields;

    /**
     * A 409 means somebody else took the slot between it being offered and this
     * request — the row lock doing its job. Sending them back to the times with the
     * list refreshed is the only useful thing to do.
     */
    if (failure.status === 409) {
      booking.slot.value = null;
      booking.goTo(3);
      void booking.loadSlots();
    }
    notifyApiFailure(error);
  } finally {
    submitting.value = false;
  }
}

/**
 * Ten DIGITS, not ten characters.
 *
 * This counted characters before the field was masked, so `(415) 555-` — a number
 * somebody was halfway through typing — satisfied it. The mask now hands over bare
 * digits, which makes the count correct by construction; stating it as digits keeps it
 * that way if the field ever changes again.
 */
const detailsValid = computed(
  () =>
    booking.details.value.firstName.trim().length > 0 &&
    booking.details.value.phone.replace(/\D/g, '').length === 10,
);

/**
 * The number as a person would write it.
 *
 * The field now holds bare digits, so the review step would otherwise read
 * "4155550123" back to somebody checking their own number — which is exactly the moment
 * it needs to be easy to scan. Falls back to the raw value if it is not a number the
 * shop can dial, so nothing disappears from a screen asking "does this look right?".
 */
const typedPhone = computed(() => {
  const e164 = normalizePhone(booking.details.value.phone);
  return e164 === null ? booking.details.value.phone : formatPhone(e164);
});

function back(): void {
  booking.goTo(Math.max(1, booking.step.value - 1) as StepIndex);
}
</script>

<template>
  <div class="flow">
    <BookingSteps />

    <Message v-if="!bookingOpen" severity="warn" :closable="false" class="closed">
      Online booking is closed right now. Walk in and we will fit you in, or give the shop a
      call.
    </Message>

    <!--
      One step on screen at a time, sliding the way the user just went.

      `out-in` rather than a crossfade: the steps are different heights, and two of them
      in the layout at once makes the whole column jump. The wrapper carries a
      min-height so the shorter steps do not collapse the page between the two halves.

      Motion is switched off entirely under `prefers-reduced-motion` by the global rule
      in main.css — this is decoration, and decoration is the first thing to drop.
    -->
    <div class="stage">
      <Transition :name="booking.direction.value === 'back' ? 'step-back' : 'step-next'" mode="out-in">
        <!-- 1 · Service ------------------------------------------------------- -->
        <section v-if="booking.step.value === 1" key="1" class="step-body">
          <header class="head">
            <div>
              <h1>Choose a service</h1>
              <p class="sub">What are you having today?</p>
            </div>
          </header>

          <div class="cards">
            <button
              v-for="service in booking.bookableServices.value"
              :key="service.id"
              type="button"
              class="card service"
              :class="{ on: booking.serviceId.value === service.id }"
              @click="chooseService(service.id)"
            >
              <span class="card-main">
                <span class="name">{{ service.name }}</span>
                <span v-if="service.description" class="desc">{{ service.description }}</span>
                <span class="meta fcb-num">
                  <ClockIcon class="tiny" aria-hidden="true" />
                  {{ service.durationMinutes }} min
                </span>
              </span>
              <span class="price fcb-num">{{ formatCents(service.priceCents) }}</span>
            </button>
          </div>

          <p v-if="booking.bookableServices.value.length === 0" class="empty">
            Nothing is bookable online at the moment. Give the shop a call and we will sort you out.
          </p>
        </section>

        <!-- 2 · Barber -------------------------------------------------------- -->
        <section v-else-if="booking.step.value === 2" key="2" class="step-body">
          <header class="head">
            <button type="button" class="back" aria-label="Back" @click="back">
              <AngleLeft class="chev" aria-hidden="true" />
            </button>
            <div>
              <h1>Choose your barber</h1>
              <p class="sub">Who would you like to see?</p>
            </div>
          </header>

          <div class="grid-2">
            <button
              type="button"
              class="card person"
              :class="{ on: booking.anyBarber.value }"
              @click="chooseBarber(null)"
            >
              <span class="avatar any" aria-hidden="true"><Sparkles class="tiny" /></span>
              <span class="who">
                <span class="name">Any barber</span>
                <span class="desc">The most times to choose from</span>
              </span>
            </button>

            <button
              v-for="barber in booking.eligibleBarbers.value"
              :key="barber.id"
              type="button"
              class="card person"
              :class="{ on: booking.barberId.value === barber.id }"
              @click="chooseBarber(barber.id)"
            >
              <span class="avatar" aria-hidden="true">{{ barber.displayName.charAt(0) }}</span>
              <span class="who">
                <span class="name">{{ barber.displayName }}</span>
                <span class="desc">{{ barber.bio ?? 'Barber' }}</span>
              </span>
            </button>
          </div>
        </section>

        <!-- 3 · Date and time -------------------------------------------------- -->
        <section v-else-if="booking.step.value === 3" key="3" class="step-body">
          <header class="head">
            <button type="button" class="back" aria-label="Back" @click="back">
              <AngleLeft class="chev" aria-hidden="true" />
            </button>
            <div>
              <h1>Pick a time</h1>
              <!-- Worth saying out loud: these render in the SHOP's zone, so somebody
                   booking from an airport sees the time they will be standing here. -->
              <p class="sub">Shop time — the clock on the wall when you walk in.</p>
            </div>
          </header>

          <div class="week">
            <button
              type="button"
              class="week-nav"
              :disabled="weekOffset === 0"
              aria-label="Previous week"
              @click="weekOffset -= 1"
            >
              <AngleLeft class="chev" aria-hidden="true" />
            </button>

            <div class="days">
              <button
                v-for="day in days"
                :key="day.iso"
                type="button"
                class="day"
                :class="{ on: booking.date.value === day.iso }"
                :disabled="day.beyondHorizon"
                @click="chooseDay(day.iso)"
              >
                <span class="dow">{{ day.weekday }}</span>
                <span class="dnum fcb-num">{{ day.dayNumber }}</span>
              </button>
            </div>

            <button
              type="button"
              class="week-nav flip"
              aria-label="Next week"
              @click="weekOffset += 1"
            >
              <AngleLeft class="chev" aria-hidden="true" />
            </button>
          </div>

          <div v-if="booking.slotsLoading.value" class="loading">
            <ProgressSpinner style="width: 1.5rem; height: 1.5rem" :stroke-width="6" />
            <span>Checking the book…</span>
          </div>

          <template v-else>
            <div v-if="booking.slots.value.length" class="slots">
              <button
                v-for="slot in booking.slots.value"
                :key="slot.startAt"
                type="button"
                class="slot fcb-num"
                :class="{ on: booking.slot.value?.startAt === slot.startAt }"
                @click="chooseSlot(slot)"
              >
                {{ slotTime(slot.startAt) }}
              </button>
            </div>

            <!-- The engine explains itself rather than shrugging: closed, booked out and
                 beyond the horizon all read differently. -->
            <p v-else class="empty">{{ booking.emptyReason.value ?? 'Nothing free that day.' }}</p>
          </template>

          <div v-if="booking.slot.value" class="continue">
            <p v-if="booking.anyBarber.value" class="with">
              That one is with <strong>{{ slotBarberName(booking.slot.value) }}</strong>.
            </p>
            <Button label="Continue" @click="booking.goTo(4)" />
          </div>
        </section>

        <!-- 4 · Details -------------------------------------------------------- -->
        <section v-else-if="booking.step.value === 4" key="4" class="step-body">
          <header class="head">
            <button type="button" class="back" aria-label="Back" @click="back">
              <AngleLeft class="chev" aria-hidden="true" />
            </button>
            <div>
              <h1>Who is it for?</h1>
              <p class="sub">Your number is how we know it is you when you arrive.</p>
            </div>
          </header>

          <div class="form">
            <div class="row">
              <div class="field">
                <label for="b-first" class="fcb-label">First name</label>
                <InputText
                  id="b-first"
                  v-model="booking.details.value.firstName"
                  :invalid="Boolean(fieldErrors.firstName)"
                  autocomplete="given-name"
                  fluid
                />
                <p v-if="fieldErrors.firstName" class="err">{{ fieldErrors.firstName[0] }}</p>
              </div>
              <div class="field">
                <label for="b-last" class="fcb-label">Last name</label>
                <InputText
                  id="b-last"
                  v-model="booking.details.value.lastName"
                  autocomplete="family-name"
                  fluid
                />
                <p class="hint">Optional. Only your initial is ever shown in the shop.</p>
              </div>
            </div>

            <div class="field">
              <label for="b-phone" class="fcb-label">Mobile number</label>
              <!-- `auto-clear` off so a half-typed number survives a glance away, and
                   `unmask` on so the model holds ten digits rather than punctuation. -->
              <InputMask
                id="b-phone"
                v-model="booking.details.value.phone"
                mask="(999) 999-9999"
                :auto-clear="false"
                unmask
                type="tel"
                inputmode="tel"
                autocomplete="tel"
                placeholder="(415) 555-0123"
                :invalid="Boolean(fieldErrors.phone)"
                fluid
              />
              <p v-if="fieldErrors.phone" class="err">{{ fieldErrors.phone[0] }}</p>
              <p v-else class="hint">
                We do not text you — it is how the shop finds your booking at the door.
              </p>
            </div>
          </div>

          <div class="continue">
            <Button label="Continue" :disabled="!detailsValid" @click="booking.goTo(5)" />
          </div>
        </section>

        <!-- 5 · Confirm --------------------------------------------------------- -->
        <section v-else key="5" class="step-body">
          <header class="head">
            <button type="button" class="back" aria-label="Back" @click="back">
              <AngleLeft class="chev" aria-hidden="true" />
            </button>
            <div>
              <h1>Does this look right?</h1>
              <p class="sub">Nothing is charged now. You pay in the shop after your cut.</p>
            </div>
          </header>

          <div class="review">
            <div class="review-row">
              <span class="k">Service</span>
              <span class="v">{{ booking.service.value?.name }}</span>
            </div>
            <div class="review-row">
              <span class="k">Barber</span>
              <span class="v">{{ booking.resolvedBarber.value?.displayName }}</span>
            </div>
            <div class="review-row">
              <span class="k">When</span>
              <span class="v fcb-num">
                {{
                  booking.slot.value
                    ? new Intl.DateTimeFormat('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZone: booking.timezone.value,
                      }).format(new Date(booking.slot.value.startAt))
                    : ''
                }}
              </span>
            </div>
            <div class="review-row">
              <span class="k">Name</span>
              <span class="v">
                {{ booking.details.value.firstName }} {{ booking.details.value.lastName }}
              </span>
            </div>
            <div class="review-row">
              <span class="k">Mobile</span>
              <span class="v fcb-num">{{ typedPhone }}</span>
            </div>
            <div class="review-row total">
              <span class="k">Total, paid in the shop</span>
              <span class="v fcb-num">{{ formatCents(booking.totalCents.value) }}</span>
            </div>
          </div>

          <div class="continue">
            <Button
              label="Book It"
              size="large"
              :loading="submitting"
              :disabled="!bookingOpen"
              @click="confirm"
            />
          </div>
        </section>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/**
 * Centred in the pane rather than pinned left.
 *
 * The rail already holds one edge of the layout, so a left-pinned column put all the
 * empty space on one side and made the page look unfinished on a wide screen. The
 * confirmation and cancel pages centre the same way — they share this shell, and a
 * column that shifts between steps reads as the page reloading into something else.
 */
.flow {
  max-width: 44rem;
  margin-inline: auto;
}

.closed {
  margin-bottom: 1.5rem;
}

/**
 * Holds the column's height steady across a step change.
 *
 * With `out-in` the outgoing step is gone before the incoming one exists, so without a
 * floor the page collapses for a frame and the whole layout — including anything the
 * user was about to click — jumps upward and back.
 */
.stage {
  min-height: 26rem;
}

.step-body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/**
 * Direction-aware. Forward slides in from the right and leaves to the left; back does
 * the reverse, so the motion matches the gesture instead of the page appearing to
 * reload into something else.
 *
 * Short and small on purpose — 180ms and 14px. A booking form is a thing people are
 * trying to get through, and animation that has to be waited for stops being polish.
 * `prefers-reduced-motion` zeroes all of it via the global rule in main.css.
 */
.step-next-enter-active,
.step-next-leave-active,
.step-back-enter-active,
.step-back-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.step-next-enter-from {
  opacity: 0;
  transform: translateX(14px);
}

.step-next-leave-to {
  opacity: 0;
  transform: translateX(-14px);
}

.step-back-enter-from {
  opacity: 0;
  transform: translateX(-14px);
}

.step-back-leave-to {
  opacity: 0;
  transform: translateX(14px);
}

/* --- Heading --------------------------------------------------------------- */

.head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
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

.back {
  margin-top: 0.375rem;
  width: 2rem;
  height: 2rem;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--fcb-line);
  background: var(--fcb-surface);
  color: var(--fcb-ink-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.back:hover {
  color: var(--fcb-ink);
  border-color: var(--fcb-line-strong);
}

.chev {
  width: 0.875rem;
  height: 0.875rem;
}

/* --- Option cards ---------------------------------------------------------- */

.cards {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.625rem;
}

.card {
  font: inherit;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--fcb-line);
  border-radius: var(--fcb-radius);
  background: var(--fcb-surface);
  padding: 1rem 1.125rem;
  color: inherit;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.card:hover {
  border-color: var(--fcb-line-strong);
}

/* Selected reads as a fill plus a border, not colour alone — the same state has to
   survive being printed, screenshotted, or looked at by someone colour-blind. */
.card.on {
  border-color: var(--fcb-accent-line);
  background: var(--fcb-accent-wash);
  box-shadow: inset 0 0 0 1px var(--fcb-accent-line);
}

.card.service {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.card-main {
  display: flex;
  flex-direction: column;
  gap: 0.1875rem;
  min-width: 0;
}

.name {
  font-size: 1.0625rem;
  font-weight: 650;
}

.desc {
  font-size: 0.875rem;
  color: var(--fcb-ink-muted);
}

.meta {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  font-size: 0.8125rem;
  color: var(--fcb-ink-faint);
  margin-top: 0.125rem;
}

.tiny {
  width: 0.8125rem;
  height: 0.8125rem;
}

.price {
  font-family: var(--fcb-font-display);
  font-size: 1.375rem;
  font-weight: 700;
  flex: none;
}

.card.person {
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.avatar {
  width: 2.75rem;
  height: 2.75rem;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: var(--fcb-font-display);
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--fcb-accent-ink);
  background: linear-gradient(135deg, var(--fcb-accent) 0%, var(--fcb-accent-strong) 100%);
}

.avatar.any {
  background: var(--fcb-ground);
  color: var(--fcb-ink-muted);
  border: 1px solid var(--fcb-line);
}

.who {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.who .name {
  font-size: 0.9375rem;
}

/* --- The week strip and times ---------------------------------------------- */

.week {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.week-nav {
  width: 2rem;
  height: 2rem;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--fcb-line);
  background: var(--fcb-surface);
  color: var(--fcb-ink-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.week-nav:disabled {
  opacity: 0.35;
  cursor: default;
}

.week-nav.flip .chev {
  transform: rotate(180deg);
}

.days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.375rem;
  flex: 1;
  min-width: 0;
}

.day {
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--fcb-line);
  border-radius: var(--fcb-radius);
  background: var(--fcb-surface);
  color: inherit;
  padding: 0.5rem 0.25rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.day:disabled {
  opacity: 0.35;
  cursor: default;
}

.day.on {
  background: var(--fcb-rail);
  border-color: var(--fcb-rail);
  color: var(--fcb-rail-ink);
}

.dow {
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fcb-ink-faint);
}

.day.on .dow {
  color: var(--fcb-rail-muted);
}

.dnum {
  font-size: 1.125rem;
  font-weight: 650;
}

.slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(6.25rem, 1fr));
  gap: 0.5rem;
}

.slot {
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--fcb-line);
  border-radius: var(--fcb-radius);
  background: var(--fcb-surface);
  color: inherit;
  padding: 0.6875rem 0.5rem;
  font-size: 0.9375rem;
  font-weight: 550;
  /* Selection eases in rather than snapping — the one place a hard cut reads as a
     glitch, because a grid of pills all change at once. */
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.slot:hover {
  border-color: var(--fcb-line-strong);
}

.slot.on {
  background: var(--fcb-accent);
  border-color: var(--fcb-accent-line);
  color: var(--fcb-accent-ink);
  font-weight: 700;
}

.loading {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--fcb-ink-muted);
  font-size: 0.875rem;
}

.empty {
  margin: 0;
  border: 1px dashed var(--fcb-line-strong);
  border-radius: var(--fcb-radius);
  padding: 1.75rem 1rem;
  text-align: center;
  color: var(--fcb-ink-muted);
  font-size: 0.9375rem;
}

/* --- Form and review -------------------------------------------------------- */

.form {
  display: flex;
  flex-direction: column;
  gap: 1.125rem;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-width: 0;
}

.err {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--fcb-danger);
}

.hint {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--fcb-ink-faint);
}

.review {
  border: 1px solid var(--fcb-line);
  border-radius: var(--fcb-radius);
  background: var(--fcb-surface);
  padding: 0.5rem 1.125rem;
}

.review-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--fcb-line);
}

.review-row:last-child {
  border-bottom: none;
}

.review-row .k {
  font-size: 0.875rem;
  color: var(--fcb-ink-muted);
  flex: none;
}

.review-row .v {
  font-weight: 600;
  text-align: right;
}

.review-row.total .v {
  font-family: var(--fcb-font-display);
  font-size: 1.25rem;
  font-weight: 700;
}

.continue {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1rem;
  flex-wrap: wrap;
}

.with {
  margin: 0;
  font-size: 0.875rem;
  color: var(--fcb-ink-muted);
}

.with strong {
  color: var(--fcb-ink);
  font-weight: 650;
}

@media (max-width: 620px) {
  .grid-2,
  .row {
    grid-template-columns: 1fr;
  }

  .continue {
    justify-content: stretch;
  }

  .continue :deep(.p-button) {
    width: 100%;
    justify-content: center;
  }
}
</style>
