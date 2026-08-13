<script setup lang="ts">
/**
 * Paired screens, and the phone line.
 *
 * This page exists because without it the kiosk cannot be paired at all — the pairing
 * endpoint has been live since the auth phase with no way to reach it except curl.
 *
 * The secret is the only moment in the flow a human handles a credential, and it is
 * shown exactly once. So the dialog switches to displaying it rather than closing on
 * success: closing would destroy the one thing the admin came here for, and the server
 * keeps only its hash.
 *
 * Two kinds of secret, discriminated by `type`. A screen gets a pairing code that
 * expires in fifteen minutes and is exchanged for a token by the tablet. A voice line
 * gets the token itself, because there is no screen at the other end to type anything
 * in — so it never expires, and the only way to stop it is to revoke it. The handover
 * has to say which it is handing over, or an admin pastes a code into Vapi and waits
 * for a phone that never rings.
 */

import { createDeviceRequestSchema, type CreatedDeviceResponse } from '@francis/shared';

useHead({ title: 'Screens — Francis Cutz' });

const devices = useDevices();
const { notifySuccess, notifyApiFailure } = useNotify();
const confirm = useConfirm();

await devices.refresh();

const dialogOpen = ref(false);
const saving = ref(false);
const fieldErrors = ref<Record<string, string[]>>({});
/** Non-null while the handover screen is up. */
const issued = ref<CreatedDeviceResponse | null>(null);
const busyId = ref<string | null>(null);

const form = reactive({ label: '', type: 'KIOSK' as string });

const TYPES = [
  { value: 'KIOSK', label: 'Kiosk', hint: 'Clients join the queue on it. Sits by the door.' },
  { value: 'DISPLAY', label: 'Wall Display', hint: 'Shows the board only. Cannot add anyone.' },
  {
    value: 'VOICE',
    label: 'Phone Line',
    hint: 'The receptionist that answers the phone. Books, moves and cancels.',
  },
];

const TYPE_NAMES: Record<string, string> = {
  KIOSK: 'Kiosk',
  DISPLAY: 'Wall display',
  VOICE: 'Phone line',
};

/** The handover differs by kind, and so does everything the admin does next. */
const issuedVoice = computed(() =>
  issued.value !== null && issued.value.type === 'VOICE' ? issued.value : null,
);
const issuedCode = computed(() =>
  issued.value !== null && issued.value.type !== 'VOICE' ? issued.value : null,
);

watch(dialogOpen, (open) => {
  if (!open) return;
  form.label = '';
  form.type = 'KIOSK';
  fieldErrors.value = {};
  issued.value = null;
});

/** Minutes left on the code, so an admin knows whether to walk or hurry. */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => {
  if (ticker !== undefined) clearInterval(ticker);
});

const expiresIn = computed(() => {
  const code = issuedCode.value;
  if (!code) return null;
  const seconds = Math.max(0, Math.round((Date.parse(code.expiresAt) - now.value) / 1000));
  const minutes = Math.floor(seconds / 60);
  return { seconds, label: `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}` };
});

async function onCreate() {
  if (saving.value) return;
  fieldErrors.value = {};

  const parsed = createDeviceRequestSchema.safeParse({ label: form.label, type: form.type });
  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return;
  }

  saving.value = true;
  try {
    issued.value = await devices.createDevice(parsed.data);
  } catch (error) {
    notifyApiFailure(error);
  } finally {
    saving.value = false;
  }
}

function onRevoke(device: { id: string; label: string; type: string }) {
  const isVoice = device.type === 'VOICE';
  confirm.require({
    header: isVoice ? 'Revoke this phone line' : 'Revoke this screen',
    // Worth saying plainly for a voice line: the consequence is not a dark tablet in
    // the corner, it is the shop's phone assistant refusing every caller.
    message: isVoice
      ? `${device.label} will stop answering immediately, and its token cannot be restored — you would add a new line and paste a fresh token into Vapi.`
      : `${device.label} will stop working immediately, and it cannot be paired again — you would add a new screen instead.`,
    acceptLabel: 'Revoke',
    rejectLabel: 'Keep It',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', variant: 'text' },
    accept: () => {
      void (async () => {
        busyId.value = device.id;
        try {
          await devices.revokeDevice(device.id);
          notifySuccess(`${device.label} revoked`);
        } catch (error) {
          notifyApiFailure(error);
        } finally {
          busyId.value = null;
        }
      })();
    },
  });
}

