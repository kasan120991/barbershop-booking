<script setup lang="ts">
/**
 * The tablet by the door.
 *
 * Three screens in one page: the board, joining, and a confirmation that takes itself
 * away. Idle shows the board because that is the question most people walked in with —
 * *how long?* — and answering it before asking anyone for their phone number is the
 * difference between a screen that helps and a form that blocks the door.
 *
 * Everything here is sized for a glance from standing height and a tap with a thumb.
 * Nothing is a table.
 *
 * The confirmation returns on its own after twenty seconds. An unattended screen must
 * never be left showing the last person's name and number to whoever walks up next —
 * and somebody who has just been told "you're fourth, about 40 minutes" has already
 * read everything they needed.
 */

import { joinQueueRequestSchema, publicDisplayName } from '@francis/shared';

definePageMeta({ layout: 'kiosk' });

useHead({ title: 'Join the queue — Francis Cutz' });

const kiosk = useKiosk();

/** Client-only: the token lives in localStorage, which does not exist during SSR. */
kiosk.connect();

type Screen = 'board' | 'join' | 'done';
const screen = ref<Screen>('board');

const pairingCode = ref('');
const pairing = ref(false);
const pairError = ref<string | null>(null);

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

// --- Pairing -------------------------------------------------------------------

async function onPair() {
  if (pairing.value) return;
  pairing.value = true;
  pairError.value = null;

  try {
    await kiosk.pair(pairingCode.value);
    pairingCode.value = '';
    await kiosk.loadBoard();
  } catch (error) {
    // The server distinguishes "not valid", "expired" and "already used" — three
    // different problems, and whoever is holding the tablet needs to know which.
    pairError.value = toApiFailure(error).message;
  } finally {
    pairing.value = false;
  }
}

// --- The board ------------------------------------------------------------------

const waiting = computed(
  () => kiosk.board.value?.entries.filter((entry) => entry.status === 'WAITING') ?? [],
);

const called = computed(
  () => kiosk.board.value?.entries.filter((entry) => entry.status === 'CALLED') ?? [],
);

const chairs = computed(() => kiosk.board.value?.chairs ?? []);

/** The honest headline: the longest anybody currently waiting has been quoted. */
const longestWait = computed(() =>
  waiting.value.reduce(
    (max, entry) => Math.max(max, entry.estimatedWaitMinutes ?? 0),
    0,
  ),
);

function waitLabel(minutes: number | null): string {
  if (minutes === null) return 'Ask at the desk';
  if (minutes < 1) return 'You are up';
  return `about ${String(minutes)} min`;
}

function clock(iso: string | null): string {
  if (iso === null) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: kiosk.timezone.value,
  }).format(new Date(iso));
}

// --- Joining --------------------------------------------------------------------

function startJoin() {
  Object.assign(form, {
    firstName: '',
    lastName: '',
    phone: '',
    serviceIds: [],
    barberId: null,
  });
  joinError.value = null;
  fieldErrors.value = {};
  screen.value = 'join';
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
  joinedId.value = null;
  screen.value = 'board';
}

onUnmounted(() => {
  if (countdown !== undefined) clearInterval(countdown);
});

/** Their own row on the board, so the number shown is the one everyone else sees. */
const myEntry = computed(
  () => kiosk.board.value?.entries.find((entry) => entry.id === joinedId.value) ?? null,
);
</script>

