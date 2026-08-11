<script setup lang="ts">
/**
 * The walk-in board — "Now Serving, then the Line".
 *
 * Two questions, answered separately because different people ask them at different
 * moments. The chair strip answers "what is happening right now", which is what a
 * barber glances at between clients. The list underneath answers "who is next", which
 * is what whoever is at the desk needs.
 *
 * Someone in a chair appears in the strip and NOT in the list. Putting one person in
 * two places would make the second look like a row somebody forgot to clear.
 *
 * Estimates are seat times, not finish times — "ready for you at 2:45" is the number a
 * waiting person actually wants. They already account for the calendar: the estimator
 * schedules walk-ins into the gaps between booked appointments, never over them.
 *
 * **Every figure on this page is measured from `board.generatedAt`, not from the
 * browser's clock.** The estimates arrive computed against that instant, so measuring
 * elapsed waits or a cut's progress against `Date.now()` would have two halves of the
 * same row disagreeing by however long it has been since the last poll — and it would
 * make the server-rendered pass differ from the client's, which is a hydration
 * mismatch on a page that fetches during SSR. One clock, and it is the board's.
 *
 * The board itself is kept fresh by the shell, which polls once for the whole app.
 * Mutations here do not refetch — each one returns the recomputed board, because
 * moving one person renumbers everyone behind them.
 */

import EllipsisIcon from '@primeicons/vue/ellipsis-v';
import {
  formatCents,
  formatDuration,
  formatPhone,
  type QueueEntryDto,
} from '@francis/shared';

useHead({ title: 'Walk-in Queue — Francis Cutz' });

const queue = useQueue();
const { board, loading, barbers: roster, settings } = queue;
const { notifyApiFailure, notifySuccess } = useNotify();
const confirm = useConfirm();

const dialogOpen = ref(false);

/**
 * Which rows are mid-request — a set, not a single id.
 *
 * It was one `busyId`, and `act` refused to start while it held anything. So a second
 * tap on a *different* row inside the same request was dropped in silence: no spinner,
 * no error, nothing. On a tablet, where calling two people in quick succession is the
 * ordinary case rather than a mistake, that is a button that sometimes does nothing.
 * Each row now locks only itself, which still stops a double-tap on one row.
 */
const busy = reactive(new Set<string>());

// The shell has already loaded the board for its own badge, so this is normally a
// no-op; the refresh on mount is what catches a client-side navigation arriving
// between two of the shell's polls.
await queue.ensureLoaded();
void queue.loadOptions();
onMounted(() => void queue.refresh({ quiet: true }));

const shopTimezone = computed(() => settings.value?.timezone ?? 'America/New_York');

/** Instants are rendered in the SHOP's zone, never the browser's. */
function clock(iso: string | null): string {
  if (iso === null) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: shopTimezone.value,
  }).format(new Date(iso));
}

/** The instant every figure below is measured from. See the note at the top. */
const asOf = computed(() =>
  board.value === null ? null : new Date(board.value.generatedAt).getTime(),
);

const entries = computed(() => board.value?.entries ?? []);
const seated = computed(() => entries.value.filter((entry) => entry.status === 'IN_CHAIR'));

/**
 * Called first, then waiting in order.
 *
 * Someone called is out of the numbered line but is the next thing anyone has to act
 * on, so they sit at the top showing a state rather than a number — a position would
 * be a lie, since they are no longer queueing for anything.
 */
const line = computed(() => [
  ...entries.value.filter((entry) => entry.status === 'CALLED'),
  ...entries.value
    .filter((entry) => entry.status === 'WAITING')
    .sort((a, b) => a.position - b.position),
]);

