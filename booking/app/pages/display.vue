<script setup lang="ts">
/**
 * The board on the wall.
 *
 * Read from about three metres by someone who has just walked in with their coat on, and
 * never touched. That single fact decides everything here: no controls, no scrolling, no
 * pagination, and a type scale roughly twice the kiosk's.
 *
 * Two questions get asked of this screen and it answers both at once — *is a chair free?*
 * down the left, *where am I?* down the right. Neither shouts, because whichever one you
 * came in with is the one you will look for.
 *
 * When the line is longer than fits, the extra becomes a count rather than a smaller
 * font or a rotating page. Somebody glancing at a wall for two seconds gets one look;
 * shrinking the type to fit eight names means they read none of them, and rotating pages
 * means they read whichever half happened to be up. "+4 more waiting" is honest and
 * legible, which is the whole job.
 *
 * The names are already redacted at the source — `queue:public` carries first name and
 * last initial and no phone number at all, to the `display` room specifically — because
 * this screen faces the entire shop.
 */

definePageMeta({ layout: 'display' });

useHead({ title: 'Queue — Francis Cutz' });

const screen = useDeviceScreen();

/** Client-only: the token lives in localStorage, which does not exist during SSR. */
screen.connect();

onMounted(async () => {
  await screen.loadSettings();
  if (screen.paired.value) await screen.loadBoard();
});

/**
 * A kiosk-paired tablet propped on a shelf would work here — it can read the board — but
 * it is the wrong device and somebody will eventually wonder why nobody can join from
 * the one by the door. Say which screen this is rather than working in a way that hides
 * a setup mistake.
 */
const wrongScreen = computed(
  () => screen.paired.value && screen.deviceType.value === 'KIOSK',
);

// --- The clock ------------------------------------------------------------------

/**
 * Null until mounted, and not out of caution about hydration alone: a clock rendered on
 * the server is wrong by however long the response took, and this one hangs on a wall
 * all day where that is visible.
 */
const now = ref<Date | null>(null);
let tick: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  now.value = new Date();
  // Every ten seconds, not every second — only hours and minutes are shown, and a screen
  // that runs for twelve hours should not wake up 43,200 times to redraw the same digits.
  tick = setInterval(() => {
    now.value = new Date();
  }, 10_000);
});

onUnmounted(() => {
  if (tick !== undefined) clearInterval(tick);
});

/**
 * "Free 8:13 PM" at 8:13 PM is a worse answer than "Free now" — `freeFrom` is the end of
 * the last thing committed to that chair, which for an idle barber is a moment that has
 * already passed. A minute of slack, because the board only redraws every ten seconds.
 */
function chairLabel(freeFrom: string | null): string {
  if (freeFrom === null) return 'Free now';
  const at = new Date(freeFrom).getTime();
  const reference = (now.value ?? new Date()).getTime();
  if (at <= reference + 60_000) return 'Free now';
  return `Free ${screen.clock(freeFrom)}`;
}

const clockLabel = computed(() =>
  now.value === null
    ? ''
    : new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: screen.timezone.value,
      }).format(now.value),
);

// --- The line -------------------------------------------------------------------

/**
 * How many rows fit before the type has to shrink.
 *
 * Measured, not guessed: on a 1080p panel the body has 849px of usable height, the
 * column label takes 61 and the overflow line 69, leaving 719 for rows at a 113px pitch
 * with a 93px last row — six. A seventh needs 901px and pushes the bottom of the queue
 * off the glass. It is a fact about the type scale, so it lives beside the layout rather
 * than in shop settings; changing a font size here means re-measuring this.
 */
const MAX_ROWS = 6;

/** Called first — somebody being called needs to see it more than anyone else. */
const rows = computed(() => [...screen.called.value, ...screen.waiting.value]);

const shown = computed(() => rows.value.slice(0, MAX_ROWS));
const overflow = computed(() => Math.max(0, rows.value.length - MAX_ROWS));
</script>

