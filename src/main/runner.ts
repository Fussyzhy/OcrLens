import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Preview, ReviewOptions, RunLogLine, RunProgress, RunResult } from '@shared/types'
import type { OcrContext } from './env'
import { buildOcrEnv, ocrArgv } from './ocr'
import { parseJsonLoose } from './proc'
import { listSessions } from './sessions'

/**
 * Runs `ocr review` / `ocr scan`.
 *
 * Two things are worth knowing about the CLI's output contract here:
 *
 * - With `--format json` the structured document owns **stdout** while progress
 *   goes to **stderr**. That is what makes a live progress panel possible without
 *   a temp file.
 * - Warnings are printed to stdout even in JSON mode (verified with
 *   `ocr scan --preview --format json`), so stdout must be parsed tolerantly.
 */

export interface Invocation {
  command: 'review' | 'scan'
  args: string[]
}

/** Translates UI options into CLI arguments. */
export function buildInvocation(options: ReviewOptions): Invocation {
  const isScan = options.mode === 'scan'
  const command: 'review' | 'scan' = isScan ? 'scan' : 'review'
  const args: string[] = [command]

  switch (options.mode) {
    case 'range':
      if (options.from) args.push('--from', options.from)
      if (options.to) args.push('--to', options.to)
      break
    case 'commit':
      if (options.commit) args.push('--commit', options.commit)
      break
    case 'scan':
      if (options.scanPath) args.push('--path', options.scanPath)
      break
    case 'workspace':
      // Default behaviour: staged + unstaged + untracked.
      break
  }

  args.push('--repo', options.repoDir)

  if (options.background?.trim()) args.push('--background', options.background.trim())
  if (options.backgroundFile?.trim()) args.push('--background-file', options.backgroundFile.trim())
  if (options.exclude?.trim()) args.push('--exclude', options.exclude.trim())

  if (options.effort) args.push('--effort', options.effort)
  if (options.provider?.trim()) args.push('--provider', options.provider.trim())
  if (options.model?.trim()) args.push('--model', options.model.trim())

  if (typeof options.concurrency === 'number' && options.concurrency > 0) {
    args.push('--concurrency', String(options.concurrency))
  }
  if (typeof options.timeoutMinutes === 'number' && options.timeoutMinutes > 0) {
    args.push('--timeout', String(options.timeoutMinutes))
  }
  if (typeof options.maxTokensBudget === 'number' && options.maxTokensBudget > 0) {
    args.push('--max-tokens-budget', String(options.maxTokensBudget))
  }

  if (isScan) {
    if (options.noPlan) args.push('--no-plan')
    if (options.noDedup) args.push('--no-dedup')
    if (options.noSummary) args.push('--no-summary')
    if (options.batch) args.push('--batch', options.batch)
  } else if (options.noFilter) {
    args.push('--no-filter')
  }

  return { command, args }
}

/** A short human-readable summary of what a run will do, for the confirm step. */
export function describeInvocation(invocation: Invocation): string {
  return `ocr ${invocation.args.join(' ')}`
}

/**
 * Runs a preview: which files would be reviewed, and why the others are skipped.
 *
 * Costs nothing — no model call is involved — which is what makes it safe to run
 * on every option change.
 */
export async function previewRun(ctx: OcrContext, options: ReviewOptions): Promise<Preview> {
  const { args } = buildInvocation(options)
  const full = [...args, '--preview', '--format', 'json']

  const { exe, args: argv } = ocrArgv(ctx.launch, full)
  const child = spawn(exe, argv, {
    cwd: options.repoDir,
    env: buildOcrEnv(ctx.gitBinDir),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => (stdout += c))
  child.stderr?.on('data', (c: string) => (stderr += c))

  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null))
    child.on('close', (c) => resolve(c))
  })

  if (code !== 0 && !stdout.includes('{')) {
    throw new Error(stderr.trim() || `preview exited ${code}`)
  }

  return parseJsonLoose<Preview>(stdout)
}

