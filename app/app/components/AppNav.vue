<script setup lang="ts">
/**
 * Renders the nav for the current mode.
 *
 * Shared by the desktop rail and the mobile drawer so the two cannot drift — the
 * drawer is the same navigation at a different size, not a second implementation.
 *
 * When collapsed, the label is removed from the flow entirely rather than hidden
 * with CSS, and a tooltip carries it instead. Visually-hidden text would still be
 * announced by a screen reader alongside the icon's own label, reading everything
 * twice.
 */

const props = withDefaults(
  defineProps<{
    collapsed?: boolean;
    /** Coarse pointers get larger targets; the drawer is always touch-first. */
    touch?: boolean;
  }>(),
  { collapsed: false, touch: false },
);

const route = useRoute();
const { items } = useNavigation();

const emit = defineEmits<{ navigate: [] }>();
</script>

<template>
  <nav aria-label="Main" :class="{ 'is-collapsed': props.collapsed, 'is-touch': props.touch }">
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      v-tooltip.right="props.collapsed ? item.label : undefined"
      :to="item.to"
      class="nav-item"
      :class="{ 'is-active': route.path === item.to }"
      :aria-current="route.path === item.to ? 'page' : undefined"
      :aria-label="props.collapsed ? item.label : undefined"
      @click="emit('navigate')"
    >
      <component :is="item.icon" class="icon" aria-hidden="true" />
      <span v-if="!props.collapsed" class="label">{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>

<style scoped>
nav {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.625rem;
  border-radius: 5px;
  color: var(--fc-ink-muted);
  text-decoration: none;
  font-size: 0.8125rem;
  transition: background-color 120ms ease, color 120ms ease;
}

.nav-item:hover {
  color: var(--fc-ink);
  background: rgba(255, 255, 255, 0.03);
}

.nav-item:focus-visible {
  outline: 2px solid var(--fc-accent);
  outline-offset: -2px;
}

.icon {
  width: 1rem;
  height: 1rem;
  flex: none;
  /* The icons are currentColor SVGs, so they inherit the active/hover treatment. */
  color: inherit;
}

.nav-item.is-active {
  background: var(--fc-accent-wash);
  color: var(--fc-ink);
}

.nav-item.is-active .icon {
  color: var(--fc-accent);
}

.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

nav.is-collapsed .nav-item {
  justify-content: center;
  padding-inline: 0;
}

/* A finger is not a mouse pointer: 44px is the smallest reliably tappable target,
   and the counter tablet is the primary device. Costs desktop nothing. */
nav.is-touch .nav-item {
  min-height: 44px;
}

@media (pointer: coarse) {
  .nav-item {
    min-height: 44px;
  }
}
</style>
