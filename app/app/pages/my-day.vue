<script setup lang="ts">
/**
 * My Day — a barber's own book.
 *
 * The first screen a barber-only account ever sees: `useShopMode` makes it the chair-mode
 * home and the route guard bounces non-admins here. So it has to answer the whole
 * question on its own — what is booked, what is walking in, what is left.
 *
 * **An agenda, not a time grid.** One list in time order, so a quiet day and a full one
 * take the same room. The one thing a list loses is empty space, and empty space is the
 * point on booth rent — an idle hour is the barber's own money, not the shop's. So the
 * gaps are named between the rows instead of drawn: `— 1 hr 30 min open —`, and past an
 * hour it goes brass.
 *
 * **A walk-in is a projection and must never look booked.** `estimatedReadyAt` moves as
 * the board moves, and `callNext` is the only thing that attaches anybody to a chair —
 * the same rule that ruled out chair columns on `/queue`. They get a dashed edge, no
 * fill, and the word said out loud. They appear on today only, because they have no
 * future date to appear on.
 *
 * **The clock is the shop's, and nothing here infers "now" from a browser.** Times render
 * in the shop's timezone through `useShopClock`, and which cut is happening is read from
 * the appointment's own `IN_PROGRESS` — a fact the server owns, and one somebody pressed
 * a button to state. Comparing the browser's clock against a start time would have
 * guessed at it instead, and guessed differently on the server-rendered pass than on the
 * client, which is a hydration mismatch on a page that fetches during SSR.
 */

import EllipsisIcon from '@primeicons/vue/ellipsis-v';
import {
  formatCents,
  formatDuration,
  type AppointmentDto,
  type QueueEntryDto,
} from '@francis/shared';

useHead({ title: 'My Day — Francis Cutz' });

const auth = useAuthStore();
const book = useAppointments();
const queue = useQueue();
const shop = useShopClock();
const confirm = useConfirm();
const { notifySuccess, notifyApiFailure } = useNotify();

const barberId = computed(() => auth.user?.barberId ?? null);

/** Per-row, not one global lock — see the note on the same guard in `queue.vue`. */
const busy = reactive(new Set<string>());

const view = ref<'day' | 'week'>('day');
const showVoids = ref(false);

/**
 * The timezone has to arrive before the first fetch, not alongside it.
 *
 * `dayRange` turns "Tuesday" into the pair of instants the endpoint wants, and with the
 * fallback zone a shop three hours away would ask for — and render — the wrong day.
 */
await shop.ensureLoaded();

const cursor = ref(shop.today());

const range = computed(() =>
  view.value === 'day'
    ? shop.dayRange(cursor.value)
    : shop.rangeOfDays(shop.weekStart(cursor.value), 7),
);

async function load(): Promise<void> {
  if (barberId.value === null) return;
  try {
    await book.loadRange(range.value.from, range.value.to);
  } catch (error) {
    notifyApiFailure(error, 'Could not load your book.');
  }
}

await load();
watch(range, () => void load());

// The queue board is already live in shared state and polled by the shell, so today's
// walk-ins cost nothing beyond this one call.
onMounted(() => void queue.refresh({ quiet: true }));

const isToday = computed(() => cursor.value === shop.today());

// --- One day's work, appointments and walk-ins together -----------------------

interface DayItem {
  key: string;
  startAt: string;
  endAt: string | null;
  clientName: string;
  services: string;
  durationMinutes: number;
  priceCents: number;
  source: string | null;
  notes: string | null;
  /** An appointment, or a walk-in the estimator has pencilled in. */
  projected: boolean;
  status: string;
  appointment: AppointmentDto | null;
}

function sourceLabel(source: string): string | null {
  if (source === 'KIOSK') return 'Kiosk';
  if (source === 'ONLINE') return 'Online';
  if (source === 'VOICE') return 'Phone';
  return null;
}

function fromAppointment(appointment: AppointmentDto): DayItem {
  return {
    key: appointment.id,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    clientName: appointment.clientName,
    services: appointment.services.map((service) => service.name).join(' + '),
    durationMinutes: appointment.durationMinutes,
    priceCents: appointment.priceCentsTotal,
    source: sourceLabel(appointment.source),
    notes: appointment.notes,
    projected: false,
    status: appointment.status,
    appointment,
  };
}