/** Recursively looks for a `session_id` in a decoded JSON document. */
function extractSessionId(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractSessionId(entry, depth + 1)
      if (found) return found
    }
    return null
  }

  const record = value as Record<string, unknown>
  for (const key of ['session_id', 'sessionId', 'run_id']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate) return candidate
  }
  for (const entry of Object.values(record)) {
    const found = extractSessionId(entry, depth + 1)
    if (found) return found
  }
  return null
}

export interface RunCallbacks {
  onLog: (line: RunLogLine) => void
  onProgress: (progress: RunProgress) => void
  onDone: (result: RunResult) => void
}

export interface RunHandle {
  runId: string
  invocation: Invocation
  cancel: () => void
}

/** Kills a process tree. Windows needs taskkill for the child's own children. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return

  if (process.platform === 'win32') {
    // ocr spawns git subprocesses; killing only the parent would leak them.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => child.kill())
    return
  }

  child.kill('SIGTERM')
}

/**
 * Starts a review and streams progress back through callbacks.
 *
 * Returns immediately with a handle; completion is reported via `onDone`.
 */
export function startRun(
  ctx: OcrContext,
  options: ReviewOptions,
  callbacks: RunCallbacks
): RunHandle {
  const runId = randomUUID()
  const invocation = buildInvocation(options)
  const startedAt = Date.now()
  let cancelled = false

  const args = [...invocation.args, '--format', 'json']
  const { exe, args: argv } = ocrArgv(ctx.launch, args)

  callbacks.onProgress({ runId, phase: 'starting', message: `ocr ${invocation.args.join(' ')}` })

  const child = spawn(exe, argv, {
    cwd: options.repoDir,
    env: buildOcrEnv(ctx.gitBinDir),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderrTail = ''
  // Partial trailing lines are held until a newline arrives.
  let stderrPartial = ''

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })

  child.stderr?.on('data', (chunk: string) => {
    const text = stderrPartial + chunk
    const lines = text.split(/\r?\n/)
    stderrPartial = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      stderrTail = (stderrTail + line + '\n').slice(-8000)
      callbacks.onLog({ runId, stream: 'stderr', text: line })
    }
  })

  child.on('error', (err) => {
    callbacks.onDone({ runId, exitCode: null, error: err.message, cancelled })
  })

  child.on('close', async (code) => {
    if (stderrPartial.trim()) {
      callbacks.onLog({ runId, stream: 'stderr', text: stderrPartial })
    }

    if (cancelled) {
      callbacks.onDone({ runId, exitCode: code, cancelled: true })
      return
    }

    callbacks.onProgress({ runId, phase: 'running', message: 'collecting results' })

    // Prefer the session id from the JSON document. Fall back to the newest
    // session for the repo, which covers runs that print only progress.
    let sessionId = extractSessionId(safeParse(stdout))

    if (!sessionId) {
      try {
        const sessions = await listSessions(ctx, options.repoDir, 4)
        const fresh = sessions.find((s) => Date.parse(s.end_time || s.start_time) >= startedAt - 5000)
        sessionId = (fresh ?? sessions[0])?.session_id
      } catch {
        // A failed lookup must not mask the run's real outcome.
      }
    }

    if (code === 0 || sessionId) {
      callbacks.onProgress({ runId, phase: 'finished', message: sessionId ?? undefined })
      callbacks.onDone({ runId, exitCode: code, sessionId: sessionId ?? undefined })
      return
    }

    callbacks.onProgress({ runId, phase: 'failed', message: stderrTail.trim().slice(-500) })
    callbacks.onDone({
      runId,
      exitCode: code,
      error: stderrTail.trim() || `ocr exited with code ${code}`
    })
  })

  return {
    runId,
    invocation,
    cancel: () => {
      cancelled = true
      callbacks.onProgress({ runId, phase: 'cancelled' })
      killTree(child)
    }
  }
}

/** Parses stdout, returning null instead of throwing. */
function safeParse(text: string): unknown {
  if (!text.trim()) return null
  try {
    return parseJsonLoose<unknown>(text)
  } catch {
    return null
  }
}