<template>
  <!-- Unpaired -------------------------------------------------------------- -->
  <div v-if="!screen.paired.value" class="centred">
    <DevicePairing what="wall board" @paired="screen.loadBoard()" />
  </div>

  <!-- Paired as the kiosk ---------------------------------------------------- -->
  <div v-else-if="wrongScreen" class="centred">
    <div class="misplaced">
      <h1>This screen is the kiosk</h1>
      <p>
        It was paired to take walk-ins, not to show them. Open
        <span class="fcb-num">/kiosk</span> on this device, or ask an admin to pair it
        again as a wall board.
      </p>
    </div>
  </div>

  <!-- The board -------------------------------------------------------------- -->
  <template v-else>
    <header class="bar">
      <div class="bar-brand">
        <span class="bar-pole" aria-hidden="true" />
        <span class="bar-name">Francis Cutz</span>
      </div>

      <div class="bar-right">
        <!-- Quiet on purpose. It matters to whoever maintains the screen and to nobody
             standing in front of it, so it is a dot and not a banner. -->
        <span
          class="link"
          :class="{ live: screen.connected.value }"
          :title="screen.connected.value ? 'Live' : 'Reconnecting'"
        >
          <i aria-hidden="true" />
        </span>
        <span class="bar-clock fcb-num">{{ clockLabel }}</span>
      </div>
    </header>

    <main class="body">
      <div class="split">
        <section class="col">
          <p class="col-label">In the Chair</p>

          <!-- Four chairs is where a single column runs out of panel. Past that they
               pair up rather than clip: a queue position can be summarised as "+2 more",
               but a barber who has been left off the board entirely just looks absent. -->
          <div
            v-if="screen.chairs.value.length"
            class="chair-stack"
            :class="{ paired: screen.chairs.value.length > 4 }"
          >
            <article
              v-for="chair in screen.chairs.value"
              :key="chair.barberId"
              class="chair"
              :class="{ busy: Boolean(chair.nowServing) }"
            >
              <span class="chair-who">{{ chair.displayName }}</span>
              <span v-if="chair.nowServing" class="chair-now">{{ chair.nowServing }}</span>
              <span v-else class="chair-now free">{{ chairLabel(chair.freeFrom) }}</span>
            </article>
          </div>

          <p v-else class="quiet">Nobody is cutting right now.</p>
        </section>

        <section class="col">
          <p class="col-label">Next Up</p>

          <!-- Walk-ins off is not the same as nobody waiting, and an empty list would
               read as "no wait" to the one person it misleads most. -->
          <p v-if="!screen.walkInsOpen.value" class="quiet">
            We are not taking walk-ins right now.
          </p>

          <p v-else-if="rows.length === 0" class="quiet">No one in line. Come on in.</p>

          <template v-else>
            <div class="line-stack">
              <article
                v-for="entry in shown"
                :key="entry.id"
                class="row"
                :class="{ called: entry.status === 'CALLED' }"
              >
                <span v-if="entry.status === 'CALLED'" class="pos">NOW</span>
                <span v-else class="pos fcb-num">{{ entry.position }}</span>

                <span class="who">{{ entry.displayName }}</span>

                <span v-if="entry.status === 'CALLED'" class="eta">Come on up</span>
                <span v-else class="eta fcb-num">
                  {{ screen.waitLabel(entry.estimatedWaitMinutes) }}
                </span>
              </article>
            </div>

            <p v-if="overflow" class="more fcb-num">
              + {{ overflow }} more waiting
            </p>
          </template>
        </section>
      </div>
    </main>
  </template>
</template>

<style scoped>
/*
 * Every size on this screen is a multiple of `--u`, set by the layout. Nothing here is in
 * rem: rem is a reading-distance unit and this is a room-distance screen.
 */

/* --- Pairing and setup mistakes ------------------------------------------------ */

/* Both are held at ordinary sizes — somebody is standing at the screen with a code in
   their hand, not reading them from the door. */
.centred {
  flex: 1;
  display: flex;
  padding: 2rem;
  min-height: 0;
}

.misplaced {
  margin: auto;
  max-width: 32rem;
  text-align: center;
}

.misplaced h1 {
  margin: 0 0 0.75rem;
  font-family: var(--fcb-font-display);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.misplaced p {
  margin: 0;
  color: var(--fcb-rail-muted);
  font-size: 1.0625rem;
}

/* --- The bar -------------------------------------------------------------------- */

.bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(2.2 * var(--u)) calc(3 * var(--u));
  border-bottom: 1px solid var(--fcb-rail-line);
}

.bar-brand {
  display: flex;
  align-items: center;
  gap: calc(1.2 * var(--u));
}

