import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitRef } from '@shared/types'
import { run } from './proc'

/**
 * Git resolution.
 *
 * Why this module exists at all: on this machine (and any machine with devkitPro,
 * MSYS2, or a similar POSIX toolchain installed) the *first* `git.exe` on PATH is
 * an MSYS2 build that resolves `rev-parse --show-toplevel` to a POSIX path like
 * `/home/admin/Documents/repo`. The ocr CLI is a Go binary that treats that as a
 * relative Windows path, produces `C:\home\admin`, and fails with
 * "The system cannot find the file specified".
 *
 * Measured on the dev machine:
 *   c:\devkitPro\msys2\usr\bin   → toplevel `/home/admin/...`    → ocr breaks
 *   C:\Program Files\Git\cmd     → toplevel `C:/Users/admin/...` → ocr works
 *
 * So we never trust the inherited PATH for git. We enumerate candidates, probe
 * each in a throwaway repo, and only accept one that reports a drive-letter
 * absolute path.
 */

export interface GitProbe {
  path: string
  ok: boolean
  version?: string
  /** What this git reported for `--show-toplevel` in the probe repo. */
  toplevel?: string
  reason?: string
}

export interface ResolvedGit {
  /** Path to the accepted git, or null when nothing usable was found. */
  gitPath: string | null
  version: string | null
  /** Directory to prepend to PATH when spawning ocr. */
  binDir: string | null
  /** A git we deliberately skipped, kept so the UI can explain the override. */
  rejected: { path: string; observedToplevel: string } | null
  /** Every candidate examined, for the diagnostics view. */
  probed: GitProbe[]
}

/** Matches an absolute Windows path, accepting either separator. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

/** Well-known Git for Windows locations. May contain a `*` segment. */
function wellKnownGitPaths(): string[] {
  const out: string[] = []
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const local = process.env['LOCALAPPDATA']
  if (pf) out.push(path.join(pf, 'Git', 'cmd', 'git.exe'))
  if (pf86) out.push(path.join(pf86, 'Git', 'cmd', 'git.exe'))
  if (local) out.push(path.join(local, 'Programs', 'Git', 'cmd', 'git.exe'))
  // GitHub Desktop bundles its own Git for Windows build under a versioned dir.
  if (local) {
    out.push(path.join(local, 'GitHubDesktop', 'app-*', 'resources', 'app', 'git', 'cmd', 'git.exe'))
  }
  return out
}

/** Every `git.exe` reachable through the inherited PATH, in PATH order. */
function pathGitCandidates(): string[] {
  const out: string[] = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const exe = path.join(dir, 'git.exe')
    try {
      if (fs.existsSync(exe)) out.push(exe)
    } catch {
      // An unreadable PATH entry is not fatal; skip it.
    }
  }
  return out
}

/**
 * Orders candidates so obviously-wrong toolchains are probed last.
 *
 * This is only a hint — correctness still comes from the runtime probe, because
 * a path can be misleading in either direction. Sorting also means the common
 * case (Git for Windows present) is decided on the first probe.
 */
function preference(gitPath: string): number {
  const lower = gitPath.toLowerCase()
  if (lower.includes('msys2')) return 100
  if (lower.includes('\\usr\\bin')) return 90
  if (lower.includes('\\mingw')) return 40
  if (lower.includes('\\cmd\\git.exe')) return 0
  if (lower.includes('\\bin\\git.exe')) return 10
  return 20
}

/** Expands a single-`*`-segment glob, or returns the input unchanged. */
function expandGlobOrSelf(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern]

  const parts = pattern.split(/[\\/]/)
  let current: string[] = [parts[0] + path.sep]

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const next: string[] = []
    for (const base of current) {
      if (!part.includes('*')) {
        next.push(path.join(base, part))
        continue
      }
      let entries: string[] = []
      try {
        entries = fs.readdirSync(base)
      } catch {
        continue
      }
      const re = new RegExp(
        '^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      )
      for (const entry of entries) {
        if (re.test(entry)) next.push(path.join(base, entry))
      }
    }
    current = next
  }
  return current
}

/**
 * Runs a candidate git inside a throwaway repository to learn which path
 * convention it emits. This is the only reliable discriminator between a Git for
 * Windows build and an MSYS2 build.
 */
