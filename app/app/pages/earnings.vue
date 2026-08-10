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

import { CONNECT_STATE } from '@francis/shared';

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
      <!-- Cleared: one line, not a checklist someone already finished. -->
      <section v-if="allClear" class="card done-line">
        <span class="mark on" aria-hidden="true">✓</span>
        <p class="body">
          Payouts are set up. Card takings reach your account automatically every day.
        </p>
      </section>

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

      <p class="hint">
        Instant cash-out needs a debit card, not just a bank account. The fee is always
        shown before you confirm.
      </p>
    </template>

    <PagePlaceholder
      phase="Phase 14 · Payouts &amp; Rent"
      summary="Today's card and cash totals, your Stripe balance, and the instant cash-out button."
    />
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

.done-line {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
</style>
