<script setup lang="ts">
/**
 * A barber's chair, in their hand.
 *
 * The first screen after signing in, and the one they open between cuts — on a phone, one
 * thumb, standing up. It answers four things and nothing else: is my chair free, who is
 * next, this one is done, what have I taken. Everything deeper — the week, the till, the
 * money — is a link away rather than a section.
 *
 * **The chair holds two kinds of work.** A booked client sitting down is an `Appointment`
 * at `IN_PROGRESS`; a walk-in is a `QueueEntry` at `IN_CHAIR`. They live in different
 * tables, take different endpoints to finish, and a screen that only understood the queue
 * would cheerfully say "Chair is open" while the barber was mid-cut on a booked client.
 * So the chair block reads both, and one button finishes whichever it is.
 *
 * **Everything is measured from the board's clock**, `generatedAt`, never the browser's —
 * the same rule as `/queue`, and for the same reason: two halves of one row would
 * otherwise disagree by however long since the last poll, and the server-rendered pass
 * would differ from the client's on a page that fetches during SSR.
 *
 * The one figure that is *not* fetched with the page is the Stripe balance. It is a live
 * call against the connected account, and this is the route every barber lands on at
 * sign-in — so it loads after mount, and says nothing at all if it cannot be had.
 */

import { formatCents, formatDuration, type AppointmentDto, type QueueEntryDto } from '@francis/shared';

useHead({ title: 'Today — Francis Cutz' });

const auth = useAuthStore();
const queue = useQueue();
const book = useAppointments();
const payouts = usePayouts();
const connect = useConnect();
const shop = useShopClock();
const { notifySuccess, notifyApiFailure } = useNotify();

const barberId = computed(() => auth.user?.barberId ?? null);

/**
 * The timezone before the first fetch, not alongside it — `dayRange` turns "today" into
 * the pair of instants the endpoint wants, and the fallback zone would ask for the wrong
 * day in a shop three hours away.
 */
await shop.ensureLoaded();

const today = computed(() => shop.today());

async function load(): Promise<void> {
  if (barberId.value === null) return;
  const range = shop.dayRange(today.value);
  try {
    await book.loadRange(range.from, range.to, { barberId: barberId.value });
  } catch (error) {
    notifyApiFailure(error, 'Could not load your day.');
  }
}

await load();

/** Takings are a database read; the balance is not, and is not asked for until mounted. */
if (barberId.value !== null) {
  try {
    await payouts.loadSummary(barberId.value);
  } catch {
    // A missing figure is better than a screen that will not open over it.
  }
}

onMounted(() => {
  if (barberId.value === null) return;
  void payouts.loadBalance(barberId.value);
  void connect.refresh(barberId.value);
  void queue.refresh({ quiet: true });
});

// --- The clock everything is measured from -----------------------------------

const asOf = computed(() =>
  queue.board.value === null ? null : new Date(queue.board.value.generatedAt).getTime(),
);

// --- The chair ----------------------------------------------------------------

const entries = computed(() => queue.board.value?.entries ?? []);

/** The chair itself, if the board has one for this barber. */
const chair = computed(() =>
  barberId.value === null
    ? undefined
    : queue.board.value?.chairs.find((row) => row.barberId === barberId.value),
);

const seatedWalkIn = computed<QueueEntryDto | undefined>(() =>
  entries.value.find(
    (entry) => entry.status === 'IN_CHAIR' && entry.assignedBarberId === barberId.value,
  ),
);

/** A booked client who has been started. The queue knows nothing about them. */
const seatedAppointment = computed<AppointmentDto | undefined>(() =>
  book.appointments.value.find(
    (appointment) =>
      appointment.status === 'IN_PROGRESS' && shop.localDate(appointment.startAt) === today.value,
  ),
);

const calledWalkIn = computed<QueueEntryDto | undefined>(() =>
  entries.value.find(
    (entry) => entry.status === 'CALLED' && entry.assignedBarberId === barberId.value,
  ),
);

/** Whoever the estimator has pencilled in next for this chair. */
const nextUp = computed<QueueEntryDto | undefined>(() =>
  entries.value
    .filter((entry) => entry.status === 'WAITING' && entry.assignedBarberId === barberId.value)
    .sort((a, b) => a.position - b.position)[0],
);

