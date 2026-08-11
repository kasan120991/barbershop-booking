<script setup lang="ts">
/**
 * Booking an appointment from the desk.
 *
 * The staff side of `POST /appointments`, which the server has been staff-aware about
 * since it was written and which nothing in the app has ever called. The route detects a
 * signed-in user and relaxes the minimum notice and the online-booking rules **itself**
 * (`routes/booking.ts`), so this sends no flags saying so: a rule the server owns must
 * not travel in a body anybody can post.
 *
 * **A barber is required, and there is no "Anyone".** The double-booking lock is per
 * barber per day — `BarberDayLock` — so there is nothing to take a lock on without one.
 * The public site solves this by asking every eligible barber and merging; at the desk
 * somebody already knows who is cutting.
 *
 * The times are grouped into morning, afternoon and evening. A run of thirty chips hides
 * the shape of a day: a barber booked solid from noon to two reads as an unbroken list,
 * where under headings the hole is the first thing anybody sees — and "anything this
 * afternoon?" is answered without reading a single time.
 */

import {
  createAppointmentRequestSchema,
  formatCents,
  formatDuration,
  type AvailabilityResponse,
  type ServiceDto,
} from '@francis/shared';

const props = defineProps<{
  visible: boolean;
  /** Preset and locked — `/my-day` books its own chair and nobody else's. */
  lockedBarberId?: string | null | undefined;
  /** The day the caller was looking at, so the dialog opens where they already are. */
  date?: string | undefined;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  booked: [];
}>();

const api = useApi();
const queue = useQueue();
const shop = useShopClock();
const { notifySuccess, notifyApiFailure } = useNotify();

const form = reactive({
  barberId: null as string | null,
  serviceIds: [] as string[],
  date: '',
  startAt: null as string | null,
  phone: '',
  firstName: '',
  lastName: '',
  notes: '',
});

const saving = ref(false);
const loadingSlots = ref(false);
const availability = ref<AvailabilityResponse | null>(null);
const fieldErrors = ref<Record<string, string[]>>({});

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    Object.assign(form, {
      barberId: props.lockedBarberId ?? null,
      serviceIds: [],
      date: props.date ?? shop.today(),
      startAt: null,
      phone: '',
      firstName: '',
      lastName: '',
      notes: '',
    });
    fieldErrors.value = {};
    availability.value = null;
    void queue.loadOptions();
  },
);

/**
 * Everything on the menu, not just what the internet may book.
 *
 * `bookableOnline` governs the public site; the desk is not the internet. The server
 * makes the same distinction — `enforceOnlineRules` is false for staff — so filtering
 * here would take away a choice the server would have allowed.
 */
const services = computed(() => queue.services.value.filter((service) => service.isActive));

const chosen = computed(() =>
  services.value.filter((service) => form.serviceIds.includes(service.id)),
);

const totalMinutes = computed(() =>
  chosen.value.reduce((total, service) => total + service.durationMinutes, 0),
);
const totalCents = computed(() =>
  chosen.value.reduce((total, service) => total + service.priceCents, 0),
);

/** Only barbers who can do everything selected — offering the rest is not a choice. */
const eligibleBarbers = computed(() =>
  queue.barbers.value.filter(
    (barber) =>
      barber.status === 'ACTIVE' &&
      form.serviceIds.every((serviceId) => barber.serviceIds.includes(serviceId)),
  ),
);

const barberOptions = computed(() =>
  eligibleBarbers.value.map((barber) => ({ id: barber.id, label: barber.displayName })),
);

const lockedBarberName = computed(
  () =>
    queue.barbers.value.find((barber) => barber.id === props.lockedBarberId)?.displayName ?? '',
);

// A barber valid a moment ago may not do the service just added.
watch(
  () => form.serviceIds.slice(),
  () => {
    if (props.lockedBarberId != null) return;
    if (form.barberId === null) return;
    if (!eligibleBarbers.value.some((barber) => barber.id === form.barberId)) {
      form.barberId = null;
    }
  },
);

function priceLabel(service: ServiceDto): string {
  return `${service.name} · ${formatDuration(service.durationMinutes)} · ${formatCents(service.priceCents)}`;
}

// --- The slots -----------------------------------------------------------------

const canAsk = computed(
  () => form.barberId !== null && form.serviceIds.length > 0 && form.date !== '',
);

let slotSequence = 0;

