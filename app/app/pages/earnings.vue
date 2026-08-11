<script setup lang="ts">
/**
 * The barber's own money page.
 *
 * Phase 13 fills in the top of it: getting this chair onboarded onto Stripe far enough
 * that it can be paid. Balances and the instant cash-out button are Phase 14.
 *
 * The card shows the gates rather than a single verdict, because the two capabilities
 * genuinely fail apart: Stripe clears a chair to take card payments before it will send
 * that money anywhere, and a card that says "Ready" while payouts are off tells a barber
 * they are set up on the exact day they are not. Three lines, one action, and the header
 * counts what is actually outstanding.
 *
 * Once every gate passes it collapses to a single line — a barber who finished months ago
 * is here for today's total, not for a checklist they have already completed.
 *
 * Two query params come back from Stripe, and they mean different things:
 *
 * - `?connect=return` — they finished (or abandoned) the hosted flow. Re-read the live
 *   account, because `account.updated` has usually not arrived yet.
 * - `?connect=refresh` — they landed on an expired link. Stripe expires these in minutes,
 *   so the only useful response is to mint another and send them straight back.
 */

import {
  CONNECT_STATE,
  INSTANT_FEE_BPS,
  INSTANT_FEE_MIN_CENTS,
  INSTANT_PAYOUT_MIN_CENTS,
  formatCents,
  type PayoutDto,
} from '@francis/shared';

useHead({ title: 'Earnings — Francis Cutz' });

const auth = useAuthStore();
const connect = useConnect();
const route = useRoute();
const router = useRouter();
const { notifySuccess, notifyApiFailure } = useNotify();

const barberId = computed(() => auth.user?.barberId ?? null);

if (barberId.value !== null) {
  await connect.refresh(barberId.value);
}

interface Gate {
  key: string;
  done: boolean;
  /** True when this is the gate the barber can actually do something about. */
  blocking: boolean;
  title: string;
  detail: string;
}

/**
 * The three gates, in the order Stripe clears them.
 *
 * `detail` on a failed gate says what happens if it stays that way, not merely that it is
 * incomplete — "your takings sit with Stripe" is the fact that makes someone act.
 */
const gates = computed<Gate[]>(() => {
  const status = connect.status.value;
  const started = status !== null && status.stripeAccountId !== null;

  return [
    {
      key: 'details',
      done: status?.detailsSubmitted ?? false,
      blocking: started && !(status?.detailsSubmitted ?? false),
      title: status?.detailsSubmitted ? 'Your details are in' : 'Stripe needs your details',
      detail: status?.detailsSubmitted
        ? 'Submitted and accepted.'
        : 'Name, date of birth and address, so Stripe can verify who is being paid.',
    },
    {
      key: 'charges',
      done: status?.chargesEnabled ?? false,
      blocking: false,
      title: status?.chargesEnabled
        ? 'You can take card payments'
        : 'Card payments are not on yet',
      detail: status?.chargesEnabled
        ? 'Stripe cleared this chair.'
        : 'Stripe turns this on once your details check out. Nothing is needed from you.',
    },
    {
      key: 'payouts',
      done: status?.payoutsEnabled ?? false,
      blocking: started && !(status?.payoutsEnabled ?? false),
      title: status?.payoutsEnabled ? 'Money reaches your account' : "Money can't reach you yet",
      detail: status?.payoutsEnabled
        ? 'Paid out automatically every day.'
        : 'Add a bank account or debit card. Until then your card takings sit with Stripe.',
    },
  ];
});

const outstanding = computed(() => gates.value.filter((gate) => !gate.done).length);
const allClear = computed(() => outstanding.value === 0 && connect.status.value !== null);

const notStarted = computed(
  () => connect.status.value === null || connect.status.value.state === CONNECT_STATE.NOT_STARTED,
);

/** The one action, named for what it does rather than for the state it leaves. */
const actionLabel = computed(() => {
  if (notStarted.value) return 'Set Up Payouts';
  if (!(connect.status.value?.detailsSubmitted ?? false)) return 'Finish Setup';
  if (!(connect.status.value?.payoutsEnabled ?? false)) return 'Add Payout Method';
  return null;
});

async function onStart() {
  if (barberId.value === null) return;
  try {
    await connect.startOnboarding(barberId.value);
  } catch (error) {
    notifyApiFailure(error, 'Could not open Stripe setup.');
  }
}

function clearQuery() {
  void router.replace({ query: {} });
}

// --- The money ----------------------------------------------------------------

const payouts = usePayouts();

if (barberId.value !== null) {
  await payouts.refresh(barberId.value);
}

