import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '@shared/types'

/**
 * Client-owned settings.
 *
 * The interface lives in shared/types so the renderer can type the settings
 * payload without importing main-process code. The file itself is stored in
 * Electron's userData directory rather than inside `~/.opencodereview`: that
 * directory belongs to the CLI, and we should not add files it might trip over.
 */

const DEFAULTS: AppSettings = {
  gitOverride: null,
  ocrOverride: null,
  manualRepos: [],
  ignoredRepos: []
}

let cache: AppSettings | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): AppSettings {
  if (cache) return cache
  try {
    const text = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(text) as Partial<AppSettings>
    cache = {
      ...DEFAULTS,
      ...parsed,
      manualRepos: Array.isArray(parsed.manualRepos) ? parsed.manualRepos : [],
      ignoredRepos: Array.isArray(parsed.ignoredRepos) ? parsed.ignoredRepos : []
    }
  } catch {
    // Missing or corrupt settings fall back to defaults rather than failing boot.
    cache = { ...DEFAULTS }
  }
  return cache
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...readSettings(), ...patch }
  const file = settingsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('failed to persist settings:', err)
  }
  cache = next
  return next
}
