<script setup lang="ts">
/**
 * Weekly schedule — the "Day Rows" design.
 *
 * Seven rows, each holding as many time ranges as it needs. Chosen over a visual grid
 * or a pattern-and-override form because it maps one-to-one onto `BarberSchedule`
 * rows: there is no expand-on-save or infer-on-load layer that can end up disagreeing
 * with what is actually stored.
 *
 * Split shifts are the normal case here — every barber works either side of lunch —
 * so "add another range to this day" is a primary action, not a hidden one. The
 * repetition that costs is answered by "copy to my other working days".
 */

import {
  dayName,
  findScheduleProblems,
  minutesToTimeString,
  timeStringToMinutes,
  totalWeeklyMinutes,
  type BarberScheduleDto,
  type ShiftRange,
} from '@francis/shared';

const props = defineProps<{
  barberId: string;
  shifts: BarberScheduleDto[];
  /** Shop opening hours, for the "outside shop hours" warning. */
  shopHours: { dayOfWeek: number; openMinute: number; closeMinute: number; isClosed: boolean }[];
}>();

const barbers = useBarbers();
const { notifySuccess, notifyApiFailure } = useNotify();

interface EditableRange {
  start: string;
  end: string;
}

/** Seven days, each a list of "HH:mm" ranges. Rebuilt whenever the barber changes. */
const week = ref<EditableRange[][]>(Array.from({ length: 7 }, () => []));
const saving = ref(false);

watch(
  () => [props.barberId, props.shifts] as const,
  () => {
    const next: EditableRange[][] = Array.from({ length: 7 }, () => []);
    for (const shift of props.shifts) {
      next[shift.dayOfWeek]?.push({
        start: minutesToTimeString(shift.startMinute),
        end: minutesToTimeString(shift.endMinute),
      });
    }
    week.value = next;
  },
  { immediate: true, deep: true },
);

/** Parsed form, or null if anything is unreadable — drives validation and the total. */
const parsed = computed<ShiftRange[] | null>(() => {
  const result: ShiftRange[] = [];
  for (const [dayOfWeek, ranges] of week.value.entries()) {
    for (const range of ranges) {
      const startMinute = timeStringToMinutes(range.start);
      const endMinute = timeStringToMinutes(range.end);
      if (startMinute === null || endMinute === null) return null;
      result.push({ dayOfWeek, startMinute, endMinute });
    }
  }
  return result;
});

/**
 * Validated with the same function the API uses, so the editor refuses exactly what
 * the server would refuse rather than approximating it.
 */
const problems = computed(() => (parsed.value === null ? [] : findScheduleProblems(parsed.value)));
const hasUnreadableTime = computed(() => parsed.value === null);
const canSave = computed(() => !hasUnreadableTime.value && problems.value.length === 0);

const weeklyHours = computed(() => {
  if (parsed.value === null) return null;
  const minutes = totalWeeklyMinutes(parsed.value);
  return (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1);
});

/** Days the barber works but the shop is shut — a warning, never a refusal. */
const outsideShopHours = computed(() => {
  if (parsed.value === null) return [];
  const warnings: string[] = [];

  for (const shift of parsed.value) {
    const hours = props.shopHours.find((row) => row.dayOfWeek === shift.dayOfWeek);
    if (!hours) continue;

    if (hours.isClosed) {
      warnings.push(`${dayName(shift.dayOfWeek)}: the shop is closed.`);
    } else if (shift.startMinute < hours.openMinute || shift.endMinute > hours.closeMinute) {
      warnings.push(
        `${dayName(shift.dayOfWeek)}: outside shop hours (${minutesToTimeString(hours.openMinute)}–${minutesToTimeString(hours.closeMinute)}).`,
      );
    }
  }
  return [...new Set(warnings)];
});

const workingDays = computed(() =>
  week.value.map((ranges, day) => ({ day, working: ranges.length > 0 })).filter((d) => d.working),
);

function addRange(dayOfWeek: number) {
  const ranges = week.value[dayOfWeek];
  if (!ranges) return;
  // A new range starts where the last one ended, which is what a lunch break needs.
  const last = ranges[ranges.length - 1];
  ranges.push(last ? { start: last.end, end: last.end } : { start: '10:00', end: '18:00' });
}