const instantAvailable = computed(() => payouts.balance.value?.instantAvailableCents ?? 0);

/**
 * The gate is the live balance, not our `instantPayoutEligible` mirror.
 *
 * That mirror only counts an external account of type `card`, and a US bank account can be
 * instant-eligible too — verified against the sandbox, where a bank-only chair has a
 * non-zero instant balance and a real instant payout to it settled. Stripe reports zero for
 * an account that genuinely cannot, which makes the balance the honest signal.
 */
const canCashOut = computed(
  () => instantAvailable.value >= INSTANT_PAYOUT_MIN_CENTS && !payouts.balanceUnavailable.value,
);

const cashOutOpen = ref(false);
const chosenCents = ref(0);

/**
 * Round amounts up to what is actually there, plus "all of it".
 *
 * Offering $100 to somebody holding $40 is offering a button that cannot work, so the
 * presets are filtered against the balance rather than shown and then refused.
 */
const amountOptions = computed(() => {
  const available = instantAvailable.value;
  const presets = [2_000, 5_000, 10_000].filter((cents) => cents < available);

  return [
    ...presets.map((cents) => ({ cents, label: formatCents(cents) })),
    { cents: available, label: `All · ${formatCents(available)}` },
  ];
});

const quote = computed(() => payouts.quote(chosenCents.value));

function openCashOut() {
  // Defaults to everything, which is what somebody pressing Cash Out almost always means.
  chosenCents.value = instantAvailable.value;
  cashOutOpen.value = true;
}

async function confirmCashOut() {
  const chair = barberId.value;
  if (chair === null) return;

  try {
    const payout = await payouts.cashOut(chair, chosenCents.value);
    cashOutOpen.value = false;
    notifySuccess(
      'On its way',
      `${formatCents(payout.amountCents - payout.feeCents)} should reach your bank within about 30 minutes.`,
    );
  } catch (error) {
    notifyApiFailure(error, 'Could not cash out just now.');
  }
}

const todayLabel = computed(() => {
  const iso = payouts.summary.value?.date;
  if (iso === undefined || iso === '') return 'today';

  // The server already resolved this in the shop's timezone; parse it as a plain date so
  // the browser's own zone cannot shift it back a day.
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return 'today';

  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
});

function payoutLine(payout: PayoutDto): string {
  const kind = payout.type === 'INSTANT' ? 'Instant' : 'Daily payout';
  const when = new Date(payout.createdAt).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
  });
  return `${kind} · ${when}`;
}

function statusLabel(status: string): string {
  if (status === 'PAID') return 'Paid';
  if (status === 'IN_TRANSIT') return 'On its way';
  if (status === 'FAILED') return 'Failed';
  if (status === 'CANCELED') return 'Cancelled';
  return 'Pending';
}

onMounted(async () => {
  const flag = route.query.connect;
  if (barberId.value === null || typeof flag !== 'string') return;

  if (flag === 'refresh') {
    clearQuery();
    await onStart();
    return;
  }

  if (flag === 'return') {
    clearQuery();
    try {
      const fresh = await connect.syncFromStripe(barberId.value);
      if (fresh.state === CONNECT_STATE.READY && fresh.payoutsEnabled) {
        notifySuccess('Payouts are set up', 'This chair can take card payments.');
      }
    } catch (error) {
      notifyApiFailure(error, 'Could not check your Stripe account.');
    }
  }
});
</script>

