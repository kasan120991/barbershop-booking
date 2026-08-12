<script setup lang="ts">
/**
 * The tablet by the door.
 *
 * Three screens in one page: the front door, joining, and a confirmation that takes
 * itself away.
 *
 * The front door is deliberately not a queue board. The wall display already answers
 * *who is in the chair* and *who is next*, at twice this type size, to the same room —
 * repeating it here bought a second copy of a screen you can see from the same spot, and
 * cost the one thing only this tablet can do. So it answers the other question, *how do
 * I get in line*, with three things: the shop, one figure, one button.
 *
 * That figure is the shop's next opening rather than anybody's quoted wait, and the
 * server computes it — see `walkUp` in the queue estimator. Nothing on the board could
 * answer it: `freeFrom` is measured before the waiting line is allocated and would read
 * "free now" to somebody standing beside four people who are waiting.
 *
 * Everything here is sized for a glance from standing height and a tap with a thumb.
 * Nothing is a table.
 *
 * The confirmation returns on its own after twenty seconds, and the form gives up after
 * ninety. An unattended screen must never be left showing the last person's name and
 * number to whoever walks up next.
 */

import { formatCents, formatDuration, joinQueueRequestSchema } from '@francis/shared';

definePageMeta({ layout: 'kiosk' });

useHead({ title: 'Join the queue — Francis Cutz' });

const kiosk = useKiosk();
const recognise = useRecognise();

/** Client-only: the token lives in localStorage, which does not exist during SSR. */
kiosk.connect();

type Screen = 'board' | 'join' | 'done';
const screen = ref<Screen>('board');

/**
 * A screen paired as the wall board is not a kiosk and never will be — `POST /queue`
 * refuses a `DISPLAY` device outright. Saying so here, before anything else renders, is
 * the whole point of keeping the type: without it this page pairs, loads the menu, draws
 * the board and runs the entire join flow, then fails with a 403 *after* somebody has
 * typed their phone number in. Setup mistakes should look like setup mistakes.
 */
const wrongScreen = computed(() => kiosk.paired.value && kiosk.deviceType.value === 'DISPLAY');

const form = reactive({
  firstName: '',
  lastName: '',
  phone: '',
  serviceIds: [] as string[],
  barberId: null as string | null,
});
const joining = ref(false);
const joinError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string[]>>({});
const joinedId = ref<string | null>(null);

onMounted(async () => {
  await kiosk.loadOptions();
  if (kiosk.paired.value) await kiosk.loadBoard();
});

// --- The front door ---------------------------------------------------------------

// `waitLabel` is the shared screen's, so this tablet and the wall board cannot come to
// different answers about the same person while facing each other across the room. The
// board's own vocabulary — chairs, positions, the line — is gone from this page on
// purpose; the wall says all of it, larger, to the same room.
const { waitLabel } = kiosk;

/**
 * The line under the figure.
 *
 * Never "0 people ahead of you", and never a reassurance the figure above it contradicts:
 * when there is no opening left at all, there is nothing encouraging to say, so it says
 * nothing rather than inviting somebody in under a heading that just turned them away.
 */
const doorSub = computed(() => {
  const ahead = kiosk.aheadLabel.value;
  if (ahead !== null) return ahead;
  return (kiosk.walkUp.value?.waitMinutes ?? null) === null ? null : 'Come on in.';
});

// --- Joining --------------------------------------------------------------------

function clearForm() {
  Object.assign(form, {
    firstName: '',
    lastName: '',
    phone: '',
    serviceIds: [],
    barberId: null,
  });
  joinError.value = null;
  fieldErrors.value = {};
}

function startJoin() {
  clearForm();
  screen.value = 'join';
  touchIdleTimer();
}

/**
 * The join screen gives up on its own, the same way the confirmation does.
 *
 * The case it covers is the worse of the two: somebody starts typing, gets called over to
 * the chair or simply walks off, and a first name and half a phone number sit on a screen
 * by the door until the next person picks it up. The confirmation already clears itself
 * after twenty seconds for exactly this reason and this is the only other place the tablet
 * holds anybody's details — but it was the one left standing.
 *
 * Ninety seconds because the form is read as well as filled: choosing between services and
 * barbers is a real pause, and a screen that wipes a half-typed number while somebody is
 * deciding is its own failure.
 */
