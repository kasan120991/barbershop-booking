<script setup lang="ts">
/**
 * Placeholder landing page.
 *
 * Its only job right now is to prove the auth loop end to end: it renders who you
 * are and which roles you hold, both of which come from the server session rather
 * than from anything the client could fabricate. The real dashboard arrives with
 * the admin and barber views.
 */

useHead({ title: 'Francis Cutz — Staff' });

const auth = useAuthStore();
</script>

<template>
  <div class="landing">
    <div>
      <p class="eyebrow">Signed in</p>
      <h1>{{ auth.displayName }}</h1>
      <p class="email">{{ auth.user?.email }}</p>
    </div>

    <div class="roles">
      <Tag
        v-for="role in auth.user?.roles ?? []"
        :key="role"
        :value="role"
        :severity="role === 'ADMIN' ? 'warn' : 'secondary'"
      />
    </div>

    <!-- The owner both administers the shop and cuts hair, which is exactly why
         roles are a set rather than a single column. -->
    <p v-if="auth.isAdmin && auth.isBarber" class="note">
      You hold both roles — you can manage the shop and take your own appointments.
    </p>

    <p v-if="auth.user?.barberId" class="note">
      Barber profile linked:
      <code>{{ auth.user.barberId }}</code>
    </p>

    <p class="next">Admin and barber views land in the next phases.</p>
  </div>
</template>

<style scoped>
.landing {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 44rem;
}

.eyebrow {
  margin: 0 0 0.25rem;
  font-size: 0.6875rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fc-ink-faint);
}

h1 {
  margin: 0;
  font-family: var(--fc-font-display);
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.015em;
}

.email {
  margin: 0.25rem 0 0;
  color: var(--fc-ink-muted);
  font-size: 0.875rem;
}

.roles {
  display: flex;
  gap: 0.5rem;
}

.note {
  margin: 0;
  color: var(--fc-ink-muted);
  font-size: 0.875rem;
}

.note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  color: var(--fc-accent);
}

.next {
  margin: 0.5rem 0 0;
  padding-top: 1rem;
  border-top: 1px solid var(--fc-line);
  color: var(--fc-ink-faint);
  font-size: 0.8125rem;
}
</style>
