import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { SessionTitle, TitleSource } from '@shared/types'

/**
 * Client-owned session titles.
 *
 * `ocr` has no title concept, so titles live beside this app's settings rather
 * than inside `~/.opencodereview`, which belongs to the CLI. They are keyed by
 * session id and joined onto session summaries when the sidebar lists history.
 */

type TitleMap = Record<string, SessionTitle>

/** Long enough for a descriptive name, short enough to stay a name. */
const MAX_TITLE_LENGTH = 120

let cache: TitleMap | null = null

function titlesPath(): string {
  return path.join(app.getPath('userData'), 'session-titles.json')
}

function load(): TitleMap {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(titlesPath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      cache = {}
      return cache
    }

    const out: TitleMap = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Partial<SessionTitle>
      if (typeof entry.title !== 'string' || !entry.title.trim()) continue
      out[id] = {
        title: entry.title,
        source: entry.source === 'user' ? 'user' : 'ai',
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
        model: typeof entry.model === 'string' ? entry.model : undefined
      }
    }
    cache = out
  } catch {
    // A missing or corrupt file just means "no titles yet".
    cache = {}
  }
  return cache
}

function persist(map: TitleMap): void {
  const file = titlesPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
  } catch (err) {
    console.error('failed to persist session titles:', err)
  }
}

/** Normalises a title for storage: single line, no wrapping quotes, bounded. */
export function normalizeTitle(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim()

  // Models like to answer with a label or a quoted string.
  text = text.replace(/^(标题|title)\s*[:：]\s*/i, '').trim()
  text = text.replace(/^["'“”‘’《<]+/, '').replace(/["'“”‘’》>]+$/, '').trim()
  text = text.replace(/[。.!！?？,，;；:：]+$/, '').trim()

  if (text.length > MAX_TITLE_LENGTH) text = text.slice(0, MAX_TITLE_LENGTH).trim()
  return text
}

export function getTitle(sessionId: string): SessionTitle | undefined {
  return load()[sessionId]
}

/** Bulk lookup, used when enriching a session list. */
export function titlesFor(sessionIds: string[]): Record<string, SessionTitle> {
  const map = load()
  const out: Record<string, SessionTitle> = {}
  for (const id of sessionIds) {
    const entry = map[id]
    if (entry) out[id] = entry
  }
  return out
}

export interface SetTitleOutcome {
  applied: boolean
  /** Present when the write was refused because the user owns the title. */
  existing?: SessionTitle
}

/**
 * Writes a title.
 *
 * An AI-generated title never overwrites one the user set by hand — regenerating
 * a session's name must not silently discard the name they chose. Pass
 * `source: 'user'` for an explicit rename or for a deliberate regeneration.
 */
export function setTitle(
  sessionId: string,
  rawTitle: string,
  source: TitleSource,
  model?: string
): SetTitleOutcome {
  const title = normalizeTitle(rawTitle)
  if (!title) return { applied: false }

  const map = { ...load() }
  const existing = map[sessionId]

  if (source === 'ai' && existing?.source === 'user') {
    return { applied: false, existing }
  }

  map[sessionId] = {
    title,
    source,
    updatedAt: new Date().toISOString(),
    model: source === 'ai' ? model : undefined
  }
  persist(map)
  cache = map
  return { applied: true }
}

/**
 * Drops several titles with a single write.
 *
 * `persist` rewrites the whole file, and the repository delete removes one title
 * per session — so deleting a repository with a long history rewrote the file once
 * per session, synchronously, on the main process. One write for the batch.
 */
export function removeTitles(sessionIds: string[]): void {
  const map = { ...load() }
  let changed = false

  for (const sessionId of sessionIds) {
    if (!(sessionId in map)) continue
    delete map[sessionId]
    changed = true
  }

  if (!changed) return
  persist(map)
  cache = map
}

/** Drops a title, e.g. when the user clears a name field. */
export function removeTitle(sessionId: string): void {
  removeTitles([sessionId])
}

