<script setup lang="ts">
/**
 * Who the cut is for — the number first, and who it belongs to.
 *
 * The phone number **is** the client identity: `Client.phoneE164` is the unique key and
 * every write path resolves a person by it. So it leads the form, and once ten digits are
 * in it is worth asking who they are before anything else gets typed.
 *
 * **The name on file wins, and now it says so.** The server's findOrCreate is
 * `update: {}` — a returning client keeps the name they are already on record under and
 * the one typed on a repeat visit is discarded. That has always been true and used to
 * happen in silence; confirming it here is the whole point. The fields lock once confirmed
 * rather than staying editable, because an editable field whose value is thrown away is a
 * worse lie than a locked one.
 *
 * **"Different Number", not "Not them".** The number is the key, so there is no way to
 * attach a different name to it from this form — a name that looks wrong almost always
 * means the number was mistyped. The button says what the only available fix actually is.
 *
 * Staff-only by construction: `GET /clients/lookup` is behind `requireUser`, which a
 * paired device can never satisfy. The kiosk and the booking site use a different call
 * that returns a boolean and no name at all.
 */

import { formatPhone, type ClientDto } from '@francis/shared';

const props = defineProps<{
  /** Ten unmasked digits — `InputMask` with `unmask` keeps it that way. */
  phone: string;
  firstName: string;
  lastName: string;
  fieldErrors?: Record<string, string[]> | undefined;
  /** Distinguishes the ids when two of these ever sit on one page. */
  idPrefix?: string | undefined;
}>();

const emit = defineEmits<{
  'update:phone': [value: string];
  'update:firstName': [value: string];
  'update:lastName': [value: string];
  /** Fires when a known number is confirmed or released, so a parent can react. */
  resolved: [client: ClientDto | null];
}>();

const api = useApi();

const prefix = computed(() => props.idPrefix ?? 'cl');

const found = ref<ClientDto | null>(null);
const confirmed = ref<ClientDto | null>(null);
const modalOpen = ref(false);
const looking = ref(false);

const phoneRef = useTemplateRef<{ $el: HTMLElement } | null>('phoneField');

/** Ten digits is the whole number; anything less is somebody still typing. */
const complete = computed(() => props.phone.replace(/\D/g, '').length === 10);

/**
 * Debounced, and cancelled on every keystroke.
 *
 * A mask fills left to right, so a ten-digit number passes through no intermediate
 * "complete" state — but a correction does: deleting a digit and retyping it would fire
 * twice without this, and the second answer could land before the first.
 */
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;

async function lookup() {
  const mine = ++sequence;
  looking.value = true;

  try {
    const response = await api<{ client: ClientDto | null }>('/clients/lookup', {
      query: { phone: props.phone },
    });

    // A slower earlier request must not overwrite a newer answer.
    if (mine !== sequence) return;

    found.value = response.client;
    if (response.client !== null) modalOpen.value = true;
  } catch {
    // A lookup that fails is not an error the desk needs to see — the form still works,
    // it just stops being helpful. The submit will report anything that actually matters.
    if (mine === sequence) found.value = null;
  } finally {
    if (mine === sequence) looking.value = false;
  }
}

watch(
  () => props.phone,
  () => {
    clearTimeout(timer);

    // Changing the number releases whoever was confirmed against the old one.
    if (confirmed.value !== null) {
      confirmed.value = null;
      emit('resolved', null);
    }
    found.value = null;
    modalOpen.value = false;

    if (!complete.value) return;
    timer = setTimeout(() => void lookup(), 250);
  },
);

onUnmounted(() => clearTimeout(timer));

function useThem() {
  const client = found.value;
  if (client === null) return;

  confirmed.value = client;
  modalOpen.value = false;
  emit('update:firstName', client.firstName);
  emit('update:lastName', client.lastName ?? '');
  emit('resolved', client);
}

/**
 * The number was wrong, which is the only thing that can be wrong here. Clear it and put
 * the cursor back rather than closing onto a form that still holds somebody else's number.
 */
function differentNumber() {
  modalOpen.value = false;
  found.value = null;
  emit('update:phone', '');
  void nextTick(() => {
    phoneRef.value?.$el?.querySelector('input')?.focus();
  });
}

/**
 * "3 days ago" up close, a date once that stops being useful.
 *
 * Relative to the browser's clock rather than the shop's, unlike everything on the queue
 * and the calendar — this is how long ago something happened, not what time of day it is,
 * and no timezone changes the answer by enough to matter at this precision.
 */
const lastVisit = computed(() => {
  const iso = confirmed.value?.lastVisitAt ?? found.value?.lastVisitAt ?? null;
  if (iso === null) return null;

  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 21) return `${String(days)} days ago`;

  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
});
</script>