<template>
  <div class="earnings">
    <section v-if="barberId === null" class="card">
      <h2>No chair on this account</h2>
      <p class="body">
        This page shows one barber's own earnings. Your account does not cut hair — open
        <NuxtLink to="/barbers">Barbers &amp; Rent</NuxtLink> to see the shop's chairs.
      </p>
    </section>

    <template v-else>
      <!--
        Cleared. The money leads, because that is what almost every visit is about — the
        "payouts are set up" line drops to a footnote at the bottom, since it is a fact
        somebody only needs when it stops being true.
      -->
      <template v-if="allClear">
        <section class="hero">
          <span class="label">Ready to cash out</span>
          <p v-if="payouts.balance.value" class="amount">
            {{ formatCents(payouts.balance.value.instantAvailableCents) }}
          </p>
          <p v-else class="amount muted-amount">—</p>

          <p v-if="canCashOut" class="body">
            In your bank in about 30 minutes for {{ INSTANT_FEE_BPS / 100 }}% — or free
            tomorrow morning.
          </p>
          <p v-else-if="payouts.balanceUnavailable.value" class="body">
            Could not reach Stripe just now. Your takings below are still right.
          </p>
          <p v-else class="body">
            Nothing to cash out yet. Card takings appear here as they come in.
          </p>
        </section>

        <div>
          <Button label="Cash Out" :disabled="!canCashOut" @click="openCashOut" />
        </div>

        <section class="card">
          <header class="today-head">
            <span class="label">Today · {{ todayLabel }}</span>
            <span v-if="payouts.summary.value" class="hint num">
              {{ payouts.summary.value.cutCount }}
              {{ payouts.summary.value.cutCount === 1 ? 'cut' : 'cuts' }}
            </span>
          </header>

          <div v-if="payouts.summary.value" class="stats">
            <span class="stat">
              <span class="label">Cash</span>
              <span class="v num">{{ formatCents(payouts.summary.value.cashCents) }}</span>
            </span>
            <span class="stat">
              <span class="label">Card</span>
              <span class="v num">{{ formatCents(payouts.summary.value.cardCents) }}</span>
            </span>
            <span class="stat">
              <span class="label">Tips</span>
              <span class="v num dim">{{ formatCents(payouts.summary.value.tipsCents) }}</span>
            </span>
          </div>
        </section>

        <section class="card">
          <h2>Payout History</h2>

          <p v-if="payouts.payouts.value.length === 0" class="hint">
            Nothing yet. Your first daily payout lands the morning after your first card
            payment.
          </p>

          <div v-else class="list">
            <div v-for="payout in payouts.payouts.value" :key="payout.id" class="item">
              <span class="who">
                <span class="k num">{{ formatCents(payout.amountCents) }}</span>
                <span class="s">{{ payoutLine(payout) }}</span>
              </span>
              <span v-if="payout.feeCents > 0" class="fee num">
                −{{ formatCents(payout.feeCents) }}
              </span>
              <span v-else class="fee free">free</span>
              <span class="pill" :class="payout.status.toLowerCase()">
                {{ statusLabel(payout.status) }}
              </span>
            </div>
          </div>

          <!-- The cost of the habit, which no single press can show. -->
          <p v-if="payouts.feesPaidCents.value > 0" class="hint">
            Instant fees so far: {{ formatCents(payouts.feesPaidCents.value) }} across
            {{ payouts.instantPayoutCount.value }}
            {{ payouts.instantPayoutCount.value === 1 ? 'payout' : 'payouts' }}.
          </p>
        </section>

        <p class="hint">
          Payouts are set up. Card takings reach your account automatically every day, free.
        </p>
      </template>

      <section v-else class="card stack">
        <header class="head">
          <h2>Getting Paid</h2>
          <span class="pill" :class="{ warn: !notStarted }">
            {{ notStarted ? 'Not set up' : `${outstanding} to do` }}
          </span>
        </header>

        <p v-if="notStarted" class="body">
          Set up payouts to take card payments. Money from your cuts goes straight into
          your own account — the shop never holds it.
        </p>

        <ul v-else class="gates">
          <li v-for="gate in gates" :key="gate.key" class="gate">
            <span
              class="mark"
              :class="{ on: gate.done, blocked: gate.blocking }"
              aria-hidden="true"
            >{{ gate.done ? '✓' : gate.blocking ? '!' : '' }}</span>
            <span class="gate-text">
              <b>{{ gate.title }}</b>
              <small>{{ gate.detail }}</small>
            </span>
          </li>
        </ul>

        <Button
          v-if="actionLabel"
          :label="actionLabel"
          :loading="connect.starting.value"
          @click="onStart"
        />
      </section>

      <p v-if="!allClear" class="hint">
        Instant cash-out moves your card takings to your bank in minutes, for a fee. The
        daily payout is always free.
      </p>
    </template>

    <!--
      A step of its own rather than a button that just fires. The amount, the fee and what
      actually lands are on one surface, and the free alternative is named — a fee somebody
      pays without being told they had a choice is one they resent afterwards.
    -->
    <Dialog
      :visible="cashOutOpen"
      header="Cash Out"
      modal
      :style="{ width: 'min(26rem, 94vw)' }"
      @update:visible="cashOutOpen = $event"
    >
      <div class="confirm">
        <div>
          <span class="label">How much</span>
          <div class="picks">
            <Button
              v-for="option in amountOptions"
              :key="option.cents"
              :label="option.label"
              size="small"
              :variant="chosenCents === option.cents ? undefined : 'outlined'"
              @click="chosenCents = option.cents"
            />
          </div>
        </div>

        <div class="lines">
          <div class="line">
            <span>Cashing out</span>
            <span class="num">{{ formatCents(quote.amountCents) }}</span>
          </div>
          <div class="line fee">
            <span>Instant fee · {{ INSTANT_FEE_BPS / 100 }}%, min
              {{ formatCents(INSTANT_FEE_MIN_CENTS) }}</span>
            <span class="num">−{{ formatCents(quote.feeCents) }}</span>
          </div>
          <div class="line net">
            <span>Lands in your bank</span>
            <span class="num">{{ formatCents(quote.netCents) }}</span>
          </div>
        </div>

        <Message severity="warn" :closable="false">
          Waiting until tomorrow costs nothing — your daily payout is free.
        </Message>

        <div class="actions">
          <Button
            :label="`Cash Out ${formatCents(quote.amountCents)}`"
            :loading="payouts.cashingOut.value"
            @click="confirmCashOut"
          />
          <Button label="Not Now" variant="outlined" @click="cashOutOpen = false" />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.earnings {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.card {
  border: 1px solid var(--fc-line);
  background: var(--fc-surface);
  border-radius: 0.75rem;
  padding: 1.25rem;
}

.stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.9rem;
}

