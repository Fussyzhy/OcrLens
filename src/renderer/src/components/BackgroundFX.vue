<script setup lang="ts">
/**
 * Ambient background.
 *
 * Four layers, all purely decorative and all extremely low contrast, because
 * this sits *behind* text: a dot lattice that drifts, three blurred aurora
 * orbs on independent slow orbits, a sheen that sweeps across once every half
 * minute, and a vignette that keeps the centre calm so the chrome keeps its
 * edge over the movement.
 *
 * Rendering it once in `App.vue` (rather than per view) means navigation never
 * restarts an animation — a background that jumps on every click reads as a
 * glitch, not as depth. `position: fixed` keeps it out of the shell's flex
 * flow, and `pointer-events: none` keeps it out of the hit-testing path.
 *
 * Everything here is disabled by the `prefers-reduced-motion` block in
 * styles.css, which is the only correct way to offer this: the animation is
 * decoration, so a user who asked the OS for less motion gets none of it.
 */
</script>

<template>
  <div class="bg-fx" aria-hidden="true">
    <div class="bg-fx__grid" />
    <div class="bg-fx__orb bg-fx__orb--a" />
    <div class="bg-fx__orb bg-fx__orb--b" />
    <div class="bg-fx__orb bg-fx__orb--c" />
    <div class="bg-fx__sheen" />
    <div class="bg-fx__vignette" />
  </div>
</template>