function fromQueueEntry(entry: QueueEntryDto): DayItem {
  return {
    key: `queue:${entry.id}`,
    // Guarded by the filter below — an entry with no estimate is not placed.
    startAt: entry.estimatedReadyAt ?? '',
    endAt: null,
    clientName: entry.clientName,
    services: entry.services.map((service) => service.name).join(' + '),
    durationMinutes: entry.durationMinutes,
    priceCents: entry.priceCentsTotal,
    source: 'Walk-in',
    notes: entry.notes,
    projected: true,
    status: entry.status,
    appointment: null,
  };
}

/** The day's appointments, in time order, split into work and write-offs. */
const dayAppointments = computed(() =>
  book.appointments.value
    .filter((appointment) => shop.localDate(appointment.startAt) === cursor.value)
    .slice()
    .sort((a, b) => a.startAt.localeCompare(b.startAt)),
);

const voids = computed(() =>
  dayAppointments.value.filter(
    (appointment) => appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW',
  ),
);

/**
 * Today's walk-ins headed for this chair.
 *
 * `assignedBarberId` rather than `requestedBarberId`, because the estimator's projection
 * is exactly what is being shown — but only where it has produced a time, since an entry
 * it cannot place has nowhere to sit on a list ordered by time.
 */
const walkIns = computed<QueueEntryDto[]>(() => {
  if (!isToday.value || barberId.value === null) return [];
  return (queue.board.value?.entries ?? []).filter(
    (entry) =>
      entry.assignedBarberId === barberId.value &&
      entry.estimatedReadyAt !== null &&
      ['WAITING', 'CALLED', 'IN_CHAIR'].includes(entry.status),
  );
});

const items = computed<DayItem[]>(() =>
  [
    ...dayAppointments.value
      .filter(
        (appointment) => appointment.status !== 'CANCELLED' && appointment.status !== 'NO_SHOW',
      )
      .map(fromAppointment),
    ...walkIns.value.map(fromQueueEntry),
  ].sort((a, b) => a.startAt.localeCompare(b.startAt)),
);

/**
 * Rows with the open stretches between them.
 *
 * Only counted between two pieces of work, never before the first or after the last —
 * a barber's day does not start at midnight, and "8 hours open" before a 3pm booking
 * would be describing time they were never working.
 */
const rows = computed(() => {
  const out: ({ kind: 'item'; item: DayItem } | { kind: 'gap'; minutes: number })[] = [];

  items.value.forEach((item, index) => {
    const previous = items.value[index - 1];
    if (previous?.endAt != null) {
      const minutes = Math.round(
        (new Date(item.startAt).getTime() - new Date(previous.endAt).getTime()) / 60_000,
      );
      if (minutes >= 15) out.push({ kind: 'gap', minutes });
    }
    out.push({ kind: 'item', item });
  });

  return out;
});

const stats = computed(() => {
  const live = items.value.filter((item) => !item.projected);
  const minutes = live.reduce((total, item) => total + item.durationMinutes, 0);
  const takings = live.reduce((total, item) => total + item.priceCents, 0);
  const toCome = live.filter(
    (item) => item.status === 'BOOKED' || item.status === 'IN_PROGRESS',
  ).length;

  return {
    booked: live.length,
    hours: minutes > 0 ? formatDuration(minutes) : '—',
    takings: formatCents(takings),
    toCome,
  };
});

// --- The week -----------------------------------------------------------------

const weekDays = computed(() => {
  const start = shop.weekStart(cursor.value);

  return Array.from({ length: 7 }, (_, offset) => {
    const date = shop.addDays(start, offset);
    const onThisDay = book.appointments.value
      .filter(
        (appointment) =>
          shop.localDate(appointment.startAt) === date &&
          appointment.status !== 'CANCELLED' &&
          appointment.status !== 'NO_SHOW',
      )
      .sort((a, b) => a.startAt.localeCompare(b.startAt));

    return {
      date,
      label: shop.longDate(date, { weekday: 'short', day: undefined, month: undefined }),
      dayNumber: date.slice(8),
      today: date === shop.today(),
      appointments: onThisDay,
      takings: onThisDay.reduce((total, appointment) => total + appointment.priceCentsTotal, 0),
    };
  });
});

