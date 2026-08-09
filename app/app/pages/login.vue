<script setup lang="ts">
/**
 * Staff sign-in.
 *
 * The three failure modes are genuinely different and are surfaced differently:
 *   401 — wrong credentials. Generic by design; the API deliberately does not say
 *         whether the email exists, so neither do we.
 *   400 — field validation. Highlight the offending input.
 *   403 — the account is LOCKED. This one matters: retyping the password will never
 *         work, so the message has to send them to the owner instead of letting them
 *         keep guessing into a wall.
 */

import { loginRequestSchema } from '@francis/shared';

definePageMeta({ layout: 'auth' });
useHead({ title: 'Sign in — Francis Cutz' });

const auth = useAuthStore();
const route = useRoute();

const email = ref('');
const password = ref('');
const masked = ref(true);
const pending = ref(false);

const formError = ref<string | null>(null);
const isLockedOut = ref(false);
const fieldErrors = ref<Record<string, string[]>>({});

const emailInvalid = computed(() => Boolean(fieldErrors.value.email?.length));
const passwordInvalid = computed(() => Boolean(fieldErrors.value.password?.length));

async function onSubmit() {
  if (pending.value) return;

  formError.value = null;
  isLockedOut.value = false;
  fieldErrors.value = {};

  // Validate against the same schema the server uses, so an obvious typo is caught
  // without a round trip. The server still re-validates — this is convenience only.
  const parsed = loginRequestSchema.safeParse({
    email: email.value.trim(),
    password: password.value,
  });

  if (!parsed.success) {
    const flattened = parsed.error.flatten().fieldErrors;
    fieldErrors.value = flattened as Record<string, string[]>;
    formError.value = 'Check the highlighted fields.';
    return;
  }

  pending.value = true;

  try {
    await auth.signIn(parsed.data);

    const redirect = route.query.redirect;
    await navigateTo(typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/');
  } catch (error) {
    const failure = toApiFailure(error);

    if (failure.status === 403) {
      isLockedOut.value = true;
      formError.value = failure.message;
    } else if (failure.status === 400 && failure.fields) {
      fieldErrors.value = failure.fields;
      formError.value = 'Check the highlighted fields.';
    } else {
      formError.value = failure.message;
    }

    password.value = '';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="login">
    <h1>Sign in</h1>

    <form novalidate @submit.prevent="onSubmit">
      <Message
        v-if="formError"
        :severity="isLockedOut ? 'warn' : 'error'"
        :closable="false"
        class="alert"
      >
        {{ formError }}
        <template v-if="isLockedOut">
          <br >
          <span class="alert-hint">Kasan can unlock it for you.</span>
        </template>
      </Message>

      <div class="field">
        <label for="email" class="fc-label">Email</label>
        <InputText
          id="email"
          v-model="email"
          type="email"
          autocomplete="username"
          :invalid="emailInvalid"
          :disabled="pending"
          fluid
          autofocus
        />
        <p v-if="emailInvalid" class="field-error">{{ fieldErrors.email?.[0] }}</p>
      </div>

      <div class="field">
        <label for="password" class="fc-label">Password</label>
        <div class="password-wrap">
          <InputPassword
            id="password"
            v-model="password"
            :mask="masked"
            autocomplete="current-password"
            :invalid="passwordInvalid"
            :disabled="pending"
            fluid
          />
          <button
            type="button"
            class="reveal"
            :aria-pressed="!masked"
            @click="masked = !masked"
          >
            {{ masked ? 'Show' : 'Hide' }}
          </button>
        </div>
        <p v-if="passwordInvalid" class="field-error">{{ fieldErrors.password?.[0] }}</p>
      </div>

      <!-- `label` and `loading` are deprecated in v5 and removed in v6; still the
           idiomatic v5 form, and preferable to hand-rolling a spinner. -->
      <Button type="submit" label="Sign in" :loading="pending" fluid />
    </form>

    <p class="foot">Locked out? An admin can reset your password in person.</p>
  </div>
</template>

<style scoped>
.login {
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

.alert-hint {
  color: var(--fc-ink-muted);
  font-size: 0.8125rem;
}

.field-error {
  margin: 0.375rem 0 0;
  font-size: 0.8125rem;
  color: var(--fc-danger-ink);
}

.password-wrap {
  position: relative;
}

.reveal {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: 0;
  color: var(--fc-ink-faint);
  cursor: pointer;
  padding: 0.25rem 0.375rem;
  font: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 3px;
}

.reveal:hover {
  color: var(--fc-ink-muted);
}

.reveal:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: 1px;
}

.foot {
  margin: 0;
  font-size: 0.75rem;
  color: var(--fc-ink-faint);
}
</style>