const IDLE_SECONDS = 90;
let idle: ReturnType<typeof setTimeout> | undefined;

function stopIdleTimer() {
  if (idle !== undefined) clearTimeout(idle);
  idle = undefined;
}

/** Called on any touch, key or field change inside the form — all three bubble. */
function touchIdleTimer() {
  stopIdleTimer();
  idle = setTimeout(() => {
    clearForm();
    backToBoard();
  }, IDLE_SECONDS * 1000);
}

const availableBarbers = computed(() => kiosk.eligibleBarbers(form.serviceIds));

// A barber who was valid a moment ago may not do the service just added.
watch(
  () => form.serviceIds.slice(),
  () => {
    if (form.barberId === null) return;
    if (!availableBarbers.value.some((barber) => barber.id === form.barberId)) {
      form.barberId = null;
    }
  },
);

const totals = computed(() => {
  const chosen = kiosk.walkInServices.value.filter((service) =>
    form.serviceIds.includes(service.id),
  );
  return {
    minutes: chosen.reduce((sum, service) => sum + service.durationMinutes, 0),
    cents: chosen.reduce((sum, service) => sum + service.priceCents, 0),
  };
});

/** Both halves together — see the note in `useRecognise`. */
watch(
  () => [form.phone, form.firstName] as const,
  ([phone, firstName]) => recognise.check(phone, firstName),
);

async function onJoin() {
  if (joining.value) return;
  joinError.value = null;
  fieldErrors.value = {};

  // The same schema the server parses with, so the two cannot disagree about what is
  // required.
  const parsed = joinQueueRequestSchema.safeParse({
    phone: form.phone,
    firstName: form.firstName,
    lastName: form.lastName.trim() || null,
    barberId: form.barberId,
    serviceIds: form.serviceIds,
  });

  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return;
  }

  joining.value = true;
  try {
    const result = await kiosk.join({
      phone: parsed.data.phone,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName ?? null,
      barberId: parsed.data.barberId ?? null,
      serviceIds: parsed.data.serviceIds,
    });
    joinedId.value = result.entryId;
    stopIdleTimer();
    screen.value = 'done';
    startReturnCountdown();
  } catch (error) {
    const failure = toApiFailure(error);
    if (failure.status === 401) {
      // Revoked mid-use. The layout falls back to pairing on its own.
      kiosk.forgetToken();
      return;
    }
    joinError.value = failure.message;
  } finally {
    joining.value = false;
  }
}

// --- The confirmation, and getting rid of it ------------------------------------

const RETURN_SECONDS = 20;
const secondsLeft = ref(RETURN_SECONDS);
let countdown: ReturnType<typeof setInterval> | undefined;

function startReturnCountdown() {
  secondsLeft.value = RETURN_SECONDS;
  if (countdown !== undefined) clearInterval(countdown);
  countdown = setInterval(() => {
    secondsLeft.value -= 1;
    if (secondsLeft.value <= 0) backToBoard();
  }, 1000);
}

function backToBoard() {
  if (countdown !== undefined) clearInterval(countdown);
  countdown = undefined;
  stopIdleTimer();
  joinedId.value = null;
  // A greeting left standing is the last person's name on a shared screen.
  recognise.reset();
  screen.value = 'board';
}

onUnmounted(() => {
  if (countdown !== undefined) clearInterval(countdown);
  stopIdleTimer();
});

/** Their own row on the board, so the number shown is the one everyone else sees. */
const myEntry = computed(
  () => kiosk.board.value?.entries.find((entry) => entry.id === joinedId.value) ?? null,
);
</script>

