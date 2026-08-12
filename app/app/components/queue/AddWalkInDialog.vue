<script setup lang="ts">
/**
 * Adding a walk-in at the desk.
 *
 * The same endpoint the kiosk will use, so the rules cannot differ between the two:
 * the price and the duration are computed server-side from the service rows, and the
 * phone number is the client identity — typing a number that already exists reuses
 * that client rather than creating a second one.
 *
 * Barbers are filtered to those who take walk-ins **and** can do everything selected.
 * Picking services first and a barber second is deliberate: the other order lets
 * someone choose a barber and then a service that barber does not perform, and the
 * only honest thing to do at that point is take the choice away again.
 *
 * The number comes before either of them, in `ClientLookupFields`. It is the identity,
 * so knowing it early is what lets the desk be told who is standing there — and told that
 * the number is blocked before, rather than after, the rest of the form is filled in.
 */

import {
  formatCents,
  formatDuration,
  walkInOpeningLabel,
  joinQueueRequestSchema,
  type ServiceDto,
} from '@francis/shared';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const queue = useQueue();
const { notifySuccess, notifyApiFailure } = useNotify();

const form = reactive({
  firstName: '',
  lastName: '',
  phone: '',
  serviceIds: [] as string[],
  barberId: null as string | null,
  notes: '',
});

const saving = ref(false);
const fieldErrors = ref<Record<string, string[]>>({});

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    Object.assign(form, {
      firstName: '',
      lastName: '',
      phone: '',
      serviceIds: [],
      barberId: null,
      notes: '',
    });
    fieldErrors.value = {};
    queue.clearQuote();
    void queue.loadOptions();
  },
);

/**
 * Long enough that Cut then Beard is one question rather than two — the desk picks three
 * services in about a second, and the first two answers are thrown away unread.
 */
const QUOTE_DEBOUNCE_MS = 250;
let quoteTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleQuote() {
  if (quoteTimer !== undefined) clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => void queue.loadQuote(form.serviceIds.slice()), QUOTE_DEBOUNCE_MS);
}

/**
 * The line moved while the dialog was open, so every figure in it did too — somebody
 * joined, or a barber called the next person up.
 */
watch(
  () => queue.board.value?.generatedAt,
  () => {
    if (props.visible && form.serviceIds.length > 0) scheduleQuote();
  },
);

onUnmounted(() => {
  if (quoteTimer !== undefined) clearTimeout(quoteTimer);
});

/**
 * What goes to the right of a barber's name, or nothing.
 *
 * Blank rather than the previous basket's figure whenever the answer on hand was computed
 * for a different one: a stale number is still a wrong number, and on this debounce the
 * gap is a blink.
 */
function waitFor(barberId: string | null): string {
  if (!queue.quoteMatches(form.serviceIds)) return '';
  const minutes =
    barberId === null ? queue.anyoneWait.value : queue.barberWaits.value.get(barberId);
  // No suffix: these sit in a column under a "Barber" label, where the word "wait" is
  // saying what the heading already said. The kiosk's own label adds it — see
  // `walkInOpeningLabel`.
  return walkInOpeningLabel(minutes);
}

/** The menu as it stands today — archived and appointment-only services are not offered. */
const walkInServices = computed(() =>
  queue.services.value.filter((service) => service.isActive && service.bookableWalkIn),
);

const chosen = computed(() =>
  walkInServices.value.filter((service) => form.serviceIds.includes(service.id)),
);

const totalMinutes = computed(() =>
  chosen.value.reduce((total, service) => total + service.durationMinutes, 0),
);
const totalCents = computed(() =>
  chosen.value.reduce((total, service) => total + service.priceCents, 0),
);

const eligibleBarbers = computed(() =>
  queue.barbers.value.filter(
    (barber) =>
      barber.status === 'ACTIVE' &&
      barber.acceptsWalkIns &&
      form.serviceIds.every((serviceId) => barber.serviceIds.includes(serviceId)),
  ),
);


// A barber who was valid a moment ago may not do the service just added, and silently
// booking them anyway would be refused by the server for reasons the form never showed.
watch(
  () => form.serviceIds.slice(),
  () => {
    // The quote is asked for on every change; the barber check below only matters when
    // one is picked. Guarding both behind that early return is how the labels silently
    // never loaded — the dialog opens with no barber chosen, which is the common case.
    scheduleQuote();

    if (form.barberId === null) return;
    if (!eligibleBarbers.value.some((barber) => barber.id === form.barberId)) {
      form.barberId = null;
    }
  },
);

function priceLabel(service: ServiceDto): string {
  return `${service.name} · ${formatDuration(service.durationMinutes)} · ${formatCents(service.priceCents)}`;
}

