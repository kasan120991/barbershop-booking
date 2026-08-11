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
const { board, barbers: roster, settings } = queue;
const { notifyApiFailure, notifySuccess } = useNotify();
const confirm = useConfirm();

const dialogOpen = ref(false);
/** Which row is mid-request, so only that row's button spins. */
const busyId = ref<string | null>(null);

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
      chair.freeFrom !== null && new Date(chair.freeFrom).getTime() - Date.now() < 60_000;

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
      state:
        chair.freeFrom === null
          ? 'Done for the day'
          : freeSoon
            ? 'Chair is open'
            : `Free from ${clock(chair.freeFrom)}`,
    };
  }),
);

const summary = computed(() => {
  if (!board.value) return '';

  const waiting = entries.value.filter((entry) => entry.status === 'WAITING');
  const parts = [waiting.length === 1 ? '1 waiting' : `${String(waiting.length)} waiting`];

  if (seated.value.length > 0) parts.push(`${String(seated.value.length)} in a chair`);

  const longest = waiting
    .map((entry) => entry.estimatedWaitMinutes)
    .filter((minutes): minutes is number => minutes !== null)
    .reduce((max, minutes) => Math.max(max, minutes), 0);
  if (longest > 0) parts.push(`longest wait ${formatDuration(longest)}`);

  parts.push(`updated ${clock(board.value.generatedAt)}`);
  return parts.join(' · ');
});

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

async function act(key: string, action: () => Promise<void>, message?: string) {
  if (busyId.value !== null) return;
  busyId.value = key;
  try {
    await action();
    if (message) notifySuccess(message);
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    busyId.value = null;
  }
}

const onCallNext = (barberId: string) =>
  act(`chair:${barberId}`, () => queue.callNext(barberId));

const onCall = (entry: QueueEntryDto) => act(entry.id, () => queue.callSpecific(entry));

const onSeat = (entry: QueueEntryDto) => act(entry.id, () => queue.setStatus(entry.id, 'IN_CHAIR'));

const onFinish = (entry: QueueEntryDto) =>
  act(entry.id, () => queue.setStatus(entry.id, 'COMPLETED'), `${entry.clientName} is done`);

const onBump = (entry: QueueEntryDto) =>
  act(entry.id, () => queue.setPriority(entry.id, entry.priority > 0 ? 0 : 5));

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
      <p class="sub">{{ summary }}</p>
      <Button label="Add Walk-in" size="small" @click="dialogOpen = true" />
    </header>

    <!-- What is happening right now, one card per chair. -->
    <section v-if="chairs.length" class="chairs" aria-label="Chairs">
      <article
        v-for="chair in chairs"
        :key="chair.barberId"
        class="chair"
        :class="{ busy: Boolean(chair.serving) }"
      >
        <span class="barber">{{ chair.displayName }}</span>

        <template v-if="chair.serving">
          <span class="now">{{ chair.serving.clientName }}</span>
          <div class="foot">
            <span class="until">Done ~{{ clock(chair.doneAt) }}</span>
            <Button
              label="Finish"
              size="small"
              variant="outlined"
              severity="secondary"
              :loading="busyId === chair.serving.id"
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
              size="small"
              :variant="chair.next ? undefined : 'text'"
              :severity="chair.next ? undefined : 'secondary'"
              :disabled="!chair.next"
              :loading="busyId === `chair:${chair.barberId}`"
              @click="onCallNext(chair.barberId)"
            />
          </div>
        </template>
      </article>
    </section>

    <!-- Who is next, in the order they will actually be seen. -->
    <section v-if="line.length" class="line" aria-label="Waiting">
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

        <span class="cell">
          <span class="name">{{ entry.clientName }}</span>
          <!-- The href keeps E.164, which is what a dialler wants; only the text is
               formatted, because nobody reads a number back as +14155550123. -->
          <a class="phone" :href="`tel:${entry.clientPhone}`">
            {{ formatPhone(entry.clientPhone) }}
          </a>
        </span>

        <span class="cell">
          <span class="strong">{{ entry.services.map((service) => service.name).join(' + ') }}</span>
          <span class="meta">
            {{ formatDuration(entry.durationMinutes) }} · {{ formatCents(entry.priceCentsTotal) }}
          </span>
        </span>

        <span class="cell">
          <span class="strong">
            {{ entry.assignedBarberName ?? entry.requestedBarberName ?? 'Unassigned' }}
          </span>
          <span class="meta">{{ entry.requestedBarberId ? 'asked for' : 'any barber' }}</span>
        </span>

        <span class="cell eta" :class="{ unservable: entry.unservableReason !== null }">
          <span class="time">{{ readyLabel(entry) }}</span>
          <span class="meta">{{ waitLabel(entry) }}</span>
        </span>

        <span class="actions">
          <Button
            v-if="entry.status === 'CALLED'"
            label="Seat"
            size="small"
            :loading="busyId === entry.id"
            @click="onSeat(entry)"
          />
          <template v-else>
            <Button
              label="Call"
              size="small"
              variant="outlined"
              severity="secondary"
              :loading="busyId === entry.id"
              @click="onCall(entry)"
            />
            <Button
              :label="entry.priority > 0 ? 'Un-bump' : 'Bump'"
              size="small"
              variant="text"
              severity="secondary"
              @click="onBump(entry)"
            />
          </template>
          <Button
            size="small"
            variant="text"
            severity="secondary"
            aria-label="More actions"
            @click="openMenu($event, entry)"
          >
            <EllipsisIcon class="ell" aria-hidden="true" />
          </Button>
        </span>
      </article>
    </section>

    <p v-else class="empty">
      Nobody is waiting. Walk-ins added here or at the kiosk appear straight away.
    </p>

    <Menu ref="menu" :model="menuItems" popup />
    <QueueAddWalkInDialog v-model:visible="dialogOpen" />
  </div>
</template>

<style scoped>
.queue {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  max-width: 72rem;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.sub {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
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
  gap: 0.3125rem;
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

.barber {
  font-size: 0.6875rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
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

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 2rem;
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

.row {
  display: grid;
  grid-template-columns: 2rem minmax(8rem, 1.3fr) minmax(8rem, 1.3fr) minmax(6rem, 0.9fr) 6.5rem auto;
  gap: 0.75rem;
  align-items: center;
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
  font-size: 1.0625rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: center;
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

.name {
  font-size: 0.875rem;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.eta .time {
  font-size: 0.875rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.eta.unservable .time {
  color: var(--fc-danger-ink);
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

.empty {
  margin: 0;
  border: 1px dashed var(--fc-line);
  border-radius: 8px;
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
}

@media (max-width: 900px) {
  .row {
    grid-template-columns: 2rem 1fr auto;
    row-gap: 0.375rem;
  }

  .row > .cell:nth-of-type(2),
  .row > .cell:nth-of-type(3) {
    grid-column: 2 / -1;
  }

  .actions {
    grid-column: 3 / 4;
    grid-row: 1;
  }
}
</style>