/**
 * "Aug 10 – 16", or "Jul 27 – Aug 2" when the week crosses a month.
 *
 * The month is named once, at the front, for the same reason `formatPeriod` does it
 * that way: these are `en-US` dates, so dropping it from the *start* renders as
 * "10 – Aug 16" — a range that appears to begin with a bare number.
 */
const weekLabel = computed(() => {
  const start = shop.weekStart(cursor.value);
  const end = shop.addDays(start, 6);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);

  const from = shop.longDate(start, { weekday: undefined, month: 'short' });
  const to = sameMonth
    ? String(Number(end.slice(8)))
    : shop.longDate(end, { weekday: undefined, month: 'short' });

  return `${from} – ${to}`;
});

const weekStats = computed(() => {
  const live = book.appointments.value.filter(
    (appointment) => appointment.status !== 'CANCELLED' && appointment.status !== 'NO_SHOW',
  );
  return {
    cuts: live.length,
    takings: formatCents(live.reduce((total, a) => total + a.priceCentsTotal, 0)),
  };
});

// --- Moving about -------------------------------------------------------------

const dayLabel = computed(() => shop.longDate(cursor.value));

const relative = computed(() => {
  if (cursor.value === shop.today()) return 'Today';
  if (cursor.value === shop.addDays(shop.today(), 1)) return 'Tomorrow';
  if (cursor.value === shop.addDays(shop.today(), -1)) return 'Yesterday';
  return null;
});

function step(days: number) {
  cursor.value = shop.addDays(cursor.value, view.value === 'day' ? days : days * 7);
}

function goToday() {
  cursor.value = shop.today();
}

function openDay(date: string) {
  cursor.value = date;
  view.value = 'day';
}

// --- Acting on an appointment --------------------------------------------------

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

const onStart = (appointment: AppointmentDto) =>
  act(appointment.id, () => book.setStatus(appointment.id, 'IN_PROGRESS'));

const onFinish = (appointment: AppointmentDto) =>
  act(
    appointment.id,
    () => book.setStatus(appointment.id, 'COMPLETED'),
    `${appointment.clientName} is done`,
  );

/**
 * Cancelling is behind the menu and asks first, unlike starting and finishing.
 *
 * Those two are the ordinary run of a day and are undone by pressing the other one.
 * A cancellation frees the slot, recomputes the queue against it, and cannot be undone
 * from here — rebooking is a new appointment.
 */
function onCancel(appointment: AppointmentDto) {
  confirm.require({
    header: 'Cancel Appointment',
    message: `Cancel ${appointment.clientName} at ${shop.clock(appointment.startAt)}? The slot goes back on the calendar.`,
    acceptLabel: 'Cancel It',
    rejectLabel: 'Keep It',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', variant: 'text' },
    accept: () =>
      void act(
        appointment.id,
        () => book.cancel(appointment.id),
        `${appointment.clientName} cancelled`,
      ),
  });
}

function onNoShow(appointment: AppointmentDto) {
  confirm.require({
    header: 'No-show',
    message: `Mark ${appointment.clientName} as a no-show? It stays on their record.`,
    acceptLabel: 'Mark No-show',
    rejectLabel: 'Cancel',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', variant: 'text' },
    accept: () => void act(appointment.id, () => book.setStatus(appointment.id, 'NO_SHOW')),
  });
}

const menu = ref<{ toggle: (event: Event) => void } | null>(null);
const menuTarget = ref<AppointmentDto | null>(null);

const menuItems = computed(() => {
  const appointment = menuTarget.value;
  if (!appointment) return [];

  const done = appointment.status === 'COMPLETED';

  return [
    { label: 'Take Payment', command: () => void navigateTo('/take-payment') },
    { separator: true },
    ...(done
      ? []
      : [
          { label: 'No-show', command: () => onNoShow(appointment) },
          { label: 'Cancel Appointment', command: () => onCancel(appointment) },
        ]),
  ];
});

