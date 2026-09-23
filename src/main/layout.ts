import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { RepoEntry, SessionListEntry } from '@shared/types'

/**
 * Client-owned sidebar layout: the order the user dragged repositories and
 * sessions into, and the display name they gave a repository.
 *
 * `ocr` has no concept of either — it lists sessions newest-first and a
 * repository is named after its folder — so this lives beside the app's other
 * client-owned state rather than inside `~/.opencodereview`, which belongs to the
 * CLI.
 *
 * Keys are normalised (resolved, lowercased, no trailing separator) because one
 * repository can arrive from three places — the CLI's storage key, a manual pin,
 * or a session record — and Windows paths compare case-insensitively.
 */

interface LayoutState {
  /** Repositories in the order the user arranged them. */
  repoOrder: string[]
  /** Display name per repository, when it differs from the folder name. */
  repoAliases: Record<string, string>
  /** Session ids per repository, in the order the user arranged them. */
  sessionOrder: Record<string, string[]>
}

const EMPTY: LayoutState = { repoOrder: [], repoAliases: {}, sessionOrder: {} }

let cache: LayoutState | null = null

function layoutPath(): string {
  return path.join(app.getPath('userData'), 'sidebar-layout.json')
}

/** Stable key for anything that identifies a repository. */
export function normalizeKey(dir: string): string {
  const trimmed = dir.trim()
  if (!trimmed) return ''
  return path.resolve(trimmed).replace(/[\\/]+$/, '').toLowerCase()
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Reads the layout file, tolerating absence and hand-edited rubbish. */
function load(): LayoutState {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(layoutPath(), 'utf8')) as Partial<LayoutState>
    const aliases: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed.repoAliases ?? {})) {
      if (typeof value === 'string' && value.trim()) aliases[key] = value.trim()
    }

    const sessionOrder: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(parsed.sessionOrder ?? {})) {
      const ids = strings(value)
      const normalized = normalizeKey(key)
      if (ids.length && normalized) sessionOrder[normalized] = ids
    }

    // Everything written above is normalized, but this file is plain JSON next to
    // the user's settings: a hand-edited path (different case, a trailing slash)
    // would otherwise never match and the stored order would vanish silently.
    const repoOrder = strings(parsed.repoOrder)
      .map((entry) => normalizeKey(entry))
      .filter(Boolean)

    cache = { repoOrder, repoAliases: aliases, sessionOrder }
  } catch {
    // A missing or unreadable file simply means "nothing has been arranged yet".
    cache = { ...EMPTY, repoAliases: {}, sessionOrder: {} }
  }
  return cache
}

function persist(next: LayoutState): LayoutState {
  try {
    fs.mkdirSync(path.dirname(layoutPath()), { recursive: true })
    fs.writeFileSync(layoutPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('failed to persist the sidebar layout:', err)
  }
  cache = next
  return next
}

/**
 * Applies the stored name and order to the discovered repository list.
 *
 * Repositories the user has never placed keep the order they came in with —
 * most recently active first, which is `listRepos`' own fallback — and sit above
 * the arranged ones. That way the very first drag stores a complete order, while
 * a repository discovered afterwards still lands at the top where a fresh
 * session is impossible to miss.
 */
export function applyRepoLayout(entries: RepoEntry[]): RepoEntry[] {
  const state = load()

  const named = entries.map((entry) => {
    const alias = state.repoAliases[normalizeKey(entry.dir || entry.key)]
    return alias ? { ...entry, name: alias } : entry
  })

  const rank = new Map<string, number>()
  state.repoOrder.forEach((dir, index) => rank.set(dir, index))

  const unplaced: RepoEntry[] = []
  const placed: Array<{ entry: RepoEntry; at: number }> = []
  for (const entry of named) {
    const at = rank.get(normalizeKey(entry.dir || entry.key))
    if (at === undefined) unplaced.push(entry)
    else placed.push({ entry, at })
  }

  placed.sort((a, b) => a.at - b.at)
  return [...unplaced, ...placed.map((item) => item.entry)]
}

/**
 * Applies the stored session order to one repository's list.
 *
 * Same rule as repositories: sessions the user has not placed keep the CLI's
 * order (newest first) and stay on top, so a review that just finished is the
 * first row while everything below it stays where it was put.
 */
export function applySessionOrder(repoDir: string, list: SessionListEntry[]): SessionListEntry[] {
  const stored = load().sessionOrder[normalizeKey(repoDir)]
  if (!stored?.length) return list

  const rank = new Map<string, number>()
  stored.forEach((id, index) => rank.set(id, index))

  const unplaced: SessionListEntry[] = []
  const placed: Array<{ entry: SessionListEntry; at: number }> = []
  for (const entry of list) {
    const at = rank.get(entry.session_id)
    if (at === undefined) unplaced.push(entry)
    else placed.push({ entry, at })
  }

  placed.sort((a, b) => a.at - b.at)
  return [...unplaced, ...placed.map((item) => item.entry)]
}

/** Stores the full repository order the renderer just arranged. */
export function setRepoOrder(dirs: string[]): string[] {
  const state = load()
  const seen = new Set<string>()
  const order: string[] = []

  for (const dir of dirs) {
    const key = normalizeKey(dir)
    if (!key || seen.has(key)) continue
    seen.add(key)
    order.push(key)
  }

  return persist({ ...state, repoOrder: order }).repoOrder
}

/** Stores the full session order for one repository. */
export function setSessionOrder(repoDir: string, sessionIds: string[]): string[] {
  const state = load()
  const key = normalizeKey(repoDir)
  if (!key) return []

  const ids = sessionIds.filter((id) => typeof id === 'string' && id)
  const sessionOrder = { ...state.sessionOrder }
  if (ids.length) sessionOrder[key] = ids
  else delete sessionOrder[key]

  return persist({ ...state, sessionOrder }).sessionOrder[key] ?? []
}

/**
 * Sets or clears a repository's display name.
 *
 * An empty name restores the folder name, and so does the folder's own name typed
 * back in: an alias equal to it would be a second source of truth for the same
 * label, and would keep showing the old name if the folder is ever renamed.
 */
export function setRepoAlias(repoDir: string, name: string | null): string | null {
  const state = load()
  const key = normalizeKey(repoDir)
  if (!key) return null

  const repoAliases = { ...state.repoAliases }
  const trimmed = name?.trim() ?? ''
  const folder = path.basename(path.resolve(repoDir.trim()))
  const alias = trimmed && trimmed !== folder ? trimmed : ''

  if (alias) repoAliases[key] = alias
  else delete repoAliases[key]

  persist({ ...state, repoAliases })
  return alias || null
}

/**
 * Drops everything remembered about a repository.
 *
 * Called when one is deleted: keeping its order entries would slowly turn the
 * layout file into a graveyard of paths the user will never see again.
 */
export function forgetRepo(repoDir: string): void {
  const state = load()
  const key = normalizeKey(repoDir)
  if (!key) return

  const repoAliases = { ...state.repoAliases }
  const sessionOrder = { ...state.sessionOrder }
  delete repoAliases[key]
  delete sessionOrder[key]

  persist({
    repoOrder: state.repoOrder.filter((dir) => dir !== key),
    repoAliases,
    sessionOrder
  })
}
