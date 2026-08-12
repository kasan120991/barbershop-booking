<script setup lang="ts">
/**
 * What a chair costs, and who has paid for it.
 *
 * Arrears first, deliberately. The number this page exists to answer is "what does this chair
 * owe", and the action it exists to take is "somebody just handed me money" — so both are at
 * the top and neither requires hunting a row. The ledger is the receipt underneath, folded
 * away, because it is what you open when a figure is disputed rather than what you read.
 *
 * A payment is recorded against the *chair*, not against a week: the server spreads it
 * oldest-first (`POST /barbers/:id/rent-payments`). The breakdown below the amount field is a
 * client-side reproduction of that same rule, shown before submitting — allocation is easy to
 * describe and unnerving to watch happen invisibly to money somebody just handed over.
 *
 * Reading the ledger is what raises any charges the plan is owed and has not had, so simply
 * opening this tab brings a chair up to date. That is deliberate: there is no scheduler in
 * this app, and rent that only accrues when somebody remembers to press something is rent
 * that stops accruing.
 */

import {
  RENT_CADENCE,
  RENT_CHARGE_STATUS,
  RENT_PAYMENT_METHOD,
  dayName,
  formatCents,
  formatCentsPlain,
  parseDollarsToCents,
  type RentChargeDto,
} from '@francis/shared';

const props = defineProps<{ barberId: string }>();

const rent = useRent();
const shop = useShopClock();
const { notifySuccess, notifyApiFailure } = useNotify();

// Not awaited — this is a panel inside a page, and the date it needs is only read when
// the plan dialog opens. See the same note in `ClientLookupFields.vue`.
void shop.ensureLoaded();

const plan = computed(() => rent.overview.value?.plan ?? null);
const charges = computed(() => rent.overview.value?.charges ?? []);
const summary = computed(() => rent.overview.value?.summary ?? null);
const outstanding = computed(() => summary.value?.outstandingCents ?? 0);

/**
 * What is owed, oldest first — the same order the server settles in.
 *
 * `outstandingCents` is already zero on a waived charge, so filtering on it drops both the
 * paid and the written-off without a second condition. The server orders by `dueDate`; the
 * overview arrives newest-first for the ledger, so this reverses rather than assuming.
 */
const owing = computed(() =>
  charges.value
    .filter((charge) => charge.outstandingCents > 0)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate)),
);

// --- Recording a payment ------------------------------------------------------

const payError = ref<string | null>(null);

const payForm = reactive({
  amount: '',
  method: RENT_PAYMENT_METHOD.CASH as string,
  note: '',
});

const METHODS = [
  { value: RENT_PAYMENT_METHOD.CASH, label: 'Cash' },
  { value: RENT_PAYMENT_METHOD.ZELLE, label: 'Zelle' },
  { value: RENT_PAYMENT_METHOD.CHECK, label: 'Cheque' },
  { value: RENT_PAYMENT_METHOD.CARD_MANUAL, label: 'Card, by hand' },
  { value: RENT_PAYMENT_METHOD.OTHER, label: 'Something else' },
];

const typedCents = computed(() => parseDollarsToCents(payForm.amount));

/** More than is owed has nowhere to go — the server refuses it, so the form says so first. */
const tooMuch = computed(
  () => typedCents.value !== null && typedCents.value > outstanding.value && outstanding.value > 0,
);

interface Slice {
  charge: RentChargeDto;
  amountCents: number;
  clears: boolean;
}

/**
 * The same walk the server does, run as you type.
 *
 * Kept as a preview only: nothing here is sent, and the figures that land come back from the
 * server's own allocation. Two implementations of one rule is a real cost, and it is worth it
 * because the alternative is a person typing $600 into a box and pressing a button that says
 * nothing about which weeks it touches.
 */