function openMenu(event: Event, appointment: AppointmentDto) {
  menuTarget.value = appointment;
  menu.value?.toggle(event);
}

// --- Row presentation ----------------------------------------------------------

function stateOf(item: DayItem): { kind: string; label: string } | null {
  if (item.projected) return { kind: 'proj', label: 'Projected' };
  if (item.status === 'IN_PROGRESS') return { kind: 'live', label: 'In the chair' };
  if (item.status === 'COMPLETED') return { kind: '', label: 'Done' };
  if (item.status === 'CANCELLED') return { kind: 'bad', label: 'Cancelled' };
  if (item.status === 'NO_SHOW') return { kind: 'bad', label: 'No-show' };

  // The next thing to actually do — the first booked slot that has not finished.
  const next = items.value.find(
    (candidate) => !candidate.projected && candidate.status === 'BOOKED',
  );
  if (next?.key === item.key && isToday.value) return { kind: 'next', label: 'Next' };

  return { kind: '', label: 'Booked' };
}

function rowClass(item: DayItem) {
  return {
    now: item.status === 'IN_PROGRESS' || (item.projected && item.status === 'IN_CHAIR'),
    projected: item.projected,
    done: item.status === 'COMPLETED',
    void: item.status === 'CANCELLED' || item.status === 'NO_SHOW',
  };
}
</script>