/** Each chair with whoever is in it and whoever the estimator has pencilled in next. */
const chairs = computed(() =>
  (board.value?.chairs ?? []).map((chair) => {
    const serving = seated.value.find((entry) => entry.assignedBarberId === chair.barberId);
    const next = line.value.find(
      (entry) => entry.status === 'WAITING' && entry.assignedBarberId === chair.barberId,
    );

    const freeSoon =
      chair.freeFrom !== null &&
      asOf.value !== null &&
      new Date(chair.freeFrom).getTime() - asOf.value < 60_000;

    return {
      ...chair,
      serving,
      next,
      /**
       * "Is up" only when they actually are. A chair standing open beside a booked
       * appointment can have somebody pencilled in for two hours' time, and reading
       * "Priya R. is up" would have a barber calling a client who is not due yet.
       */
      nextLabel:
        next === undefined
          ? 'No walk-ins'
          : (next.estimatedWaitMinutes ?? 0) < 1
            ? `${next.clientName} is up`
            : next.estimatedReadyAt === null
              ? `${next.clientName} waiting`
              : `${next.clientName} at ${clock(next.estimatedReadyAt)}`,
      doneAt:
        serving?.startedAt == null
          ? null
          : new Date(
              new Date(serving.startedAt).getTime() + serving.durationMinutes * 60_000,
            ).toISOString(),
      /**
       * How far through the cut is, 0–100. A bar says "nearly done" at a glance where
       * a finish time has to be read and subtracted from. Brass, never red: a cut
       * running long is not a failure, and red means exactly one thing here.
       */
      progress:
        serving?.startedAt == null || serving.durationMinutes <= 0 || asOf.value === null
          ? null
          : Math.min(
              100,
              Math.max(
                0,
                ((asOf.value - new Date(serving.startedAt).getTime()) /
                  (serving.durationMinutes * 60_000)) *
                  100,
              ),
            ),
      state:
        chair.freeFrom === null
          ? 'Done for the day'
          : freeSoon
            ? 'Chair is open'
            : `Free from ${clock(chair.freeFrom)}`,
    };
  }),
);

/**
 * The four figures, as figures.
 *
 * This was one grey `·`-joined sentence at 12px. These are the numbers the room is
 * run on and they were the quietest thing on the page.
 */
const stats = computed(() => {
  const waiting = entries.value.filter((entry) => entry.status === 'WAITING');

  const longest = waiting
    .map((entry) => entry.estimatedWaitMinutes)
    .filter((minutes): minutes is number => minutes !== null)
    .reduce((max, minutes) => Math.max(max, minutes), 0);

  return {
    waiting: waiting.length,
    inChair: seated.value.length,
    longest: longest > 0 ? formatDuration(longest) : '—',
    updated: board.value === null ? '' : clock(board.value.generatedAt),
  };
});

/**
 * Long enough that somebody has noticed they are waiting.
 *
 * A threshold rather than a comparison against what they were quoted, because the
 * original quote is not stored — only the current projection, which moves.
 */
const LONG_WAIT_MINUTES = 45;

/** How long they have actually been here — from `joinedAt`, which nothing showed. */
function waitedMinutes(entry: QueueEntryDto): number | null {
  if (asOf.value === null) return null;
  return Math.max(0, Math.round((asOf.value - new Date(entry.joinedAt).getTime()) / 60_000));
}

function waitedLabel(entry: QueueEntryDto): string {
  const minutes = waitedMinutes(entry);
  return minutes === null ? '' : formatDuration(minutes);
}

function readyLabel(entry: QueueEntryDto): string {
  if (entry.status === 'CALLED') return 'Called';
  if (entry.estimatedReadyAt === null) return '—';
  return (entry.estimatedWaitMinutes ?? 0) < 1 ? 'Now' : clock(entry.estimatedReadyAt);
}

function waitLabel(entry: QueueEntryDto): string {
  if (entry.status === 'CALLED') return `at ${clock(entry.calledAt)}`;
  // The engine explains itself rather than leaving a blank where a time should be.
  if (entry.unservableReason !== null) return entry.unservableReason;
  if (entry.estimatedWaitMinutes === null) return '';
  return entry.estimatedWaitMinutes < 1
    ? 'chair is open'
    : `in ${formatDuration(entry.estimatedWaitMinutes)}`;
}

/**
 * Where the entry came from, when that is not the desk.
 *
 * `STAFF` and `WALK_IN` are somebody standing at the counter typing it in, which is
 * the default and needs no badge. The rest arrived without a member of staff seeing
 * the person, which is worth knowing before calling their name.
 */
function sourceLabel(entry: QueueEntryDto): string | null {
  if (entry.source === 'KIOSK') return 'Kiosk';
  if (entry.source === 'ONLINE') return 'Online';
  if (entry.source === 'VOICE') return 'Phone';
  return null;
}

async function act(key: string, action: () => Promise<void>, message?: string) {
  if (busy.has(key)) return;
  busy.add(key);
  try {
    await action();
    if (message) notifySuccess(message);
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    busy.delete(key);
  }
}

