<script setup lang="ts">
/**
 * Barbers & Rent — the roster, each barber's weekly schedule, and their time off.
 *
 * Master–detail because this is one-barber-at-a-time work. The roster stays visible
 * so switching between people is one click rather than a round trip through a list.
 *
 * Rent lands with the payouts phase; the nav label already says "Barbers & Rent"
 * because that is where it will live.
 */

import type { BarberStaffDto } from '@francis/shared';

useHead({ title: 'Barbers — Francis Cutz' });

const barbers = useBarbers();
const catalog = useCatalog();
const { notifySuccess, notifyApiFailure } = useNotify();

const addOpen = ref(false);
const savingProfile = ref(false);

await barbers.refreshRoster();
// Shop hours drive the "outside shop hours" warning in the schedule editor.
await catalog.refresh();
if (barbers.selectedId.value) await barbers.loadDetail(barbers.selectedId.value);

const profile = reactive({
  displayName: '',
  bio: '',
  status: 'ACTIVE',
  acceptsOnline: true,
  acceptsWalkIns: true,
  sortOrder: 0,
});

watchEffect(() => {
  const selected = barbers.selected.value;
  if (!selected) return;
  Object.assign(profile, {
    displayName: selected.displayName,
    bio: selected.bio ?? '',
    status: selected.status,
    acceptsOnline: selected.acceptsOnline,
    acceptsWalkIns: selected.acceptsWalkIns,
    sortOrder: selected.sortOrder,
  });
});

function initials(barber: BarberStaffDto): string {
  return `${barber.firstName[0] ?? ''}${barber.lastName[0] ?? ''}`.toUpperCase();
}

async function onSelect(barberId: string) {
  if (barberId === barbers.selectedId.value) return;
  await barbers.select(barberId);
}

async function onSaveProfile() {
  const selected = barbers.selected.value;
  if (!selected || savingProfile.value) return;

  savingProfile.value = true;
  try {
    await barbers.updateBarber(selected.id, {
      displayName: profile.displayName.trim(),
      bio: profile.bio.trim() || null,
      status: profile.status,
      acceptsOnline: profile.acceptsOnline,
      acceptsWalkIns: profile.acceptsWalkIns,
      sortOrder: profile.sortOrder,
    });
    notifySuccess('Profile saved');
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    savingProfile.value = false;
  }
}
</script>

