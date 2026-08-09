<script setup lang="ts">
/**
 * Time off and extra hours.
 *
 * The admin picks between two things — "time off" or "extra hours" — and whether it
 * covers a whole day. The three database types are derived from that: all-day time
 * off is TIME_OFF, a partial range is BLOCK, extra hours is EXTRA_HOURS. TIME_OFF and
 * BLOCK remove availability identically, so offering both would ask for a decision
 * that changes nothing.
 *
 * Dates and times go to the server as the shop's local calendar, never as instants —
 * the conversion happens once, server-side, against the shop timezone.
 */

import { EXCEPTION_KIND, formatDayMinute, timeStringToMinutes, type ScheduleExceptionDto } from '@francis/shared';

const props = defineProps<{
  barberId: string;
  exceptions: ScheduleExceptionDto[];
}>();

const barbers = useBarbers();
const { notifySuccess, notifyApiFailure } = useNotify();

const form = reactive({
  kind: EXCEPTION_KIND.TIME_OFF as string,
  startDate: '',
  endDate: '',
  allDay: true,
  startTime: '09:00',
  endTime: '12:00',
  reason: '',
});

const saving = ref(false);
const formError = ref<string | null>(null);

// Extra hours describe times worked, so "all day" would say nothing useful.
watch(
  () => form.kind,
  (kind) => {
    if (kind === EXCEPTION_KIND.EXTRA_HOURS) form.allDay = false;
  },
);

function describe(exception: ScheduleExceptionDto): string {
  const sameDay = exception.startDate === exception.endDate;
  const dates = sameDay ? exception.startDate : `${exception.startDate} – ${exception.endDate}`;

  if (exception.allDay) return dates;

  const start = timeStringToMinutes(exception.startTime ?? '');
  const end = timeStringToMinutes(exception.endTime ?? '');
  if (start === null || end === null) return dates;

  return `${dates} · ${formatDayMinute(start)} – ${formatDayMinute(end)}`;
}

async function onAdd() {
  formError.value = null;

  if (!form.startDate) {
    formError.value = 'Pick a date.';
    return;
  }
  if (!form.allDay && form.endTime <= form.startTime) {
    formError.value = 'The end time must be after the start time.';
    return;
  }

  saving.value = true;
  try {
    await barbers.addException(props.barberId, {
      kind: form.kind,
      startDate: form.startDate,
      // A single day is the common case, so an empty end means the same day.
      ...(form.endDate ? { endDate: form.endDate } : {}),
      allDay: form.allDay,
      ...(form.allDay ? {} : { startTime: form.startTime, endTime: form.endTime }),
      reason: form.reason.trim() || null,
    });

    Object.assign(form, { startDate: '', endDate: '', reason: '' });
    notifySuccess('Added to the calendar');
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    saving.value = false;
  }
}

async function onRemove(exceptionId: string) {
  try {
    await barbers.removeException(exceptionId);
    notifySuccess('Removed');
  } catch (error) {
    notifyApiFailure(error);
  }
}
</script>

<template>
  <section class="timeoff">
    <h3>Time Off</h3>

    <Message v-if="formError" severity="error" :closable="false">{{ formError }}</Message>

    <div class="add">
      <div class="kinds">
        <label class="kind">
          <RadioButton v-model="form.kind" :value="EXCEPTION_KIND.TIME_OFF" input-id="k-off" />
          <span>Time off</span>
        </label>
        <label class="kind">
          <RadioButton v-model="form.kind" :value="EXCEPTION_KIND.EXTRA_HOURS" input-id="k-extra" />
          <span>Extra hours</span>
        </label>
      </div>

      <div class="row">
        <div class="field">
          <label for="ex-start" class="fc-label">From</label>
          <input id="ex-start" v-model="form.startDate" type="date" class="native">
        </div>
        <div class="field">
          <label for="ex-end" class="fc-label">To</label>
          <input id="ex-end" v-model="form.endDate" type="date" class="native">
        </div>
      </div>

      <div class="toggle">
        <ToggleSwitch
          v-model="form.allDay"
          input-id="ex-allday"
          :disabled="form.kind === EXCEPTION_KIND.EXTRA_HOURS"
        />
        <label for="ex-allday">All day</label>
      </div>

      <div v-if="!form.allDay" class="row">
        <div class="field">
          <label for="ex-from" class="fc-label">Start</label>
          <input id="ex-from" v-model="form.startTime" type="time" class="native">
        </div>
        <div class="field">
          <label for="ex-to" class="fc-label">End</label>
          <input id="ex-to" v-model="form.endTime" type="time" class="native">
        </div>
      </div>

      <div class="field">
        <label for="ex-reason" class="fc-label">Reason</label>
        <InputText id="ex-reason" v-model="form.reason" placeholder="Vacation" fluid />
      </div>

      <Button label="Add" size="small" :loading="saving" @click="onAdd" />
    </div>

    <ul v-if="props.exceptions.length" class="list">
      <li v-for="exception in props.exceptions" :key="exception.id">
        <Tag
          :value="exception.kind === EXCEPTION_KIND.EXTRA_HOURS ? 'Extra' : exception.allDay ? 'All day' : 'Part day'"
          :severity="exception.kind === EXCEPTION_KIND.EXTRA_HOURS ? 'warn' : 'danger'"
        />
        <span class="when">{{ describe(exception) }}</span>
        <span class="why">{{ exception.reason ?? '' }}</span>
        <Button
          label="Remove"
          size="small"
          variant="text"
          severity="danger"
          @click="onRemove(exception.id)"
        />
      </li>
    </ul>
    <p v-else class="empty">Nothing scheduled.</p>
  </section>
</template>

<style scoped>
.timeoff {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

h3 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 0.9375rem;
  font-weight: 650;
}

.add {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid var(--fc-line);
  border-radius: 6px;
  background: var(--fc-surface);
  padding: 0.875rem;
}

.kinds {
  display: flex;
  gap: 1.25rem;
}

.kind {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

.native {
  background: var(--fc-input);
  border: 1px solid var(--fc-line);
  border-radius: 5px;
  color: var(--fc-ink);
  font: inherit;
  font-size: 0.8125rem;
  padding: 0.4375rem 0.5rem;
  color-scheme: dark;
  min-width: 0;
}

.native:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
}

.list li {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 0.8125rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--fc-line);
  border-radius: 5px;
  background: var(--fc-surface);
}

.when {
  font-variant-numeric: tabular-nums;
  color: var(--fc-ink-muted);
}

.why {
  flex: 1;
  color: var(--fc-ink-faint);
  font-size: 0.75rem;
}

.empty {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
}
</style>
