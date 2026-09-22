import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ViewKey = 'welcome' | 'new-review' | 'results' | 'settings'

export interface Toast {
  id: number
  kind: 'ok' | 'error' | 'info'
  text: string
}

/**
 * Navigation and transient notifications.
 *
 * Deliberately not vue-router: this is a single-window desktop shell where the
 * left rail stays mounted and only the right pane swaps. URL semantics would add
 * hash-history machinery for no benefit.
 */
export const useUiStore = defineStore('ui', () => {
  const view = ref<ViewKey>('welcome')
  const toasts = ref<Toast[]>([])
  const sidebarWidth = ref(288)

  let sequence = 0

  function showView(next: ViewKey): void {
    view.value = next
  }

  function notify(text: string, kind: Toast['kind'] = 'info', ttlMs = 5200): void {
    const id = ++sequence
    toasts.value = [...toasts.value, { id, kind, text }]
    window.setTimeout(() => dismiss(id), ttlMs)
  }

  function notifyError(err: unknown): void {
    notify(err instanceof Error ? err.message : String(err), 'error', 9000)
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return { view, toasts, sidebarWidth, showView, notify, notifyError, dismiss }
})
