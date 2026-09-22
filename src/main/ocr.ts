import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, type RunOptions, type RunOutcome } from './proc'

/**
 * Locating and launching the `ocr` CLI.
 *
 * The npm package is a thin JavaScript launcher around a platform-specific Go
 * binary. On this machine:
 *   shim      C:\nvm4w\nodejs\ocr.cmd
 *   launcher  C:\nvm4w\nodejs\node_modules\@alibaba-group\open-code-review\bin\ocr.js
 *   binary    ...\node_modules\@alibaba-group\ocr-win32-x64\bin\opencodereview.exe
 *
 * We prefer the real binary: no shell quoting hazards, exact exit codes, and it
 * skips the launcher's detached "check for updates" side effect.
 */

export type OcrLaunchKind = 'native' | 'node-launcher' | 'shim'

export interface OcrLaunch {
  kind: OcrLaunchKind
  /** Executable to spawn. */
  exe: string
  /** Arguments that must precede the caller's arguments. */
  prefix: string[]
  /** Where this resolution came from, for diagnostics. */
  resolvedFrom: string
}

export interface ResolvedOcr {
  launch: OcrLaunch | null
  /** Config/state directory shared by the CLI: `~/.opencodereview`. */
  stateDir: string
  configPath: string
  sessionsDir: string
  warnings: string[]
}

export function ocrStateDir(): string {
  return path.join(os.homedir(), '.opencodereview')
}

export function ocrConfigPath(): string {
  return path.join(ocrStateDir(), 'config.json')
}

export function ocrSessionsDir(): string {
  return path.join(ocrStateDir(), 'sessions')
}

/** Finds the native binary inside a resolved package directory. */
function findNativeBinary(pkgDir: string): string | null {
  const scopeDir = path.join(pkgDir, 'node_modules', '@alibaba-group')
  let entries: string[] = []
  try {
    entries = fs.readdirSync(scopeDir)
  } catch {
    return null
  }

  // The platform package is named like `ocr-win32-x64`, `ocr-darwin-arm64`, ...
  const platformPkgs = entries.filter((e) => e.startsWith('ocr-'))
  for (const pkg of platformPkgs) {
    const binDir = path.join(scopeDir, pkg, 'bin')
    let binEntries: string[] = []
    try {
      binEntries = fs.readdirSync(binDir)
    } catch {
      continue
    }
    for (const entry of binEntries) {
      // `opencodereview.exe` on Windows, `opencodereview` elsewhere.
      if (entry === 'opencodereview.exe' || entry === 'opencodereview') {
        return path.join(binDir, entry)
      }
    }
  }
  return null
}

/** Every `ocr*` shim or executable reachable through PATH, in PATH order. */
function pathOcrCandidates(): string[] {
  const names = ['ocr.cmd', 'ocr.exe', 'ocr.bat', 'ocr.ps1', 'ocr']
  const out: string[] = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate)) out.push(candidate)
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }
  return out
}

/**
 * Resolves how to launch ocr.
 *
 * `override` wins if it points at something real; otherwise we search PATH for
 * npm's shims and walk into the installed package to find the native binary.
 */
export function resolveOcr(override?: string | null): ResolvedOcr {
  const warnings: string[] = []
  const stateDir = ocrStateDir()
  const configPath = ocrConfigPath()
  const sessionsDir = ocrSessionsDir()

  const consider = (candidate: string): OcrLaunch | null => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(candidate)
    } catch {
      return null
    }

    const ext = path.extname(candidate).toLowerCase()
    const base = path.basename(candidate).toLowerCase()

    // A directly-pointed-at native binary.
    if (stat.isFile() && (ext === '.exe' || base === 'opencodereview')) {
      return { kind: 'native', exe: candidate, prefix: [], resolvedFrom: candidate }
    }

    if (stat.isFile() && ext === '.js') {
      return {
        kind: 'node-launcher',
        exe: process.execPath,
        prefix: [candidate],
        resolvedFrom: candidate
      }
    }

    if (stat.isFile() && (ext === '.cmd' || ext === '.bat' || base === 'ocr' || ext === '.ps1')) {
      // A shim. Try to reach the real binary through the package it belongs to.
      const binDir = path.dirname(candidate)
      const pkgDir = path.join(binDir, 'node_modules', '@alibaba-group', 'open-code-review')
      const native = findNativeBinary(pkgDir)

      if (native && fs.existsSync(native)) {
        return { kind: 'native', exe: native, prefix: [], resolvedFrom: candidate }
      }

      const launcher = path.join(pkgDir, 'bin', 'ocr.js')
      if (fs.existsSync(launcher)) {
        return {
          kind: 'node-launcher',
          exe: process.execPath,
          prefix: [launcher],
          resolvedFrom: candidate
        }
      }

      // Last resort: go through cmd.exe. Quoting is handled by spawn's argv
      // serialisation, which is correct for well-formed paths.
      return {
        kind: 'shim',
        exe: process.env.ComSpec ?? 'cmd.exe',
        prefix: ['/d', '/s', '/c', candidate],
        resolvedFrom: candidate
      }
    }

    return null
  }

  const candidates: string[] = []
  if (override) candidates.push(override)

  // Standard npm global prefixes, in case PATH is unusual (e.g. a GUI launch).
  const appData = process.env.APPDATA
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'))
    candidates.push(path.join(appData, 'npm', 'ocr.cmd'))
  }

  candidates.push(...pathOcrCandidates())

  for (const candidate of candidates) {
    const launch = consider(candidate)
    if (launch) {
      return { launch, stateDir, configPath, sessionsDir, warnings }
    }
  }

  warnings.push(
    'ocr CLI not found. Install it with: npm install -g @alibaba-group/open-code-review'
  )
  return { launch: null, stateDir, configPath, sessionsDir, warnings }
}

/**
 * Builds the environment for an ocr child process.
 *
 * The critical part is `gitBinDir`: prepending a working Git for Windows to PATH
 * is what makes ocr's repository resolution succeed on machines where an MSYS2
 * git shadows it. See the comment block in git.ts.
 */
export function buildOcrEnv(gitBinDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }

  if (gitBinDir) {
    const current = env.PATH ?? env.Path ?? ''
    env.PATH = gitBinDir + path.delimiter + current
    // Windows spells this key in several cases; normalise so the child sees one.
    delete env.Path
    delete env.path
  }

  // Keep the CLI from spawning its detached update checker mid-review.
  env.OCR_NO_UPDATE = '1'
  return env
}

/** Builds argv (including any launch prefix) for a set of ocr arguments. */
export function ocrArgv(launch: OcrLaunch, args: string[]): { exe: string; args: string[] } {
  return { exe: launch.exe, args: [...launch.prefix, ...args] }
}

/** Runs ocr to completion and captures output. Never throws on non-zero exit. */
export async function execOcr(
  launch: OcrLaunch,
  args: string[],
  gitBinDir: string | null,
  opts: RunOptions = {}
): Promise<RunOutcome> {
  const { exe, args: full } = ocrArgv(launch, args)
  return run(exe, full, { ...opts, env: buildOcrEnv(gitBinDir) })
}

const VERSION_RE = /v(\d+\.\d+\.\d+)/

/** Reads the CLI version from `ocr version`. */
export async function ocrVersion(
  launch: OcrLaunch,
  gitBinDir: string | null
): Promise<{ version: string | null; output: string }> {
  const result = await execOcr(launch, ['version'], gitBinDir, { timeoutMs: 30_000 })
  const output = (result.stdout || result.stderr).trim()
  const match = VERSION_RE.exec(output)
  return { version: match ? match[1] : null, output }
}
