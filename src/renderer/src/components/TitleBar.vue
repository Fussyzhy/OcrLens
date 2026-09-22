<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/**
 * The window's own title bar.
 *
 * The window is frameless (see main/index.ts), so this bar *is* the chrome: it
 * is the drag region, and these three buttons are the only way to minimise,
 * maximise or close. The glyphs are inline SVG rather than a font or an icon
 * dependency, so 1px strokes stay crisp at every display scale.
 *
 * The bar is laid out on the shell's grid: its left segment repeats the
 * sidebar's width and colour, so the sidebar reads as running up through the
 * chrome instead of stopping under an empty strip.
 */

/** Tracks the window's real state, which the OS can change without asking us. */
const maximized = ref(false)
let stopWatching: (() => void) | null = null

onMounted(async () => {
  stopWatching = window.ocr.onWindowMaximized((value) => {
    maximized.value = value
  })
  // A reload can land in a window that is already maximised.
  const current = await window.ocr.windowIsMaximized()
  if (current.ok) maximized.value = current.data
})

onUnmounted(() => stopWatching?.())

function minimize(): void {
  void window.ocr.windowMinimize()
}

async function toggleMaximize(): Promise<void> {
  const result = await window.ocr.windowToggleMaximize()
  if (result.ok) maximized.value = result.data
}

function close(): void {
  void window.ocr.windowClose()
}
</script>

<template>
  <header class="titlebar">
    <div class="titlebar-side" />

    <div class="titlebar-main">
      <div class="window-controls">
        <button
          class="window-btn"
          type="button"
          title="最小化"
          aria-label="最小化"
          @click="minimize"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            shape-rendering="crispEdges"
          >
            <path d="M0 5.5h10" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>

        <button
          class="window-btn"
          type="button"
          :title="maximized ? '向下还原' : '最大化'"
          :aria-label="maximized ? '向下还原' : '最大化'"
          @click="toggleMaximize"
        >
          <!-- Restore: the front pane overlaps the back one, the way Windows
               draws "not maximised any more". -->
          <svg
            v-if="maximized"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            shape-rendering="crispEdges"
          >
            <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1" />
            <rect
              x="0.5"
              y="2.5"
              width="7"
              height="7"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
          <svg
            v-else
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            shape-rendering="crispEdges"
          >
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
        </button>

        <button class="window-btn close" type="button" title="关闭" aria-label="关闭" @click="close">
          <!-- Diagonals are left to anti-alias rather than snapped to the grid. -->
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5 9.5 9.5M9.5 0.5 0.5 9.5" stroke="currentColor" stroke-width="1.1" />
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>
