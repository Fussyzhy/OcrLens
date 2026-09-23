import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Preview, ReviewMode, ReviewOptions, RunLogLine, RunProgress, RunResult, RunSessionBound } from '@shared/types'
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
  /**
   * Fired once the CLI's session file for this run has been located.
   *
   * The CLI creates it within a second of starting (measured: 0.1–0.8s from the
   * first `session_start` record) and names the file after the session id, but it
   * names the id nowhere on stdout until the run is over — so the rail needs this
   * early signal to show the run as the session it already is.
   */
  onSession?: (bound: RunSessionBound) => void
}

export interface RunHandle {
  runId: string
  invocation: Invocation
  repoDir: string
  startedAt: number
  /** How the run was started, so a re-attached panel can label it. */
  mode: ReviewMode
  /** Set once the session is known, by early discovery or by the final document. */
  sessionId?: string
  cancel: () => void
}

/**
 * Session ids already attributed to a run in this process.
 *
 * Two runs in the same repository are refused by the UI, so this only has to keep
 * a run from claiming the session of an earlier one that finished seconds ago —
 * which is also why the entries expire: a long-lived window would otherwise hold
 * one id per review for as long as the app is open, for no benefit.
 */
const claimedSessions = new Map<string, number>()
const CLAIM_TTL_MS = 10 * 60_000

function isClaimed(sessionId: string): boolean {
  const at = claimedSessions.get(sessionId)
  if (at === undefined) return false
  if (Date.now() - at > CLAIM_TTL_MS) {
    claimedSessions.delete(sessionId)
    return false
  }
  return true
}

function claimSession(sessionId: string): void {
  const now = Date.now()
  for (const [id, at] of claimedSessions) {
    if (now - at > CLAIM_TTL_MS) claimedSessions.delete(id)
  }
  claimedSessions.set(sessionId, now)
}

/** How often to look for the run's session, and how long to keep looking. */
const SESSION_POLL_MS = 700
const SESSION_POLL_ATTEMPTS = 20

/**
 * Watches a repository's session list for the session a run just created.
 *
 * Polling the CLI's own listing rather than reading the session directory keeps
 * the supported contract as the only source of truth, and it stops as soon as the
 * session is found — one extra CLI call in the normal case, none afterwards.
 */
function watchForSession(
  ctx: OcrContext,
  repoDir: string,
  startedAt: number,
  onFound: (sessionId: string) => void
): () => void {
  let stopped = false
  let attempts = 0
  let timer: NodeJS.Timeout | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    attempts += 1

    try {
      const sessions = await listSessions(ctx, repoDir, 5)
      // The lookup is slow enough to outlive the run it was started for, so the
      // answer is worthless once we were told to stop. Without this a cancelled or
      // finished run could still be handed a session — possibly an old one the
      // tolerances happen to accept — after its `run:done` was already sent.
      if (stopped) return

      const fresh = sessions.find((session) => {
        if (isClaimed(session.session_id)) return false
        const began = Date.parse(session.start_time)
        // Sessions are stamped in whole seconds (`2026-09-23T09:53:58Z`), so a
        // session this run created can be stamped up to a second before the run
        // started; anything older belongs to a run started in a terminal, which
        // this window cannot see and must not adopt.
        return Number.isFinite(began) && began >= startedAt - 1000
      })

      if (fresh) {
        claimSession(fresh.session_id)
        stopped = true
        onFound(fresh.session_id)
        return
      }
    } catch {
      // A failed lookup is not fatal: the run's final document still names the id.
    }

    if (attempts >= SESSION_POLL_ATTEMPTS || stopped) return
    timer = setTimeout(() => void tick(), SESSION_POLL_MS)
  }

  timer = setTimeout(() => void tick(), SESSION_POLL_MS)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
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

  const handle: RunHandle = {
    runId,
    invocation,
    repoDir: options.repoDir,
    startedAt,
    mode: options.mode,
    cancel: () => {
      cancelled = true
      stopWatching()
      callbacks.onProgress({ runId, phase: 'cancelled' })
      killTree(child)
    }
  }

  // Say which session this run is the moment the CLI's file shows up, so the rail
  // can list it while it is still running. A cancelled run keeps its file too, so
  // an interrupted task stays a real, openable record.
  const stopWatching = watchForSession(ctx, options.repoDir, startedAt, (sessionId) => {
    handle.sessionId = sessionId
    callbacks.onSession?.({ runId, repoDir: options.repoDir, sessionId })
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
    stopWatching()
    callbacks.onDone({ runId, exitCode: null, error: err.message, cancelled })
  })

  child.on('close', async (code) => {
    stopWatching()

    if (stderrPartial.trim()) {
      callbacks.onLog({ runId, stream: 'stderr', text: stderrPartial })
    }

    if (cancelled) {
      callbacks.onDone({ runId, exitCode: code, cancelled: true, sessionId: handle.sessionId })
      return
    }

    callbacks.onProgress({ runId, phase: 'running', message: 'collecting results' })

    // Prefer the session id from the JSON document; otherwise keep whatever the
    // early watcher found. The listing is the last resort, for runs that print
    // only progress.
    let sessionId = extractSessionId(safeParse(stdout)) ?? handle.sessionId

    if (!sessionId) {
      try {
        const sessions = await listSessions(ctx, options.repoDir, 4)
        const fresh = sessions.find((s) => Date.parse(s.end_time || s.start_time) >= startedAt - 5000)
        sessionId = (fresh ?? sessions[0])?.session_id
      } catch {
        // A failed lookup must not mask the run's real outcome.
      }
    }

    if (sessionId) {
      claimSession(sessionId)
      handle.sessionId = sessionId
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

  return handle
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