<template>
  <div class="who">
    <!-- The number leads. Everything below it is a consequence of what it resolves to. -->
    <div class="field">
      <label :for="`${prefix}-phone`" class="fc-label">Mobile Number</label>
      <!--
        `auto-clear` off and `unmask` on, and both matter.

        The default clears a half-typed number the moment the field loses focus — somebody
        glances at the service list and comes back to an empty box with no explanation.
        And `unmask` puts ten digits in the model rather than the punctuation, so what the
        form holds is data; formatting is a display decision made once, in `formatPhone`.
      -->
      <InputMask
        :id="`${prefix}-phone`"
        ref="phoneField"
        :model-value="props.phone"
        mask="(999) 999-9999"
        :auto-clear="false"
        unmask
        type="tel"
        inputmode="tel"
        placeholder="(415) 555-0123"
        :invalid="Boolean(props.fieldErrors?.phone)"
        fluid
        @update:model-value="emit('update:phone', $event ?? '')"
      />
      <p v-if="props.fieldErrors?.phone" class="err">{{ props.fieldErrors.phone[0] }}</p>
      <p v-else-if="looking" class="hint">Checking…</p>
      <p v-else class="hint">How we know who they are. A number we already have is reused.</p>
    </div>

    <div class="row">
      <div class="field">
        <label :for="`${prefix}-first`" class="fc-label">First Name</label>
        <InputText
          :id="`${prefix}-first`"
          :model-value="props.firstName"
          :disabled="confirmed !== null"
          :invalid="Boolean(props.fieldErrors?.firstName)"
          fluid
          @update:model-value="emit('update:firstName', $event ?? '')"
        />
        <p v-if="props.fieldErrors?.firstName" class="err">{{ props.fieldErrors.firstName[0] }}</p>
      </div>

      <div class="field">
        <label :for="`${prefix}-last`" class="fc-label">Last Name</label>
        <InputText
          :id="`${prefix}-last`"
          :model-value="props.lastName"
          :disabled="confirmed !== null"
          fluid
          @update:model-value="emit('update:lastName', $event ?? '')"
        />
        <p v-if="confirmed === null" class="hint">Only the initial is ever shown.</p>
      </div>
    </div>

    <p v-if="confirmed" class="hint onfile">
      Using the name we have on file for {{ formatPhone(confirmed.phoneE164) }}.
      <template v-if="confirmed.visitCount > 0">
        {{ confirmed.visitCount }} {{ confirmed.visitCount === 1 ? 'visit' : 'visits' }}<template
          v-if="lastVisit"
        >, last in {{ lastVisit }}</template>.
      </template>
    </p>

    <!-- We know this number ---------------------------------------------------- -->
    <Dialog
      :visible="modalOpen"
      :header="found?.isBlocked ? 'This Number Is Blocked' : 'We Know This Number'"
      modal
      :style="{ width: 'min(24rem, 94vw)' }"
      @update:visible="modalOpen = $event"
    >
      <div v-if="found" class="known">
        <p class="name">{{ found.firstName }} {{ found.lastName ?? '' }}</p>

        <p v-if="found.isBlocked" class="blocked">
          Blocked numbers cannot join the queue or book. An admin can lift it from the
          client record.
        </p>

        <!--
          `visitCount` only moves when a cut is completed, so a number the shop has taken
          a booking from but never finished a cut for sits at zero. "0 visits" reads as a
          fault; "not been in yet" is the same fact and is true.
        -->
        <div v-else class="facts">
          <span v-if="found.visitCount === 0">Not been in yet</span>
          <span v-else>
            <b>{{ found.visitCount }}</b>
            {{ found.visitCount === 1 ? 'visit' : 'visits' }}
          </span>
          <span v-if="lastVisit">last in <b>{{ lastVisit }}</b></span>
          <span v-if="found.noShowCount > 0">
            <b>{{ found.noShowCount }}</b>
            {{ found.noShowCount === 1 ? 'no-show' : 'no-shows' }}
          </span>
        </div>

        <p v-if="found.notes && !found.isBlocked" class="note">{{ found.notes }}</p>
      </div>

      <template #footer>
        <Button
          label="Different Number"
          severity="secondary"
          variant="outlined"
          @click="differentNumber"
        />
        <Button
          v-if="!found?.isBlocked"
          label="Yes, That's Them"
          @click="useThem"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.who {
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

.hint.onfile {
  margin: 0;
  color: var(--fc-accent);
  font-variant-numeric: tabular-nums;
}

/* --- The modal ------------------------------------------------------------- */

.known {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.name {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 1.35rem;
  font-weight: 680;
  line-height: 1.15;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
  font-variant-numeric: tabular-nums;
}

.facts b {
  color: var(--fc-ink-muted);
  font-weight: 620;
}

.note {
  margin: 0;
  padding: 0.5rem 0.65rem;
  border-left: 2px solid var(--fc-line);
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

.blocked {
  margin: 0;
  font-size: 0.85rem;
  color: var(--fc-danger-ink);
}

@media (max-width: 520px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
