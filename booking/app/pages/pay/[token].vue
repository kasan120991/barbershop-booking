<script setup lang="ts">
/**
 * The customer's checkout page.
 *
 * Reached by scanning the QR the barber is holding, so the person here has no account and
 * never will — the token in the URL is the whole credential, exactly as it is on the
 * cancel link. It carries nothing about them: no name, no phone, just the cut they are
 * being asked to pay for.
 *
 * The money goes **straight into the barber's own Stripe account**. That is why Stripe.js
 * is initialised with `stripeAccount`: on a direct charge the barber is the merchant, not
 * the shop, and an Element pointed at the platform would collect for the wrong party.
 *
 * The PaymentIntent is created at submit, not on load. The tip changes the amount and the
 * customer can change their mind twice before paying; creating the intent up front would
 * mean amending it on every tap, and racing anyone who submits mid-amendment.
 */

import { formatCents, percentOfCents, type CheckoutViewDto } from '@francis/shared';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';

const route = useRoute();
const api = useApi();

const token = computed(() => String(route.params.token ?? ''));

const { data, error } = await useAsyncData(`pay:${token.value}`, () =>
  api<CheckoutViewDto>(`/payments/checkout/${token.value}`),
);

useHead({ title: 'Pay for your cut — Francis Cutz' });

const TIP_PERCENTS = [15, 18, 20];

const tipCents = ref(0);
const customOpen = ref(false);
const customDollars = ref<number | null>(null);

const amountCents = computed(() => data.value?.amountCents ?? 0);
const totalCents = computed(() => amountCents.value + tipCents.value);

