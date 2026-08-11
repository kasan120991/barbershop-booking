<script setup lang="ts">
/**
 * Services & Hours — everything the shop sells and when it is open.
 *
 * Three tabs rather than one long page: the menu, the weekly hours, and the shop's
 * own settings including holiday closures. They share one `useCatalog()` state, so
 * editing a service in one tab cannot leave another showing a stale roster.
 */

import {
  dayName,
  formatCents,
  formatDuration,
  minutesToTimeString,
  nationalDigits,
  normalizePhone,
  timeStringToMinutes,
} from '@francis/shared';

import type { ServiceWithBarbers } from '../composables/useCatalog';

useHead({ title: 'Services & Hours — Francis Cutz' });

const catalog = useCatalog();
const { notifySuccess, notifyApiFailure } = useNotify();

const dialogOpen = ref(false);
const editing = ref<ServiceWithBarbers | null>(null);
/** Usage counts, loaded lazily so Delete is only offered where it can succeed. */
const usage = ref<Record<string, number>>({});
const savingHours = ref(false);
const savingSettings = ref(false);

await catalog.refresh();

// --- Services ---

function onAdd() {
  editing.value = null;
  dialogOpen.value = true;
}

function onEdit(service: ServiceWithBarbers) {
  editing.value = service;
  dialogOpen.value = true;
}

function barberNames(service: ServiceWithBarbers): string {
  if (service.barberIds.length === 0) return 'Nobody';
  if (service.barberIds.length === catalog.barbers.value.length) return 'Everyone';
  return catalog.barbers.value
    .filter((barber) => service.barberIds.includes(barber.id))
    .map((barber) => barber.displayName)
    .join(', ');
}

async function onToggleActive(service: ServiceWithBarbers) {
  try {
    await catalog.updateService(service.id, { isActive: !service.isActive });
    notifySuccess(service.isActive ? 'Service archived' : 'Service restored');
  } catch (error) {
    notifyApiFailure(error);
  }
}

async function loadUsage(service: ServiceWithBarbers) {
  if (usage.value[service.id] !== undefined) return;
  try {
    usage.value = { ...usage.value, [service.id]: await catalog.serviceUsage(service.id) };
  } catch {
    // Not knowing the count just means Delete stays hidden, which is the safe default.
  }
}

async function onDelete(service: ServiceWithBarbers) {
  try {
    await catalog.deleteService(service.id);
    notifySuccess('Service deleted');
  } catch (error) {
    // The server refuses anything with booking history and explains why — surface
    // that message rather than a generic failure.
    notifyApiFailure(error);
  }
}

// --- Hours ---

interface HoursRow {
  dayOfWeek: number;
  open: string;
  close: string;
  isClosed: boolean;
}

const hoursRows = ref<HoursRow[]>([]);
const hoursError = ref<string | null>(null);

watchEffect(() => {
  const hours = catalog.settings.value?.hours ?? [];
  hoursRows.value = Array.from({ length: 7 }, (_, dayOfWeek) => {
    const row = hours.find((h) => h.dayOfWeek === dayOfWeek);
    return {
      dayOfWeek,
      open: minutesToTimeString(row?.openMinute ?? 540),
      close: minutesToTimeString(row?.closeMinute ?? 1020),
      isClosed: row?.isClosed ?? true,
    };
  });
});

async function onSaveHours() {
  hoursError.value = null;

  const hours = [];
  for (const row of hoursRows.value) {
    const openMinute = timeStringToMinutes(row.open);
    const closeMinute = timeStringToMinutes(row.close);

    if (openMinute === null || closeMinute === null) {
      hoursError.value = `${dayName(row.dayOfWeek)} has a time that could not be read.`;
      return;
    }
    if (!row.isClosed && closeMinute <= openMinute) {
      hoursError.value = `${dayName(row.dayOfWeek)} closes before it opens.`;
      return;
    }

    hours.push({ dayOfWeek: row.dayOfWeek, openMinute, closeMinute, isClosed: row.isClosed });
  }

  savingHours.value = true;
  try {
    await catalog.replaceHours(hours);
    notifySuccess('Hours saved');
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    savingHours.value = false;
  }
}

