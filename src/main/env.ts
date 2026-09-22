import type { EnvInfo } from '@shared/types'
import { resolveGit, type ResolvedGit } from './git'
import { ocrVersion, resolveOcr, type OcrLaunch, type ResolvedOcr } from './ocr'
import { readSettings } from './settings'

/**
 * The resolved local environment: which git and which ocr we will actually use.
 *
 * Resolution happens once at startup and is cached, because probing git spins up
 * throwaway repositories. `refreshEnv` re-runs it after the user changes a path
 * override in settings.
 */

export interface OcrContext {
  launch: OcrLaunch
  /** Directory to prepend to PATH so ocr's own git calls work. */
  gitBinDir: string | null
}

interface ResolvedEnv {
  info: EnvInfo
  git: ResolvedGit
  ocr: ResolvedOcr
}

let cached: ResolvedEnv | null = null
/** De-duplicates concurrent initialisation; probing git is not free. */
let inflight: Promise<EnvInfo> | null = null

function buildWarnings(git: ResolvedGit, ocr: ResolvedOcr): string[] {
  const warnings: string[] = []

  if (!ocr.launch) {
    warnings.push(
      'ocr CLI not found on PATH. Install it with `npm install -g @alibaba-group/open-code-review`.'
    )
  }
  warnings.push(...ocr.warnings)

  if (!git.gitPath) {
    warnings.push(
      'No usable git found. The ocr CLI resolves repositories through git, so reviews will fail until one is available.'
    )
  } else if (git.rejected) {
    // This is the devkitPro/MSYS2 case: worth naming explicitly, because the
    // user's own terminal may work fine while the app would not.
    warnings.push(
      `Ignoring ${git.rejected.path} — it reports "${git.rejected.observedToplevel}", a POSIX path the ocr CLI cannot resolve. Using ${git.gitPath} instead.`
    )
  }

  return warnings
}

export async function refreshEnv(): Promise<EnvInfo> {
  const settings = readSettings()

  // Probe git and ocr concurrently; they are independent.
  const [git, ocr] = await Promise.all([
    resolveGit(settings.gitOverride),
    Promise.resolve(resolveOcr(settings.ocrOverride))
  ])

  let version: string | null = null
  if (ocr.launch) {
    const result = await ocrVersion(ocr.launch, git.binDir)
    version = result.version
    if (!version) {
      ocr.warnings.push('Could not read the ocr version; the CLI may be broken.')
    }
  }

  const info: EnvInfo = {
    ocrPath: ocr.launch ? ocr.launch.resolvedFrom : null,
    ocrLaunchKind: ocr.launch ? ocr.launch.kind : 'none',
    ocrVersion: version,
    gitPath: git.gitPath,
    gitVersion: git.version,
    rejectedGit: git.rejected,
    sessionsDir: ocr.sessionsDir,
    configPath: ocr.configPath,
    warnings: buildWarnings(git, ocr)
  }

  cached = { info, git, ocr }
  return info
}

export function envInfo(): EnvInfo | null {
  return cached?.info ?? null
}

/**
 * Returns the resolved environment, probing on first use.
 *
 * Concurrent callers share one probe, so a burst of IPC calls at startup cannot
 * spin up several git probes at once.
 */
export function ensureEnv(): Promise<EnvInfo> {
  if (cached) return Promise.resolve(cached.info)
  if (!inflight) {
    inflight = refreshEnv().finally(() => {
      inflight = null
    })
  }
  return inflight
}

/** Context for spawning ocr. Throws when the CLI is unavailable. */
export function ocrContext(): OcrContext {
  if (!cached) throw new Error('Environment not initialised yet')
  if (!cached.ocr.launch) {
    throw new Error(
      'ocr CLI not found. Install it with `npm install -g @alibaba-group/open-code-review`.'
    )
  }
  return { launch: cached.ocr.launch, gitBinDir: cached.git.binDir }
}

/** Returns the context or null, for callers that prefer to degrade gracefully. */
export function tryOcrContext(): OcrContext | null {
  if (!cached?.ocr.launch) return null
  return { launch: cached.ocr.launch, gitBinDir: cached.git.binDir }
}

/** Resolved git path, for git operations the client performs itself. */
export function gitPath(): string | null {
  return cached?.git.gitPath ?? null
}
