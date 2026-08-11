<script setup lang="ts">
/**
 * The barber's own side of booth rent.
 *
 * Read-only, and not because it is a lesser version of the admin panel — because a barber
 * saying they paid is not evidence the shop received it. Recording a payment is the job of
 * whoever took the money. The server enforces that (`rent-payments` is admin-only); this
 * simply does not offer it.
 *
 * Same shape as the admin panel: the number owed leads, the receipt is underneath. What
 * changes is that there is no form between them, so the ledger opens by default — with
 * nothing to do here, the detail *is* the page.
 *
 * Reading raises any charges the plan is owed and has not had, so a barber opening this is
 * as good as an admin opening it for keeping the chair up to date.
 */

import { RENT_CADENCE, RENT_CHARGE_STATUS, dayName, formatCents } from '@francis/shared';

import type { RentChargeDto } from '@francis/shared';

useHead({ title: 'My Rent — Francis Cutz' });

const auth = useAuthStore();
const rent = useRent();

const barberId = computed(() => auth.user?.barberId ?? null);

if (barberId.value !== null) {
  await rent.refresh(barberId.value);
}

const plan = computed(() => rent.overview.value?.plan ?? null);
const charges = computed(() => rent.overview.value?.charges ?? []);
const summary = computed(() => rent.overview.value?.summary ?? null);
const outstanding = computed(() => summary.value?.outstandingCents ?? 0);

const behind = computed(() => {
  const count = summary.value?.unpaidCount ?? 0;
  if (count === 0) return null;
  const noun = plan.value?.cadence === RENT_CADENCE.MONTHLY ? 'month' : 'week';
  return `${String(count)} ${count === 1 ? noun : `${noun}s`} behind`;
});

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
</script>

<template>
  <div class="myrent">
    <section v-if="barberId === null" class="card">
      <h2>No chair on this account</h2>
      <p class="sub">
        This page shows one barber's own rent. Your account does not cut hair — open
        <NuxtLink to="/barbers">Barbers &amp; Rent</NuxtLink> to see the shop's chairs.
      </p>
    </section>

    <template v-else>
      <section class="card owed" :class="{ square: outstanding === 0 }">
        <span class="fc-label">You owe</span>
        <p class="figure num">{{ formatCents(outstanding) }}</p>

        <p v-if="outstanding > 0 && summary" class="sub">
          {{ behind }}
          <template v-if="summary.oldestDueDate">
            · oldest due {{ formatPlainDate(summary.oldestDueDate) }}
          </template>
        </p>
        <p v-else-if="plan && summary?.nextDueDate" class="sub">
          You are square. Next {{ formatCents(plan.amountCents) }} due
          {{ formatPlainDate(summary.nextDueDate) }}.
        </p>
        <p v-else-if="plan" class="sub">You are square.</p>
        <p v-else class="sub">No rent is set for your chair yet.</p>
      </section>

      <section class="card row">
        <div class="planline">
          <span class="fc-label">Your Rent</span>
          <p class="sub">{{ planSummary ?? 'Not set.' }}</p>
        </div>
      </section>

      <section class="card">
        <h3>Ledger</h3>

        <p v-if="charges.length === 0" class="sub">
          Nothing charged yet. Periods appear here once your rent has started.
        </p>

        <table v-else class="ledger">
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
      </section>

      <p class="footnote">
        Rent is settled with the shop in person — cash, Zelle or a cheque. It appears here once
        the shop has recorded taking it, which is why nothing on this page is yours to change.
      </p>
    </template>
  </div>
</template>

<style scoped>
.myrent {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 44rem;
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

h2 {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
  font-weight: 640;
  color: var(--fc-ink);
}

h3 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  font-weight: 620;
  color: var(--fc-ink);
}

.owed .figure {
  margin: 0.25rem 0 0.3rem;
  font-size: 2.6rem;
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

.footnote {
  margin: 0;
  padding: 0 0.2rem;
  color: var(--fc-ink-faint);
  font-size: 0.78rem;
  line-height: 1.6;
}

.num {
  font-variant-numeric: tabular-nums;
}

.planline {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
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
</style>
