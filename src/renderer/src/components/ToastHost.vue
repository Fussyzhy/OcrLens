<script setup lang="ts">
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="toast-host">
    <div v-for="toast in ui.toasts" :key="toast.id" class="toast" :class="toast.kind">
      {{ toast.text }}
    </div>
  </div>
</template>
