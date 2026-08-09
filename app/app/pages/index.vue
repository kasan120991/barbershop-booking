<script setup lang="ts">
/**
 * `/` has no content of its own — it forwards to whichever hat you are wearing.
 *
 * A redirect rather than a dashboard, because "home" genuinely differs by role: the
 * shop's calendar and a barber's own day are different screens, and neither is a
 * sensible default for the other.
 */

const { homeRoute } = useShopMode();

await navigateTo(homeRoute.value, { replace: true });
</script>

<template>
  <div />
</template>