/**
 * What the chair is doing, in the order a barber cares about.
 *
 * A seated walk-in beats a started appointment if both somehow exist: the queue is the
 * thing with a row lock on it, so it is the one to believe.
 */
type ChairState = 'no-chair' | 'serving' | 'called' | 'ready' | 'idle';

const state = computed<ChairState>(() => {
  if (seatedWalkIn.value ?? seatedAppointment.value) return 'serving';
  if (calledWalkIn.value) return 'called';
  if (chair.value === undefined) return 'no-chair';
  return nextUp.value ? 'ready' : 'idle';
});

/** Who is in the chair, whichever table they came from. */
const serving = computed(() => {
  const walkIn = seatedWalkIn.value;
  if (walkIn) {
    return {
      kind: 'walk-in' as const,
      id: walkIn.id,
      name: walkIn.clientName,
      services: walkIn.services.map((service) => service.name).join(' + '),
      durationMinutes: walkIn.durationMinutes,
      priceCents: walkIn.priceCentsTotal,
      startedAt: walkIn.startedAt,
    };
  }

  const appointment = seatedAppointment.value;
  if (appointment) {
    return {
      kind: 'booked' as const,
      id: appointment.id,
      name: appointment.clientName,
      services: appointment.services.map((service) => service.name).join(' + '),
      durationMinutes: appointment.durationMinutes,
      priceCents: appointment.priceCentsTotal,
      // An appointment has no `startedAt`; its own slot is when it should have begun.
      startedAt: appointment.startAt,
    };
  }

  return null;
});

const doneAt = computed(() => {
  const cut = serving.value;
  if (cut === null || cut.startedAt === null) return null;
  return new Date(
    new Date(cut.startedAt).getTime() + cut.durationMinutes * 60_000,
  ).toISOString();
});

/** How far through, 0–100. Brass, never red — a cut running long is not a failure. */
const progress = computed(() => {
  const cut = serving.value;
  if (cut === null || cut.startedAt === null || cut.durationMinutes <= 0) return null;
  if (asOf.value === null) return null;
  const elapsed = asOf.value - new Date(cut.startedAt).getTime();
  return Math.min(100, Math.max(0, (elapsed / (cut.durationMinutes * 60_000)) * 100));
});

/**
 * The chair's own sentence. Same words as the board at the desk, so the phone in a
 * barber's hand and the screen across the room cannot describe one chair differently.
 */
const chairState = computed(() => {
  const row = chair.value;
  if (row === undefined) return 'Walk-ins are off for your chair';
  if (row.freeFrom === null) return 'Done for the day';
  const freeSoon = asOf.value !== null && new Date(row.freeFrom).getTime() - asOf.value < 60_000;
  return freeSoon ? 'Chair is open' : `Free from ${shop.clock(row.freeFrom)}`;
});

const waitingForMe = computed(() => chair.value?.waitingCount ?? 0);

// --- Acting -------------------------------------------------------------------

const busy = ref(false);

/** Held after a finish so the till is one tap away. Cleared by the next board push. */
const justFinished = ref<{ name: string; priceCents: number } | null>(null);

watch(
  () => queue.board.value?.generatedAt,
  () => {
    if (state.value === 'serving') justFinished.value = null;
  },
);

async function act(action: () => Promise<void>, message?: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
    if (message) notifySuccess(message);
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    busy.value = false;
  }
}

/**
 * Names a likely person, never a promise.
 *
 * `callNext` re-scans the line under a row lock, so if two barbers finish at the same
 * moment the person actually called may not be the one this button named.
 */
function onCallNext(): void {
  if (barberId.value === null) return;
  const id = barberId.value;
  void act(() => queue.callNext(id));
}

function onSeat(entry: QueueEntryDto): void {
  void act(() => queue.setStatus(entry.id, 'IN_CHAIR'));
}

function onBackToLine(entry: QueueEntryDto): void {
  void act(() => queue.setStatus(entry.id, 'WAITING'));
}

