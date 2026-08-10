<script setup lang="ts">
/**
 * The wall shell.
 *
 * Less than the kiosk's, not more: no header bar, no Toast, no link, nothing to touch.
 * The board draws its own top bar because the clock belongs to the board, and a screen
 * nobody can reach has no use for a notification that disappears after four seconds.
 *
 * `--u` is the whole layout system. Everything on this screen is sized in multiples of
 * it rather than in rem, because the design constraint is *read from three metres*, not
 * *read at arm's length* — a 24px heading is correct on a tablet and invisible on a wall.
 * At 16:9 one `--u` is exactly 1% of the width, which is what the mockup was drawn in;
 * the `vh` term takes over on a shorter panel so a wide-and-short screen shrinks the type
 * instead of pushing the bottom of the queue off the glass.
 */
</script>

<template>
  <div class="display-shell fcb-screen">
    <slot />
  </div>
</template>

<style scoped>
.display-shell {
  --u: min(1vw, 1.78vh);
  height: 100%;
  display: flex;
  flex-direction: column;
  /* Nothing here scrolls. If it does not fit, the board says how many did not. */
  overflow: hidden;
}
</style>
