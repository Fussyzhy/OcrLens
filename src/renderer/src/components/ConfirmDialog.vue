<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

/**
 * A small confirmation modal.
 *
 * Deliberately rendered by the caller rather than through Electron's native
 * `dialog.showMessageBox`: a renderer-side modal keeps the flow testable by
 * driving the real DOM, and lets the dialog show the same severity styling as the
 * rest of the app.
 */
const props = withDefaults(
  defineProps<{
    title: string
    message: string
    /** Optional monospace detail block, e.g. an id or path. */
    detail?: string
    confirmLabel?: string
    /** Styles the confirm button as destructive. */
    danger?: boolean
    busy?: boolean
  }>(),
  { detail: '', confirmLabel: '确定', danger: false, busy: false }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

/**
 * Escape closes the dialog.
 *
 * Bound on the window rather than on the backdrop: the backdrop is not
 * focusable, so a `@keydown.esc` on it would never fire.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.busy) emit('cancel')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- Dismissing by clicking away is a shortcut, not an escape hatch: it is off
       while the confirmed operation is still running. -->
  <div class="modal-backdrop" @click.self="!busy && emit('cancel')">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>{{ title }}</h3>
      <p class="modal-message">{{ message }}</p>
      <pre v-if="detail" class="modal-detail">{{ detail }}</pre>

      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="emit('cancel')">取消</button>
        <button
          class="btn"
          :class="danger ? 'danger' : 'primary'"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? '处理中…' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