const preview = computed<Slice[]>(() => {
  const total = typedCents.value;
  if (total === null || total <= 0 || tooMuch.value) return [];

  const slices: Slice[] = [];
  let remaining = total;

  for (const charge of owing.value) {
    if (remaining <= 0) break;
    const amountCents = Math.min(remaining, charge.outstandingCents);
    remaining -= amountCents;
    slices.push({ charge, amountCents, clears: amountCents === charge.outstandingCents });
  }

  return slices;
});

function payEverything() {
  payForm.amount = formatCentsPlain(outstanding.value);
  payError.value = null;
}

async function submitPayment() {
  payError.value = null;

  const amountCents = typedCents.value;
  if (amountCents === null || amountCents <= 0) {
    payError.value = 'Enter how much was handed over, like 250 or 250.00.';
    return;
  }

  // Named up front so the confirmation can still describe the weeks after the refetch.
  const cleared = preview.value.filter((slice) => slice.clears).length;

  try {
    await rent.payChair(props.barberId, {
      amountCents,
      method: payForm.method,
      ...(payForm.note.trim() === '' ? {} : { note: payForm.note.trim() }),
    });

    payForm.amount = '';
    payForm.note = '';
    notifySuccess(
      'Payment recorded',
      cleared === 0
        ? `${formatCents(amountCents)} against the oldest week owed.`
        : `${formatCents(amountCents)} received, clearing ${String(cleared)} ${cleared === 1 ? 'period' : 'periods'}.`,
    );
  } catch (error) {
    notifyApiFailure(error, 'Could not record that payment.');
  }
}

// --- The ledger ---------------------------------------------------------------

const ledgerOpen = ref(false);

/**
 * Its own fetch, re-run when the roster selection changes — see the note in `useRent`.
 *
 * It sits below the state it clears rather than at the top of the file where the other
 * panels put theirs, because `immediate: true` runs the callback *during setup*: reaching
 * up at a `const` declared further down is a temporal-dead-zone error, and the whole route
 * 500s with "Cannot access 'payForm' before initialization".
 *
 * Clearing matters as much as fetching. A half-typed $600 left in the box while the roster
 * moves to another chair is an amount about to be recorded against the wrong barber.
 */
watch(
  () => props.barberId,
  (barberId) => {
    void rent.refresh(barberId);
    payForm.amount = '';
    payForm.note = '';
    payError.value = null;
    ledgerOpen.value = false;
  },
  { immediate: true },
);

// --- The plan -----------------------------------------------------------------

const planOpen = ref(false);
const planError = ref<string | null>(null);

const form = reactive({
  amount: '',
  cadence: RENT_CADENCE.WEEKLY as string,
  anchorDay: 1,
  startDate: '',
});

const WEEKDAYS = Array.from({ length: 7 }, (_, index) => ({
  value: index,
  label: dayName(index),
}));

const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => ({
  value: index + 1,
  label: String(index + 1),
}));

const CADENCES = [
  { value: RENT_CADENCE.WEEKLY, label: 'Weekly' },
  { value: RENT_CADENCE.MONTHLY, label: 'Monthly' },
];

watch(planOpen, (open) => {
  if (!open) return;
  planError.value = null;

  const current = plan.value;
  // Dollars in the field, cents everywhere else — the conversion happens once, on save.
  form.amount = current ? formatCentsPlain(current.amountCents) : '';
  form.cadence = current?.cadence ?? RENT_CADENCE.WEEKLY;
  form.anchorDay = current?.anchorDay ?? 1;
  // `toISOString()` is UTC, so between eight in the evening and midnight the shop was
  // offered tomorrow's date as the day the rent starts.
  form.startDate = current?.startDate ?? shop.today();
});

async function savePlan() {
  planError.value = null;

  const amountCents = parseDollarsToCents(form.amount);
  if (amountCents === null || amountCents <= 0) {
    planError.value = 'Enter what the chair costs, like 250 or 250.00.';
    return;
  }

  if (form.startDate === '') {
    planError.value = 'Pick the date this rent starts from.';
    return;
  }

  try {
    await rent.savePlan(props.barberId, {
      amountCents,
      cadence: form.cadence,
      anchorDay: form.anchorDay,
      startDate: form.startDate,
    });
    planOpen.value = false;
    notifySuccess('Rent plan saved', 'Charges will be raised from the start date.');
  } catch (error) {
    notifyApiFailure(error, 'Could not save that rent plan.');
  }
}

