<script setup lang="ts">
/**
 * The time-grid primitive — a vertical axis with blocks positioned by minutes.
 *
 * Knows minutes, not timezones: `useCalendarColumns` converts instants to
 * minutes-of-day before anything arrives here, so this component never touches a
 * Date. The two calendar views are this primitive worn two ways — seven days for
 * one barber on `/my-day`, one day across every chair on `/calendar` — differing
 * only in what a column means, which is why the header and footer are slots.
 *
 * The look is the picked mockup variant: the column ground is absence, working
 * time reads as a lit slab (a split shift is literally two slabs with a gap),
 * hour lines live inside the slabs, and the now-line draws only inside a working
 * column rather than across the gutter.
 */

import type { TimeGridBlock, TimeGridColumn } from '~/composables/useCalendarColumns';

const props = withDefaults(
  defineProps<{
    columns: TimeGridColumn[];
    startMinute: number;
    endMinute: number;
    /** Pixels per minute. The default keeps a 30-minute cut two readable lines tall. */
    minuteHeight?: number;
    /** Shop-local minutes past midnight, or null to draw no now-line. */
    nowMinute?: number | null;
    /** Columns navigate somewhere — headers and blocks render as buttons. */
    interactive?: boolean;
  }>(),
  { minuteHeight: 1.2, nowMinute: null, interactive: false },
);

const emit = defineEmits<{
  (event: 'column-click', column: TimeGridColumn): void;
  (event: 'block-click', block: TimeGridBlock): void;
}>();

const HOUR = 60;

const gridTemplate = computed(() => ({
  gridTemplateColumns: `3.25rem repeat(${String(props.columns.length)}, minmax(0, 1fr))`,
}));

const trackHeight = computed(() => (props.endMinute - props.startMinute) * props.minuteHeight);

const y = (minute: number) => (minute - props.startMinute) * props.minuteHeight;

const hourMarks = computed(() => {
  const marks: number[] = [];
  for (
    let minute = Math.ceil(props.startMinute / HOUR) * HOUR;
    minute <= props.endMinute;
    minute += HOUR
  ) {
    marks.push(minute);
  }
  return marks;
});

function hourLabel(minute: number): string {
  const hour = Math.floor(minute / 60) % 24;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Hour lines are a background on each slab, offset so they align to the global hours. */
function slabStyle(span: { startMinute: number; endMinute: number }) {
  const mh = props.minuteHeight;
  return {
    top: `${String(y(span.startMinute))}px`,
    height: `${String((span.endMinute - span.startMinute) * mh)}px`,
    backgroundSize: `100% ${String(HOUR * mh)}px`,
    backgroundPosition: `0 ${String(((HOUR - (span.startMinute % HOUR)) % HOUR) * mh)}px`,
  };
}

function blockStyle(block: TimeGridBlock) {
  return {
    top: `${String(y(block.startMinute))}px`,
    height: `${String(Math.max((block.endMinute - block.startMinute) * props.minuteHeight - 2, 16))}px`,
    left: `calc(${String((block.lane / block.laneCount) * 100)}% + 2px)`,
    width: `calc(${String((1 / block.laneCount) * 100)}% - 4px)`,
  };
}

function blockClass(block: TimeGridBlock) {
  const { status, projected, moving } = block.data;
  return {
    'b-projected': moving,
    'b-void': block.kind === 'void',
    'b-live': status === 'IN_PROGRESS' || (projected && status === 'IN_CHAIR'),
    'b-called': projected && status === 'CALLED',
    'b-done': status === 'COMPLETED',
  };
}

/** Room for the second line — below this the card clips to its first line cleanly. */
const showDetail = (block: TimeGridBlock) =>
  (block.endMinute - block.startMinute) * props.minuteHeight >= 34;

const showNow = (column: TimeGridColumn) =>
  props.nowMinute !== null &&
  column.today &&
  column.working.length > 0 &&
  props.nowMinute >= props.startMinute &&
  props.nowMinute <= props.endMinute;
</script>

<template>
  <div class="timegrid">
    <div class="ghead" :style="gridTemplate">
      <div aria-hidden="true" />
      <!-- Explicit branches, not `<component :is>`: a string 'button' there resolves
           to PrimeVue's globally registered Button, which restyles every block. -->
      <template v-for="column in columns" :key="column.key">
        <button
          v-if="interactive"
          type="button"
          class="chead"
          @click="emit('column-click', column)"
        >
          <slot name="head" :column="column" />
        </button>
        <div v-else class="chead">
          <slot name="head" :column="column" />
        </div>
      </template>
    </div>

    <div class="track" :style="gridTemplate">
      <div class="gutter" :style="{ height: `${trackHeight}px` }">
        <span
          v-for="minute in hourMarks"
          :key="minute"
          class="glabel"
          :style="{ top: `${y(minute)}px` }"
        >
          {{ hourLabel(minute) }}
        </span>
      </div>

      <div
        v-for="column in columns"
        :key="column.key"
        class="col"
        :style="{ height: `${trackHeight}px` }"
      >
        <div
          v-for="(span, index) in column.working"
          :key="index"
          class="slab"
          :style="slabStyle(span)"
        />

        <p v-if="column.working.length === 0 && column.reason" class="reason">
          {{ column.reason }}
        </p>

        <template v-for="block in column.blocks" :key="block.key">
          <button
            v-if="interactive"
            type="button"
            class="blk"
            :class="blockClass(block)"
            :style="blockStyle(block)"
            @click="emit('block-click', block)"
          >
            <CalendarBlock :data="block.data" :show-detail="showDetail(block)" />
          </button>
          <div v-else class="blk" :class="blockClass(block)" :style="blockStyle(block)">
            <CalendarBlock :data="block.data" :show-detail="showDetail(block)" />
          </div>
        </template>

        <div v-if="showNow(column)" class="nowline" :style="{ top: `${y(nowMinute!)}px` }" />
      </div>
    </div>

    <div v-if="$slots.foot" class="gfoot" :style="gridTemplate">
      <div aria-hidden="true" />
      <div v-for="column in columns" :key="column.key" class="cfoot">
        <slot name="foot" :column="column" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.timegrid {
  min-width: 0;
}

.ghead,
.track,
.gfoot {
  display: grid;
  gap: 0 0.5rem;
}

/* --- headers --- */

.chead {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  min-width: 0;
  padding: 0 2px 0.35rem;
}
button.chead {
  cursor: pointer;
}
button.chead:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
  border-radius: 4px;
}
/* No today styling here on purpose: on the day board every column is today, so
   emphasis is the page's call, made in its header slot. The flag drives the now-line. */

