<script setup lang="ts">
/**
 * Onboarding a barber.
 *
 * Creates the sign-in account, the roles, and the public profile in one step, and
 * shows the temporary password exactly once. There is no email in v1, so the admin
 * reads it across the counter — the same channel the password-reset flow uses.
 *
 * After creating, the dialog switches to showing the password rather than closing:
 * closing on success would destroy the one thing the admin needs.
 */

import { createBarberRequestSchema, type CreatedBarberDto } from '@francis/shared';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const barbers = useBarbers();
const { notifySuccess, notifyApiFailure } = useNotify();

const form = reactive({
  firstName: '',
  lastName: '',
  email: '',
  displayName: '',
  alsoAdmin: false,
  acceptsOnline: true,
  acceptsWalkIns: true,
});

const saving = ref(false);
const fieldErrors = ref<Record<string, string[]>>({});
/** Set on success; while non-null the dialog shows the handover screen. */
const created = ref<CreatedBarberDto | null>(null);
const copied = ref(false);

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    Object.assign(form, {
      firstName: '',
      lastName: '',
      email: '',
      displayName: '',
      alsoAdmin: false,
      acceptsOnline: true,
      acceptsWalkIns: true,
    });
    fieldErrors.value = {};
    created.value = null;
    copied.value = false;
  },
);

async function onCreate() {
  if (saving.value) return;
  fieldErrors.value = {};

  const parsed = createBarberRequestSchema.safeParse({
    ...form,
    displayName: form.displayName.trim() || undefined,
    sortOrder: 0,
  });

  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return;
  }

  saving.value = true;
  try {
    created.value = await barbers.createBarber(parsed.data);
    notifySuccess('Barber added');
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    saving.value = false;
  }
}

async function onCopy() {
  if (!created.value) return;
  try {
    await navigator.clipboard.writeText(created.value.temporaryPassword);
    copied.value = true;
  } catch {
    // Clipboard access can be denied; the password is on screen to read regardless.
    copied.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="props.visible"
    :header="created ? 'Barber Added' : 'Add Barber'"
    modal
    :closable="true"
    :style="{ width: 'min(32rem, 94vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <!-- Handover screen: shown once, and the password cannot be retrieved again. -->
    <div v-if="created" class="done">
      <p class="done-lede">
        <strong>{{ created.displayName }}</strong> can sign in with
        <strong>{{ created.email }}</strong> and this temporary password.
      </p>

      <div class="password">
        <code>{{ created.temporaryPassword }}</code>
        <Button
          :label="copied ? 'Copied' : 'Copy'"
          size="small"
          variant="outlined"
          severity="secondary"
          @click="onCopy"
        />
      </div>

      <Message severity="warn" :closable="false">
        This is the only time it is shown. Read it to them in person — they will be asked to
        choose a new password before they can do anything else.
      </Message>
    </div>

    <div v-else class="form">
      <div class="row">
        <div class="field">
          <label for="b-first" class="fc-label">First Name</label>
          <InputText id="b-first" v-model="form.firstName" :invalid="Boolean(fieldErrors.firstName)" fluid />
          <p v-if="fieldErrors.firstName" class="err">{{ fieldErrors.firstName[0] }}</p>
        </div>
        <div class="field">
          <label for="b-last" class="fc-label">Last Name</label>
          <InputText id="b-last" v-model="form.lastName" :invalid="Boolean(fieldErrors.lastName)" fluid />
          <p v-if="fieldErrors.lastName" class="err">{{ fieldErrors.lastName[0] }}</p>
        </div>
      </div>

      <div class="field">
        <label for="b-email" class="fc-label">Email</label>
        <InputText id="b-email" v-model="form.email" type="email" :invalid="Boolean(fieldErrors.email)" fluid />
        <p v-if="fieldErrors.email" class="err">{{ fieldErrors.email[0] }}</p>
        <p v-else class="hint">They sign in with this. It is never shown to clients.</p>
      </div>

      <div class="field">
        <label for="b-display" class="fc-label">Display Name</label>
        <InputText id="b-display" v-model="form.displayName" :placeholder="form.firstName || 'Marcus'" fluid />
        <p class="hint">What clients see when booking. Defaults to their first name.</p>
      </div>

      <div class="toggles">
        <div class="toggle">
          <ToggleSwitch v-model="form.acceptsOnline" input-id="b-online" />
          <label for="b-online">Takes online bookings</label>
        </div>
        <div class="toggle">
          <ToggleSwitch v-model="form.acceptsWalkIns" input-id="b-walkin" />
          <label for="b-walkin">Takes walk-ins</label>
        </div>
        <div class="toggle">
          <ToggleSwitch v-model="form.alsoAdmin" input-id="b-admin" />
          <label for="b-admin">Also an admin</label>
        </div>
      </div>
      <p class="hint">
        An admin can manage the whole shop. Give it to someone who also runs the business.
      </p>
    </div>

    <template #footer>
      <template v-if="created">
        <Button label="Done" @click="emit('update:visible', false)" />
      </template>
      <template v-else>
        <Button label="Cancel" severity="secondary" variant="text" @click="emit('update:visible', false)" />
        <Button label="Create Barber" :loading="saving" @click="onCreate" />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.form,
.done {
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
  flex-direction: column;
  gap: 0.625rem;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

.done-lede {
  margin: 0;
  color: var(--fc-ink-muted);
  font-size: 0.875rem;
}

.done-lede strong {
  color: var(--fc-ink);
  font-weight: 650;
}

.password {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid var(--fc-accent);
  border-radius: 6px;
  background: var(--fc-accent-wash);
  padding: 0.75rem 0.875rem;
}

.password code {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 1rem;
  color: var(--fc-accent);
  letter-spacing: 0.02em;
}

@media (max-width: 520px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