/** Finishing dispatches by where the person came from — two tables, one button. */
function onFinish(): void {
  const cut = serving.value;
  if (cut === null) return;

  const finished = { name: cut.name, priceCents: cut.priceCents };
  void act(async () => {
    if (cut.kind === 'walk-in') {
      await queue.setStatus(cut.id, 'COMPLETED');
    } else {
      await book.setStatus(cut.id, 'COMPLETED');
    }
    justFinished.value = finished;
    // What they just took is now a different number.
    if (barberId.value !== null) await payouts.loadSummary(barberId.value);
  });
}

function onStart(appointment: AppointmentDto): void {
  void act(() => book.setStatus(appointment.id, 'IN_PROGRESS'));
}

// --- The money ------------------------------------------------------------------

const takings = computed(() => payouts.summary.value);

/**
 * The quiet line under the takings.
 *
 * `availableCents`, not `instantAvailableCents` — this answers "what have I got", and
 * `/earnings` answers "what can I move right now". Two numbers for one question is how a
 * barber ends up believing the smaller one is all there is.
 *
 * Silence is the right degradation. "Could not reach Stripe" printed under a figure that
 * came from our own database makes the true number look doubtful.
 */
const stripeLine = computed<{ text: string; to: string } | null>(() => {
  if (payouts.balance.value !== null) {
    return { text: `${formatCents(payouts.balance.value.availableCents)} with Stripe`, to: '/earnings' };
  }
  if (connect.status.value?.stripeAccountId == null) {
    return { text: 'Set up payouts', to: '/earnings' };
  }
  return null;
});

// --- The lineup -------------------------------------------------------------------

const isToday = computed(() => true);
const { items } = useDayLineup({ barberId, date: today, isToday });

/**
 * What is still to come. What is done is dropped — a phone is not a ledger, and the
 * person in the chair is already the block above.
 *
 * No "N done today" line to go with it: a completed walk-in leaves the board entirely
 * (it carries active entries only), so any count here would be appointments plus
 * whichever walk-ins happened to still be live. Half a number is worse than none, and
 * the takings block below says what was actually collected.
 */
const ahead = computed(() =>
  items.value.filter(
    (item) => item.status !== 'COMPLETED' && item.status !== 'IN_PROGRESS' && item.status !== 'IN_CHAIR',
  ),
);

/** The next booked cut that has not been started — the only row that acts. */
const nextBooked = computed(() =>
  ahead.value.find((item) => !item.projected && item.status === 'BOOKED'),
);
</script>