.bar-pole {
  width: calc(0.9 * var(--u));
  height: calc(2.6 * var(--u));
  border-radius: 1px;
  flex: none;
  background: repeating-linear-gradient(
    -45deg,
    var(--fcb-accent) 0 calc(0.45 * var(--u)),
    var(--fcb-rail) calc(0.45 * var(--u)) calc(0.9 * var(--u))
  );
}

.bar-name {
  font-family: var(--fcb-font-display);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.2em;
  font-size: calc(1.5 * var(--u));
}

.bar-right {
  display: flex;
  align-items: center;
  gap: calc(1.6 * var(--u));
}

.link i {
  display: block;
  width: calc(0.7 * var(--u));
  height: calc(0.7 * var(--u));
  border-radius: 50%;
  background: var(--fcb-rail-line);
}

.link.live i {
  background: var(--fcb-accent);
}

.bar-clock {
  font-family: var(--fcb-font-display);
  font-size: calc(2.4 * var(--u));
  font-weight: 700;
  color: var(--fcb-rail-muted);
  line-height: 1;
}

/* --- The two columns ------------------------------------------------------------ */

.body {
  flex: 1;
  min-height: 0;
  padding: calc(2.5 * var(--u)) calc(3 * var(--u));
}

/* Chairs are a fixed share rather than auto: the left column must not resize every time
   a name in the right one gets longer. A board that reflows as the queue moves is the
   one thing a wall screen must never do. */
.split {
  display: grid;
  grid-template-columns: 38% 1fr;
  gap: calc(3 * var(--u));
  height: 100%;
}

.col {
  min-width: 0;
}

.col-label {
  margin: 0 0 calc(1.4 * var(--u));
  font-size: calc(1.1 * var(--u));
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fcb-rail-muted);
  font-weight: 600;
}

.quiet {
  margin: 0;
  color: var(--fcb-rail-muted);
  font-size: calc(1.8 * var(--u));
}

/* --- Chairs --------------------------------------------------------------------- */

.chair-stack {
  display: grid;
  gap: calc(1.2 * var(--u));
}

.chair-stack.paired {
  grid-template-columns: 1fr 1fr;
}

.chair {
  border: 1px solid var(--fcb-rail-line);
  border-radius: calc(1 * var(--u));
  background: var(--fcb-rail-raised);
  padding: calc(1.4 * var(--u)) calc(1.8 * var(--u));
  display: flex;
  flex-direction: column;
  gap: calc(0.3 * var(--u));
  min-width: 0;
}

/* Brass marks occupied, not free — the eye should land on where the shop is busy. */
.chair.busy {
  border-color: var(--fcb-accent);
  background: var(--fcb-accent-wash);
}

.chair-who {
  font-size: calc(1.1 * var(--u));
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fcb-rail-muted);
}

.chair-now {
  font-family: var(--fcb-font-display);
  font-size: calc(2.6 * var(--u));
  font-weight: 650;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chair-now.free {
  color: var(--fcb-accent);
  font-size: calc(2.2 * var(--u));
}

/* --- The line ------------------------------------------------------------------- */

.line-stack {
  display: flex;
  flex-direction: column;
  gap: calc(1 * var(--u));
}

.row {
  display: grid;
  grid-template-columns: calc(4 * var(--u)) 1fr auto;
  gap: calc(1.6 * var(--u));
  align-items: center;
  border-bottom: 1px solid var(--fcb-rail-line);
  padding-bottom: calc(1 * var(--u));
  min-width: 0;
}

.row:last-of-type {
  border-bottom: none;
}

.pos {
  font-family: var(--fcb-font-display);
  font-size: calc(2.6 * var(--u));
  font-weight: 700;
  color: var(--fcb-rail-muted);
  text-align: center;
  line-height: 1;
}

.row.called .pos {
  font-size: calc(1.4 * var(--u));
  color: var(--fcb-accent);
}

.who {
  font-size: calc(2.4 * var(--u));
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.called .who {
  color: var(--fcb-accent);
}

.eta {
  font-size: calc(1.8 * var(--u));
  color: var(--fcb-rail-muted);
  white-space: nowrap;
}

.row.called .eta {
  color: var(--fcb-accent);
  font-weight: 650;
}

.more {
  margin: calc(1.2 * var(--u)) 0 0;
  color: var(--fcb-rail-muted);
  font-size: calc(1.5 * var(--u));
}
</style>
