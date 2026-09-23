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

/** Accepts a string, or falls back — for the `string | null` fields. */
function text(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback
}

/** Accepts an array of strings, ignoring anything else in it. */
function paths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Coerces a settings-shaped object into the shape this app actually promises.
 *
 * Both sides of this file's boundary are untrusted: settings.json is
 * hand-editable (and may have been written by an older version), and a patch
 * arrives over IPC from the renderer. Without this, a non-string `gitOverride`
 * was persisted and later reached `path.resolve()`, failing with a TypeError that
 * had nothing to do with the field the user edited. Anything not named here is
 * dropped, which is also how fields from earlier versions retire.
 */
function normalize(raw: Partial<AppSettings>): AppSettings {
  return {
    gitOverride: text(raw.gitOverride, null),
    ocrOverride: text(raw.ocrOverride, null),
    manualRepos: paths(raw.manualRepos),
    ignoredRepos: paths(raw.ignoredRepos)
  }
}

export function readSettings(): AppSettings {
  if (cache) return cache
  try {
    const contents = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(contents) as Partial<AppSettings>
    cache = normalize(parsed)
  } catch {
    // Missing or corrupt settings fall back to defaults rather than failing boot.
    cache = { ...DEFAULTS }
  }
  return cache
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalize({ ...readSettings(), ...patch })
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
