<script setup lang="ts">
/**
 * Shell for signed-in pages.
 *
 * Deliberately minimal for now — the shell gets its own round of design variants
 * before nav, admin/barber differentiation, and the queue indicator land. This is
 * enough to prove the auth loop and no more.
 */

const auth = useAuthStore();
const signingOut = ref(false);

async function onSignOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await auth.signOut();
    await navigateTo('/login');
  } finally {
    signingOut.value = false;
  }
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="fc-pole" aria-hidden="true" />
        <p class="fc-wordmark">Francis Cutz</p>
      </div>

      <div class="account">
        <span class="who">{{ auth.displayName }}</span>
        <Button
          severity="secondary"
          variant="text"
          size="small"
          label="Sign out"
          :loading="signingOut"
          @click="onSignOut"
        />
      </div>
    </header>

    <main class="content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--fc-ground);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem clamp(1rem, 3vw, 2rem);
  border-bottom: 1px solid var(--fc-line);
  background: var(--fc-surface);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.account {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.who {
  font-size: 0.8125rem;
  color: var(--fc-ink-muted);
}

.content {
  flex: 1;
  padding: clamp(1.5rem, 4vw, 2.5rem);
  width: min(72rem, 100%);
  margin-inline: auto;
}
</style>