<template>
  <div class="today">
    <section v-if="barberId === null" class="fc-card empty">
      <b>No chair on this account</b>
      This screen is one barber's chair. Your account does not cut hair — open
      <NuxtLink to="/calendar">Calendar</NuxtLink> to see the shop's.
    </section>

    <template v-else>
      <!-- --- The chair ------------------------------------------------------ -->
      <section class="fc-card chair" :class="{ live: state === 'serving' || justFinished }">
        <template v-if="justFinished">
          <span class="fc-label">Just finished</span>
          <p class="who">{{ justFinished.name }}</p>
          <span class="svc">{{ formatCents(justFinished.priceCents) }} to collect</span>
          <NuxtLink to="/take-payment" class="act">Take Payment</NuxtLink>
          <button type="button" class="act ghost" :disabled="busy || !nextUp" @click="onCallNext()">
            {{ nextUp ? `Call Next · ${nextUp.clientName}` : 'Nobody waiting' }}
          </button>
        </template>

        <template v-else-if="state === 'serving' && serving">
          <span class="fc-label">In your chair</span>
          <p class="who">
            {{ serving.name }}
            <span class="tag" :class="{ booked: serving.kind === 'booked' }">
              {{ serving.kind === 'booked' ? 'Booked' : 'Walk-in' }}
            </span>
          </p>
          <span class="svc">{{ serving.services }} · {{ formatDuration(serving.durationMinutes) }}</span>
          <span v-if="progress !== null" class="bar" aria-hidden="true">
            <span :style="{ width: `${progress}%` }" />
          </span>
          <span v-if="doneAt" class="until">Done ~{{ shop.clock(doneAt) }}</span>
          <button type="button" class="act" :disabled="busy" @click="onFinish()">Finish Cut</button>
        </template>

        <template v-else-if="state === 'called' && calledWalkIn">
          <span class="fc-label">Called up</span>
          <p class="who">{{ calledWalkIn.clientName }}</p>
          <span class="svc">
            {{ calledWalkIn.services.map((service) => service.name).join(' + ') }}
          </span>
          <button type="button" class="act" :disabled="busy" @click="onSeat(calledWalkIn)">
            Seat Them
          </button>
          <button
            type="button"
            class="act ghost"
            :disabled="busy"
            @click="onBackToLine(calledWalkIn)"
          >
            Back to the Line
          </button>
        </template>

        <template v-else>
          <span class="fc-label">Your chair</span>
          <p class="free">{{ chairState }}</p>
          <!-- No Call Next at all when the chair is not on the board: the shop has
               walk-ins switched off for it, so there is nothing to call. -->
          <template v-if="state !== 'no-chair'">
            <span class="svc">
              {{
                nextUp
                  ? `${nextUp.clientName} is next · ${waitingForMe} waiting for you`
                  : 'No walk-ins waiting'
              }}
            </span>
            <button type="button" class="act" :disabled="busy || !nextUp" @click="onCallNext()">
              {{ nextUp ? `Call Next · ${nextUp.clientName}` : 'Call Next' }}
            </button>
          </template>
          <span v-else class="svc">Your booked clients below are still right.</span>
        </template>
      </section>

      <!-- --- The lineup ----------------------------------------------------- -->
      <section class="fc-card">
        <span class="fc-label">Your lineup</span>

        <p v-if="ahead.length === 0" class="quiet">
          Nothing left today. Walk-ins that come to your chair will appear here.
        </p>

        <div v-else class="rows">
          <article
            v-for="item in ahead"
            :key="item.key"
            class="row"
            :class="{ projected: item.moving }"
          >
            <span class="t">{{ item.moving ? '≈' : '' }}{{ shop.clock(item.startAt) }}</span>
            <span class="n">
              {{ item.clientName }}
              <span v-if="item.source" class="tag">{{ item.source }}</span>
            </span>
            <span class="p">{{ formatCents(item.priceCents) }}</span>
            <span class="s">
              {{ item.services }} · {{ formatDuration(item.durationMinutes) }}
              <template v-if="item.moving"> · moves as the board moves</template>
            </span>
            <span v-if="nextBooked && nextBooked.key === item.key" class="go">
              <button
                type="button"
                class="act small"
                :disabled="busy"
                @click="item.appointment && onStart(item.appointment)"
              >
                Start
              </button>
            </span>
          </article>
        </div>

      </section>

      <!-- --- The money ------------------------------------------------------ -->
      <section class="fc-card">
        <span class="fc-label">Today's takings</span>
        <p class="amount">{{ takings ? formatCents(takings.totalCents) : '—' }}</p>
        <span v-if="takings" class="svc">
          {{ takings.cutCount }} {{ takings.cutCount === 1 ? 'cut' : 'cuts' }} ·
          Cash {{ formatCents(takings.cashCents) }} ·
          Card {{ formatCents(takings.cardCents) }} ·
          Tips {{ formatCents(takings.tipsCents) }}
        </span>

        <!-- Client-only: the balance is a live Stripe call and is not asked for until
             the screen is up, so there is nothing to render on the server pass. -->
        <ClientOnly>
          <NuxtLink v-if="stripeLine" :to="stripeLine.to" class="stripe-line">
            {{ stripeLine.text }} →
          </NuxtLink>
        </ClientOnly>
      </section>

      <nav class="fc-card links">
        <NuxtLink to="/my-day">Full schedule <span aria-hidden="true">→</span></NuxtLink>
        <NuxtLink to="/queue">Walk-in queue <span aria-hidden="true">→</span></NuxtLink>
        <NuxtLink to="/take-payment">Take payment <span aria-hidden="true">→</span></NuxtLink>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.today {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  max-width: 34rem;
}

.fc-label {
  margin-bottom: 0;
}