async function loadSlots() {
  availability.value = null;
  form.startAt = null;

  if (!canAsk.value) return;

  const mine = ++slotSequence;
  loadingSlots.value = true;

  try {
    const response = await api<AvailabilityResponse>('/availability', {
      query: {
        barberId: form.barberId,
        date: form.date,
        serviceIds: form.serviceIds.join(','),
      },
    });
    if (mine === slotSequence) availability.value = response;
  } catch (error) {
    if (mine === slotSequence) notifyApiFailure(error, 'Could not load the times.');
  } finally {
    if (mine === slotSequence) loadingSlots.value = false;
  }
}

watch(
  () => [form.barberId, form.serviceIds.slice(), form.date] as const,
  () => void loadSlots(),
  { deep: true },
);

/** Morning, afternoon, evening — see the note at the top. Empty groups are not drawn. */
const slotGroups = computed(() => {
  const slots = availability.value?.slots ?? [];

  const buckets: { label: string; slots: string[] }[] = [
    { label: 'Morning', slots: [] },
    { label: 'Afternoon', slots: [] },
    { label: 'Evening', slots: [] },
  ];

  for (const slot of slots) {
    const hour = shop.hourOf(slot);
    const bucket = hour < 12 ? 0 : hour < 17 ? 1 : 2;
    buckets[bucket]?.slots.push(slot);
  }

  return buckets.filter((bucket) => bucket.slots.length > 0);
});

const slotCount = computed(() => availability.value?.slots.length ?? 0);

// --- Booking it ----------------------------------------------------------------

async function onBook() {
  if (saving.value) return;
  fieldErrors.value = {};

  const parsed = createAppointmentRequestSchema.safeParse({
    barberId: form.barberId,
    serviceIds: form.serviceIds,
    startAt: form.startAt,
    phone: form.phone,
    firstName: form.firstName,
    lastName: form.lastName.trim() || null,
    notes: form.notes.trim() || null,
  });

  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return;
  }

  saving.value = true;
  try {
    await api('/appointments', { method: 'POST', body: parsed.data });
    notifySuccess(
      `${form.firstName.trim()} booked`,
      `${shop.longDate(form.date)} at ${shop.clock(form.startAt)}`,
    );
    emit('booked');
    emit('update:visible', false);
  } catch (error) {
    notifyApiFailure(error, 'Could not book that.');
  } finally {
    saving.value = false;
  }
}

const summary = computed(() => {
  if (form.startAt === null) return null;
  return `${shop.longDate(form.date, { weekday: 'short', month: 'short' })} · ${shop.clock(form.startAt)} · ${formatDuration(totalMinutes.value)} · ${formatCents(totalCents.value)}`;
});
</script>