<template>
  <!-- Unpaired ------------------------------------------------------------- -->
  <DevicePairing v-if="!kiosk.paired.value" what="kiosk" @paired="kiosk.loadBoard()" />

  <!-- Paired as the wall board ---------------------------------------------- -->
  <section v-else-if="wrongScreen" class="misplaced">
    <h1>This screen is the wall board</h1>
    <p class="lede">
      It was paired to show the queue, not to join it. Open <span class="fcb-num">/display</span>
      on this device, or ask an admin to pair it again as a kiosk.
    </p>
  </section>

  <!-- The front door --------------------------------------------------------
       The shop on one side, the question and the way in on the other. A wide
       screen is not a tall one with more air, so this is a row until the glass
       stops being wider than it is high. -->
  <section v-else-if="screen === 'board'" class="door">
    <div class="door-brand">
      <span class="door-pole" aria-hidden="true" />
      <!-- The shop's name is this screen's heading; the other two states have their
           own, and a page with none reads as a fragment to anything but an eye. -->
      <h1 class="door-word">Francis Cutz</h1>
    </div>

    <div class="door-ask">
      <p v-if="!kiosk.walkInsOpen.value" class="door-closed">
        We are not taking walk-ins right now.
      </p>

      <template v-else>
        <div class="door-wait">
          <span class="door-label">Next Opening</span>
          <!-- The shop's next opening, not this person's wait — they have not chosen a
               service yet. Their own quote is made when they do. -->
          <span class="door-figure fcb-num">{{ kiosk.nextOpeningLabel.value }}</span>
          <span v-if="doorSub" class="door-sub">{{ doorSub }}</span>
        </div>

        <Button label="Join the Queue" class="door-join" @click="startJoin" />
      </template>
    </div>
  </section>

  <!-- Joining -------------------------------------------------------------- -->
  <!--
    Any of the three resets the clock, and all three bubble, so one listener on the
    section covers every field and option button inside it without threading a handler
    through each one.
  -->
  <section
    v-else-if="screen === 'join'"
    class="join"
    @pointerdown="touchIdleTimer"
    @keydown="touchIdleTimer"
    @input="touchIdleTimer"
  >
    <header class="join-head">
      <Button label="Back" severity="secondary" variant="text" @click="backToBoard" />
      <h1>Join the queue</h1>
    </header>

    <div class="field">
      <span class="fcb-label">What are you having?</span>
      <div class="options">
        <button
          v-for="service in kiosk.walkInServices.value"
          :key="service.id"
          type="button"
          class="option"
          :class="{ on: form.serviceIds.includes(service.id) }"
          @click="
            form.serviceIds = form.serviceIds.includes(service.id)
              ? form.serviceIds.filter((id) => id !== service.id)
              : [...form.serviceIds, service.id]
          "
        >
          <span class="o-name">{{ service.name }}</span>
          <span class="o-meta fcb-num">{{ formatDuration(service.durationMinutes) }}</span>
        </button>
      </div>
      <p v-if="fieldErrors.serviceIds" class="err">{{ fieldErrors.serviceIds[0] }}</p>
    </div>

    <div v-if="form.serviceIds.length" class="field">
      <span class="fcb-label">With who?</span>
      <div class="options">
        <button
          type="button"
          class="option"
          :class="{ on: form.barberId === null }"
          @click="form.barberId = null"
        >
          <span class="o-name">Anyone</span>
          <span class="o-meta">Shortest wait</span>
        </button>
        <button
          v-for="barber in availableBarbers"
          :key="barber.id"
          type="button"
          class="option"
          :class="{ on: form.barberId === barber.id }"
          @click="form.barberId = barber.id"
        >
          <span class="o-name">{{ barber.displayName }}</span>
        </button>
      </div>
    </div>

    <div class="field">
      <label for="k-phone" class="fcb-label">Mobile number</label>
      <!--
        `auto-clear` off matters more here than anywhere: on a tablet somebody types
        half a number, taps a service to check the price, and the default would wipe
        the field while they were looking away. `unmask` keeps the model to ten digits.
      -->
      <InputMask
        id="k-phone"
        v-model="form.phone"
        class="big fcb-num"
        mask="(999) 999-9999"
        :auto-clear="false"
        unmask
        type="tel"
        inputmode="tel"
        autocomplete="off"
        placeholder="(415) 555-0123"
        :invalid="Boolean(fieldErrors.phone)"
        fluid
      />
      <p v-if="fieldErrors.phone" class="err">{{ fieldErrors.phone[0] }}</p>
      <p v-else class="hint">So we can find you if you step out.</p>
    </div>

    <div class="field">
      <label for="k-first" class="fcb-label">Your name</label>
      <InputText
        id="k-first"
        v-model="form.firstName"
        class="big"
        autocomplete="off"
        :invalid="Boolean(fieldErrors.firstName)"
        fluid
      />
      <p v-if="fieldErrors.firstName" class="err">{{ fieldErrors.firstName[0] }}</p>
      <p v-else-if="recognise.recognised.value" class="hint welcome">
        Welcome back, {{ form.firstName.trim() }}.
      </p>
    </div>

    <!-- Recognised, so the rest is on file. Nothing about who they are came back over
         the wire to work that out — only that the number and the name matched. -->
    <p v-if="recognise.recognised.value" class="known">
      We already have the rest — no need to type your last name.
    </p>

    <div v-else class="field">
      <label for="k-last" class="fcb-label">Last name</label>
      <InputText id="k-last" v-model="form.lastName" class="big" autocomplete="off" fluid />
      <p class="hint">Only the initial is shown.</p>
    </div>

    <Message v-if="joinError" severity="error" :closable="false">{{ joinError }}</Message>

    <div class="join-foot">
      <p v-if="totals.minutes" class="totals fcb-num">
        {{ formatDuration(totals.minutes) }} · {{ formatCents(totals.cents) }} to pay after
      </p>
      <Button label="Join" size="large" :loading="joining" @click="onJoin" />
    </div>
  </section>

  <!-- Done ------------------------------------------------------------------ -->
  <section v-else class="done">
    <h1>You're in the queue</h1>

    <div v-if="myEntry" class="place">
      <span class="place-num fcb-num">{{ myEntry.position }}</span>
      <span class="place-label">in line</span>
      <span class="place-eta fcb-num">{{ waitLabel(myEntry.estimatedWaitMinutes) }}</span>
      <span v-if="myEntry.barberName" class="place-with">with {{ myEntry.barberName }}</span>
    </div>

    <p class="lede">
      Have a seat — we will call your name. There is nothing to pay until after your cut.
    </p>

    <div class="done-foot">
      <Button label="Done" size="large" @click="backToBoard" />
      <span class="countdown fcb-num">Back to the board in {{ secondsLeft }}s</span>
    </div>
  </section>