<template>
  <div class="myday">
    <section v-if="barberId === null" class="empty">
      <b>No chair on this account</b>
      This page shows one barber's own book. Your account does not cut hair — open
      <NuxtLink to="/calendar">Calendar</NuxtLink> to see the shop's.
    </section>

    <template v-else>
      <header class="toolbar">
        <div class="datebar">
          <Button
            variant="text"
            severity="secondary"
            :aria-label="view === 'day' ? 'Previous day' : 'Previous week'"
            @click="step(-1)"
          >
            ‹
          </Button>
          <span class="d">
            {{ view === 'day' ? dayLabel : weekLabel }}
            <span v-if="view === 'day' && relative" class="rel">· {{ relative }}</span>
          </span>
          <Button
            variant="text"
            severity="secondary"
            :aria-label="view === 'day' ? 'Next day' : 'Next week'"
            @click="step(1)"
          >
            ›
          </Button>
          <Button
            :label="view === 'day' ? 'Today' : 'This Week'"
            variant="outlined"
            severity="secondary"
            size="small"
            :disabled="view === 'day' && isToday"
            @click="goToday"
          />
        </div>

        <div class="views">
          <Button
            label="Day"
            size="small"
            :variant="view === 'day' ? undefined : 'outlined'"
            :severity="view === 'day' ? undefined : 'secondary'"
            @click="view = 'day'"
          />
          <Button
            label="Week"
            size="small"
            :variant="view === 'week' ? undefined : 'outlined'"
            :severity="view === 'week' ? undefined : 'secondary'"
            @click="view = 'week'"
          />
        </div>
      </header>

      <!-- --- Day ------------------------------------------------------------ -->
      <template v-if="view === 'day'">
        <div class="stats">
          <span class="stat">
            <span class="n">{{ stats.booked }}</span>
            <span class="k">Booked</span>
          </span>
          <span class="stat">
            <span class="n">{{ stats.hours }}</span>
            <span class="k">In the Chair</span>
          </span>
          <span class="stat">
            <span class="n" :class="{ warn: stats.booked > 0 }">{{ stats.takings }}</span>
            <span class="k">Day's Takings</span>
          </span>
          <span class="stat">
            <span class="n">{{ stats.toCome }}</span>
            <span class="k">Still to Come</span>
          </span>
        </div>

        <div v-if="book.loading.value && items.length === 0" class="skeleton">
          <span class="bone" />
          <span class="bone" />
          <span class="bone" />
        </div>

        <p v-else-if="items.length === 0" class="empty">
          <b>Nothing booked.</b>
          Walk-ins that come to your chair will appear here as they join the queue.
        </p>

        <template v-else>
          <div class="head-row" aria-hidden="true">
            <span class="h-when">When</span>
            <span class="h-who">Client</span>
            <span class="h-what">Service</span>
            <span class="h-price">Price</span>
            <span class="h-state" />
            <span class="h-acts" />
          </div>

          <div class="agenda">
            <template v-for="row in rows" :key="row.kind === 'item' ? row.item.key : row.minutes">
              <!-- The open stretch, named rather than drawn. See the header note. -->
              <p v-if="row.kind === 'gap'" class="gap" :class="{ long: row.minutes >= 60 }">
                <span>{{ formatDuration(row.minutes) }} open</span>
              </p>

              <article v-else class="item" :class="rowClass(row.item)">
                <span class="when">
                  <span class="t">{{ shop.clock(row.item.startAt) }}</span>
                  <span v-if="row.item.endAt" class="u">– {{ shop.clock(row.item.endAt) }}</span>
                </span>

                <span class="who">
                  <span class="nm">
                    {{ row.item.clientName }}
                    <span v-if="row.item.source" class="tag">{{ row.item.source }}</span>
                  </span>
                  <!-- Only the projection needs a caption here; the duration already
                       sits under the service and does not want saying twice. -->
                  <span v-if="row.item.projected" class="meta">moves as the board moves</span>
                </span>

                <span class="what">
                  <span class="strong">{{ row.item.services }}</span>
                  <span class="meta">{{ formatDuration(row.item.durationMinutes) }}</span>
                </span>

                <span class="price">{{ formatCents(row.item.priceCents) }}</span>

                <span class="state">
                  <span v-if="stateOf(row.item)" class="pill" :class="stateOf(row.item)?.kind">
                    {{ stateOf(row.item)?.label }}
                  </span>
                </span>

                <span class="acts">
                  <template v-if="row.item.appointment">
                    <Button
                      v-if="row.item.status === 'BOOKED'"
                      label="Start"
                      :loading="busy.has(row.item.appointment.id)"
                      @click="onStart(row.item.appointment)"
                    />
                    <Button
                      v-else-if="row.item.status === 'IN_PROGRESS'"
                      label="Finish"
                      :loading="busy.has(row.item.appointment.id)"
                      @click="onFinish(row.item.appointment)"
                    />
                    <Button
                      variant="text"
                      severity="secondary"
                      aria-label="More actions"
                      @click="openMenu($event, row.item.appointment)"
                    >
                      <EllipsisIcon class="ell" aria-hidden="true" />
                    </Button>
                  </template>
                  <!-- A walk-in is acted on from the queue, which is where it lives. -->
                  <NuxtLink v-else class="linkish" to="/queue">In the Queue</NuxtLink>
                </span>

                <span v-if="row.item.notes" class="note">
                  <span class="note-key">Note</span>
                  <span class="note-body">{{ row.item.notes }}</span>
                </span>
              </article>
            </template>
          </div>

          <!-- Counted and folded, not dropped: a client who cancels twice is worth
               seeing, just not at the same weight as the work. -->
          <p v-if="voids.length > 0" class="fold">
            <button type="button" class="linkish" @click="showVoids = !showVoids">
              {{ showVoids ? 'Hide' : 'Show' }} {{ voids.length }} cancelled and no-show
            </button>
          </p>

          <div v-if="showVoids" class="agenda">
            <article
              v-for="appointment in voids"
              :key="appointment.id"
              class="item void"
            >
              <span class="when">
                <span class="t">{{ shop.clock(appointment.startAt) }}</span>
                <span class="u">– {{ shop.clock(appointment.endAt) }}</span>
              </span>
              <span class="who">
                <span class="nm">{{ appointment.clientName }}</span>
                <span class="meta">{{ formatDuration(appointment.durationMinutes) }}</span>
              </span>
              <span class="what">
                <span class="strong">
                  {{ appointment.services.map((service) => service.name).join(' + ') }}
                </span>
              </span>
              <span class="price">{{ formatCents(appointment.priceCentsTotal) }}</span>
              <span class="state">
                <span class="pill bad">
                  {{ appointment.status === 'NO_SHOW' ? 'No-show' : 'Cancelled' }}
                </span>
              </span>
              <span class="acts" />
            </article>
          </div>
        </template>
      </template>

      <!-- --- Week ----------------------------------------------------------- -->
      <template v-else>
        <div class="stats">
          <span class="stat">
            <span class="n">{{ weekStats.cuts }}</span>
            <span class="k">{{ weekStats.cuts === 1 ? 'Cut This Week' : 'Cuts This Week' }}</span>
          </span>
          <span class="stat">
            <span class="n" :class="{ warn: weekStats.cuts > 0 }">{{ weekStats.takings }}</span>
            <span class="k">Booked So Far</span>
          </span>
        </div>

        <div class="week">
          <button
            v-for="day in weekDays"
            :key="day.date"
            type="button"
            class="wday"
            :class="{ today: day.today, bare: day.appointments.length === 0 }"
            @click="openDay(day.date)"
          >
            <span class="dh">
              <span class="dn">{{ day.label }}</span>
              <span class="dd">{{ day.dayNumber }}</span>
            </span>

            <span v-if="day.appointments.length === 0" class="quiet-day">Nothing booked</span>

            <span v-else class="chips">
              <span v-for="appointment in day.appointments" :key="appointment.id" class="chip">
                <span class="ct">{{ shop.clock(appointment.startAt) }}</span>
                <span class="cn">{{ appointment.clientName }}</span>
              </span>
            </span>

            <span v-if="day.appointments.length > 0" class="tot">
              <span>{{ day.appointments.length }} {{ day.appointments.length === 1 ? 'cut' : 'cuts' }}</span>
              <b>{{ formatCents(day.takings) }}</b>
            </span>
          </button>
        </div>
      </template>
    </template>

    <Menu ref="menu" :model="menuItems" popup />
  </div>