function presetCents(percent: number): number {
  return percentOfCents(amountCents.value, percent);
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

// Dollars exist only at this input; everything downstream is integer cents.
watch(customDollars, (dollars) => {
  tipCents.value = dollars === null ? 0 : Math.round(dollars * 100);
});

const stripe = shallowRef<Stripe | null>(null);
const elements = shallowRef<StripeElements | null>(null);
const mounting = ref(true);
const paying = ref(false);
const paid = ref(false);
const refusal = ref<string | null>(null);

/**
 * Already settled when the page opened — a paid link that got scanned twice, or reloaded
 * after paying. Better to say so than to offer a second payment for the same cut.
 */
const alreadyDone = computed(() => data.value != null && data.value.status !== 'PENDING');

onMounted(async () => {
  const view = data.value;

  if (view == null || alreadyDone.value) {
    mounting.value = false;
    return;
  }

  try {
    // Loaded from js.stripe.com by this call, never bundled — Stripe requires that for
    // PCI, and a self-hosted copy silently breaks compliance rather than the page.
    const loaded = await loadStripe(view.publishableKey, {
      stripeAccount: view.stripeAccountId,
    });

    if (loaded === null) {
      refusal.value = 'Could not load the payment form. Check your connection and try again.';
      return;
    }

    stripe.value = loaded;
    elements.value = loaded.elements({
      mode: 'payment',
      currency: 'usd',
      amount: totalCents.value,
      appearance: { theme: 'stripe' },
    });

    elements.value.create('payment').mount('#payment-element');
  } catch {
    refusal.value = 'Could not load the payment form. Check your connection and try again.';
  } finally {
    mounting.value = false;
  }
});

// The Element has to be told the amount changed, or it prices the wrong total.
watch(totalCents, (next) => {
  if (elements.value !== null && next > 0) elements.value.update({ amount: next });
});

async function pay() {
  const client = stripe.value;
  const group = elements.value;
  if (client === null || group === null) return;

  paying.value = true;
  refusal.value = null;

  try {
    // Validates the form before anything is created server-side.
    const submitted = await group.submit();
    if (submitted.error) {
      refusal.value = submitted.error.message ?? 'Check your card details and try again.';
      return;
    }

    let intent: { clientSecret: string; totalCents: number };
    try {
      intent = await api<{ clientSecret: string; totalCents: number }>(
        `/payments/checkout/${token.value}/intent`,
        { method: 'POST', body: { tipCents: tipCents.value } },
      );
    } catch (caught) {
      // Only our own API failures get this treatment — the server's own sentence, not a
      // generic one. Anything thrown further down is not a request that failed.
      refusal.value = toApiFailure(caught).message;
      return;
    }

    const result = await client.confirmPayment({
      elements: group,
      clientSecret: intent.clientSecret,
      /**
       * `return_url` is required even though a card never uses it.
       *
       * `redirect: 'if_required'` keeps a card payment on this page, but the Element also
       * offers Cash App Pay, Affirm and Klarna — all of which leave the site — and Stripe
       * refuses to confirm at all unless it has somewhere to send them back to. Omitting
       * it throws an integration error at the moment of payment, which is the worst
       * possible time to find out.
       */
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (result.error) {
      refusal.value = result.error.message ?? 'That payment did not go through.';
      return;
    }

    paid.value = true;
  } catch (caught) {
    // Not a failed request — a fault in the payment form itself. The customer cannot act
    // on the detail, so they get a plain sentence and the console gets the rest.
    console.error('Payment confirmation failed', caught);
    refusal.value = 'Something went wrong taking that payment. Try again, or ask your barber.';
  } finally {
    paying.value = false;
  }
}
</script>

<template>
  <div class="pay-page">
    <div v-if="error" class="empty">
      <h1>That link is not valid.</h1>
      <p>It may have been mistyped, or the payment may already be done.</p>
      <NuxtLink to="/"><Button label="Book an Appointment" /></NuxtLink>
    </div>

    <div v-else-if="paid" class="empty">
      <h1>Paid. Thank you.</h1>
      <p>{{ formatCents(totalCents) }} to {{ data?.barberName }}. You're all set.</p>
    </div>

    <div v-else-if="alreadyDone" class="empty">
      <h1>This one's already settled.</h1>
      <p>Nothing more to pay. If that doesn't look right, ask your barber.</p>
    </div>

    <div v-else-if="data" class="sheet">
      <header class="head">
        <p class="who">{{ data.barberName }}</p>
        <h1>{{ data.serviceNames.join(' · ') || 'Your cut' }}</h1>
        <p class="amount">{{ formatCents(amountCents) }}</p>
      </header>

      <section class="block">
        <h2>Add a tip</h2>
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
            label="Other"
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
      </section>

      <section class="block">
        <div class="line">
          <span>Cut</span><span>{{ formatCents(amountCents) }}</span>
        </div>
        <div class="line">
          <span>Tip</span><span>{{ formatCents(tipCents) }}</span>
        </div>
        <div class="line grand">
          <span>Total</span><span>{{ formatCents(totalCents) }}</span>
        </div>
      </section>

      <section class="block">
        <p v-if="mounting" class="hint">Loading the payment form…</p>
        <div id="payment-element"></div>
      </section>

      <Message v-if="refusal" severity="warn" :closable="false">{{ refusal }}</Message>

      <Button
        :label="`Pay ${formatCents(totalCents)}`"
        :loading="paying"
        :disabled="mounting || paying"
        @click="pay"
      />

      <p class="hint">
        This payment goes directly to {{ data.barberName }}. Francis Cutz never holds it.
      </p>
    </div>
  </div>
</template>

<style scoped>
.pay-page {
  max-width: 30rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}

.sheet {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.who {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--fcb-ink-muted);
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  line-height: 1.15;
  letter-spacing: -0.015em;
  text-wrap: balance;
}

.amount {
  margin: 0.25rem 0 0;
  font-size: 2rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

h2 {
  margin: 0 0 0.6rem;
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--fcb-ink-muted);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.tips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.92rem;
}

.line span:last-child {
  font-variant-numeric: tabular-nums;
}

.line.grand {
  border-top: 1px solid var(--fcb-line);
  padding-top: 0.6rem;
  font-size: 1.05rem;
  font-weight: 650;
}

.hint {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--fcb-ink-muted);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 3rem 0;
}

.empty p {
  margin: 0;
  color: var(--fcb-ink-muted);
  line-height: 1.5;
}
</style>