<template>
  <!-- Unpaired ------------------------------------------------------------- -->
  <section v-if="!kiosk.paired.value" class="pair">
    <h1>Set this screen up</h1>
    <p class="lede">
      Ask an admin to add a screen in the staff app, then type the code here. It is only
      needed once.
    </p>

    <div class="pair-form">
      <InputText
        v-model="pairingCode"
        class="code-input fcb-num"
        inputmode="numeric"
        autocomplete="off"
        placeholder="0000-0000"
        aria-label="Pairing code"
        @keyup.enter="onPair"
      />
      <Button label="Pair" size="large" :loading="pairing" @click="onPair" />
    </div>

    <Message v-if="pairError" severity="error" :closable="false">{{ pairError }}</Message>
  </section>

  <!-- The board ------------------------------------------------------------ -->
  <section v-else-if="screen === 'board'" class="board">
    <header class="board-head">
      <div>
        <h1>Walk-ins</h1>
        <p class="lede">
          <template v-if="!kiosk.walkInsOpen.value">
            We are not taking walk-ins right now.
          </template>
          <template v-else-if="waiting.length === 0">
            Nobody is waiting. Come on in.
          </template>
          <template v-else>
            {{ waiting.length }} {{ waiting.length === 1 ? 'person' : 'people' }} waiting ·
            longest about {{ longestWait }} min
          </template>
        </p>
      </div>

      <Button
        v-if="kiosk.walkInsOpen.value"
        label="Join the Queue"
        size="large"
        @click="startJoin"
      />
    </header>

    <div v-if="chairs.length" class="chairs">
      <article v-for="chair in chairs" :key="chair.barberId" class="chair">
        <span class="chair-name">{{ chair.displayName }}</span>
        <span v-if="chair.nowServing" class="chair-now">{{ chair.nowServing }}</span>
        <span v-else class="chair-now free">Free</span>
        <span class="chair-meta">
          <template v-if="chair.nowServing">In the chair</template>
          <template v-else-if="chair.freeFrom">Ready {{ clock(chair.freeFrom) }}</template>
          <template v-else>Done for today</template>
        </span>
      </article>
    </div>

    <div v-if="called.length || waiting.length" class="line">
      <article v-for="entry in called" :key="entry.id" class="row called">
        <span class="pos">Now</span>
        <span class="who">{{ entry.displayName }}</span>
        <span class="eta">Come on up</span>
      </article>

      <article v-for="entry in waiting" :key="entry.id" class="row">
        <span class="pos fcb-num">{{ entry.position }}</span>
        <span class="who">
          {{ entry.displayName }}
          <span v-if="entry.barberName" class="with">with {{ entry.barberName }}</span>
        </span>
        <span class="eta fcb-num">{{ waitLabel(entry.estimatedWaitMinutes) }}</span>
      </article>
    </div>

    <p v-else class="empty">No one in line.</p>
  </section>

  <!-- Joining -------------------------------------------------------------- -->
  <section v-else-if="screen === 'join'" class="join">
    <header class="join-head">
      <Button label="Back" severity="secondary" variant="text" @click="screen = 'board'" />
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
          <span class="o-meta fcb-num">{{ service.durationMinutes }} min</span>
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

    <div class="row-2">
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
      </div>
      <div class="field">
        <label for="k-last" class="fcb-label">Last name</label>
        <InputText id="k-last" v-model="form.lastName" class="big" autocomplete="off" fluid />
        <p class="hint">Only the initial is shown.</p>
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

    <Message v-if="joinError" severity="error" :closable="false">{{ joinError }}</Message>

    <div class="join-foot">
      <p v-if="totals.minutes" class="totals fcb-num">
        {{ totals.minutes }} min · {{ (totals.cents / 100).toFixed(2) }} to pay after
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

/* --- Pairing ---------------------------------------------------------------- */

.pair {
  margin: auto;
  max-width: 30rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  text-align: center;
  align-items: center;
}

.pair-form {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
}

.code-input :deep(input),
.code-input {
  font-size: 2rem;
  letter-spacing: 0.18em;
  text-align: center;
  /* Wide enough for "0000-0000" WITH the tracking — at 12ch the placeholder was
     clipped mid-digit, which reads as a broken field rather than a hint. */
  width: 14ch;
}

/* --- Board ------------------------------------------------------------------ */

.board {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.board-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.chairs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem;
}

.chair {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  border: 1px solid var(--fcb-rail-line);
  border-radius: 12px;
  background: var(--fcb-rail-raised);
  padding: 1rem 1.125rem;
  min-width: 0;
}

.chair-name {
  font-size: 0.75rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fcb-rail-muted);
}

.chair-now {
  font-family: var(--fcb-font-display);
  font-size: 1.375rem;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chair-now.free {
  color: var(--fcb-accent);
}

.chair-meta {
  font-size: 0.875rem;
  color: var(--fcb-rail-muted);
}

.line {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: grid;
  grid-template-columns: 3.5rem 1fr auto;
  gap: 1rem;
  align-items: center;
  border: 1px solid var(--fcb-rail-line);
  border-radius: 12px;
  background: var(--fcb-rail-raised);
  padding: 0.875rem 1.125rem;
}

.row.called {
  border-color: var(--fcb-accent);
  background: rgba(212, 162, 76, 0.12);
}

.pos {
  font-family: var(--fcb-font-display);
  font-size: 1.5rem;
  font-weight: 700;
  text-align: center;
  color: var(--fcb-rail-muted);
}

.row.called .pos {
  font-size: 1rem;
  color: var(--fcb-accent);
}

.who {
  font-size: 1.25rem;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.with {
  font-size: 0.9375rem;
  font-weight: 400;
  color: var(--fcb-rail-muted);
  margin-left: 0.5rem;
}

.eta {
  font-size: 1.0625rem;
  color: var(--fcb-rail-muted);
  white-space: nowrap;
}

.row.called .eta {
  color: var(--fcb-accent);
  font-weight: 650;
}

.empty {
  margin: 0;
  border: 1px dashed var(--fcb-rail-line);
  border-radius: 12px;
  padding: 2.5rem 1rem;
  text-align: center;
  color: var(--fcb-rail-muted);
  font-size: 1.0625rem;
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

  .row {
    grid-template-columns: 2.75rem 1fr;
    row-gap: 0.25rem;
  }

  .eta {
    grid-column: 2;
  }
}
</style>