const onCallNext = (barberId: string) =>
  act(`chair:${barberId}`, () => queue.callNext(barberId));

const onCall = (entry: QueueEntryDto) => act(entry.id, () => queue.callSpecific(entry));

const onSeat = (entry: QueueEntryDto) => act(entry.id, () => queue.setStatus(entry.id, 'IN_CHAIR'));

const onFinish = (entry: QueueEntryDto) =>
  act(entry.id, () => queue.setStatus(entry.id, 'COMPLETED'), `${entry.clientName} is done`);

/** Its own key, so bumping does not grey out Call on the same row. */
const onBump = (entry: QueueEntryDto) =>
  act(`bump:${entry.id}`, () => queue.setPriority(entry.id, entry.priority > 0 ? 0 : 5));

const onRemove = (entry: QueueEntryDto) =>
  act(entry.id, () => queue.setStatus(entry.id, 'CANCELLED'), `${entry.clientName} removed`);

/**
 * A no-show is counted against the client for good, so it asks first. Removing someone
 * is not — changing your mind is ordinary, and undoing it is just rejoining.
 */
function onNoShow(entry: QueueEntryDto) {
  confirm.require({
    header: 'No-show',
    message: `Mark ${entry.clientName} as a no-show? It stays on their record.`,
    acceptLabel: 'Mark No-show',
    rejectLabel: 'Cancel',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', variant: 'text' },
    accept: () => void act(entry.id, () => queue.setStatus(entry.id, 'NO_SHOW')),
  });
}

// --- The row overflow menu ---------------------------------------------------

const menu = ref<{ toggle: (event: Event) => void } | null>(null);
const menuEntry = ref<QueueEntryDto | null>(null);

/** One Menu reused by every row, rather than one overlay per person waiting. */
const menuItems = computed(() => {
  const entry = menuEntry.value;
  if (!entry) return [];

  const moves = roster.value
    .filter(
      (barber) =>
        barber.status === 'ACTIVE' &&
        barber.id !== entry.requestedBarberId &&
        // Offering a move to someone who cannot do the work is not a choice.
        entry.services.every((service) => barber.serviceIds.includes(service.serviceId)),
    )
    .map((barber) => ({
      label: `Move to ${barber.displayName}`,
      command: () => void act(entry.id, () => queue.setBarber(entry.id, barber.id)),
    }));

  const backToAnyone =
    entry.requestedBarberId !== null && entry.status === 'WAITING'
      ? [
          {
            label: 'Back to Anyone',
            command: () => void act(entry.id, () => queue.setBarber(entry.id, null)),
          },
        ]
      : [];

  const backToLine =
    entry.status === 'CALLED'
      ? [
          {
            label: 'Back to the Line',
            command: () => void act(entry.id, () => queue.setStatus(entry.id, 'WAITING')),
          },
        ]
      : [];

  return [
    ...moves,
    ...backToAnyone,
    ...backToLine,
    { separator: true },
    { label: 'No-show', command: () => onNoShow(entry) },
    { label: 'Remove from Queue', command: () => void onRemove(entry) },
  ];
});

function openMenu(event: Event, entry: QueueEntryDto) {
  menuEntry.value = entry;
  menu.value?.toggle(event);
}
</script>