<template>
  <Dialog
    :visible="props.visible"
    header="Add an Appointment"
    modal
    :style="{ width: 'min(56rem, 96vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="book">
      <!-- The cut: what is being booked, and when there is room for it. -->
      <div class="cols">
        <section class="col">
          <div class="field">
            <label for="a-services" class="fc-label">Services</label>
            <MultiSelect
              id="a-services"
              v-model="form.serviceIds"
              :options="services"
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
            <p v-else class="hint">The whole menu — the desk is not the internet.</p>
          </div>

          <div class="field">
            <label for="a-barber" class="fc-label">Barber</label>
            <template v-if="props.lockedBarberId != null">
              <div class="locked">{{ lockedBarberName }} — you</div>
              <p class="hint">Your own chair. Booking somebody else is done from the Calendar.</p>
            </template>
            <template v-else>
              <Select
                id="a-barber"
                v-model="form.barberId"
                :options="barberOptions"
                option-label="label"
                option-value="id"
                placeholder="Who is cutting"
                :disabled="form.serviceIds.length === 0"
                :invalid="Boolean(fieldErrors.barberId)"
                fluid
              />
              <p class="hint">
                <template v-if="form.serviceIds.length === 0">Pick the services first.</template>
                <template v-else>Only barbers who do everything selected.</template>
              </p>
            </template>
          </div>

          <div class="field">
            <label for="a-date" class="fc-label">Date</label>
            <input id="a-date" v-model="form.date" type="date" class="fc-input" >
          </div>
        </section>

        <section class="col">
          <span class="fc-label">Time</span>

          <p v-if="!canAsk" class="hint empty-slots">
            Pick a barber, the services and a date to see what is open.
          </p>

          <p v-else-if="loadingSlots" class="hint empty-slots">Looking for openings…</p>

          <!-- The engine explains itself: closed, fully booked and too far ahead all
               read differently, and it is the one place that knows which. -->
          <Message v-else-if="slotCount === 0" severity="secondary" :closable="false">
            {{ availability?.reason ?? 'Nothing open that day.' }}
          </Message>

          <template v-else>
            <div class="slot-groups">
              <div v-for="group in slotGroups" :key="group.label" class="slot-group">
                <span class="group-label">
                  {{ group.label }} <b>{{ group.slots.length }}</b>
                </span>
                <div class="slot-grid">
                  <button
                    v-for="slot in group.slots"
                    :key="slot"
                    type="button"
                    class="slot"
                    :class="{ on: form.startAt === slot }"
                    @click="form.startAt = slot"
                  >
                    {{ shop.clock(slot) }}
                  </button>
                </div>
              </div>
            </div>
            <p class="hint">
              {{ slotCount }} {{ slotCount === 1 ? 'opening' : 'openings' }} ·
              times shown in {{ shop.timezone.value }}
            </p>
          </template>

          <p v-if="fieldErrors.startAt" class="err">Pick a time.</p>
        </section>
      </div>

      <p class="fc-label section">Who It Is For</p>

      <ClientLookupFields
        v-model:phone="form.phone"
        v-model:first-name="form.firstName"
        v-model:last-name="form.lastName"
        :field-errors="fieldErrors"
        id-prefix="a"
      />

      <div class="field">
        <label for="a-notes" class="fc-label">Notes</label>
        <InputText id="a-notes" v-model="form.notes" placeholder="Number 2 on the sides" fluid />
        <p class="hint">Staff only. Never shown on the kiosk or the wall display.</p>
      </div>
    </div>

    <template #footer>
      <span v-if="summary" class="summary">{{ summary }}</span>
      <span class="foot-actions">
        <Button
          label="Cancel"
          severity="secondary"
          variant="text"
          @click="emit('update:visible', false)"
        />
        <Button label="Book It" :loading="saving" :disabled="form.startAt === null" @click="onBook" />
      </span>
    </template>
  </Dialog>
</template>

<style scoped>
.book {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/*
 * Narrow pickers, wide times.
 *
 * The three pickers need a fixed amount of room and never more; the times are the only
 * part that grows with the day. Splitting the dialog down the middle gave the left column
 * width it had no use for and squeezed the one thing that varies.
 */
.cols {
  display: grid;
  grid-template-columns: 20rem 1fr;
  gap: 1.5rem;
  align-items: start;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* `.fc-label` carries a bottom margin for a field; as a section header the flex gap
   sets the rhythm instead. */
.section {
  margin: 0.25rem 0 0;
}

.locked {
  display: flex;
  align-items: center;
  height: var(--fc-field-height);
  padding: 0 0.7rem;
  border: 1px dashed var(--fc-line);
  border-radius: 6px;
  color: var(--fc-ink-muted);
  font-size: 0.9375rem;
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

.empty-slots {
  margin: 0;
}

/* --- The times --------------------------------------------------------------- */

.slot-groups {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  /* Tall enough that all three parts of an ordinary day show at once — a scrollbar
     hiding Evening would undo the reason for grouping. A genuinely full day scrolls. */
  max-height: 22rem;
  overflow-y: auto;
  padding-right: 0.35rem;
}

.slot-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.group-label {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.625rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 660;
}

.group-label b {
  letter-spacing: 0;
  color: var(--fc-ink-muted);
  font-variant-numeric: tabular-nums;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(5.25rem, 1fr));
  gap: 0.35rem;
}

.slot {
  appearance: none;
  font: inherit;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--fc-line);
  background: var(--fc-input);
  color: var(--fc-ink);
  border-radius: 5px;
  padding: 0.4rem 0.3rem;
  cursor: pointer;
  text-align: center;
}

.slot:hover {
  border-color: var(--fc-accent);
}

.slot:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.slot.on {
  background: var(--fc-accent);
  color: var(--fc-accent-ink);
  border-color: transparent;
  font-weight: 640;
}

/* --- Footer ------------------------------------------------------------------ */

.summary {
  margin-right: auto;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
  font-variant-numeric: tabular-nums;
}

.foot-actions {
  display: flex;
  gap: 0.5rem;
}

@media (max-width: 820px) {
  .cols {
    grid-template-columns: 1fr;
    gap: 1rem;
  }

  .slot-groups {
    max-height: none;
  }
}
</style>