/* --- the axis --- */

.gutter {
  position: relative;
}
.glabel {
  position: absolute;
  right: 6px;
  transform: translateY(-50%);
  font-size: 0.625rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* --- columns: ground is absence, working time is a lit slab --- */

.col {
  position: relative;
  min-width: 0;
}
.slab {
  position: absolute;
  left: 0;
  right: 0;
  background-color: var(--fc-surface);
  border: 1px solid var(--fc-line);
  border-radius: 6px;
  background-image: linear-gradient(
    to bottom,
    var(--fc-line-soft) 0,
    var(--fc-line-soft) 1px,
    transparent 1px
  );
  background-repeat: repeat-y;
}

.reason {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 1rem;
  text-align: center;
  color: var(--fc-ink-faint);
  font-size: 0.75rem;
  font-style: italic;
}

/* --- blocks --- */

.blk {
  position: absolute;
  z-index: 3;
  appearance: none;
  font: inherit;
  text-align: left;
  border: 1px solid var(--fc-line);
  background: var(--fc-input);
  color: var(--fc-ink);
  border-radius: 6px;
  padding: 3px 7px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
button.blk {
  cursor: pointer;
}
.blk:hover {
  border-color: var(--fc-accent);
}
button.blk:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.blk.b-done {
  opacity: 0.62;
}
.blk.b-live {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}
.blk.b-called {
  border-color: var(--fc-accent);
}
/* A projection is drawn as one: dashed, unfilled, never mistakable for a booking. */
.blk.b-projected {
  border-style: dashed;
  background: transparent;
  color: var(--fc-ink-muted);
}
.blk.b-void {
  border-style: dashed;
  opacity: 0.5;
}

/* --- now --- */

.nowline {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--fc-accent);
  z-index: 5;
  pointer-events: none;
}
.nowline::before {
  content: '';
  position: absolute;
  left: -1px;
  top: -2.5px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--fc-accent);
}

/* --- footer row --- */

.gfoot {
  margin-top: 0.4rem;
}
.cfoot {
  min-width: 0;
  padding: 0.3rem 2px 0;
  border-top: 1px solid var(--fc-line-soft);
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
