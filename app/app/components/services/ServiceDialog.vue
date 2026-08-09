<script setup lang="ts">
/**
 * Create/edit a service.
 *
 * The price is the interesting part: the admin types dollars, the API takes integer
 * cents, and the conversion happens exactly once here via `parseDollarsToCents` from
 * `@francis/shared`. Nothing downstream ever sees a float, which is the rule the
 * whole money design rests on.
 */

import {
  createServiceRequestSchema,
  formatCentsPlain,
  parseDollarsToCents,
  type BarberStaffDto,
} from '@francis/shared';

import type { ServiceWithBarbers } from '../../composables/useCatalog';

const props = defineProps<{
  visible: boolean;
  /** Null when creating. */
  service: ServiceWithBarbers | null;
  barbers: BarberStaffDto[];
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  saved: [];
}>();

const catalog = useCatalog();
const { notifySuccess, notifyApiFailure } = useNotify();

const isEdit = computed(() => props.service !== null);

const name = ref('');
const description = ref('');
const category = ref('');
const priceInput = ref('');
const durationMinutes = ref<number | null>(30);
const sortOrder = ref(0);
const bookableOnline = ref(true);
const bookableWalkIn = ref(true);
const barberIds = ref<string[]>([]);

const saving = ref(false);
const fieldErrors = ref<Record<string, string[]>>({});

/** Reset every time the dialog opens, so a cancelled edit leaves nothing behind. */
watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    fieldErrors.value = {};
    const service = props.service;
    name.value = service?.name ?? '';
    description.value = service?.description ?? '';
    category.value = service?.category ?? '';
    priceInput.value = service ? formatCentsPlain(service.priceCents) : '';
    durationMinutes.value = service?.durationMinutes ?? 30;
    sortOrder.value = service?.sortOrder ?? 0;
    bookableOnline.value = service?.bookableOnline ?? true;
    bookableWalkIn.value = service?.bookableWalkIn ?? true;
    barberIds.value = service ? [...service.barberIds] : props.barbers.map((b) => b.id);
  },
);

async function onSave() {
  if (saving.value) return;
  fieldErrors.value = {};

  const priceCents = parseDollarsToCents(priceInput.value);
  if (priceCents === null) {
    fieldErrors.value = { priceCents: ['Enter a price, like 45 or 45.00.'] };
    return;
  }

  const payload = {
    name: name.value.trim(),
    description: description.value.trim() || null,
    category: category.value.trim() || null,
    priceCents,
    durationMinutes: durationMinutes.value ?? 0,
    sortOrder: sortOrder.value,
    bookableOnline: bookableOnline.value,
    bookableWalkIn: bookableWalkIn.value,
  };

  // Validate against the same schema the server uses, so an obvious mistake never
  // costs a round trip. The server still re-validates.
  const parsed = createServiceRequestSchema.safeParse(payload);
  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return;
  }

  saving.value = true;
  try {
    if (props.service) {
      await catalog.updateService(props.service.id, parsed.data);
      await catalog.setServiceBarbers(props.service.id, barberIds.value);
      notifySuccess('Service updated');
    } else {
      const created = await catalog.createService(parsed.data);
      await catalog.setServiceBarbers(created.id, barberIds.value);
      notifySuccess('Service added');
    }

    emit('saved');
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
    :header="isEdit ? 'Edit Service' : 'Add Service'"
    modal
    :style="{ width: 'min(34rem, 94vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="form">
      <div class="field">
        <label for="svc-name" class="fc-label">Name</label>
        <InputText id="svc-name" v-model="name" :invalid="Boolean(fieldErrors.name)" fluid />
        <p v-if="fieldErrors.name" class="err">{{ fieldErrors.name[0] }}</p>
      </div>

      <div class="row">
        <div class="field">
          <label for="svc-price" class="fc-label">Price</label>
          <InputGroup>
            <InputGroupAddon>$</InputGroupAddon>
            <InputText
              id="svc-price"
              v-model="priceInput"
              inputmode="decimal"
              placeholder="45.00"
              :invalid="Boolean(fieldErrors.priceCents)"
            />
          </InputGroup>
          <p v-if="fieldErrors.priceCents" class="err">{{ fieldErrors.priceCents[0] }}</p>
        </div>

        <div class="field">
          <label for="svc-duration" class="fc-label">Minutes</label>
          <InputNumber
            id="svc-duration"
            v-model="durationMinutes"
            :min="5"
            :max="480"
            :step="5"
            show-buttons
            :invalid="Boolean(fieldErrors.durationMinutes)"
            fluid
          />
          <p v-if="fieldErrors.durationMinutes" class="err">{{ fieldErrors.durationMinutes[0] }}</p>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label for="svc-category" class="fc-label">Category</label>
          <InputText id="svc-category" v-model="category" placeholder="Cuts" fluid />
        </div>
        <div class="field">
          <label for="svc-order" class="fc-label">Sort Order</label>
          <InputNumber id="svc-order" v-model="sortOrder" :min="0" :max="999" fluid />
        </div>
      </div>

      <div class="field">
        <label for="svc-desc" class="fc-label">Description</label>
        <Textarea id="svc-desc" v-model="description" rows="2" auto-resize fluid />
      </div>

      <div class="field">
        <label for="svc-barbers" class="fc-label">Performed By</label>
        <MultiSelect
          id="svc-barbers"
          v-model="barberIds"
          :options="props.barbers"
          option-label="displayName"
          option-value="id"
          display="chip"
          placeholder="Nobody yet"
          fluid
        />
        <p class="hint">
          A service nobody performs cannot be booked, so it will not appear as an option.
        </p>
      </div>

      <div class="toggles">
        <div class="toggle">
          <ToggleSwitch v-model="bookableOnline" input-id="svc-online" />
          <label for="svc-online">Bookable online</label>
        </div>
        <div class="toggle">
          <ToggleSwitch v-model="bookableWalkIn" input-id="svc-walkin" />
          <label for="svc-walkin">Available to walk-ins</label>
        </div>
      </div>
    </div>

    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        variant="text"
        @click="emit('update:visible', false)"
      />
      <Button :label="isEdit ? 'Save Changes' : 'Add Service'" :loading="saving" @click="onSave" />
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

.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  padding-top: 0.25rem;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

@media (max-width: 520px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