const planSummary = computed(() => {
  const current = plan.value;
  if (current === null) return null;

  const every =
    current.cadence === RENT_CADENCE.WEEKLY
      ? `every ${dayName(current.anchorDay)}`
      : `on the ${ordinal(current.anchorDay)} of the month`;

  return `${formatCents(current.amountCents)} ${every}, since ${formatPlainDate(current.startDate)}`;
});

function ordinal(value: number): string {
  const suffix =
    value % 10 === 1 && value !== 11
      ? 'st'
      : value % 10 === 2 && value !== 12
        ? 'nd'
        : value % 10 === 3 && value !== 13
          ? 'rd'
          : 'th';
  return `${String(value)}${suffix}`;
}

function periodOf(charge: RentChargeDto): string {
  return formatPeriod(charge.periodStart, charge.periodEnd);
}

function statusLabel(charge: RentChargeDto): string {
  if (charge.status === RENT_CHARGE_STATUS.PAID) return 'Paid';
  if (charge.status === RENT_CHARGE_STATUS.PARTIAL) return 'Part paid';
  if (charge.status === RENT_CHARGE_STATUS.WAIVED) return 'Waived';
  return 'Due';
}

/** "3 weeks behind" is the shape of the sentence people actually say about arrears. */
const behind = computed(() => {
  const count = summary.value?.unpaidCount ?? 0;
  if (count === 0) return null;
  const noun = plan.value?.cadence === RENT_CADENCE.MONTHLY ? 'month' : 'week';
  return `${String(count)} ${count === 1 ? noun : `${noun}s`} behind`;
});
</script>