.chair.live {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

.who {
  margin: 0.35rem 0 0.15rem;
  font-family: var(--fc-font-display);
  font-size: 1.375rem;
  font-weight: 660;
  line-height: 1.2;
}

.free {
  margin: 0.35rem 0 0.15rem;
  font-family: var(--fc-font-display);
  font-size: 1.25rem;
  font-weight: 620;
}

.svc {
  display: block;
  font-size: 0.875rem;
  color: var(--fc-ink-muted);
}

/* Brass, never red — a cut running long is not a failure. */
.bar {
  display: block;
  height: 4px;
  border-radius: 999px;
  background: var(--fc-line);
  margin: 0.875rem 0 0.5rem;
  overflow: hidden;
}

.bar span {
  display: block;
  height: 100%;
  background: var(--fc-accent);
}

.until {
  display: block;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
}

/*
 * A thumb's button: full width, and tall enough to hit without looking. Not a fixed bar
 * at the bottom of the screen — what it does changes with the chair's state, and an
 * action detached from the name it acts on is how somebody finishes the wrong person.
 */
.act {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 52px;
  margin-top: 0.875rem;
  padding: 0 1rem;
  font: inherit;
  font-size: 1rem;
  font-weight: 620;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid var(--fc-accent);
  background: var(--fc-accent);
  color: var(--fc-accent-ink);
}

.act.ghost {
  background: transparent;
  color: var(--fc-ink);
  border-color: var(--fc-line);
  margin-top: 0.5rem;
}

.act:disabled {
  background: transparent;
  color: var(--fc-ink-faint);
  border-color: var(--fc-line);
  cursor: default;
}

.act.small {
  width: auto;
  min-height: 36px;
  margin-top: 0;
  font-size: 0.875rem;
  padding: 0 0.875rem;
}

.tag {
  display: inline-block;
  font-size: 0.5625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 660;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  border: 1px solid var(--fc-line);
  color: var(--fc-ink-faint);
  vertical-align: 0.15em;
  margin-left: 0.25rem;
}

.tag.booked {
  color: var(--fc-accent-ink);
  background: var(--fc-accent);
  border-color: transparent;
}

/* --- The lineup -------------------------------------------------------------- */

.rows {
  display: flex;
  flex-direction: column;
  margin-top: 0.5rem;
}

.row {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr) auto;
  gap: 0.15rem 0.75rem;
  align-items: baseline;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--fc-line-soft);
}

.row:last-child {
  border-bottom: 0;
}

.row .t {
  font-size: 0.875rem;
  font-weight: 620;
  font-variant-numeric: tabular-nums;
}

.row .n {
  font-size: 0.9375rem;
  min-width: 0;
}

.row .p {
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
  font-variant-numeric: tabular-nums;
}

.row .s {
  grid-column: 2 / -1;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.row .go {
  grid-column: 2 / -1;
  margin-top: 0.35rem;
}

/* A projection, drawn as one — never mistakable for a booking. */
.row.projected .t,
.row.projected .n {
  color: var(--fc-ink-muted);
}

/* --- The money --------------------------------------------------------------- */

.amount {
  margin: 0.25rem 0 0.15rem;
  font-family: var(--fc-font-display);
  font-size: 2.25rem;
  font-weight: 680;
  line-height: 1.1;
  color: var(--fc-accent);
  font-variant-numeric: tabular-nums;
}

.stripe-line {
  display: inline-block;
  margin-top: 0.625rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
  text-decoration: none;
}

.stripe-line:hover {
  color: var(--fc-ink-muted);
}

/* --- Footer links ------------------------------------------------------------ */

.links {
  display: flex;
  flex-direction: column;
  padding-block: 0.25rem;
}

.links a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  font-size: 0.875rem;
  color: var(--fc-ink-muted);
  text-decoration: none;
  border-top: 1px solid var(--fc-line-soft);
}

.links a:first-child {
  border-top: 0;
}

.quiet {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
  color: var(--fc-ink-faint);
}

.empty {
  text-align: center;
  padding: 2.5rem 1rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
}

.empty b {
  display: block;
  font-size: 0.95rem;
  color: var(--fc-ink-muted);
  font-weight: 580;
  margin-bottom: 0.3rem;
}
</style>
