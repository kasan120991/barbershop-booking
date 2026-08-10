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
import QRCode from 'qrcode';

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

/**
 * The open card checkout, if there is one.
 *
 * Held on the page rather than in the store: it is a QR code being shown to one person
 * standing at the counter, and it stops mattering the moment they walk away.
 */
const checkout = ref<{ paymentId: string; url: string; qr: string } | null>(null);

/** Which of the two ids the current selection needs, so both paths agree on it. */
function ticketRef(ticket: PayableTicketDto) {
  return ticket.kind === TICKET_KIND.APPOINTMENT
    ? { appointmentId: ticket.id }
    : { queueEntryId: ticket.id };
}

async function startCard() {
  const ticket = selected.value;
  const chair = barberId.value;
  if (ticket === null || chair === null) return;

  try {
    const started = await payments.startCardCheckout({ barberId: chair, ...ticketRef(ticket) });

    // Rendered client-side; the URL never needs to leave the tablet to become a QR.
    const qr = await QRCode.toDataURL(started.checkoutUrl, {
      width: 512,
      margin: 1,
      // A QR needs a light quiet zone to scan reliably, even on a dark screen.
      color: { dark: '#17171b', light: '#ffffff' },
    });

    checkout.value = { paymentId: started.paymentId, url: started.checkoutUrl, qr };
  } catch (error) {
    notifyApiFailure(error, 'Could not start a card payment.');
  }
}

async function cancelCheckout(paymentId: string) {
  const chair = barberId.value;
  if (chair === null) return;

  try {
    await payments.voidPayment(paymentId, chair);
    if (checkout.value?.paymentId === paymentId) checkout.value = null;
    notifySuccess('Card payment cancelled', 'This cut can be settled another way now.');
  } catch (error) {
    notifyApiFailure(error, 'Could not cancel that payment.');
  }
}

/**
 * The QR panel closes itself once the payment lands.
 *
 * The webhook settles the row and the poll below picks it up, so the barber sees the cut
 * clear without touching anything — which is the only signal they get that a customer
 * standing in front of them actually paid.
 */
watch(
  () => payments.tickets.value,
  (list) => {
    const open = checkout.value;
    if (open === null) return;

    const stillPending = list.some((ticket) => ticket.pendingPayment?.id === open.paymentId);
    if (!stillPending) {
      checkout.value = null;
      notifySuccess('Card payment received', 'That cut is settled.');
    }
  },
);

/** Only while a QR is on screen. Off the rest of the time — nothing else here changes. */
let poll: ReturnType<typeof setInterval> | undefined;

watch(checkout, (open) => {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
  if (open === null || barberId.value === null) return;

  poll = setInterval(() => {
    if (barberId.value !== null) void payments.refresh(barberId.value);
  }, 3000);
});

onUnmounted(() => {
  if (poll !== undefined) clearInterval(poll);
});

async function confirmCash() {
  const ticket = selected.value;
  const chair = barberId.value;
  if (ticket === null || chair === null) return;

  const body: RecordCashPaymentRequest = {
    barberId: chair,
    tipCents: tipCents.value,
    ...ticketRef(ticket),
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
            <!-- A cut awaiting a card stays listed, because cancelling it is the only way
                 out and the row is where that action lives. -->
            <span v-if="ticket.pendingPayment" class="chip waiting">Waiting on card</span>
            <span v-else-if="ticket.finishedAt === null" class="chip chair">In chair</span>
          </button>
        </section>

        <!-- A QR on screen replaces the pad entirely: there is one thing happening, and
             it is the customer's phone. -->
        <section v-if="checkout" class="card qr">
          <div class="qr-frame">
            <img :src="checkout.qr" alt="Scan to pay" width="220" height="220" >
          </div>
          <div class="qr-side">
            <h3>Scan to pay</h3>
            <p class="body">
              The customer adds their own tip on their phone, then pays. This closes by
              itself once the payment lands.
            </p>
            <p class="hint break">{{ checkout.url }}</p>
            <Button
              label="Cancel Card Payment"
              size="small"
              variant="outlined"
              severity="danger"
              :loading="payments.saving.value"
              @click="cancelCheckout(checkout.paymentId)"
            />
          </div>
        </section>

        <!-- A cut already waiting on a card offers only the way out of that. -->
        <section v-else-if="selected?.pendingPayment" class="card pad">
          <div class="pad-head">
            <span class="label">{{ selected.clientName }} · {{ selected.serviceNames.join(' · ') }}</span>
            <span class="chip waiting">Waiting on card</span>
          </div>
          <p class="body">
            A card payment for {{ formatCents(selected.pendingPayment.totalCents) }} is open on
            this cut. Cancel it to take cash instead.
          </p>
          <Button
            label="Cancel Card Payment"
            size="small"
            variant="outlined"
            severity="danger"
            :loading="payments.saving.value"
            @click="cancelCheckout(selected.pendingPayment.id)"
          />
        </section>

        <section v-else-if="selected" class="card pad">
          <div class="pad-head">
            <span class="label">{{ selected.clientName }} · {{ selected.serviceNames.join(' · ') }}</span>
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

          <!-- Two ways to be paid, side by side. The tip pad above governs cash only:
               on a card the person holding it chooses their own tip, on their own phone. -->
          <div class="methods">
            <Button
              label="Confirm Cash Payment"
              :loading="payments.saving.value"
              @click="confirmCash"
            />
            <Button
              label="Pay by Card"
              variant="outlined"
              :loading="payments.saving.value"
              @click="startCard"
            />
          </div>
          <p class="hint">On a card, the customer adds their own tip when they pay.</p>
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

.chip.chair {
  color: var(--fc-accent);
  background: var(--fc-accent-wash);
  border-color: transparent;
}

.chip.waiting {
  color: var(--fc-ink);
  border-color: var(--fc-ink-faint);
}

.methods {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.qr {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 1.5rem;
}

/*
 * The QR sits on white regardless of the surrounding dark app. A scanner needs the light
 * quiet zone; rendering it on charcoal is how a code becomes unreliable at arm's length.
 */
.qr-frame {
  background: #ffffff;
  border-radius: 0.5rem;
  padding: 0.75rem;
  line-height: 0;
  flex: none;
}

.qr-frame img {
  display: block;
  width: 220px;
  height: 220px;
}

.qr-side {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.6rem;
  flex: 1;
  min-width: 15rem;
}

.qr-side h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--fc-ink);
}

.break {
  word-break: break-all;
  font-size: 0.75rem;
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
