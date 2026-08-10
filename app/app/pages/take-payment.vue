<script setup lang="ts">
/**
 * Taking payment for a finished cut.
 *
 * The list is the screen. A barber who lets three cuts stack up before settling any of
 * them can see all of it at once, and nothing sits unpaid without being visible — which
 * is the failure this replaces, where the only record of an unsettled cut was the
 * barber's memory of it.
 *
 * Cash only for now. The card path adds a second button beside Confirm, not a second
 * screen, which is why the pad below is built around the ticket rather than the method.
 *
 * A row disappearing from the list IS the confirmation that the payment landed — the
 * server drops anything already carrying a settled payment, so the refetch after a
 * mutation is doing real work rather than being defensive.
 */

import {
  formatCents,
  percentOfCents,
  TICKET_KIND,
  type PayableTicketDto,
  type RecordCashPaymentRequest,
} from '@francis/shared';

useHead({ title: 'Take Payment — Francis Cutz' });

const auth = useAuthStore();
const payments = usePayments();
const { notifySuccess, notifyApiFailure } = useNotify();

const barberId = computed(() => auth.user?.barberId ?? null);

if (barberId.value !== null) {
  await payments.refresh(barberId.value);
}

const selectedId = ref<string | null>(null);

const selected = computed<PayableTicketDto | null>(
  () => payments.tickets.value.find((ticket) => ticket.id === selectedId.value) ?? null,
);

/**
 * The top ticket is whoever is in the chair, or the most recent finish — which is nearly
 * always the one being paid for. Pre-selecting it takes the common case from three taps
 * to two without hiding the others.
 */