<template>
  <div class="queue">
    <Message v-if="board && !board.queueEnabled" severity="warn" :closable="false">
      Walk-ins are switched off in Services &amp; Hours, so nobody new can join. Anyone already
      in the line is still served.
    </Message>

    <header class="toolbar">
      <div class="stats">
        <span class="stat">
          <span class="n">{{ stats.waiting }}</span>
          <span class="k">Waiting</span>
        </span>
        <span class="stat">
          <span class="n">{{ stats.inChair }}</span>
          <span class="k">In a Chair</span>
        </span>
        <span class="stat">
          <span class="n" :class="{ warn: stats.waiting > 0 }">{{ stats.longest }}</span>
          <span class="k">Longest Wait</span>
        </span>
        <span class="stat">
          <span class="n quiet">{{ stats.updated }}</span>
          <span class="k">Updated</span>
        </span>
      </div>
      <Button label="Add Walk-in" @click="dialogOpen = true" />
    </header>

    <!-- Nothing has arrived yet. The shell normally has the board before this page
         renders, so this is the client-side navigation that beat the fetch. -->
    <template v-if="board === null">
      <div class="skeleton" :aria-busy="loading">
        <span class="bone" />
        <span class="bone" />
        <span class="bone" />
      </div>
    </template>

    <template v-else>
      <!-- What is happening right now, one card per chair. -->
      <p class="fc-label section">In the Chair</p>

      <section v-if="chairs.length" class="chairs" aria-label="Chairs">
        <article
          v-for="chair in chairs"
          :key="chair.barberId"
          class="chair"
          :class="{ busy: Boolean(chair.serving) }"
        >
          <span class="who">
            <span>{{ chair.displayName }}</span>
            <span v-if="chair.waitingCount > 0" class="depth">
              {{ chair.waitingCount }} waiting
            </span>
          </span>

          <template v-if="chair.serving">
            <span class="now">{{ chair.serving.clientName }}</span>
            <span class="svc">
              {{ chair.serving.services.map((service) => service.name).join(' + ') }}
            </span>
            <span v-if="chair.progress !== null" class="bar" aria-hidden="true">
              <span :style="{ width: `${chair.progress}%` }" />
            </span>
            <div class="foot">
              <span class="until">Done ~{{ clock(chair.doneAt) }}</span>
              <Button
                label="Finish"
                variant="outlined"
                severity="secondary"
                :loading="busy.has(chair.serving.id)"
                @click="onFinish(chair.serving)"
              />
            </div>
          </template>

          <template v-else>
            <span class="now free">{{ chair.state }}</span>
            <div class="foot">
              <span class="until">{{ chair.nextLabel }}</span>
              <Button
                label="Call Next"
                :variant="chair.next ? undefined : 'text'"
                :severity="chair.next ? undefined : 'secondary'"
                :disabled="!chair.next"
                :loading="busy.has(`chair:${chair.barberId}`)"
                @click="onCallNext(chair.barberId)"
              />
            </div>
          </template>
        </article>
      </section>

      <p v-else class="empty">
        No chairs on the board. Barbers appear here once they have hours today.
      </p>

      <!-- Who is next, in the order they will actually be seen. -->
      <p class="fc-label section">Next Up</p>

      <section v-if="line.length" class="line" aria-label="Waiting">
        <!-- Headers, because "11:05 AM" above "in 21 mins" says nothing to somebody
             who has not been told what the columns are. Hidden once the row stacks,
             where each cell carries its own label instead. -->
        <div class="head-row" aria-hidden="true">
          <span class="h-pos" />
          <span class="h-client">Client</span>
          <span class="h-service">Service</span>
          <span class="h-barber">Barber</span>
          <span class="h-waited">Waited</span>
          <span class="h-ready">Ready</span>
          <span class="h-acts" />
        </div>

        <article
          v-for="entry in line"
          :key="entry.id"
          class="row"
          :class="{ called: entry.status === 'CALLED', bumped: entry.priority > 0 }"
        >
          <span class="pos">
            <span v-if="entry.status === 'CALLED'" class="dot" aria-hidden="true" />
            <template v-else>{{ entry.position }}</template>
          </span>

          <span class="cell client">
            <span class="name">
              {{ entry.clientName }}
              <span v-if="sourceLabel(entry)" class="tag">{{ sourceLabel(entry) }}</span>
            </span>
            <!-- The href keeps E.164, which is what a dialler wants; only the text is
                 formatted, because nobody reads a number back as +14155550123. -->
            <a class="phone" :href="`tel:${entry.clientPhone}`">
              {{ formatPhone(entry.clientPhone) }}
            </a>
          </span>

          <span class="cell service">
            <span class="strong">{{ entry.services.map((service) => service.name).join(' + ') }}</span>
            <span class="meta">
              {{ formatDuration(entry.durationMinutes) }} · {{ formatCents(entry.priceCentsTotal) }}
            </span>
          </span>

          <span class="cell barber">
            <span class="strong">
              {{ entry.assignedBarberName ?? entry.requestedBarberName ?? 'Unassigned' }}
            </span>
            <span class="meta">{{ entry.requestedBarberId ? 'asked for' : 'any barber' }}</span>
          </span>

          <!-- How long they have actually been standing here, which is the number a
               complaint is made of. The projection beside it answers a different
               question and neither substitutes for the other. -->
          <span class="cell waited">
            <span
              class="time"
              :class="{ long: (waitedMinutes(entry) ?? 0) >= LONG_WAIT_MINUTES }"
            >
              {{ waitedLabel(entry) }}
            </span>
            <span class="meta">here</span>
          </span>

          <span class="cell eta" :class="{ unservable: entry.unservableReason !== null }">
            <span class="time">{{ readyLabel(entry) }}</span>
            <span class="meta">{{ waitLabel(entry) }}</span>
          </span>

          <span class="actions">
            <Button
              v-if="entry.status === 'CALLED'"
              label="Seat"
              :loading="busy.has(entry.id)"
              @click="onSeat(entry)"
            />
            <template v-else>
              <Button
                label="Call"
                variant="outlined"
                severity="secondary"
                :loading="busy.has(entry.id)"
                @click="onCall(entry)"
              />
              <Button
                :label="entry.priority > 0 ? 'Un-bump' : 'Bump'"
                variant="text"
                severity="secondary"
                :loading="busy.has(`bump:${entry.id}`)"
                @click="onBump(entry)"
              />
            </template>
            <Button
              variant="text"
              severity="secondary"
              aria-label="More actions"
              @click="openMenu($event, entry)"
            >
              <EllipsisIcon class="ell" aria-hidden="true" />
            </Button>
          </span>

          <!-- Asked for at the kiosk or the desk, stored, and until now never shown
               back to the one person who needed it. -->
          <span v-if="entry.notes" class="note">
            <span class="note-key">Note</span>
            <span class="note-body">{{ entry.notes }}</span>
          </span>
        </article>
      </section>

      <p v-else class="empty">
        Nobody is waiting. Walk-ins added here or at the kiosk appear straight away.
      </p>
    </template>

    <Menu ref="menu" :model="menuItems" popup />
    <QueueAddWalkInDialog v-model:visible="dialogOpen" />
  </div>