<template>
  <div class="barbers">
    <aside class="roster">
      <!-- "Add Barber", not "Add": the time-off panel on the same screen has its own
           Add button, and two identical labels doing different things is a trap. -->
      <div class="roster-head">
        <h2>Barbers</h2>
        <Button label="Add Barber" size="small" @click="addOpen = true" />
      </div>

      <button
        v-for="barber in barbers.barbers.value"
        :key="barber.id"
        type="button"
        class="entry"
        :class="{ on: barber.id === barbers.selectedId.value, inactive: barber.status !== 'ACTIVE' }"
        @click="onSelect(barber.id)"
      >
        <span class="avatar">{{ initials(barber) }}</span>
        <span class="who">
          <span class="name">{{ barber.displayName }}</span>
          <span class="meta">
            {{ barber.status === 'ACTIVE' ? '' : 'Inactive · ' }}{{ barber.serviceIds.length }} services
          </span>
        </span>
      </button>

      <p v-if="barbers.barbers.value.length === 0" class="empty">
        No barbers yet. Add the first one.
      </p>
    </aside>

    <section v-if="barbers.selected.value" class="detail">
      <header class="detail-head">
        <div>
          <h1>{{ barbers.selected.value.displayName }}</h1>
          <p class="sub">{{ barbers.selected.value.email }}</p>
        </div>
        <Tag
          v-if="barbers.selected.value.status !== 'ACTIVE'"
          value="Inactive"
          severity="secondary"
        />
      </header>

      <Tabs value="schedule">
        <TabList>
          <Tab value="schedule">Schedule</Tab>
          <Tab value="timeoff">Time Off</Tab>
          <Tab value="rent">Rent</Tab>
          <Tab value="profile">Profile</Tab>
        </TabList>

        <TabPanels>
          <TabPanel value="schedule">
            <BarbersScheduleEditor
              :barber-id="barbers.selected.value.id"
              :shifts="barbers.shifts.value"
              :shop-hours="catalog.settings.value?.hours ?? []"
            />
          </TabPanel>

          <TabPanel value="timeoff">
            <BarbersTimeOffPanel
              :barber-id="barbers.selected.value.id"
              :exceptions="barbers.exceptions.value"
            />
          </TabPanel>

          <!--
            Rent fetches its own data rather than arriving as a prop like the two above it.
            A ledger is dozens of rows most roster clicks never open — see `useRent`.
          -->
          <TabPanel value="rent">
            <BarbersRentPanel :barber-id="barbers.selected.value.id" />
          </TabPanel>

          <TabPanel value="profile">
            <div class="profile">
              <div class="field">
                <label for="p-name" class="fc-label">Display Name</label>
                <InputText id="p-name" v-model="profile.displayName" fluid />
                <p class="hint">What clients see when booking.</p>
              </div>

              <div class="field">
                <label for="p-bio" class="fc-label">Bio</label>
                <Textarea id="p-bio" v-model="profile.bio" rows="3" auto-resize fluid />
              </div>

              <div class="field">
                <label for="p-order" class="fc-label">Sort Order</label>
                <InputNumber id="p-order" v-model="profile.sortOrder" :min="0" :max="999" fluid />
              </div>

              <div class="toggle">
                <ToggleSwitch v-model="profile.acceptsOnline" input-id="p-online" />
                <label for="p-online">Takes online bookings</label>
              </div>
              <div class="toggle">
                <ToggleSwitch v-model="profile.acceptsWalkIns" input-id="p-walkin" />
                <label for="p-walkin">Takes walk-ins</label>
              </div>

              <div class="field">
                <label for="p-status" class="fc-label">Status</label>
                <Select
                  id="p-status"
                  v-model="profile.status"
                  :options="[
                    { label: 'Active', value: 'ACTIVE' },
                    { label: 'Inactive', value: 'INACTIVE' },
                  ]"
                  option-label="label"
                  option-value="value"
                  fluid
                />
                <p class="hint">
                  Inactive hides them from booking. Past appointments, payments and rent are
                  untouched.
                </p>
              </div>

              <Button label="Save Profile" :loading="savingProfile" @click="onSaveProfile" />
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </section>

    <section v-else class="detail empty-detail">
      <p class="empty">Add a barber to get started.</p>
    </section>

    <BarbersAddBarberDialog v-model:visible="addOpen" />
  </div>
</template>

<style scoped>
.barbers {
  display: grid;
  grid-template-columns: 14rem 1fr;
  gap: 1.25rem;
  align-items: start;
  max-width: 72rem;
}

.roster {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 0.875rem 0.75rem;
}

.roster-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-bottom: 0.375rem;
  border-bottom: 1px solid var(--fc-line);
  margin-bottom: 0.25rem;
}

.roster-head h2 {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
  font-weight: 600;
}

.entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 0.4375rem 0.5rem;
  font: inherit;
  color: var(--fc-ink-muted);
  cursor: pointer;
}

.entry:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--fc-ink);
}

.entry.on {
  background: var(--fc-accent-wash);
  border-color: rgba(212, 162, 76, 0.45);
  color: var(--fc-ink);
}

.entry.inactive .name {
  color: var(--fc-ink-faint);
}

.entry:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: -2px;
}

.avatar {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 50%;
  background: var(--fc-input);
  border: 1px solid var(--fc-line);
  display: grid;
  place-items: center;
  font-size: 0.625rem;
  font-weight: 650;
  color: var(--fc-ink-muted);
  flex: none;
}

.who {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}

.name {
  font-size: 0.8125rem;
}

.meta {
  font-size: 0.625rem;
  color: var(--fc-ink-faint);
}

.detail {
  min-width: 0;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.detail-head h1 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 1.25rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.sub {
  margin: 0.125rem 0 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.profile {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  padding-top: 0.75rem;
  max-width: 28rem;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
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

.empty {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
  padding: 0.5rem 0;
}

.empty-detail {
  border: 1px dashed var(--fc-line);
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
}

@media (max-width: 820px) {
  .barbers {
    grid-template-columns: 1fr;
  }

  .roster {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
  }

  .roster-head {
    width: 100%;
    margin-bottom: 0;
  }
}
</style>
