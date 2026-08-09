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
 */

import { formatCents, joinQueueRequestSchema, type ServiceDto } from '@francis/shared';

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
    void queue.loadOptions();
  },
);

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

/** "Anyone" first, because it is the right answer for most people through the door. */
const barberOptions = computed(() => [
  { id: null as string | null, label: 'Anyone' },
  ...eligibleBarbers.value.map((barber) => ({ id: barber.id as string | null, label: barber.displayName })),
]);

// A barber who was valid a moment ago may not do the service just added, and silently
// booking them anyway would be refused by the server for reasons the form never showed.
watch(
  () => form.serviceIds.slice(),
  () => {
    if (form.barberId === null) return;
    if (!eligibleBarbers.value.some((barber) => barber.id === form.barberId)) {
      form.barberId = null;
    }
  },
);

function priceLabel(service: ServiceDto): string {
  return `${service.name} · ${String(service.durationMinutes)} min · ${formatCents(service.priceCents)}`;
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
      <div class="row">
        <div class="field">
          <label for="w-first" class="fc-label">First Name</label>
          <InputText
            id="w-first"
            v-model="form.firstName"
            :invalid="Boolean(fieldErrors.firstName)"
            fluid
          />
          <p v-if="fieldErrors.firstName" class="err">{{ fieldErrors.firstName[0] }}</p>
        </div>
        <div class="field">
          <label for="w-last" class="fc-label">Last Name</label>
          <InputText id="w-last" v-model="form.lastName" fluid />
          <p class="hint">Only the initial is ever shown.</p>
        </div>
      </div>

      <div class="field">
        <label for="w-phone" class="fc-label">Phone</label>
        <!--
          `auto-clear` off and `unmask` on, and both matter.

          The default clears a half-typed number the moment the field loses focus —
          somebody glances at the service list and comes back to an empty box with no
          explanation. And `unmask` puts ten digits in the model rather than the
          punctuation, so what the form holds is data; formatting is a display decision
          made once, in `formatPhone`.
        -->
        <InputMask
          id="w-phone"
          v-model="form.phone"
          mask="(999) 999-9999"
          :auto-clear="false"
          unmask
          type="tel"
          inputmode="tel"
          placeholder="(415) 555-0123"
          :invalid="Boolean(fieldErrors.phone)"
          fluid
        />
        <p v-if="fieldErrors.phone" class="err">{{ fieldErrors.phone[0] }}</p>
        <p v-else class="hint">How we know who they are. A number we already have is reused.</p>
      </div>

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
          {{ totalMinutes }} minutes · {{ formatCents(totalCents) }}
        </p>
        <p v-else class="hint">Appointment-only services are not listed.</p>
      </div>

      <div class="field">
        <label for="w-barber" class="fc-label">Barber</label>
        <Select
          id="w-barber"
          v-model="form.barberId"
          :options="barberOptions"
          option-label="label"
          option-value="id"
          :disabled="form.serviceIds.length === 0"
          fluid
        />
        <p class="hint">
          <template v-if="form.serviceIds.length === 0">Pick the services first.</template>
          <template v-else-if="form.barberId === null">
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

@media (max-width: 520px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