function removeRange(dayOfWeek: number, index: number) {
  week.value[dayOfWeek]?.splice(index, 1);
}

/** Copies this day's ranges onto every OTHER day that already has hours. */
function copyToOtherWorkingDays(dayOfWeek: number) {
  const source = week.value[dayOfWeek];
  if (!source || source.length === 0) return;

  for (const { day } of workingDays.value) {
    if (day === dayOfWeek) continue;
    week.value[day] = source.map((range) => ({ ...range }));
  }
  notifySuccess(`Copied ${dayName(dayOfWeek)} to the other working days`);
}

async function onSave() {
  if (saving.value || !canSave.value || parsed.value === null) return;
  saving.value = true;
  try {
    await barbers.saveSchedule(props.barberId, parsed.value);
    notifySuccess('Schedule saved');
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="editor">
    <div class="head">
      <div>
        <h3>Weekly Schedule</h3>
        <p class="sub">
          <template v-if="weeklyHours !== null">{{ weeklyHours }} hours a week</template>
          <template v-else>Fix the highlighted times</template>
        </p>
      </div>
      <Button label="Save Week" size="small" :loading="saving" :disabled="!canSave" @click="onSave" />
    </div>

    <Message v-for="problem in problems" :key="problem.message" severity="error" :closable="false">
      {{ problem.message }}
    </Message>

    <!-- A warning, not a block: an admin may set next month's hours before changing
         the shop's, and the availability engine intersects the two anyway. -->
    <Message v-for="warning in outsideShopHours" :key="warning" severity="warn" :closable="false">
      {{ warning }}
    </Message>

    <div class="days">
      <div
        v-for="(ranges, dayOfWeek) in week"
        :key="dayOfWeek"
        class="day"
        :class="{ off: ranges.length === 0 }"
      >
        <span class="dname">{{ dayName(dayOfWeek) }}</span>

        <div class="ranges">
          <p v-if="ranges.length === 0" class="not-working">Not working</p>

          <div v-for="(range, index) in ranges" :key="index" class="range">
            <input
              v-model="range.start"
              type="time"
              class="fc-input"
              :aria-label="`${dayName(dayOfWeek)} shift ${index + 1} start`"
            >
            <span class="dash">–</span>
            <input
              v-model="range.end"
              type="time"
              class="fc-input"
              :aria-label="`${dayName(dayOfWeek)} shift ${index + 1} end`"
            >
            <Button
              label="Remove"
              size="small"
              variant="text"
              severity="secondary"
              @click="removeRange(dayOfWeek, index)"
            />
          </div>
        </div>

        <div class="day-actions">
          <Button label="+ Add" size="small" variant="text" @click="addRange(dayOfWeek)" />
          <Button
            v-if="ranges.length > 0 && workingDays.length > 1"
            label="Copy"
            size="small"
            variant="text"
            severity="secondary"
            :title="`Copy ${dayName(dayOfWeek)} to the other working days`"
            @click="copyToOtherWorkingDays(dayOfWeek)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

h3 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 0.9375rem;
  font-weight: 650;
}

.sub {
  margin: 0.125rem 0 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
}

.days {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.day {
  display: grid;
  grid-template-columns: 6rem 1fr auto;
  gap: 0.75rem;
  align-items: start;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--fc-line);
  border-radius: 6px;
  background: var(--fc-surface);
}

.day.off {
  opacity: 0.6;
}

.dname {
  font-size: 0.8125rem;
  padding-top: 0.3125rem;
}

.ranges {
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
  min-width: 0;
}

.not-working {
  margin: 0;
  padding-top: 0.3125rem;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.range {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.dash {
  color: var(--fc-ink-faint);
}

.day-actions {
  display: flex;
  gap: 0.125rem;
  flex-wrap: wrap;
}

/* Native time input: keyboard-friendly, locale-aware, and lighter than a full
   date-picker overlay for "what time do you start". */
@media (max-width: 620px) {
  .day {
    grid-template-columns: 1fr;
    gap: 0.375rem;
  }
}
</style>