</template>

<style scoped>
.queue {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 78rem;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.25rem;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.75rem;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.stat .n {
  font-family: var(--fc-font-display);
  font-size: 1.35rem;
  font-weight: 680;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.stat .n.warn {
  color: var(--fc-accent);
}

.stat .n.quiet {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--fc-ink-faint);
  /* Sits on the same baseline as the figures beside it despite being smaller. */
  padding-top: 0.4rem;
}

.stat .k {
  font-size: 0.625rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 640;
}

/* `.fc-label` carries its own bottom margin for a form field; here it labels a
   section, so the rhythm is set by the flex gap instead. */
.section {
  margin: 0.5rem 0 0;
}

/* --- Loading --------------------------------------------------------------- */

.skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.bone {
  height: 3.25rem;
  border-radius: 8px;
  border: 1px solid var(--fc-line-soft);
  background: var(--fc-surface);
  opacity: 0.55;
}

/* --- Chairs ---------------------------------------------------------------- */

.chairs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.625rem;
}

.chair {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 0.75rem 0.875rem;
}

.chair.busy {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

.who {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.6875rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 640;
}

/* The chair's own queue depth — carried on the DTO all along and never rendered. */
.depth {
  letter-spacing: 0;
  text-transform: none;
  font-weight: 500;
  white-space: nowrap;
}

.now {
  font-family: var(--fc-font-display);
  font-size: 1.0625rem;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now.free {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--fc-ink-faint);
}

.svc {
  font-size: 0.6875rem;
  color: var(--fc-ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar {
  display: block;
  height: 3px;
  border-radius: 2px;
  background: var(--fc-line);
  overflow: hidden;
  margin: 0.3rem 0 0.1rem;
}

.bar > span {
  display: block;
  height: 100%;
  background: var(--fc-accent);
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 2.5rem;
}

/* Three chairs across a tablet leaves each card about 15rem, and "Call Next" broke
   over two lines there — a button that changes height as the board changes. The
   label holds its line and the text beside it gives way instead. */
.foot :deep(.p-button) {
  flex: none;
  white-space: nowrap;
}

.until {
  font-size: 0.75rem;
  color: var(--fc-ink-muted);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- The line -------------------------------------------------------------- */

.line {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

/*
 * Every cell is placed by name, at both widths.
 *
 * The old rule placed columns 1–3 and the actions and left the barber and the ETA
 * unplaced, so below 900px they flowed into whatever auto rows the grid decided on.
 * Named areas make "did I place this one" answerable by reading rather than by
 * resizing the window.
 */
/*
 * The header and the rows are two independent grids, so every track they share has
 * to resolve the same way in both. The actions column is therefore a fixed width
 * rather than `auto`: `auto` measured the buttons in a row and the empty span in the
 * header, so the two grids disagreed by about 160px and every heading sat left of
 * the column it named. Wide enough for Call + Un-bump + the ellipsis, which is the
 * broadest the cell gets.
 *
 * `waited` and `ready` are sized for the long-form durations — "1 hour 45 mins" is
 * the ordinary case now, not the outlier, and wrapping it made the row two lines tall.
 */
.head-row,
.row {
  display: grid;
  grid-template-columns:
    2.25rem minmax(7rem, 1.3fr) minmax(7rem, 1.15fr)
    minmax(5.5rem, 0.85fr) 7rem 7rem 11.5rem;
  grid-template-areas:
    'pos client service barber waited ready acts'
    'pos note   note    note   note   note  note';
  gap: 0 0.75rem;
  align-items: center;
}

.head-row {
  padding: 0 0.75rem 0.3rem;
  border-bottom: 1px solid var(--fc-line-soft);
}

.head-row > span {
  font-size: 0.625rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 660;
}

.h-pos { grid-area: pos; }
.h-client { grid-area: client; }
.h-service { grid-area: service; }
.h-barber { grid-area: barber; }
.h-waited { grid-area: waited; }
.h-ready { grid-area: ready; }
.h-acts { grid-area: acts; }

.row {
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 0.5rem 0.75rem;
}

.row.called {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

/* A rail, not a tint: a whole amber row would compete with the called row, which is
   the one that actually needs acting on. */
.row.bumped {
  box-shadow: inset 3px 0 0 var(--fc-accent);
}

.pos {
  grid-area: pos;
  font-size: 1.0625rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--fc-ink-muted);
}

.dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--fc-accent);
}

.cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.client { grid-area: client; }
.service { grid-area: service; }
.barber { grid-area: barber; }
.waited { grid-area: waited; }
.eta { grid-area: ready; }
.actions { grid-area: acts; }

.name {
  font-size: 0.875rem;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Where it came from, when a member of staff did not type it in. */
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
  vertical-align: 0.08em;
  margin-left: 0.25rem;
}

.phone {
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  text-decoration: none;
}

.phone:hover {
  color: var(--fc-ink-muted);
  text-decoration: underline;
}

.strong {
  font-size: 0.8125rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.waited .time,
.eta .time {
  font-size: 0.875rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Amber, not red. Somebody waiting a long time is a thing to notice, not a failure —
   red on this page means the estimator cannot seat them at all. */
.waited .time.long {
  color: var(--fc-accent);
}

.eta.unservable .time {
  color: var(--fc-danger-ink);
}

.eta.unservable .meta {
  color: var(--fc-danger-ink);
  white-space: normal;
}

.actions {
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
  align-items: center;
}

.ell {
  width: 0.875rem;
  height: 0.875rem;
}

.note {
  grid-area: note;
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  padding-top: 0.3rem;
  min-width: 0;
}

.note-key {
  flex: none;
  font-size: 0.5625rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 660;
}

.note-body {
  font-size: 0.75rem;
  color: var(--fc-ink-muted);
}

.empty {
  margin: 0;
  border: 1px dashed var(--fc-line);
  border-radius: 8px;
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
}

/*
 * Tablet and narrow desktop.
 *
 * 1040 rather than 900: at 1024 landscape with the rail expanded the seven-column
 * row is already past its minimums, and a row that only breaks once it visibly
 * overflows breaks too late.
 */
@media (max-width: 1040px) {
  .head-row {
    display: none;
  }

  .row {
    grid-template-columns: 2.25rem minmax(0, 1fr) auto;
    grid-template-areas:
      'pos client  waited'
      'pos service ready'
      'pos barber  acts'
      'pos note    note';
    row-gap: 0.3rem;
    padding: 0.625rem 0.75rem;
  }

  .pos {
    align-self: start;
    padding-top: 0.15rem;
  }

  /* The right-hand column reads down as waited → ready → the buttons, which puts
     the actions at the bottom corner nearest a thumb. */
  .waited,
  .eta {
    text-align: right;
  }

  .waited .meta,
  .eta .meta {
    white-space: nowrap;
  }

  .eta.unservable .meta {
    white-space: normal;
  }
}
</style>