// --- Shop settings ---

const shopForm = reactive({
  name: '',
  timezone: '',
  phone: '',
  slotGranularityMinutes: 15,
  bookingHorizonDays: 30,
  minimumNoticeMinutes: 60,
  walkInQueueEnabled: true,
  onlineBookingEnabled: true,
});

watchEffect(() => {
  const settings = catalog.settings.value;
  if (!settings) return;
  Object.assign(shopForm, {
    name: settings.name,
    timezone: settings.timezone,
    // The ten national digits, NOT the stored value. A mask fills left to right, so
    // handing it "+14155550134" would show "(141) 555-5013" and save that back.
    phone: nationalDigits(settings.phone),
    slotGranularityMinutes: settings.slotGranularityMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
    walkInQueueEnabled: settings.walkInQueueEnabled,
    onlineBookingEnabled: settings.onlineBookingEnabled,
  });
});

async function onSaveSettings() {
  savingSettings.value = true;
  try {
    // Normalised on the way out, so the shop's own number is stored the same way every
    // client's is — and so the `tel:` links on the booking site actually dial.
    await catalog.updateSettings({ ...shopForm, phone: normalizePhone(shopForm.phone) });
    notifySuccess('Shop settings saved');
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    savingSettings.value = false;
  }
}

// --- Closures ---

const closureForm = reactive({ startDate: '', endDate: '', reason: '' });
const closureError = ref<string | null>(null);

async function onAddClosure() {
  closureError.value = null;
  if (!closureForm.startDate) {
    closureError.value = 'Pick a start date.';
    return;
  }

  try {
    await catalog.createClosure({
      startDate: closureForm.startDate,
      // A one-day closure is the common case, so an empty end means the same day.
      endDate: closureForm.endDate || closureForm.startDate,
      reason: closureForm.reason.trim() || null,
    });
    Object.assign(closureForm, { startDate: '', endDate: '', reason: '' });
    notifySuccess('Closure added');
  } catch (error) {
    notifyApiFailure(error);
  }
}

async function onDeleteClosure(closureId: string) {
  try {
    await catalog.deleteClosure(closureId);
    notifySuccess('Closure removed');
  } catch (error) {
    notifyApiFailure(error);
  }
}
</script>

