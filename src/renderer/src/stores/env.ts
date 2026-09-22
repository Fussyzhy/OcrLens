import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppSettings, EnvInfo } from '@shared/types'
import { unwrap } from '../utils/ipc'

/**
 * The resolved local environment plus this client's own settings.
 *
 * `warnings` is the interesting bit: it is where the MSYS2-git override shows up,
 * so the UI can explain why a review that works in the user's terminal would
 * otherwise fail when launched from the desktop.
 */
export const useEnvStore = defineStore('env', () => {
  const info = ref<EnvInfo | null>(null)
  const settings = ref<AppSettings | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const ready = computed(() => info.value !== null)
  const hasOcr = computed(() => Boolean(info.value?.ocrPath))
  const hasGit = computed(() => Boolean(info.value?.gitPath))
  const warnings = computed(() => info.value?.warnings ?? [])

  async function load(force = false): Promise<void> {
    if (loading.value) return
    loading.value = true
    error.value = null
    try {
      info.value = await unwrap(force ? window.ocr.refreshEnv() : window.ocr.envInfo())
      settings.value = await unwrap(window.ocr.getSettings())
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  /** Persists a path override and re-probes the environment. */
  async function setOverride(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await unwrap(window.ocr.setSettings(patch))
    info.value = await unwrap(window.ocr.envInfo())
  }

  return { info, settings, loading, error, ready, hasOcr, hasGit, warnings, load, setOverride }
})
