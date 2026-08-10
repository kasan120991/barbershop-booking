<script setup lang="ts">
/**
 * The barber's own money page.
 *
 * Phase 13 fills in the top of it: getting this chair onboarded onto Stripe far enough
 * that it can be paid. Balances, today's totals and the instant cash-out button are
 * Phase 14 and still placeheld below.
 *
 * The chair is always the signed-in barber's own. An admin who does not also cut hair
 * has no chair here — that is not an error state, it is simply not their page, and
 * `/barbers` is where they look at somebody else's.
 *
 * Two query params come back from Stripe, and they mean different things:
 *
 * - `?connect=return` — they finished (or abandoned) the hosted flow. Re-read the live
 *   account, because `account.updated` has usually not arrived yet and the mirror would
 *   otherwise still say "Set Up Payouts" to someone who just spent five minutes on it.
 * - `?connect=refresh` — they landed on an expired link. Stripe expires these in
 *   minutes. The only useful response is to mint another one and send them straight
 *   back, so this is not an error page.
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

/**
 * The wording each state deserves.
 *
 * `PENDING` gets no button on purpose: nothing the barber can do moves it, and offering
 * an action that cannot help is worse than saying plainly that it is Stripe's turn.
 */
const COPY: Record<string, { label: string; body: string; action: string | null }> = {
  [CONNECT_STATE.NOT_STARTED]: {
    label: 'Not set up',
    body: 'Set up payouts to take card payments. Money from your cuts goes straight into your own account — the shop never holds it.',
    action: 'Set Up Payouts',
  },
  [CONNECT_STATE.INCOMPLETE]: {
    label: 'Unfinished',
    body: 'Stripe still needs a few details before this chair can take card payments. You can pick up where you left off.',
    action: 'Finish Setup',
  },
  [CONNECT_STATE.PENDING]: {
    label: 'Under review',
    body: 'Everything is submitted. Stripe is reviewing your details — this usually takes a few minutes, and nothing else is needed from you.',
    action: null,
  },
  [CONNECT_STATE.READY]: {
    label: 'Ready',
    body: 'This chair can take card payments.',
    action: null,
  },
};

const copy = computed(() => COPY[connect.status.value?.state ?? CONNECT_STATE.NOT_STARTED]!);

/**
 * Surfaced on its own rather than folded into the state, because it fails on its own: a
 * chair can be cleared to charge while its payout method is still missing, and "you're
 * all set" to that barber is a lie they discover at the end of the day.
 */
const payoutsBlocked = computed(
  () => connect.status.value?.chargesEnabled === true && !connect.status.value.payoutsEnabled,
);

async function onStart() {
  if (barberId.value === null) return;
  try {
    await connect.startOnboarding(barberId.value);
  } catch (error) {
    notifyApiFailure(error, 'Could not open Stripe setup.');
  }
}

/** Drops the query param so a reload does not repeat the round trip. */
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
      if (fresh.state === CONNECT_STATE.READY) {
        notifySuccess('Payouts are set up', 'This chair can now take card payments.');
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

    <section v-else class="card">
      <header class="head">
        <h2>Card Payouts</h2>
        <span class="pill" :class="(connect.status.value?.state ?? 'NOT_STARTED').toLowerCase()">
          {{ copy.label }}
        </span>
      </header>

      <p class="body">{{ copy.body }}</p>

      <!-- Charges and payouts are reported separately because they fail separately. -->
      <p v-if="payoutsBlocked" class="warn">
        Card payments work, but Stripe cannot pay out yet — a bank account or debit card
        is still missing. Add one to start receiving your daily payout.
      </p>

      <Button
        v-if="copy.action"
        :label="copy.action"
        size="small"
        :loading="connect.starting.value"
        @click="onStart"
      />
    </section>

    <PagePlaceholder
      phase="Phase 14 · Payouts & Rent"
      summary="Today's card and cash totals, your Stripe balance, and the instant cash-out button."
    />
  </div>
</template>

<style scoped>
.earnings {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.card {
  border: 1px solid var(--fc-line);
  background: var(--fc-surface);
  border-radius: 0.75rem;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.75rem;
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

.warn {
  margin: 0;
  max-width: 60ch;
  color: var(--fc-danger-ink);
  line-height: 1.5;
}

.pill {
  margin-left: auto;
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--fc-ink-faint);
  border: 1px solid var(--fc-line);
}

.pill.ready {
  color: var(--fc-accent);
  background: var(--fc-accent-wash);
  border-color: transparent;
}
</style>