watchEffect(() => {
  const list = payments.tickets.value;
  if (list.length === 0) {
    selectedId.value = null;
    return;
  }
  if (!list.some((ticket) => ticket.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null;
  }
});

/** Percentages, not amounts — the presets have to follow whatever the cut cost. */
const TIP_PERCENTS = [15, 18, 20];

const tipCents = ref(0);
const customOpen = ref(false);
const customDollars = ref<number | null>(null);

// A new ticket is a new transaction; carrying a tip across would silently apply one
// person's 20% to the next person's cut.
watch(selectedId, () => {
  tipCents.value = 0;
  customOpen.value = false;
  customDollars.value = null;
});

function presetCents(percent: number): number {
  return percentOfCents(selected.value?.amountCents ?? 0, percent);
}

function chooseTip(cents: number) {
  tipCents.value = cents;
  customOpen.value = false;
}

function openCustom() {
  customOpen.value = true;
  customDollars.value = null;
  tipCents.value = 0;
}

// Dollars only ever exist at this edge; everything downstream is integer cents.
watch(customDollars, (dollars) => {
  tipCents.value = dollars === null ? 0 : Math.round(dollars * 100);
});

const totalCents = computed(() => (selected.value?.amountCents ?? 0) + tipCents.value);

function finishedLabel(ticket: PayableTicketDto): string {
  if (ticket.finishedAt === null) return 'In the chair';
  return `Finished ${new Date(ticket.finishedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

async function confirmCash() {
  const ticket = selected.value;
  const chair = barberId.value;
  if (ticket === null || chair === null) return;

  const body: RecordCashPaymentRequest = {
    barberId: chair,
    tipCents: tipCents.value,
    ...(ticket.kind === TICKET_KIND.APPOINTMENT
      ? { appointmentId: ticket.id }
      : { queueEntryId: ticket.id }),
  };

  try {
    const payment = await payments.recordCash(body);
    notifySuccess(
      `${ticket.clientName} paid`,
      `${formatCents(payment.totalCents)} in cash${payment.tipCents > 0 ? `, including a ${formatCents(payment.tipCents)} tip` : ''}.`,
    );
  } catch (error) {
    notifyApiFailure(error, 'Could not record that payment.');
  }
}
</script>

<template>
  <div class="pay">
    <section v-if="barberId === null" class="card">
      <h2>No chair on this account</h2>
      <p class="body">
        This page settles one barber's own cuts. Your account does not cut hair — open
        <NuxtLink to="/barbers">Barbers &amp; Rent</NuxtLink> to see the shop's chairs.
      </p>
    </section>

    <template v-else>
      <header class="head">
        <div>
          <h2>Take Payment</h2>
          <p class="body">Cuts finished today that haven't been settled.</p>
        </div>
        <span v-if="payments.tickets.value.length" class="chip">
          {{ payments.tickets.value.length }} unpaid
        </span>
      </header>

      <section v-if="payments.tickets.value.length === 0" class="card empty">
        <p class="body">Nothing to settle right now.</p>
        <p class="hint">
          A cut appears here once the client is in the chair, and disappears once it has
          been paid for.
        </p>
      </section>

      <template v-else>
        <section class="card list">
          <!-- One row per unsettled cut. Selecting one drives the pad below rather than
               opening a dialog, so the rest of the list stays in view while settling. -->
          <button
            v-for="ticket in payments.tickets.value"
            :key="ticket.id"
            type="button"
            class="ticket"
            :class="{ active: ticket.id === selectedId }"
            :aria-pressed="ticket.id === selectedId"
            @click="selectedId = ticket.id"
          >
            <span class="who">
              <span class="name">{{ ticket.clientName }}</span>
              <span class="meta">
                {{ ticket.serviceNames.join(' · ') || 'Service' }} · {{ finishedLabel(ticket) }}
              </span>
            </span>
            <span class="amt">{{ formatCents(ticket.amountCents) }}</span>
            <span v-if="ticket.finishedAt === null" class="chip chair">In chair</span>
          </button>
        </section>

        <section v-if="selected" class="card pad">
          <div class="pad-head">
            <span class="label">{{ selected.clientName }} · {{ selected.serviceNames.join(' · ') }}</span>
            <span class="chip cash">Cash</span>
          </div>

          <span class="label">Tip</span>
          <div class="tips">
            <Button
              label="No tip"
              size="small"
              :variant="tipCents === 0 && !customOpen ? undefined : 'outlined'"
              @click="chooseTip(0)"
            />
            <Button
              v-for="percent in TIP_PERCENTS"
              :key="percent"
              size="small"
              :label="`${percent}% · ${formatCents(presetCents(percent))}`"
              :variant="!customOpen && tipCents === presetCents(percent) && tipCents > 0 ? undefined : 'outlined'"
              @click="chooseTip(presetCents(percent))"
            />
            <Button
              label="Custom"
              size="small"
              :variant="customOpen ? undefined : 'outlined'"
              @click="openCustom"
            />
          </div>

          <InputNumber
            v-if="customOpen"
            v-model="customDollars"
            mode="currency"
            currency="USD"
            locale="en-US"
            :min="0"
            :max="500"
            placeholder="Tip amount"
            fluid
          />

          <div class="totals">
            <div class="line">
              <span>Cut</span>
              <span>{{ formatCents(selected.amountCents) }}</span>
            </div>
            <div class="line">
              <span>Tip</span>
              <span>{{ formatCents(tipCents) }}</span>
            </div>
            <div class="line grand">
              <span>Total</span>
              <span>{{ formatCents(totalCents) }}</span>
            </div>
          </div>

          <Button
            label="Confirm Cash Payment"
            :loading="payments.saving.value"
            @click="confirmCash"
          />
        </section>
      </template>

      <p v-if="payments.payments.value.length" class="hint taken">
        Taken today: {{ payments.payments.value.length }}
        {{ payments.payments.value.length === 1 ? 'cut' : 'cuts' }} ·
        {{ formatCents(payments.takenTodayCents.value) }} including tips.
      </p>
    </template>
  </div>
</template>

<style scoped>
.pay {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}

h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--fc-ink);
}

.body {
  margin: 0.15rem 0 0;
  max-width: 60ch;
  color: var(--fc-ink-muted);
  line-height: 1.5;
}

.hint {
  margin: 0;
  color: var(--fc-ink-faint);
  font-size: 0.85rem;
  line-height: 1.5;
}

.taken {
  padding-top: 0.25rem;
}

.card {
  border: 1px solid var(--fc-line);
  background: var(--fc-surface);
  border-radius: 0.75rem;
  padding: 1.25rem;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.list {
  padding: 0.25rem 1.25rem;
}

.ticket {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  width: 100%;
  padding: 0.85rem 0;
  border: 0;
  border-bottom: 1px solid var(--fc-line);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ticket:last-child {
  border-bottom: 0;
}

.ticket.active .name {
  color: var(--fc-accent);
}

.ticket:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: -2px;
}

.who {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  flex: 1;
  min-width: 0;
}

.name {
  font-weight: 600;
  font-size: 0.95rem;
}

.meta {
  font-size: 0.8rem;
  color: var(--fc-ink-muted);
}

.amt {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.chip {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--fc-line);
  color: var(--fc-ink-faint);
  white-space: nowrap;
}

.chip.cash,
.chip.chair {
  color: var(--fc-accent);
  background: var(--fc-accent-wash);
  border-color: transparent;
}

.pad {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: stretch;
}

.pad-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
}

.tips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.totals {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.25rem;
}

.line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.88rem;
  color: var(--fc-ink-muted);
}

.line span:last-child {
  font-variant-numeric: tabular-nums;
  color: var(--fc-ink);
}

.line.grand {
  border-top: 1px solid var(--fc-line);
  padding-top: 0.55rem;
  margin-top: 0.15rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--fc-ink);
}

.line.grand span:last-child {
  font-size: 1.3rem;
  color: var(--fc-accent);
}
</style>
