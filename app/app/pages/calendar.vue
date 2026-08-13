<script setup lang="ts">
/**
 * Calendar — the shop's day, one column per chair.
 *
 * Admin-only, which is what makes the one un-scoped `loadRange` correct: an admin
 * who does not name a barber is given every chair, and a board of columns is the
 * one place that wants exactly that. A barber never reaches this page — the route
 * guard bounces them to `/my-day`, whose request always names their own chair.
 *
 * The availability prober that lived here through the middle phases is gone —
 * its two duties are covered better now. "Why is this day empty" is answered
 * per column by `/working-hours` using the engine's own sentences, and booking
 * goes through the dialog, which asks the same engine for its slots.
 *
 * Walk-ins appear as projections on today's board, dashed while they can still
 * move — the same vocabulary as `/my-day`, from the same components.
 */

import { appointmentChangeTouches } from '@francis/shared';
import type { QueueEntryDto, WorkingHoursResponse } from '@francis/shared';

useHead({ title: 'Calendar — Francis Cutz' });

const book = useAppointments();
const queue = useQueue();
const catalog = useCatalog();
const shop = useShopClock();
const columnsApi = useCalendarColumns();
const workingHoursApi = useWorkingHours();
const { notifyApiFailure } = useNotify();

await catalog.refresh();
await shop.ensureLoaded();

const cursor = ref(shop.today());
const bookingOpen = ref(false);
const showVoids = ref(false);

const range = computed(() => shop.dayRange(cursor.value));

async function load(quiet = false): Promise<void> {
  try {
    // No barberId on purpose — see the header note.
    await book.loadRange(range.value.from, range.value.to, { quiet });
  } catch (error) {
    notifyApiFailure(error, "Could not load the day's book.");
  }
}

const workingDay = ref<WorkingHoursResponse | null>(null);

/** Shading and the empty-column sentences; the board survives without them. */
async function loadWorkingDay(): Promise<void> {
  try {
    workingDay.value = await workingHoursApi.loadWorkingHours(cursor.value, 1);
  } catch {
    workingDay.value = null;
  }
}

await Promise.all([load(), loadWorkingDay()]);
watch(cursor, () => {
  void load();
  void loadWorkingDay();
});

// The queue board is already live in shared state and polled by the shell.
onMounted(() => void queue.refresh({ quiet: true }));

/**
 * Somebody else's booking, arriving live.
 *
 * Quiet, with the same rules as everything else here: it must not blank a board an admin
 * is reading, and it must not raise a toast about a fetch nobody asked for. No `barberId`
 * in the view — this board is every chair, so any chair's change is this board's change.
 */
watch(book.lastChange, (change) => {
  if (change === null) return;
  if (!appointmentChangeTouches(change, range.value)) return;
  void load(true);
});

/**
 * A quiet minute poll underneath the socket, gated to the visible tab.
 *
 * Not for a link that drops loudly — Socket.IO reconnects by itself and
 * `appointment:changed` resumes. It is for the one that dies quietly while reporting
 * itself healthy, and for the gap during a reconnect: unlike the queue board there is no
 * connect-time backfill for appointments, because three pages read three different ranges
 * and there is no one payload to send them.
 *
 * It also carries `/working-hours`, which has no socket event of its own — an admin
 * changing somebody's schedule is not an appointment change.
 */
useVisiblePoll(60_000, () => {
  void load(true);
  void loadWorkingDay();
});

const isToday = computed(() => cursor.value === shop.today());

/** The roster: staff `/barbers` includes retired chairs, the board does not. */
const chairs = computed(() =>
  catalog.barbers.value.filter((barber) => barber.status === 'ACTIVE'),
);

const dayAppointments = computed(() =>
  book.appointments.value.filter(
    (appointment) => shop.localDate(appointment.startAt) === cursor.value,
  ),
);

const voidsCount = computed(
  () =>
    dayAppointments.value.filter(
      (appointment) => appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW',
    ).length,
);

const columns = computed(() =>
  chairs.value.map((barber) => {
    const queueEntries: QueueEntryDto[] = isToday.value
      ? (queue.board.value?.entries ?? []).filter(
          (entry) =>
            entry.assignedBarberId === barber.id &&
            entry.estimatedReadyAt !== null &&
            ['WAITING', 'CALLED', 'IN_CHAIR'].includes(entry.status),
        )
      : [];

    return columnsApi.buildColumn({
      key: barber.id,
      today: isToday.value,
      appointments: dayAppointments.value.filter(
        (appointment) => appointment.barberId === barber.id,
      ),
      queueEntries,
      workingDay:
        workingDay.value?.days[0]?.barbers.find((row) => row.barberId === barber.id) ?? null,
      showVoids: showVoids.value,
    });
  }),
);

const extent = computed(() => columnsApi.gridExtent(columns.value));

const chairNames = computed(
  () => new Map(chairs.value.map((barber) => [barber.id, barber.displayName])),
);

/** The server's clock, borrowed from the queue board — never the browser's. */
const nowMinute = computed(() => {
  const generatedAt = queue.board.value?.generatedAt;
  return generatedAt === undefined ? null : shop.minuteOfDay(generatedAt);
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
  cursor.value = shop.addDays(cursor.value, days);
}

function goToday() {
  cursor.value = shop.today();
}
</script>

<template>
  <div class="calboard">
    <header class="toolbar">
      <div class="datebar">
        <Button variant="text" severity="secondary" aria-label="Previous day" @click="step(-1)">
          ‹
        </Button>
        <span class="d">
          {{ dayLabel }}
          <span v-if="relative" class="rel">· {{ relative }}</span>
        </span>
        <Button variant="text" severity="secondary" aria-label="Next day" @click="step(1)">
          ›
        </Button>
        <Button
          label="Today"
          variant="outlined"
          severity="secondary"
          size="small"
          :disabled="isToday"
          @click="goToday"
        />
      </div>

      <div class="views">
        <!-- Counted and folded, not dropped — same rule as the agenda. -->
        <button v-if="voidsCount > 0" type="button" class="linkish" @click="showVoids = !showVoids">
          {{ showVoids ? 'Hide' : 'Show' }} {{ voidsCount }} cancelled and no-show
        </button>
        <Button label="Add Appointment" size="small" @click="bookingOpen = true" />
      </div>
    </header>

    <CalendarTimeGrid
      :columns="columns"
      :start-minute="extent.startMinute"
      :end-minute="extent.endMinute"
      :now-minute="nowMinute"
    >
      <template #head="{ column }">
        <span class="chair">{{ chairNames.get(column.key) }}</span>
      </template>
    </CalendarTimeGrid>

    <!-- Opens on whatever date is on the board; the admin picks the chair inside. -->
    <AppointmentsAddAppointmentDialog
      v-model:visible="bookingOpen"
      :date="cursor"
      @booked="load()"
    />
  </div>
</template>

<style scoped>
.calboard {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
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
  align-items: center;
  gap: 0.75rem;
}

.linkish {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--fc-accent);
  font: inherit;
  font-size: 0.75rem;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  padding: 0.2rem 0;
}

.linkish:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.chair {
  font-size: 0.8125rem;
  font-weight: 640;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