<template>
  <div class="catalog">
    <Tabs value="services">
      <TabList>
        <Tab value="services">Services</Tab>
        <Tab value="hours">Hours</Tab>
        <Tab value="shop">Shop</Tab>
      </TabList>

      <TabPanels>
        <!-- ---------------- Services ---------------- -->
        <TabPanel value="services">
          <div class="panel">
            <div class="panel-head">
              <p class="panel-note">
                Prices and durations are copied onto each booking, so editing them here changes
                future appointments only.
              </p>
              <Button label="Add Service" size="small" @click="onAdd" />
            </div>

            <DataTable
              :value="catalog.services.value"
              data-key="id"
              size="small"
              striped-rows
              :loading="catalog.loading.value"
            >
              <Column field="name" header="Name">
                <template #body="{ data }">
                  <div class="name-cell">
                    <span :class="{ archived: !data.isActive }">{{ data.name }}</span>
                    <Tag v-if="!data.isActive" value="Archived" severity="secondary" />
                  </div>
                  <p v-if="data.category" class="sub">{{ data.category }}</p>
                </template>
              </Column>

              <Column header="Price" style="width: 7rem">
                <template #body="{ data }">
                  <span class="num">{{ formatCents(data.priceCents) }}</span>
                </template>
              </Column>

              <Column header="Duration" style="width: 7rem">
                <template #body="{ data }">
                  <span class="num">{{ formatDuration(data.durationMinutes) }}</span>
                </template>
              </Column>

              <Column header="Performed By">
                <template #body="{ data }">
                  <span class="sub">{{ barberNames(data) }}</span>
                </template>
              </Column>

              <Column header="Booking" style="width: 9rem">
                <template #body="{ data }">
                  <div class="flags">
                    <Tag v-if="data.bookableOnline" value="Online" severity="info" />
                    <Tag v-if="data.bookableWalkIn" value="Walk-in" severity="info" />
                  </div>
                </template>
              </Column>

              <Column header="" style="width: 12rem">
                <template #body="{ data }">
                  <div class="actions">
                    <Button label="Edit" size="small" variant="text" @click="onEdit(data)" />
                    <Button
                      :label="data.isActive ? 'Archive' : 'Restore'"
                      size="small"
                      variant="text"
                      severity="secondary"
                      @click="onToggleActive(data)"
                    />
                    <!-- Delete only appears once the server confirms the service has
                         never been booked, so it is never offered as a failure. -->
                    <Button
                      v-if="usage[data.id] === 0"
                      label="Delete"
                      size="small"
                      variant="text"
                      severity="danger"
                      @click="onDelete(data)"
                    />
                    <Button
                      v-else-if="usage[data.id] === undefined"
                      label="…"
                      size="small"
                      variant="text"
                      severity="secondary"
                      aria-label="Check whether this can be deleted"
                      @click="loadUsage(data)"
                    />
                  </div>
                </template>
              </Column>

              <template #empty>
                <p class="empty">No services yet. Add the first one.</p>
              </template>
            </DataTable>
          </div>
        </TabPanel>

        <!-- ---------------- Hours ---------------- -->
        <TabPanel value="hours">
          <div class="panel">
            <p class="panel-note">
              Times are the shop's local clock. Stored as minutes from midnight, so they do not
              move when the clocks change.
            </p>

            <Message v-if="hoursError" severity="error" :closable="false">{{ hoursError }}</Message>

            <div class="hours">
              <div v-for="row in hoursRows" :key="row.dayOfWeek" class="hours-row">
                <span class="day">{{ dayName(row.dayOfWeek) }}</span>
                <div class="closed-toggle">
                  <ToggleSwitch v-model="row.isClosed" :input-id="`closed-${row.dayOfWeek}`" />
                  <label :for="`closed-${row.dayOfWeek}`">Closed</label>
                </div>
                <input
                  v-model="row.open"
                  type="time"
                  class="fc-input"
                  :disabled="row.isClosed"
                  :aria-label="`${dayName(row.dayOfWeek)} opening time`"
                >
                <span class="dash">–</span>
                <input
                  v-model="row.close"
                  type="time"
                  class="fc-input"
                  :disabled="row.isClosed"
                  :aria-label="`${dayName(row.dayOfWeek)} closing time`"
                >
              </div>
            </div>

            <div class="panel-actions">
              <Button label="Save Hours" :loading="savingHours" @click="onSaveHours" />
            </div>
          </div>
        </TabPanel>

        <!-- ---------------- Shop ---------------- -->
        <TabPanel value="shop">
          <div class="panel two-col">
            <section class="card">
              <h2>Shop Settings</h2>

              <div class="field">
                <label for="shop-name" class="fc-label">Name</label>
                <InputText id="shop-name" v-model="shopForm.name" fluid />
              </div>

              <div class="field">
                <label for="shop-tz" class="fc-label">Timezone</label>
                <InputText id="shop-tz" v-model="shopForm.timezone" fluid />
                <p class="hint">IANA name, e.g. America/New_York. Everything is stored in UTC.</p>
              </div>

              <div class="field">
                <label for="shop-phone" class="fc-label">Phone</label>
                <InputMask
                  id="shop-phone"
                  v-model="shopForm.phone"
                  mask="(999) 999-9999"
                  :auto-clear="false"
                  unmask
                  type="tel"
                  inputmode="tel"
                  placeholder="(415) 555-0123"
                  fluid
                />
                <p class="hint">Shown to clients on the booking site, and dialable from it.</p>
              </div>

              <div class="field">
                <label for="shop-slot" class="fc-label">Slot Granularity (minutes)</label>
                <InputNumber
                  id="shop-slot"
                  v-model="shopForm.slotGranularityMinutes"
                  :min="5"
                  :max="120"
                  :step="5"
                  show-buttons
                  fluid
                />
              </div>

              <div class="field">
                <label for="shop-horizon" class="fc-label">Booking Horizon (days)</label>
                <InputNumber
                  id="shop-horizon"
                  v-model="shopForm.bookingHorizonDays"
                  :min="1"
                  :max="365"
                  fluid
                />
              </div>

              <div class="field">
                <label for="shop-notice" class="fc-label">Minimum Notice (minutes)</label>
                <InputNumber
                  id="shop-notice"
                  v-model="shopForm.minimumNoticeMinutes"
                  :min="0"
                  :max="10080"
                  :step="15"
                  fluid
                />
              </div>

              <div class="toggle">
                <ToggleSwitch v-model="shopForm.onlineBookingEnabled" input-id="shop-online" />
                <label for="shop-online">Online booking enabled</label>
              </div>
              <div class="toggle">
                <ToggleSwitch v-model="shopForm.walkInQueueEnabled" input-id="shop-queue" />
                <label for="shop-queue">Walk-in queue enabled</label>
              </div>

              <Button label="Save Settings" :loading="savingSettings" @click="onSaveSettings" />
            </section>

            <section class="card">
              <h2>Closures</h2>
              <p class="hint">
                Holidays and one-off closures. Dates are the shop's own calendar.
              </p>

              <Message v-if="closureError" severity="error" :closable="false">
                {{ closureError }}
              </Message>

              <div class="closure-form">
                <div class="field">
                  <label for="cl-start" class="fc-label">From</label>
                  <input id="cl-start" v-model="closureForm.startDate" type="date" class="fc-input">
                </div>
                <div class="field">
                  <label for="cl-end" class="fc-label">To</label>
                  <input id="cl-end" v-model="closureForm.endDate" type="date" class="fc-input">
                </div>
                <div class="field grow">
                  <label for="cl-reason" class="fc-label">Reason</label>
                  <InputText id="cl-reason" v-model="closureForm.reason" placeholder="Christmas" fluid />
                </div>
                <Button label="Add" size="small" @click="onAddClosure" />
              </div>

              <ul v-if="catalog.closures.value.length" class="closures">
                <li v-for="closure in catalog.closures.value" :key="closure.id">
                  <span class="num">
                    {{ closure.startDate }}
                    <template v-if="closure.endDate !== closure.startDate">
                      – {{ closure.endDate }}
                    </template>
                  </span>
                  <span class="sub">{{ closure.reason ?? 'Closed' }}</span>
                  <Button
                    label="Remove"
                    size="small"
                    variant="text"
                    severity="danger"
                    @click="onDeleteClosure(closure.id)"
                  />
                </li>
              </ul>
              <p v-else class="empty">No closures scheduled.</p>
            </section>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <ServicesServiceDialog
      v-model:visible="dialogOpen"
      :service="editing"
      :barbers="catalog.barbers.value"
    />
  </div>