</template>

<style scoped>
/*
 * Everything here is one or two sizes larger than the rest of the app. The tablet is
 * read standing up, at arm's length, often by someone who has not taken their coat off.
 */

h1 {
  margin: 0;
  font-family: var(--fcb-font-display);
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.lede {
  margin: 0.375rem 0 0;
  color: var(--fcb-rail-muted);
  font-size: 1.0625rem;
}

.fcb-label {
  color: var(--fcb-rail-muted);
}

.err {
  margin: 0.375rem 0 0;
  color: #eab8b3;
  font-size: 0.9375rem;
}

.hint {
  margin: 0.375rem 0 0;
  color: var(--fcb-rail-muted);
  font-size: 0.875rem;
}

/* The greeting, and the box that replaces the last-name field once it is not needed. */
.hint.welcome {
  color: var(--fcb-accent);
  font-weight: 600;
}

.known {
  margin: 0;
  border: 1px dashed var(--fcb-rail-line, var(--fcb-line));
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  font-size: 0.9375rem;
  color: var(--fcb-rail-muted, var(--fcb-ink-faint));
}

/* --- Wrong screen ------------------------------------------------------------ */

.misplaced {
  margin: auto;
  max-width: 32rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  text-align: center;
}

/* --- The front door ----------------------------------------------------------
 *
 * Sized in `vmin` clamps rather than the rem the rest of this page uses. The join
 * form is filled in at arm's length with a thumb on the glass; this is read on the
 * way past, and it has to hold its proportions on whatever the shop mounts. `vmin`
 * is the short edge whichever way the tablet stands, which is what stops a wide
 * panel rendering type sized for its width — the same reasoning behind the wall
 * display's `--u`, one screen closer.
 */

.door {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: clamp(2rem, 7vmin, 5rem);
}

.door-brand {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: clamp(0.75rem, 2.5vmin, 1.75rem);
  min-width: 0;
}

/* The pole from `main.css` at hero scale. Not the shared class: that one is fixed
   at 0.5rem and is worn by the top bar of this very screen. */
.door-pole {
  width: clamp(0.7rem, 2.2vmin, 1.5rem);
  height: clamp(2.2rem, 7vmin, 4.75rem);
  border-radius: 2px;
  flex: none;
  background: repeating-linear-gradient(
    -45deg,
    var(--fcb-accent) 0 clamp(0.35rem, 1.1vmin, 0.75rem),
    var(--fcb-rail-raised) clamp(0.35rem, 1.1vmin, 0.75rem) clamp(0.7rem, 2.2vmin, 1.5rem)
  );
}

.door-word {
  font-family: var(--fcb-font-display);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.22em;
  line-height: 1.05;
  font-size: clamp(1.5rem, 5vmin, 3.25rem);
}

.door-ask {
  flex: 1.15;
  display: flex;
  flex-direction: column;
  gap: clamp(1.5rem, 5vmin, 3.5rem);
  min-width: 0;
}

.door-wait {
  display: flex;
  flex-direction: column;
  gap: clamp(0.35rem, 1.2vmin, 0.75rem);
  min-width: 0;
}

.door-label {
  font-size: clamp(0.75rem, 1.6vmin, 1.0625rem);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--fcb-rail-muted);
}