async function probeGit(gitPath: string): Promise<GitProbe> {
  let tmp: string | null = null
  try {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocr-client-gitprobe-'))

    const init = await run(gitPath, ['init', '--quiet'], { cwd: tmp, timeoutMs: 15_000 })
    if (init.code !== 0) {
      return {
        path: gitPath,
        ok: false,
        reason: init.error ?? init.stderr.trim() ?? `git init exited ${init.code}`
      }
    }

    const [top, version] = await Promise.all([
      run(gitPath, ['rev-parse', '--show-toplevel'], { cwd: tmp, timeoutMs: 15_000 }),
      run(gitPath, ['--version'], { cwd: tmp, timeoutMs: 15_000 })
    ])

    const toplevel = top.stdout.trim()
    if (top.code !== 0 || !toplevel) {
      return {
        path: gitPath,
        ok: false,
        toplevel,
        reason: top.error ?? top.stderr.trim() ?? 'rev-parse produced no path'
      }
    }

    const ok = WINDOWS_ABSOLUTE.test(toplevel)
    return {
      path: gitPath,
      ok,
      version: version.stdout.trim() || undefined,
      toplevel,
      reason: ok ? undefined : 'reports a POSIX path, which the ocr CLI cannot resolve'
    }
  } catch (err) {
    return { path: gitPath, ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    if (tmp) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Picks a git whose paths the ocr CLI can consume.
 *
 * `override` (from settings) is honoured first but still probed, so a bad manual
 * entry surfaces as a clear warning instead of a mysterious review failure.
 */
export async function resolveGit(override?: string | null): Promise<ResolvedGit> {
  const seen = new Set<string>()
  const candidates: string[] = []

  const push = (candidate: string | undefined | null): void => {
    if (!candidate) return
    for (const expanded of expandGlobOrSelf(candidate)) {
      const resolved = path.resolve(expanded)
      const key = resolved.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(resolved)
    }
  }

  push(override)
  for (const candidate of wellKnownGitPaths()) push(candidate)
  for (const candidate of pathGitCandidates()) push(candidate)

  const ordered = candidates
    .filter((candidate) => {
      try {
        return fs.existsSync(candidate)
      } catch {
        return false
      }
    })
    // Array.prototype.sort is stable, so insertion order breaks ties: the
    // override wins, then well-known Git for Windows paths, then PATH order.
    .sort((a, b) => preference(a) - preference(b))

  const probed: GitProbe[] = []
  let rejected: { path: string; observedToplevel: string } | null = null

  for (const candidate of ordered) {
    const result = await probeGit(candidate)
    probed.push(result)

    if (result.ok) {
      return {
        gitPath: result.path,
        version: result.version ?? null,
        binDir: path.dirname(result.path),
        rejected,
        probed
      }
    }

    // Remember the first git that actually produced a path we had to reject, so
    // the UI can name the broken install instead of staying silent.
    if (!rejected && result.toplevel) {
      rejected = { path: result.path, observedToplevel: result.toplevel }
    }
  }

  return { gitPath: null, version: null, binDir: null, rejected, probed }
}

/** Lists local branches for the range picker. Never throws; returns [] on failure. */
export async function listBranches(gitPath: string, repoDir: string): Promise<GitRef[]> {
  const [local, current] = await Promise.all([
    run(gitPath, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads'], {
      cwd: repoDir,
      timeoutMs: 20_000
    }),
    run(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, timeoutMs: 20_000 })
  ])

  const head = current.code === 0 ? current.stdout.trim() : ''

  const refs: GitRef[] = local.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Branch names cannot contain tabs, so this split is unambiguous.
      const [name = '', stamp = ''] = line.split('\t')
      const seconds = Number(stamp)
      return {
        name,
        current: name === head,
        kind: 'local' as const,
        committedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
      }
    })
    .filter((ref) => ref.name)

  // Most-recently-committed first, with the checked-out branch pinned on top.
  // `for-each-ref` is alphabetical, which buries what anyone actually wants in a
  // repo like this one: 102 release branches where `4.7.10` sorts before `4.7.2`.
  return refs.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return (b.committedAt ?? 0) - (a.committedAt ?? 0)
  })
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  meta: string
}

/** Lists recent commits for the single-commit picker. */
export async function listCommits(
  gitPath: string,
  repoDir: string,
  limit = 50
): Promise<GitCommit[]> {
  const result = await run(
    gitPath,
    ['log', `-n${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=short'],
    { cwd: repoDir, timeoutMs: 20_000 }
  )
  if (result.code !== 0) return []

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash = '', short = '', author = '', date = '', subject = ''] = line.split('\x1f')
      return { hash, short, subject, meta: `${date} · ${author}` }
    })
}

/** Verifies a directory is the root of a git work tree. */
export async function isGitRepo(gitPath: string, dir: string): Promise<boolean> {
  const result = await run(gitPath, ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    timeoutMs: 15_000
  })
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** Reads the `origin` remote URL, used only to produce a friendlier repo name. */
export async function remoteUrl(gitPath: string, repoDir: string): Promise<string | null> {
  const result = await run(gitPath, ['remote', 'get-url', 'origin'], {
    cwd: repoDir,
    timeoutMs: 15_000
  })
  if (result.code !== 0) return null
  return result.stdout.trim() || null
}