<template>
  <section class="rent">
    <div v-if="rent.loading.value && rent.overview.value === null" class="hint">Loading rent…</div>

    <template v-else>
      <!-- What is owed --------------------------------------------------------- -->
      <div class="card owed" :class="{ square: outstanding === 0 }">
        <span class="fc-label">Outstanding</span>
        <p class="figure num">{{ formatCents(outstanding) }}</p>

        <p v-if="outstanding > 0 && summary" class="sub">
          {{ behind }}
          <template v-if="summary.oldestDueDate">
            · oldest due {{ formatPlainDate(summary.oldestDueDate) }}
          </template>
        </p>
        <p v-else-if="plan && summary?.nextDueDate" class="sub">
          Square. Next {{ formatCents(plan.amountCents) }} due
          {{ formatPlainDate(summary.nextDueDate) }}.
        </p>
        <p v-else-if="plan" class="sub">Square.</p>
        <p v-else class="sub">No rent set for this chair. Nothing is charged until a plan exists.</p>
      </div>

      <!-- Taking money --------------------------------------------------------- -->
      <div v-if="outstanding > 0" class="card">
        <header class="head">
          <h3>Record A Payment</h3>
          <button type="button" class="link" @click="payEverything">
            Pay it all — {{ formatCents(outstanding) }}
          </button>
        </header>

        <Message v-if="payError" severity="error" :closable="false">{{ payError }}</Message>

        <div class="pay">
          <div class="field amount">
            <label for="pay-amount" class="fc-label">Amount received</label>
            <InputGroup>
              <InputGroupAddon>$</InputGroupAddon>
              <InputText
                id="pay-amount"
                v-model="payForm.amount"
                inputmode="decimal"
                placeholder="0.00"
              />
            </InputGroup>
          </div>

          <div class="field">
            <label for="pay-method" class="fc-label">How</label>
            <Select
              id="pay-method"
              v-model="payForm.method"
              :options="METHODS"
              option-label="label"
              option-value="value"
              fluid
            />
          </div>

          <div class="field grow">
            <label for="pay-note" class="fc-label">Note</label>
            <InputText id="pay-note" v-model="payForm.note" placeholder="Optional" />
          </div>
        </div>

        <!-- Where it goes ------------------------------------------------------ -->
        <p v-if="tooMuch" class="hint warn">
          That is more than this chair owes. The most that can be recorded is
          {{ formatCents(outstanding) }}.
        </p>

        <div v-else-if="preview.length > 0" class="allocation">
          <span class="fc-label">This settles</span>
          <ul>
            <li v-for="slice in preview" :key="slice.charge.id">
              <span class="period">{{ periodOf(slice.charge) }}</span>
              <span class="num">{{ formatCents(slice.amountCents) }}</span>
              <span class="outcome" :class="{ clears: slice.clears }">
                {{
                  slice.clears
                    ? 'cleared'
                    : `leaves ${formatCents(slice.charge.outstandingCents - slice.amountCents)}`
                }}
              </span>
            </li>
          </ul>
        </div>

        <p v-else class="hint">
          Whatever is entered goes against the oldest period owed first, and carries on into the
          next if there is more than one to settle.
        </p>

        <div class="actions">
          <Button
            label="Record Payment"
            :disabled="tooMuch || preview.length === 0"
            :loading="rent.saving.value"
            @click="submitPayment"
          />
        </div>
      </div>

      <!-- The plan ------------------------------------------------------------- -->
      <div class="card row">
        <div class="planline">
          <span class="fc-label">The Plan</span>
          <p class="sub">{{ planSummary ?? 'Not set.' }}</p>
        </div>
        <Button
          :label="plan ? 'Change' : 'Set Rent'"
          size="small"
          variant="outlined"
          @click="planOpen = true"
        />
      </div>

      <!-- The receipt ---------------------------------------------------------- -->
      <div v-if="charges.length > 0" class="card">
        <button type="button" class="disclose" @click="ledgerOpen = !ledgerOpen">
          <span class="chev" :class="{ open: ledgerOpen }">›</span>
          <h3>Ledger</h3>
          <span class="hint">{{ charges.length }} charges</span>
        </button>

        <table v-if="ledgerOpen" class="ledger">
          <thead>
            <tr>
              <th>Period</th>
              <th class="right">Rent</th>
              <th class="right">Paid</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="charge in charges" :key="charge.id">
              <td>
                {{ periodOf(charge) }}
                <span v-if="!charge.fromPlan" class="oneoff" title="Added by hand">one-off</span>
              </td>
              <td class="right num">{{ formatCents(charge.amountCents) }}</td>
              <td class="right num">
                {{ charge.paidCents > 0 ? formatCents(charge.paidCents) : '—' }}
              </td>
              <td>
                <span class="pill" :class="charge.status.toLowerCase()">
                  {{ statusLabel(charge) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Set the plan ---------------------------------------------------------- -->
    <Dialog
      :visible="planOpen"
      header="Rent For This Chair"
      modal
      :style="{ width: 'min(28rem, 94vw)' }"
      @update:visible="planOpen = $event"
    >
      <div class="form">
        <Message v-if="planError" severity="error" :closable="false">{{ planError }}</Message>

        <div class="field">
          <label for="rent-amount" class="fc-label">Amount</label>
          <InputGroup>
            <InputGroupAddon>$</InputGroupAddon>
            <InputText
              id="rent-amount"
              v-model="form.amount"
              inputmode="decimal"
              placeholder="250.00"
            />
          </InputGroup>
        </div>

        <div class="field">
          <label for="rent-cadence" class="fc-label">How often</label>
          <Select
            id="rent-cadence"
            v-model="form.cadence"
            :options="CADENCES"
            option-label="label"
            option-value="value"
            fluid
          />
        </div>

        <div class="field">
          <label for="rent-anchor" class="fc-label">
            {{ form.cadence === RENT_CADENCE.WEEKLY ? 'Charged every' : 'Charged on the' }}
          </label>
          <Select
            id="rent-anchor"
            v-model="form.anchorDay"
            :options="form.cadence === RENT_CADENCE.WEEKLY ? WEEKDAYS : MONTH_DAYS"
            option-label="label"
            option-value="value"
            fluid
          />
          <p class="hint">
            Rent is due at the start of each period, so this is both the day it is charged and the
            day it is owed.
          </p>
        </div>

        <div class="field">
          <label for="rent-start" class="fc-label">Starting from</label>
          <input id="rent-start" v-model="form.startDate" type="date" class="fc-input" >
          <p class="hint">
            The first charge is the first
            {{ form.cadence === RENT_CADENCE.WEEKLY ? 'anchor day' : 'anchor date' }} on or after
            this — nobody is charged for time before they were here.
          </p>
        </div>

        <div class="actions">
          <Button label="Save Plan" :loading="rent.saving.value" @click="savePlan" />
          <Button label="Cancel" variant="outlined" @click="planOpen = false" />
        </div>
      </div>
    </Dialog>
  </section>
</template>

<style scoped>
.rent {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.75rem;
}

.card {
  border: 1px solid var(--fc-line);
  background: var(--fc-surface);
  border-radius: 0.75rem;
  padding: 1.1rem;
}

.card.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

/* The number the page exists to answer, so it is the only thing set at this size. */
.owed .figure {
  margin: 0.25rem 0 0.3rem;
  font-size: 2.4rem;
  line-height: 1;
  font-weight: 660;
  letter-spacing: -0.02em;
  color: var(--fc-ink);
  font-variant-numeric: tabular-nums;
}

.owed.square .figure {
  color: var(--fc-ink-faint);
}

.sub {
  margin: 0;
  color: var(--fc-ink-faint);
  font-size: 0.83rem;
  line-height: 1.5;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 620;
  color: var(--fc-ink);
}

.hint {
  margin: 0;
  color: var(--fc-ink-faint);
  font-size: 0.8rem;
  line-height: 1.5;
}

.hint.warn {
  color: var(--fc-accent);
}

.num {
  font-variant-numeric: tabular-nums;
}

.pay {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.9rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.pay .amount {
  width: 9.5rem;
}

.pay .grow {
  flex: 1 1 12rem;
}

/* The allocation, indented under the amount that caused it. */
.allocation {
  border-left: 2px solid var(--fc-accent);
  padding-left: 0.8rem;
}

.allocation ul {
  margin: 0.4rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.85rem;
}

.allocation li {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.allocation .period {
  min-width: 8rem;
}

.allocation .num {
  font-weight: 620;
  min-width: 5rem;
}

.allocation .outcome {
  font-size: 0.78rem;
  color: var(--fc-ink-faint);
}

.allocation .outcome.clears {
  color: var(--fc-accent);
}

.planline {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.disclose {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.chev {
  display: inline-block;
  color: var(--fc-ink-faint);
  transition: transform 0.15s ease;
}

.chev.open {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .chev {
    transition: none;
  }
}

.ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
  margin-top: 0.85rem;
}

.ledger th {
  text-align: left;
  font-size: 0.62rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 660;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--fc-line);
}

.ledger td {
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--fc-line);
}

.ledger tr:last-child td {
  border-bottom: 0;
}

.ledger .right {
  text-align: right;
}

.oneoff {
  margin-left: 0.4rem;
  font-size: 0.66rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
}

.pill {
  font-size: 0.62rem;
  font-weight: 660;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.14rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--fc-line);
  color: var(--fc-ink-faint);
  white-space: nowrap;
}

/* Red is reserved for failure; rent that is simply owed is not a failure, it is a fact. */
.pill.due {
  color: var(--fc-ink);
  border-color: var(--fc-ink-faint);
}

.pill.partial {
  color: var(--fc-accent);
  background: var(--fc-accent-wash);
  border-color: transparent;
}

.pill.waived {
  font-style: italic;
}

.link {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 0.8rem;
  color: var(--fc-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.9rem;
}
</style>
