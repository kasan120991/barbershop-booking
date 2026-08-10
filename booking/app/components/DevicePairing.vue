<script setup lang="ts">
/**
 * Claiming a screen, once.
 *
 * The same on the kiosk and on the wall board, which is why it is a component: the code
 * field is trivial, but surfacing the server's own refusal is not. "Not a valid code",
 * "That code has expired" and "That code has already been used" are three different
 * problems with three different fixes, and whoever is standing there holding the tablet
 * needs to know which one they have. Flattening them into "Pairing failed" turns a
 * thirty-second fix into a phone call.
 */

const props = defineProps<{
  /** What this screen is for, in the heading — "kiosk" reads better than "device". */
  what: string;
}>();

const screen = useDeviceScreen();

const code = ref('');
const working = ref(false);
const failure = ref<string | null>(null);

const emit = defineEmits<{ paired: [] }>();

async function submit(): Promise<void> {
  if (working.value) return;
  working.value = true;
  failure.value = null;

  try {
    await screen.pair(code.value);
    code.value = '';
    emit('paired');
  } catch (error) {
    failure.value = toApiFailure(error).message;
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <section class="pair">
    <h1>Set this {{ props.what }} up</h1>
    <p class="lede">
      Ask an admin to add a screen in the staff app, then type the code here. It is only
      needed once.
    </p>

    <div class="pair-form">
      <InputText
        v-model="code"
        class="code-input fcb-num"
        inputmode="numeric"
        autocomplete="off"
        placeholder="0000-0000"
        aria-label="Pairing code"
        @keyup.enter="submit"
      />
      <Button label="Pair" size="large" :loading="working" @click="submit" />
    </div>

    <Message v-if="failure" severity="error" :closable="false">{{ failure }}</Message>
  </section>
</template>

<style scoped>
.pair {
  margin: auto;
  max-width: 30rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  text-align: center;
  align-items: center;
}

h1 {
  margin: 0;
  font-family: var(--fcb-font-display);
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.lede {
  margin: 0;
  color: var(--fcb-rail-muted);
  font-size: 1.0625rem;
}

.pair-form {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
}

.code-input :deep(input),
.code-input {
  font-size: 2rem;
  letter-spacing: 0.18em;
  text-align: center;
  /* Wide enough for "0000-0000" WITH the tracking — at 12ch the placeholder was clipped
     mid-digit, which reads as a broken field rather than as a hint. */
  width: 14ch;
}
</style>