function onDelete(device: { id: string; label: string }) {
  confirm.require({
    header: 'Remove this screen',
    // No warning about it stopping working: it already has. This is only about the list.
    message: `${device.label} will be removed from this list. It was revoked, so nothing changes on the screen itself.`,
    acceptLabel: 'Remove',
    rejectLabel: 'Keep It',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', variant: 'text' },
    accept: () => {
      void (async () => {
        busyId.value = device.id;
        try {
          await devices.deleteDevice(device.id);
          notifySuccess(`${device.label} removed`);
        } catch (error) {
          notifyApiFailure(error);
        } finally {
          busyId.value = null;
        }
      })();
    },
  });
}

function statusLabel(status: string): string {
  if (status === 'PAIRED') return 'Paired';
  if (status === 'PENDING') return 'Waiting to pair';
  return 'Revoked';
}

function when(value: string | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
</script>

<template>
  <div class="screens">
    <header class="toolbar">
      <p class="sub">
        A screen is paired once with a short code, then works until an admin revokes it.
      </p>
      <Button label="Add Screen" size="small" @click="dialogOpen = true" />
    </header>

    <div v-if="devices.devices.value.length" class="list">
      <article
        v-for="device in devices.devices.value"
        :key="device.id"
        class="row"
        :class="{ revoked: device.status === 'REVOKED' }"
      >
        <span class="cell">
          <span class="name">{{ device.label }}</span>
          <span class="meta">{{ TYPE_NAMES[device.type] ?? device.type }}</span>
        </span>

        <span class="cell">
          <span class="status" :class="device.status.toLowerCase()">
            {{ statusLabel(device.status) }}
          </span>
          <span class="meta">Paired {{ when(device.pairedAt) }}</span>
        </span>

        <span class="cell">
          <span class="strong">Last seen</span>
          <span class="meta">{{ when(device.lastSeenAt) }}</span>
        </span>

        <!-- One action per row, and which one depends on the state: a live screen can
             only be revoked, a revoked one can only be removed. Showing both would put
             the destructive pair side by side on the row that is still working. -->
        <span class="actions">
          <Button
            v-if="device.status !== 'REVOKED'"
            label="Revoke"
            size="small"
            variant="text"
            severity="danger"
            :loading="busyId === device.id"
            @click="onRevoke(device)"
          />
          <Button
            v-else
            label="Remove"
            size="small"
            variant="text"
            severity="secondary"
            :loading="busyId === device.id"
            @click="onDelete(device)"
          />
        </span>
      </article>
    </div>

    <p v-else class="empty">
      No screens yet. Add one, then type its code into the tablet at
      <code>/kiosk</code> on the booking site — or add a phone line for the receptionist.
    </p>

    <Dialog
      :visible="dialogOpen"
      :header="issuedVoice ? 'Copy the Token' : issued ? 'Pair the Screen' : 'Add Screen'"
      modal
      :style="{ width: 'min(30rem, 94vw)' }"
      @update:visible="dialogOpen = $event"
    >
      <!-- The handover. Shown once and never retrievable — the server keeps a hash. -->
      <div v-if="issuedVoice" class="done">
        <p class="done-lede">
          Paste this into the assistant's <strong>server.headers</strong> in Vapi, as
          <strong>x-device-token</strong>.
        </p>

        <div class="code token">
          <code>{{ issuedVoice.deviceToken }}</code>
        </div>

        <Message severity="warn" :closable="false">
          This is shown once and cannot be read again. It does not expire — if it is lost
          or leaked, revoke this line and add a new one.
        </Message>
      </div>

      <div v-else-if="issuedCode" class="done">
        <p class="done-lede">
          Open <strong>/kiosk</strong> on the tablet and type this in.
        </p>

        <div class="code">
          <code>{{ issuedCode.pairingCode }}</code>
        </div>

        <Message v-if="expiresIn && expiresIn.seconds > 0" severity="info" :closable="false">
          Expires in <strong class="fc-num">{{ expiresIn.label }}</strong
          >. After that, add the screen again for a fresh code.
        </Message>
        <Message v-else severity="warn" :closable="false">
          This code has expired. Add the screen again for a fresh one.
        </Message>
      </div>

      <div v-else class="form">
        <div class="field">
          <label for="d-label" class="fc-label">Name</label>
          <InputText
            id="d-label"
            v-model="form.label"
            placeholder="Front counter"
            :invalid="Boolean(fieldErrors.label)"
            fluid
          />
          <p v-if="fieldErrors.label" class="err">{{ fieldErrors.label[0] }}</p>
          <p v-else class="hint">Something you will recognise in this list later.</p>
        </div>

        <div class="field">
          <span class="fc-label">Type</span>
          <div class="types">
            <label v-for="type in TYPES" :key="type.value" class="type">
              <RadioButton v-model="form.type" :value="type.value" :input-id="`t-${type.value}`" />
              <span class="type-text">
                <span class="type-name">{{ type.label }}</span>
                <span class="hint">{{ type.hint }}</span>
              </span>
            </label>
          </div>
        </div>
      </div>

      <template #footer>
        <template v-if="issued">
          <Button label="Done" @click="dialogOpen = false" />
        </template>
        <template v-else>
          <Button
            label="Cancel"
            severity="secondary"
            variant="text"
            @click="dialogOpen = false"
          />
          <Button
            :label="form.type === 'VOICE' ? 'Issue a Token' : 'Get a Code'"
            :loading="saving"
            @click="onCreate"
          />
        </template>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.screens {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  max-width: 60rem;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.sub {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.row {
  display: grid;
  grid-template-columns: minmax(10rem, 1.4fr) minmax(9rem, 1fr) minmax(8rem, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
  border: 1px solid var(--fc-line);
  border-radius: 8px;
  background: var(--fc-surface);
  padding: 0.625rem 0.875rem;
}

.row.revoked {
  opacity: 0.55;
}

.cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name {
  font-size: 0.9375rem;
  font-weight: 600;
}

.strong {
  font-size: 0.8125rem;
}

.meta {
  font-size: 0.6875rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
}

.status {
  font-size: 0.8125rem;
  font-weight: 600;
}

.status.paired {
  color: var(--fc-accent);
}

.status.pending {
  color: var(--fc-ink-muted);
}

.status.revoked {
  color: var(--fc-ink-faint);
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.empty {
  margin: 0;
  border: 1px dashed var(--fc-line);
  border-radius: 8px;
  padding: 2rem 1rem;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--fc-ink-faint);
}

.empty code {
  color: var(--fc-ink-muted);
}

/* --- Dialog ---------------------------------------------------------------- */

.form,
.done {
  display: flex;
  flex-direction: column;
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

.types {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.25rem;
}

.type {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
}

.type-text {
  display: flex;
  flex-direction: column;
}

.type-name {
  font-size: 0.875rem;
  font-weight: 550;
}

.type .hint {
  margin: 0;
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

/* Big, spaced and monospaced — it gets read aloud across a counter. */
.code {
  border: 1px solid var(--fc-accent);
  border-radius: 8px;
  background: var(--fc-accent-wash);
  padding: 1.25rem;
  text-align: center;
}

.code code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 2.25rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--fc-accent);
}

/**
 * A device token is 43 characters of base64url, not an eight-digit code. At the code's
 * size it would overflow the dialog; and it is read by selecting rather than by eye, so
 * it wants to be legible and wrappable rather than large.
 */
.token {
  padding: 0.9rem;
  text-align: left;
}

.token code {
  font-size: 0.95rem;
  font-weight: 500;
  letter-spacing: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: all;
}

.fc-num {
  font-variant-numeric: tabular-nums;
}

@media (max-width: 760px) {
  .row {
    grid-template-columns: 1fr auto;
    row-gap: 0.5rem;
  }

  .actions {
    grid-row: 1;
    grid-column: 2;
  }
}
</style>