.head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
}

h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--fc-ink);
}

.body {
  margin: 0;
  max-width: 60ch;
  color: var(--fc-ink-muted);
  line-height: 1.5;
}

.hint {
  margin: 0;
  color: var(--fc-ink-faint);
  font-size: 0.85rem;
  line-height: 1.5;
  max-width: 60ch;
}

.pill {
  margin-left: auto;
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  border: 1px solid var(--fc-line);
  white-space: nowrap;
}

.pill.warn {
  color: var(--fc-danger-ink);
  background: var(--fc-danger-bg);
  border-color: transparent;
}

.gates {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  width: 100%;
}

.gate {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
}

.mark {
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  border: 1.5px solid var(--fc-line);
  display: grid;
  place-items: center;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--fc-ground);
  flex: none;
  margin-top: 0.15rem;
}

.mark.on {
  background: var(--fc-accent);
  border-color: var(--fc-accent);
}

.mark.blocked {
  border-color: var(--fc-danger);
  color: var(--fc-danger);
  background: none;
}

.gate-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.gate-text b {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--fc-ink);
}

.gate-text small {
  font-size: 0.8rem;
  color: var(--fc-ink-muted);
  line-height: 1.45;
}

/* --- The money ------------------------------------------------------------- */

.num {
  font-variant-numeric: tabular-nums;
}

.label {
  font-size: 0.65rem;
  font-weight: 660;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
}

.hero {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

/*
 * The one number most visits are about, so it is the size of a headline rather than a
 * figure in a table.
 */
.amount {
  margin: 0.1rem 0 0;
  font-size: 2.6rem;
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--fc-accent);
}

.amount.muted-amount {
  color: var(--fc-ink-faint);
}

.today-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.8rem;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr));
  gap: 0.9rem;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.stat .v {
  font-size: 1.35rem;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
}

.stat .v.dim {
  color: var(--fc-ink-muted);
  font-weight: 600;
}

.list {
  display: flex;
  flex-direction: column;
  margin-top: 0.6rem;
}

.item {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--fc-line);
}

.item:last-child {
  border-bottom: 0;
}

.item .who {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  flex: 1;
  min-width: 0;
}

.item .k {
  font-size: 0.95rem;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
}

.item .s {
  font-size: 0.78rem;
  color: var(--fc-ink-muted);
}

/* Red is reserved for failure, so a fee is muted rather than alarming — it was agreed to. */
.item .fee {
  font-size: 0.82rem;
  color: var(--fc-ink-muted);
  white-space: nowrap;
}

.item .fee.free {
  color: var(--fc-ink-faint);
}

.pill.paid {
  color: var(--fc-accent);
  background: var(--fc-accent-wash);
  border-color: transparent;
}

.pill.failed,
.pill.canceled {
  color: var(--fc-danger-ink);
  background: var(--fc-danger-bg);
  border-color: transparent;
}

/* --- The confirm step ------------------------------------------------------- */

.confirm {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.picks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.5rem;
}

.lines {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.88rem;
  color: var(--fc-ink-muted);
}

.line .num {
  color: var(--fc-ink);
}

/*
 * The fee is the number somebody is agreeing to, so it is the one that stands out — but
 * in the danger ink rather than the danger red, because it is a cost, not a failure.
 */
.line.fee .num {
  color: var(--fc-danger-ink);
}

.line.net {
  border-top: 1px solid var(--fc-line);
  padding-top: 0.6rem;
  margin-top: 0.2rem;
  font-size: 1rem;
  font-weight: 660;
  color: var(--fc-ink);
}

.line.net .num {
  font-size: 1.45rem;
  color: var(--fc-accent);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