</template>

<style scoped>
.catalog {
  max-width: 72rem;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.75rem;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.panel-note {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
  max-width: 56ch;
}

.panel-actions {
  display: flex;
  justify-content: flex-start;
}

.name-cell {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.archived {
  color: var(--fc-ink-faint);
  text-decoration: line-through;
}

.sub {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.num {
  font-variant-numeric: tabular-nums;
}

.flags,
.actions {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.empty {
  margin: 0;
  padding: 1rem 0;
  color: var(--fc-ink-faint);
  font-size: 0.875rem;
}

/* Hours */
.hours {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 34rem;
}

.hours-row {
  display: grid;
  grid-template-columns: 6rem auto 1fr auto 1fr;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--fc-line);
  border-radius: 6px;
  background: var(--fc-surface);
}

.day {
  font-size: 0.8125rem;
}

.closed-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.dash {
  color: var(--fc-ink-faint);
}
/* Shop */
.two-col {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: 1.25rem;
  align-items: start;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 1.25rem;
}

.card h2 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 0.9375rem;
  font-weight: 650;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.field.grow {
  flex: 1;
}

.hint {
  margin: 0.375rem 0 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

.closure-form {
  display: flex;
  align-items: flex-end;
  gap: 0.625rem;
  flex-wrap: wrap;
}

.closures {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.closures li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8125rem;
  border-top: 1px solid var(--fc-line);
  padding-top: 0.375rem;
}

.closures li .sub {
  flex: 1;
}
</style>