async function onAdd() {
  if (saving.value) return;
  fieldErrors.value = {};

  const parsed = joinQueueRequestSchema.safeParse({
    phone: form.phone,
    firstName: form.firstName,
    lastName: form.lastName.trim() || null,
    barberId: form.barberId,
    serviceIds: form.serviceIds,
    notes: form.notes.trim() || null,
  });

  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return;
  }

  saving.value = true;
  try {
    await queue.join(parsed.data);
    notifySuccess(`${form.firstName.trim()} added to the queue`);
    emit('update:visible', false);
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="props.visible"
    header="Add Walk-in"
    modal
    :style="{ width: 'min(34rem, 94vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="form">
      <!--
        The number leads, and a known one is confirmed before anything else is typed —
        including whether they are blocked, which used to surface at submit after the
        whole form had been filled in. Shared with the appointment dialog.
      -->
      <ClientLookupFields
        v-model:phone="form.phone"
        v-model:first-name="form.firstName"
        v-model:last-name="form.lastName"
        :field-errors="fieldErrors"
        id-prefix="w"
      />

      <div class="field">
        <label for="w-services" class="fc-label">Services</label>
        <MultiSelect
          id="w-services"
          v-model="form.serviceIds"
          :options="walkInServices"
          :option-label="priceLabel"
          option-value="id"
          display="chip"
          placeholder="Pick at least one"
          :invalid="Boolean(fieldErrors.serviceIds)"
          fluid
        />
        <p v-if="fieldErrors.serviceIds" class="err">{{ fieldErrors.serviceIds[0] }}</p>
        <p v-else-if="chosen.length" class="hint total">
          {{ formatDuration(totalMinutes) }} · {{ formatCents(totalCents) }}
        </p>
        <p v-else class="hint">Appointment-only services are not listed.</p>
      </div>

      <div class="field">
        <span class="fc-label">Barber</span>

        <p v-if="form.serviceIds.length === 0" class="hint no-pick">Pick the services first.</p>

        <!-- Not "Anyone" of nobody: with no capable barber there is nothing to choose
             between, and the join would be refused anyway. -->
        <p v-else-if="eligibleBarbers.length === 0" class="hint no-pick">
          Nobody in today does all of that. Try fewer services.
        </p>

        <div v-else class="picker" role="group" aria-label="Barber">
          <button
            type="button"
            class="pick"
            :class="{ on: form.barberId === null }"
            @click="form.barberId = null"
          >
            <span class="c-name">Anyone</span>
            <span class="c-wait">{{ waitFor(null) }}</span>
          </button>
          <button
            v-for="barber in eligibleBarbers"
            :key="barber.id"
            type="button"
            class="pick"
            :class="{ on: form.barberId === barber.id }"
            @click="form.barberId = barber.id"
          >
            <span class="c-name">{{ barber.displayName }}</span>
            <!-- "Not today" is still selectable: the desk can promise somebody a chair
                 that has nothing left, and the estimator records why rather than refusing. -->
            <span class="c-wait">{{ waitFor(barber.id) }}</span>
          </button>
        </div>

        <p v-if="form.serviceIds.length > 0 && eligibleBarbers.length > 0" class="hint">
          <template v-if="form.barberId === null">
            Whoever is free first — usually the shortest wait.
          </template>
          <template v-else>They will wait for this chair, however long it takes.</template>
        </p>
      </div>

      <div class="field">
        <label for="w-notes" class="fc-label">Notes</label>
        <InputText id="w-notes" v-model="form.notes" placeholder="Number 2 on the sides" fluid />
        <p class="hint">Staff only. Never shown on the kiosk or the wall display.</p>
      </div>
    </div>

    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        variant="text"
        @click="emit('update:visible', false)"
      />
      <Button label="Add to Queue" :loading="saving" @click="onAdd" />
    </template>
  </Dialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.err {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
  color: var(--fc-danger-ink);
}

.hint {
  margin: 0.375rem 0 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.hint.total {
  color: var(--fc-accent);
  font-variant-numeric: tabular-nums;
}

.hint.no-pick {
  margin-top: 0;
}

/*
 * A column rather than a dropdown, because the desk is comparing four numbers on
 * somebody's behalf and a `Select` can only show one of them at a time.
 *
 * Not `.chair` — the queue page behind this dialog already has a chair strip of that
 * name. Scoping keeps them apart, but two different things wearing one class in the same
 * corner of the app is a trap for whoever reads it next.
 */
.picker {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.pick {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--fc-line);
  border-radius: 6px;
  background: var(--fc-input);
  color: inherit;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.pick:hover {
  border-color: var(--fc-accent);
}

.pick.on {
  border-color: var(--fc-accent);
  background: var(--fc-accent-wash);
}

.c-name {
  font-size: 0.9375rem;
  font-weight: 580;
}

/* The figure the column exists to be scanned down. Its height is held whether or not an
   answer has arrived, so the list does not jump when one does. */
.c-wait {
  min-height: 1.125rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 520px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
