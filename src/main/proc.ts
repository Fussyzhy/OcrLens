import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Cap captured bytes per stream so a runaway review cannot exhaust memory. */
  maxBuffer?: number
}

export interface RunOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set only for spawn-level failures (ENOENT, EACCES), not for non-zero exits. */
  error?: string
  /** True when the stream was truncated by `maxBuffer`. */
  truncated: boolean
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Runs a process to completion and captures both streams as UTF-8.
 *
 * Non-zero exit codes are returned, never thrown: the ocr CLI uses them for
 * ordinary outcomes ("no files changed", partial coverage, every item failed),
 * so callers must inspect `code` rather than rely on exceptions.
 */
export function run(exe: string, args: string[], opts: RunOptions = {}): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const max = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
    let child
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }

    let out = ''
    let errText = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, opts.timeoutMs)
      : null

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      if (out.length < max) out += chunk
      else truncated = true
    })
    child.stderr?.on('data', (chunk: string) => {
      if (errText.length < max) errText += chunk
      else truncated = true
    })

    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, signal, stdout: out, stderr: errText, timedOut, truncated, error })
    }

    child.on('error', (err) => finish(null, null, err.message))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/**
 * Parses a CLI's stdout as JSON, tolerating leading noise.
 *
 * Necessary in practice: `ocr scan --preview --format json` prints lines like
 * `[ocr] WARNING: skipping <file> ...` to **stdout** before the document, so a
 * plain `JSON.parse` on the buffer fails. We cannot simply look for the first
 * `[` either, because that noise itself starts with one — so every plausible
 * start position is tried in ascending order and the first document that parses
 * wins.
 */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty output')

  try {
    return JSON.parse(trimmed) as T
  } catch {
    // Fall through to scanning for an embedded document.
  }

  // Bound the search so a pathological buffer cannot stall the main process.
  const MAX_CANDIDATES = 64
  const starts: number[] = []
  for (let i = 0; i < trimmed.length && starts.length < MAX_CANDIDATES; i++) {
    const ch = trimmed[i]
    if (ch === '{' || ch === '[') starts.push(i)
  }

  for (const start of starts) {
    const open = trimmed[start]
    const close = open === '{' ? '}' : ']'
    const end = trimmed.lastIndexOf(close)
    if (end <= start) continue
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T
    } catch {
      // Not a document boundary; try the next start position.
    }
  }

  throw new Error(`no JSON found in output: ${trimmed.slice(0, 200)}`)
}