.door-figure {
  font-family: var(--fcb-font-display);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 0.98;
  font-size: clamp(2.25rem, 9vmin, 6rem);
  text-wrap: balance;
}

.door-sub {
  font-size: clamp(1rem, 2.4vmin, 1.625rem);
  color: var(--fcb-rail-muted);
  line-height: 1.3;
}

/* The only thing there is to do on this screen, and it looks like it. */
.door-join {
  width: 100%;
  justify-content: center;
  font-size: clamp(1.25rem, 3.4vmin, 2.25rem);
  font-weight: 700;
  padding-block: clamp(0.9rem, 3.2vmin, 2rem);
  border-radius: clamp(0.75rem, 2vmin, 1.25rem);
}

.door-closed {
  margin: 0;
  border: 1px dashed var(--fcb-rail-line);
  border-radius: clamp(0.75rem, 2vmin, 1.25rem);
  padding: clamp(1.5rem, 5vmin, 3rem) clamp(1rem, 3vmin, 2rem);
  text-align: center;
  color: var(--fcb-rail-muted);
  font-size: clamp(1rem, 2.4vmin, 1.625rem);
  line-height: 1.45;
}

/*
 * Taller than it is wide — a tablet turned upright, or a narrow window. The row
 * would divide that into two columns of nothing, so it stacks and centres.
 */
@media (max-aspect-ratio: 1 / 1) {
  .door {
    flex-direction: column;
    justify-content: center;
    text-align: center;
    gap: clamp(2rem, 6vmin, 4rem);
  }

  .door-brand,
  .door-ask {
    flex: none;
    width: 100%;
    align-items: center;
  }

  .door-wait {
    align-items: center;
  }
}

/* --- Join ------------------------------------------------------------------- */

.join {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 46rem;
  width: 100%;
  margin-inline: auto;
}

.join-head {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.625rem;
}

/* Big enough for a thumb, which is the only pointer this screen has. */
.option {
  font: inherit;
  cursor: pointer;
  text-align: left;
  border: 1px solid var(--fcb-rail-line);
  border-radius: 12px;
  background: var(--fcb-rail-raised);
  color: inherit;
  padding: 0.875rem 1rem;
  min-height: 3.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.option.on {
  border-color: var(--fcb-accent);
  background: rgba(212, 162, 76, 0.14);
}

.o-name {
  font-size: 1.0625rem;
  font-weight: 600;
}

.o-meta {
  font-size: 0.875rem;
  color: var(--fcb-rail-muted);
}

.big :deep(input),
.big {
  font-size: 1.25rem;
  padding-block: 0.75rem;
}

.join-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.totals {
  margin: 0;
  color: var(--fcb-rail-muted);
  font-size: 1rem;
}

/* --- Done ------------------------------------------------------------------- */

.done {
  margin: auto;
  max-width: 32rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  text-align: center;
}

.place {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--fcb-accent);
  border-radius: 16px;
  background: rgba(212, 162, 76, 0.12);
  padding: 2rem 3rem;
}

.place-num {
  font-family: var(--fcb-font-display);
  font-size: 4rem;
  font-weight: 800;
  line-height: 1;
  color: var(--fcb-accent);
}

.place-label {
  font-size: 0.8125rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fcb-rail-muted);
}

.place-eta {
  font-size: 1.25rem;
  font-weight: 600;
  margin-top: 0.5rem;
}

.place-with {
  color: var(--fcb-rail-muted);
}

.done-foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.625rem;
}

.countdown {
  font-size: 0.875rem;
  color: var(--fcb-rail-muted);
}

@media (max-width: 620px) {
  .row-2 {
    grid-template-columns: 1fr;
  }
}
</style>
