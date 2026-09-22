<script setup lang="ts">
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
</script>

<template>
  <!-- `<TransitionGroup>` rather than a plain list: toasts enter from the right
       and, when one leaves, the ones above it slide down together instead of
       snapping. `tag` keeps the flex column that positions them. -->
  <TransitionGroup name="toast" tag="div" class="toast-host">
    <div
      v-for="toast in ui.toasts"
      :key="toast.id"
      class="toast"
      :class="toast.kind"
      title="点击关闭"
      @click="ui.dismiss(toast.id)"
    >
      {{ toast.text }}
    </div>
  </TransitionGroup>
</template>
