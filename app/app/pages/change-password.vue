<script setup lang="ts">
/**
 * Change password — reached two ways.
 *
 * FORCED: an admin reset the password and handed a temporary one across the counter.
 * The guard pins the user here until it is replaced, because otherwise they simply
 * keep using a password the admin knows.
 *
 * VOLUNTARY (`?voluntary=1`): chosen from the account menu, and escapable.
 *
 * The wrinkle worth handling: the API revokes EVERY session on a password change,
 * including this one. A naive implementation would drop someone at the login screen
 * moments after they proved who they are. Since the new password is in hand, this
 * signs straight back in and carries on.
 */

import { changePasswordRequestSchema, MIN_PASSWORD_LENGTH } from '@francis/shared';

definePageMeta({ layout: 'auth' });
useHead({ title: 'Change Password — Francis Cutz' });

const auth = useAuthStore();
const route = useRoute();
const { homeRoute } = useShopMode();
const { notifySuccess } = useNotify();

const isForced = computed(() => auth.mustChangePassword);

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const masked = ref(true);
const pending = ref(false);

const formError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string[]>>({});

const currentInvalid = computed(() => Boolean(fieldErrors.value.currentPassword?.length));
const newInvalid = computed(() => Boolean(fieldErrors.value.newPassword?.length));
const confirmInvalid = computed(() => Boolean(fieldErrors.value.confirmPassword?.length));

async function onSubmit() {
  if (pending.value) return;

  formError.value = null;
  fieldErrors.value = {};

  // The confirm field is ours alone — the API neither needs nor receives it.
  if (newPassword.value !== confirmPassword.value) {
    fieldErrors.value = { confirmPassword: ['Those passwords do not match.'] };
    formError.value = 'Check the highlighted fields.';
    return;
  }

  const parsed = changePasswordRequestSchema.safeParse({
    currentPassword: currentPassword.value,
    newPassword: newPassword.value,
  });

  if (!parsed.success) {
    fieldErrors.value = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    formError.value = 'Check the highlighted fields.';
    return;
  }

  pending.value = true;
  const api = useApi();

  try {
    await api('/auth/change-password', { method: 'POST', body: parsed.data });

    // Every session was just revoked, this one included. Sign back in with the
    // password we already hold rather than bouncing them to the login screen.
    await auth.signIn({ email: auth.user?.email ?? '', password: parsed.data.newPassword });

    notifySuccess('Password changed');
    await navigateTo(homeRoute.value, { replace: true });
  } catch (error) {
    const failure = toApiFailure(error);

    if (failure.status === 400 && failure.fields) {
      fieldErrors.value = failure.fields;
      formError.value = 'Check the highlighted fields.';
    } else if (failure.status === 401) {
      // The API returns 401 for a wrong CURRENT password. Without this branch the
      // global interceptor's meaning ("session expired") would be badly misleading.
      fieldErrors.value = { currentPassword: ['That is not your current password.'] };
      formError.value = 'Check the highlighted fields.';
    } else {
      formError.value = failure.message;
    }

    currentPassword.value = '';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="change">
    <div>
      <h1>Change Password</h1>
      <p v-if="isForced" class="lede">
        Your password was reset by an admin. Choose a new one to carry on.
      </p>
      <p v-else class="lede">Choose a new password for your account.</p>
    </div>

    <form novalidate @submit.prevent="onSubmit">
      <Message v-if="formError" severity="error" :closable="false" class="alert">
        {{ formError }}
      </Message>

      <div class="field">
        <label for="current" class="fc-label">Current Password</label>
        <InputPassword
          id="current"
          v-model="currentPassword"
          :mask="masked"
          autocomplete="current-password"
          :invalid="currentInvalid"
          :disabled="pending"
          fluid
        />
        <p v-if="currentInvalid" class="field-error">{{ fieldErrors.currentPassword?.[0] }}</p>
      </div>

      <div class="field">
        <label for="next" class="fc-label">New Password</label>
        <InputPassword
          id="next"
          v-model="newPassword"
          :mask="masked"
          autocomplete="new-password"
          :invalid="newInvalid"
          :disabled="pending"
          fluid
        />
        <p v-if="newInvalid" class="field-error">{{ fieldErrors.newPassword?.[0] }}</p>
        <p v-else class="field-hint">At least {{ MIN_PASSWORD_LENGTH }} characters.</p>
      </div>

      <div class="field">
        <label for="confirm" class="fc-label">Confirm New Password</label>
        <InputPassword
          id="confirm"
          v-model="confirmPassword"
          :mask="masked"
          autocomplete="new-password"
          :invalid="confirmInvalid"
          :disabled="pending"
          fluid
        />
        <p v-if="confirmInvalid" class="field-error">{{ fieldErrors.confirmPassword?.[0] }}</p>
      </div>

      <Button type="submit" label="Change Password" :loading="pending" fluid />

      <!-- No escape when forced: leaving would mean keeping a password the admin
           knows. Offered only when they chose to be here. -->
      <NuxtLink v-if="!isForced" :to="homeRoute" class="cancel">Cancel</NuxtLink>
    </form>
  </div>
</template>

<style scoped>
.change {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

h1 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 1.125rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.lede {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
}

.alert {
  margin: 0;
}

.field-error {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
  color: var(--fc-danger-ink);
}

.field-hint {
  margin: 0.375rem 0 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.cancel {
  align-self: center;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}

.cancel:hover {
  color: var(--fc-accent);
}
</style>
