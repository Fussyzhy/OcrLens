import fs from 'node:fs'
import path from 'node:path'
import type { RepoEntry } from '@shared/types'
import { gitPath, ocrContext } from './env'
import { isGitRepo } from './git'
import { ocrSessionsDir } from './ocr'
import { readSettings, writeSettings } from './settings'

/**
 * Repository discovery.
 *
 * The CLI stores sessions under `~/.opencodereview/sessions/<key>/`, where `key`
 * is the repository path with `:` and separators flattened — for example
 * `C:\Users\admin\Documents\Han_Jiang\shanhaibi\city-builder` becomes
 * `C_Users-admin-Documents-Han_Jiang-shanhaibi-city-builder`.
 *
 * That transform is **not reversible**: `-` maps both to a path separator and to
 * a literal hyphen, so `city-builder` is indistinguishable from `city\builder`.
 * Rather than guess, we read the authoritative `cwd` recorded in the first line
 * of a session file. The flattened key is kept only as a stable identifier.
 *
 * Discovery deliberately avoids spawning ocr: it stats files instead, so the
 * sidebar appears instantly. Authoritative session data is fetched lazily when a
 * repository is expanded.
 */

/** Reads the first JSONL record's `cwd`, which is the repo the session ran in. */
async function peekCwd(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(file, 'r')
    // `session_start` is the first record and is small; 64 KiB is ample.
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead <= 0) return null

    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const firstLine = text.split(/\r?\n/, 1)[0]
    if (!firstLine) return null

    const record = JSON.parse(firstLine) as { cwd?: string; repo_dir?: string }
    const cwd = record.cwd ?? record.repo_dir ?? null
    return cwd ? cwd.split('/').join(path.sep) : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

interface DirStats {
  count: number
  lastActivity?: string
}

/** Counts session files and finds the most recent one, without parsing them. */
async function scanSessionDir(dir: string): Promise<DirStats> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return { count: 0 }
  }

  let count = 0
  let newest = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    count++
    try {
      const stat = await fs.promises.stat(path.join(dir, name))
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      // Ignore files that vanish mid-scan.
    }
  }

  return {
    count,
    lastActivity: newest ? new Date(newest).toISOString() : undefined
  }
}

/** Newest `.jsonl` in a directory, used to recover the recorded repo path. */
async function newestSessionFile(dir: string): Promise<string | null> {
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl'))
    if (!names.length) return null

    let best: { file: string; mtime: number } | null = null
    for (const name of names) {
      const full = path.join(dir, name)
      try {
        const stat = await fs.promises.stat(full)
        if (!best || stat.mtimeMs > best.mtime) best = { file: full, mtime: stat.mtimeMs }
      } catch {
        // Skip unreadable entries.
      }
    }
    return best?.file ?? null
  } catch {
    return null
  }
}

/**
 * Best-effort reconstruction of a path from a flattened session key.
 *
 * Only used when a session file yields no `cwd`. Every `-` becomes a separator,
 * so hyphenated directory names decode incorrectly — which is exactly why this
 * is a fallback and its result is verified against the filesystem.
 */
function decodeKeyBestEffort(key: string): string | null {
  if (!/^[A-Za-z]_/.test(key)) return null
  const drive = key[0].toUpperCase()
  const rest = key.slice(2)
  return `${drive}:\\${rest.split('-').join('\\')}`
}

/** Human-friendly label: the last path segment. */
function displayName(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const base = path.basename(trimmed)
  return base || trimmed
}

/** Normalises to forward slashes so keys compare equal across sources. */
function normalize(dir: string): string {
  return path.resolve(dir).replace(/[\\/]+$/, '')
}

/** Lists repositories known to the client: discovered plus manually added. */
export async function listRepos(): Promise<RepoEntry[]> {
  const settings = readSettings()
  const sessionsRoot = ocrSessionsDir()
  const ignored = new Set(settings.ignoredRepos.map((d) => normalize(d).toLowerCase()))

  const byDir = new Map<string, RepoEntry>()

  // 1. Discover from the CLI's session storage.
  let keys: string[] = []
  try {
    keys = await fs.promises.readdir(sessionsRoot)
  } catch {
    keys = []
  }

  for (const key of keys) {
    const dir = path.join(sessionsRoot, key)
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    const stats = await scanSessionDir(dir)
    if (stats.count === 0) continue

    // Authoritative repo path, straight from a session record.
    let repoDir: string | null = null
    const newest = await newestSessionFile(dir)
    if (newest) repoDir = await peekCwd(newest)
    if (!repoDir) repoDir = decodeKeyBestEffort(key)

    const exists = repoDir ? fs.existsSync(repoDir) : false
    const resolvedKey = repoDir ? normalize(repoDir) : key

    if (repoDir && ignored.has(resolvedKey.toLowerCase())) continue

    const entry: RepoEntry = {
      key,
      dir: repoDir ?? '',
      name: repoDir ? displayName(repoDir) : key,
      sessionCount: stats.count,
      lastActivity: stats.lastActivity,
      exists
    }
    byDir.set(resolvedKey.toLowerCase(), entry)
  }

  // 2. Add repositories the user pinned manually.
  for (const manual of settings.manualRepos) {
    const resolved = normalize(manual)
    const lower = resolved.toLowerCase()
    if (ignored.has(lower)) continue

    const existing = byDir.get(lower)
    if (existing) {
      existing.manual = true
      continue
    }

    byDir.set(lower, {
      key: '',
      dir: resolved,
      name: displayName(resolved),
      sessionCount: 0,
      exists: fs.existsSync(resolved),
      manual: true
    })
  }

  return [...byDir.values()].sort((a, b) => {
    // Most recently active first; repos with no history fall to the bottom.
    const at = a.lastActivity ? Date.parse(a.lastActivity) : 0
    const bt = b.lastActivity ? Date.parse(b.lastActivity) : 0
    if (at !== bt) return bt - at
    return a.name.localeCompare(b.name)
  })
}

/** Validates and pins a repository the user picked. */
export async function addRepo(dir: string): Promise<{ ok: boolean; error?: string; repo?: RepoEntry }> {
  const resolved = normalize(dir)

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Directory does not exist: ${resolved}` }
  }

  const git = gitPath()
  if (!git) {
    return { ok: false, error: 'No usable git was found; cannot verify the repository.' }
  }

  if (!(await isGitRepo(git, resolved))) {
    return { ok: false, error: `${resolved} is not the root of a git repository.` }
  }

  const settings = readSettings()
  if (!settings.manualRepos.some((d) => normalize(d).toLowerCase() === resolved.toLowerCase())) {
    writeSettings({ manualRepos: [...settings.manualRepos, resolved] })
  }

  return {
    ok: true,
    repo: {
      key: '',
      dir: resolved,
      name: displayName(resolved),
      sessionCount: 0,
      exists: true,
      manual: true
    }
  }
}

/** Hides a repository from the sidebar without touching its session data. */
export function removeRepo(dir: string): void {
  const settings = readSettings()
  const lower = normalize(dir).toLowerCase()

  writeSettings({
    manualRepos: settings.manualRepos.filter((d) => normalize(d).toLowerCase() !== lower),
    ignoredRepos: settings.ignoredRepos
      .filter((d) => normalize(d).toLowerCase() !== lower)
      .concat(normalize(dir))
  })
}

/** Makes sure the OCR context is available; helper for IPC layers. */
export function requireContext(): ReturnType<typeof ocrContext> {
  return ocrContext()
}