</template>

<style scoped>
.myday {
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
}

.datebar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.datebar .d {
  font-family: var(--fc-font-display);
  font-size: 1.05rem;
  font-weight: 650;
  white-space: nowrap;
}

.datebar .rel {
  color: var(--fc-ink-faint);
  font-weight: 500;
  font-size: 0.85rem;
}

.views {
  display: flex;
  gap: 0.375rem;
}

/* --- Figures ---------------------------------------------------------------- */

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.75rem;
  margin: 0.25rem 0 0.5rem;
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

.stat .k {
  font-size: 0.625rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 640;
}

/* --- Loading ---------------------------------------------------------------- */

.skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.bone {
  height: 3.5rem;
  border-radius: 8px;
  border: 1px solid var(--fc-line-soft);
  background: var(--fc-surface);
  opacity: 0.55;
}

/* --- The agenda ------------------------------------------------------------- */

.agenda {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

/* Named areas at both widths, so every cell is placed by reading rather than by
   resizing the window — the lesson from the queue row. */
.head-row,
.item {
  display: grid;
  grid-template-columns:
    7rem minmax(8rem, 1.4fr) minmax(8rem, 1.25fr)
    5.5rem 7.5rem 11.5rem;
  grid-template-areas:
    'when who  what price state acts'
    'when note note note  note  acts';
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

.h-when { grid-area: when; }
.h-who { grid-area: who; }
.h-what { grid-area: what; }
.h-price { grid-area: price; text-align: right; }
.h-state { grid-area: state; }
.h-acts { grid-area: acts; }

.item {
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 0.6rem 0.75rem;
}

/* The one row that is about this minute. */
.item.now {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

/* A projection, drawn as one: dashed, unfilled, and never mistakable for a booking. */
.item.projected {
  border-style: dashed;
  background: transparent;
}

.item.projected.now {
  border-color: var(--fc-accent);
}

/* Done is still worth seeing — it is the day's takings — but it is not work left. */
.item.done {
  opacity: 0.62;
}

.item.void {
  opacity: 0.5;
  border-style: dashed;
}

.when {
  grid-area: when;
  display: flex;
  flex-direction: column;
}

.when .t {
  font-size: 0.9375rem;
  font-weight: 640;
  font-variant-numeric: tabular-nums;
}

.when .u {
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
}

.who {
  grid-area: who;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.what {
  grid-area: what;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.price {
  grid-area: price;
  text-align: right;
  font-size: 0.875rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.state {
  grid-area: state;
}

.acts {
  grid-area: acts;
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
  align-items: center;
}

.nm {
  font-size: 0.9375rem;
  font-weight: 580;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.strong {
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill {
  display: inline-block;
  font-size: 0.5625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 660;
  padding: 0.14rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--fc-line);
  color: var(--fc-ink-faint);
  white-space: nowrap;
}

.pill.live {
  color: var(--fc-accent-ink);
  background: var(--fc-accent);
  border-color: transparent;
}

.pill.next {
  color: var(--fc-accent);
  border-color: var(--fc-accent);
}

/* Red is failure only. A cancellation is the one thing here that qualifies. */
.pill.bad {
  color: var(--fc-danger-ink);
  border-color: var(--fc-danger-line);
  background: var(--fc-danger-bg);
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
  vertical-align: 0.08em;
  margin-left: 0.25rem;
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

/*
 * The open stretch between two pieces of work.
 *
 * The one thing an agenda loses against a time grid is empty space, and on booth rent
 * empty space is the barber's own money. Naming it costs a single row. Brass past an
 * hour — noticeable, not a failure, so never red.
 */
.gap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0;
  padding: 0.1rem 0.75rem;
  color: var(--fc-ink-faint);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.gap::before,
.gap::after {
  content: '';
  height: 1px;
  background: var(--fc-line-soft);
  flex: 1;
}

.gap.long {
  color: var(--fc-accent);
}

.fold {
  margin: 0.25rem 0 0;
  text-align: center;
}

.linkish {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 0.75rem;
  color: var(--fc-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ell {
  width: 0.875rem;
  height: 0.875rem;
}

.empty {
  margin: 0;
  border: 1px dashed var(--fc-line);
  border-radius: 8px;
  padding: 2.5rem 1rem;
  text-align: center;
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

/* --- The week --------------------------------------------------------------- */

.week {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0.5rem;
  align-items: stretch;
}

.wday {
  appearance: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  color: inherit;
  padding: 0.7rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-height: 11rem;
  min-width: 0;
}

.wday:hover {
  border-color: var(--fc-accent);
}

.wday:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.wday.today {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

/* A day with nothing on it is not a card, it is an absence. */
.wday.bare {
  background: transparent;
  border-style: dashed;
}

.dh {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.4rem;
}

.dn {
  font-size: 0.6875rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 660;
}

.dd {
  font-family: var(--fc-font-display);
  font-size: 1.05rem;
  font-weight: 660;
  font-variant-numeric: tabular-nums;
}

.wday.today .dd {
  color: var(--fc-accent);
}

.chips {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.chip {
  border: 1px solid var(--fc-line);
  border-radius: 5px;
  background: var(--fc-input);
  padding: 0.22rem 0.4rem;
  font-size: 0.6875rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ct {
  font-variant-numeric: tabular-nums;
  color: var(--fc-ink-muted);
}

.cn {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quiet-day {
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-style: italic;
}

.tot {
  margin-top: auto;
  padding-top: 0.4rem;
  border-top: 1px solid var(--fc-line-soft);
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  display: flex;
  justify-content: space-between;
  gap: 0.4rem;
}

.tot b {
  color: var(--fc-ink-muted);
  font-weight: 600;
}

/* Tablet and narrow desktop — 1040 for the same reason as the queue row: at 1024
   landscape with the rail out, the wide row is already past its minimums. */
@media (max-width: 1040px) {
  .head-row {
    display: none;
  }

  .item {
    grid-template-columns: 6rem minmax(0, 1fr) auto;
    grid-template-areas:
      'when who   price'
      'when what  state'
      'when acts  acts'
      'when note  note';
    row-gap: 0.3rem;
  }

  .when {
    align-self: start;
    padding-top: 0.1rem;
  }

  .acts {
    justify-content: flex-start;
  }

  .week {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wday {
    min-height: 0;
  }
}

@media (max-width: 640px) {
  .week {
    grid-template-columns: 1fr;
  }
}
</style>
