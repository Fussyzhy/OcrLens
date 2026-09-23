import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { GitRef, Preview, ReviewMode, ReviewOptions, RunResult, RunSessionBound } from '@shared/types'
import { unwrap } from '../utils/ipc'
import { syncLiveRuns } from './liveRuns'
import { useRepoStore } from './repos'
import { useResultsStore } from './results'
import { useUiStore } from './ui'

/** Keeps the progress log bounded during long reviews. */
const MAX_LOG_LINES = 600

/** How often the elapsed counters tick while something is running. */
const TICK_MS = 500

/** Where a run is in its life; `starting` and `running` are the live ones. */
export type RunPhase = 'starting' | 'running' | 'finished' | 'failed' | 'cancelled'

export interface RunState {
  runId: string
  repoDir: string
  /** The CLI session this run is writing; unknown for the first second or so. */
  sessionId: string | null
  phase: RunPhase
  statusText: string
  logs: string[]
  startedAt: number
  /** Frozen once the run ends. */
  elapsedMs: number
  command: string
  /** How the run was started; the rail labels a running row with it. */
  mode: ReviewMode
  /** True between the cancel request and the process actually being gone. */
  cancelling: boolean
  error?: string
}

/** Live while the CLI process is still producing output. */
function isLive(run: RunState): boolean {
  return run.phase === 'starting' || run.phase === 'running'
}

/**
 * The "new review" workbench: options, preview, and every run it started.
 *
 * Runs are kept per id rather than as one global panel. Reviews take minutes, the
 * rail shows them as the sessions they write, and several repositories can be
 * reviewed at once — a single `running`/`logs` pair made every repository show the
 * same task and made a second task impossible to start. Two runs in the *same*
 * repository are refused (here, and again in the main process): a repository's
 * history is then one run per session, with no ambiguity about which run a session
 * belongs to.
 *
 * The old single-run names (`running`, `logs`, `statusText`, …) survive as
 * projections of the *active repository's* run, which is what the workbench page
 * itself shows.
 */
export const useRunStore = defineStore('run', () => {
  const repos = useRepoStore()
  const results = useResultsStore()
  const ui = useUiStore()

  /* ---------------- options ---------------- */

  const mode = ref<ReviewMode>('workspace')
  const from = ref('')
  const to = ref('')
  const commit = ref('')
  const scanPath = ref('')

  const background = ref('')
  const exclude = ref('')
  const effort = ref<'' | 'low' | 'medium' | 'high'>('')
  const provider = ref('')
  const model = ref('')

  const concurrency = ref<number | null>(null)
  const timeoutMinutes = ref<number | null>(null)
  const maxTokensBudget = ref<number | null>(null)
  const noFilter = ref(false)

  // scan-only switches
  const noPlan = ref(false)
  const noDedup = ref(false)
  const noSummary = ref(false)
  const batch = ref<'' | 'none' | 'by-language' | 'by-directory'>('')

  /* ---------------- refs for the pickers ---------------- */

  const branches = ref<GitRef[]>([])
  const commits = ref<{ hash: string; short: string; subject: string; meta: string }[]>([])
  const refsLoading = ref(false)
  const refsError = ref<string | null>(null)

  /* ---------------- preview ---------------- */

  const preview = ref<Preview | null>(null)
  const previewing = ref(false)
  const previewError = ref<string | null>(null)
  const previewStale = ref(false)

  /* ---------------- runs ---------------- */

  /** Every run this window knows about, oldest first. */
  const runs = ref<RunState[]>([])

  /**
   * Events that arrived before the renderer learned the run id.
   *
   * The main process replays what fired while `startRun` was still returning, and
   * a bound session can arrive while a re-attached run is being adopted, so an
   * unknown run id is stashed rather than dropped.
   *
   * Entries are dropped again by `attachExisting`, which is the last moment a run
   * this window does not know about could still be adopted — anything left belongs
   * to a run that ended before the window was listening.
   */
  const early = new Map<string, { logs: string[]; session?: RunSessionBound; done?: RunResult }>()

  function stashFor(runId: string): { logs: string[]; session?: RunSessionBound; done?: RunResult } {
    const existing = early.get(runId)
    if (existing) return existing
    const created = { logs: [] as string[] }
    early.set(runId, created)
    return created
  }

  function known(runId: string): boolean {
    return runs.value.some((run) => run.runId === runId)
  }

  function patchRun(runId: string, patch: Partial<RunState>): void {
    runs.value = runs.value.map((run) => (run.runId === runId ? { ...run, ...patch } : run))
  }

  function appendLog(runId: string, text: string): void {
    const run = runs.value.find((entry) => entry.runId === runId)
    if (!run) return
    const next = [...run.logs, text]
    patchRun(runId, {
      logs: next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    })
  }

  let ticker: number | null = null

  function ensureTicker(): void {
    if (ticker !== null) return
    ticker = window.setInterval(() => {
      const now = Date.now()
      const live = runs.value.filter(isLive)
      if (!live.length) {
        if (ticker !== null) window.clearInterval(ticker)
        ticker = null
        return
      }
      const liveIds = new Set(live.map((run) => run.runId))
      runs.value = runs.value.map((run) =>
        liveIds.has(run.runId) ? { ...run, elapsedMs: now - run.startedAt } : run
      )
    }, TICK_MS)
  }

  // The rail and the repository store ask which sessions are running; this is the
  // one place that answer is computed. Synchronous on purpose: the naming queue
  // consults it in the same turn a run changes phase, and a stale answer there names
  // a session whose review is still being written.
  watch(
    () => runs.value.map((run) => `${run.runId}\u0000${run.repoDir}\u0000${run.sessionId ?? ''}\u0000${run.phase}`).join('\u0001'),
    () => syncLiveRuns(runs.value.filter(isLive)),
    { immediate: true, flush: 'sync' }
  )

  /** Creates (or adopts) the state for a run and drains anything that raced ahead. */
  function adopt(runId: string, seed: Omit<RunState, 'logs' | 'elapsedMs'> & { logs?: string[] }): void {
    if (!known(runId)) {
      runs.value = [
        ...runs.value,
        { ...seed, logs: seed.logs ?? [], elapsedMs: Date.now() - seed.startedAt }
      ]
    }

    const pending = early.get(runId)
    if (pending) {
      early.delete(runId)
      for (const line of pending.logs) appendLog(runId, line)
      if (pending.session) bindSession(pending.session)
      if (pending.done) finish(pending.done)
    }

    if (runs.value.some((run) => run.runId === runId && isLive(run))) ensureTicker()
  }

  /* ---------------- live run events ---------------- */

  window.ocr.onRunLog((line) => {
    if (!known(line.runId)) {
      // Bounded here too: a stashed run may never be adopted, and an unbounded
      // buffer is exactly the leak a stash invites.
      const stashed = stashFor(line.runId)
      stashed.logs.push(line.text)
      if (stashed.logs.length > MAX_LOG_LINES) {
        stashed.logs.splice(0, stashed.logs.length - MAX_LOG_LINES)
      }
      return
    }
    appendLog(line.runId, line.text)
  })

  /**
   * What each phase says in the panel.
   *
   * A table rather than a chain of ternaries: this vocabulary is read by a person
   * waiting for a review, and adding a phase should be one line, not a fifth
   * branch to place correctly.
   */
  const PHASE_TEXT: Record<RunPhase, string> = {
    starting: '正在启动…',
    running: '正在收集结果…',
    finished: '已完成',
    cancelled: '已中断',
    failed: '失败'
  }

  window.ocr.onRunProgress((progress) => {
    if (!known(progress.runId)) return

    // A phase from this event is never terminal. The main process says "finished"
    // and "cancelled" *before* the CLI process is gone, and the renderer must not
    // decide a run is over while `activeRuns` in the main process still refuses a
    // new run for that repository — the stop button, the button that starts the
    // next review and the wait before a repository delete all read that one fact.
    // Only `run:done` ends a run.
    const text = progress.phase === 'cancelled' ? '正在中断…' : PHASE_TEXT[progress.phase]

    const patch: Partial<RunState> = { statusText: text }
    // Only the live phases move the phase; the rest are narration until `run:done`.
    if (progress.phase === 'starting' || progress.phase === 'running') patch.phase = progress.phase
    patchRun(progress.runId, patch)

    if (progress.phase === 'starting' && progress.message) {
      appendLog(progress.runId, `$ ${progress.message}`)
    }
  })

  /**
   * The CLI named the session this run is writing.
   *
   * This is what makes a task appear in the rail as a real session within a second
   * of starting, instead of as a placeholder that only becomes a record once the
   * run is over.
   */
  window.ocr.onRunSession((bound) => {
    if (!known(bound.runId)) {
      stashFor(bound.runId).session = bound
      return
    }
    bindSession(bound)
  })

  function bindSession(bound: RunSessionBound): void {
    const run = runs.value.find((entry) => entry.runId === bound.runId)
    if (!run || run.sessionId === bound.sessionId) return

    patchRun(bound.runId, { sessionId: bound.sessionId })
    repos.expandRepo(bound.repoDir)
    void repos.refreshSessions(bound.repoDir)
  }

  window.ocr.onRunDone((result) => {
    if (!known(result.runId)) {
      stashFor(result.runId).done = result
      return
    }
    finish(result)
  })

  async function finish(result: RunResult): Promise<void> {
    const run = runs.value.find((entry) => entry.runId === result.runId)
    if (!run) return

    const sessionId = result.sessionId ?? run.sessionId
    const dir = run.repoDir

    if (result.cancelled) {
      patchRun(result.runId, {
        phase: 'cancelled',
        statusText: '已中断',
        cancelling: false,
        sessionId,
        elapsedMs: Date.now() - run.startedAt
      })
      // The CLI keeps the partial session on disk and reports it as aborted, so
      // re-reading the list is all it takes for the interrupted task to appear as
      // an openable record — with the log this window captured attached to it. It
      // is also how a session that was never matched to this run is found: the file
      // exists whether or not the poll got there first.
      await repos.refreshSessions(dir)
      ui.notify('审查已中断，记录已保留', 'info')
      return
    }

    if (result.error || result.exitCode !== 0) {
      patchRun(result.runId, {
        phase: 'failed',
        statusText: '失败',
        cancelling: false,
        sessionId,
        error: result.error,
        elapsedMs: Date.now() - run.startedAt
      })
      if (sessionId) await repos.refreshSessions(dir)
      ui.notifyError(result.error ?? `ocr 退出码 ${result.exitCode}`)
      return
    }

    // A clean exit with no session is not a failure: ocr found nothing to review.
    if (!sessionId) {
      patchRun(result.runId, {
        phase: 'finished',
        statusText: '无可审查内容',
        cancelling: false,
        elapsedMs: Date.now() - run.startedAt
      })
      ui.notify('没有需要审查的改动', 'info')
      return
    }

    patchRun(result.runId, {
      phase: 'finished',
      statusText: '已完成',
      cancelling: false,
      sessionId,
      elapsedMs: Date.now() - run.startedAt
    })

    // Named before the list is re-read, so the job is at the front of the naming
    // queue rather than behind whatever the refresh is about to queue: this is the
    // row the user is looking at, and waiting behind a backfill of an old history
    // is the wrong order. `refreshSessions` then finds the job already queued.
    repos.queueTitleNow(dir, sessionId)
    await repos.refreshSessions(dir)

    const watchingThisSession = ui.view === 'results' && results.sessionId === sessionId
    if (watchingThisSession) {
      await results.load(dir, sessionId)
      return
    }

    // Only follow the run the user is actually watching: switching the page under
    // someone reading another repository is worse than a toast.
    if (ui.view === 'new-review' && repos.activeRepoDir === dir) {
      repos.activeSessionId = sessionId
      await results.load(dir, sessionId)
      // Reading the session takes a moment, and the user may have moved on in the
      // meantime — clicked another repository, gone home. Switching the page under
      // them after the fact is worse than leaving the result in the rail.
      if (ui.view === 'new-review' && repos.activeRepoDir === dir) {
        ui.showView('results')
        ui.notify('审查完成，已打开结果', 'ok')
      }
      return
    }

    ui.notify('审查完成', 'ok')
  }

  /* ---------------- actions ---------------- */

  /** Resets everything tied to a repository when the selection changes. */
  function resetFor(dir: string | null): void {
    preview.value = null
    previewError.value = null
    previewStale.value = false
    branches.value = []
    commits.value = []
    from.value = ''
    to.value = ''
    commit.value = ''
    scanPath.value = ''

    if (dir) void loadRefs()
  }

  /** Marks the preview out of date after an option changes. */
  function markStale(): void {
    if (preview.value) previewStale.value = true
  }

  /** Loads branches and recent commits for the pickers. */
  async function loadRefs(): Promise<void> {
    if (!repoDir.value) return
    refsLoading.value = true
    refsError.value = null
    try {
      const [branchList, commitList] = await Promise.all([
        unwrap(window.ocr.gitBranches(repoDir.value)),
        unwrap(window.ocr.gitCommits(repoDir.value, 60))
      ])
      branches.value = branchList
      commits.value = commitList

      // Sensible defaults: current branch as the head, main/master as the base.
      const current = branchList.find((b) => b.current)
      if (current) to.value = to.value || current.name
      const base = branchList.find((b) => ['main', 'master', 'develop'].includes(b.name))
      if (base) from.value = from.value || base.name
    } catch (err) {
      refsError.value = err instanceof Error ? err.message : String(err)
    } finally {
      refsLoading.value = false
    }
  }

  /** Runs the free preview. */
  async function doPreview(): Promise<void> {
    if (!repoDir.value) return
    previewing.value = true
    previewError.value = null
    try {
      preview.value = await unwrap(window.ocr.previewRun(options()))
      previewStale.value = false
    } catch (err) {
      previewError.value = err instanceof Error ? err.message : String(err)
      preview.value = null
    } finally {
      previewing.value = false
    }
  }

  const repoDir = computed(() => repos.activeRepoDir ?? '')

  /** Assembles the payload for the main process. */
  function options(): ReviewOptions {
    return {
      repoDir: repoDir.value,
      mode: mode.value,
      from: from.value || undefined,
      to: to.value || undefined,
      commit: commit.value || undefined,
      scanPath: scanPath.value || undefined,
      background: background.value || undefined,
      exclude: exclude.value || undefined,
      effort: effort.value || undefined,
      provider: provider.value || undefined,
      model: model.value || undefined,
      concurrency: concurrency.value ?? undefined,
      timeoutMinutes: timeoutMinutes.value ?? undefined,
      maxTokensBudget: maxTokensBudget.value ?? undefined,
      noFilter: noFilter.value || undefined,
      noPlan: noPlan.value || undefined,
      noDedup: noDedup.value || undefined,
      noSummary: noSummary.value || undefined,
      batch: batch.value || undefined
    }
  }

  /** A human-readable command line, shown before running. */
  const commandPreview = computed(() => {
    const parts: string[] = [isScan.value ? 'ocr scan' : 'ocr review']

    if (mode.value === 'range') {
      if (from.value) parts.push(`--from ${from.value}`)
      if (to.value) parts.push(`--to ${to.value}`)
    } else if (mode.value === 'commit' && commit.value) {
      parts.push(`--commit ${commit.value}`)
    } else if (mode.value === 'scan' && scanPath.value) {
      parts.push(`--path ${scanPath.value}`)
    }

    if (repoDir.value) parts.push(`--repo "${repoDir.value}"`)
    if (background.value.trim()) parts.push('--background "…"')
    if (exclude.value.trim()) parts.push(`--exclude "${exclude.value.trim()}"`)
    if (effort.value) parts.push(`--effort ${effort.value}`)
    if (provider.value) parts.push(`--provider ${provider.value}`)
    if (model.value) parts.push(`--model ${model.value}`)
    if (concurrency.value) parts.push(`--concurrency ${concurrency.value}`)
    if (timeoutMinutes.value) parts.push(`--timeout ${timeoutMinutes.value}`)
    if (maxTokensBudget.value) parts.push(`--max-tokens-budget ${maxTokensBudget.value}`)
    if (isScan.value) {
      if (noPlan.value) parts.push('--no-plan')
      if (noDedup.value) parts.push('--no-dedup')
      if (noSummary.value) parts.push('--no-summary')
      if (batch.value) parts.push(`--batch ${batch.value}`)
    } else if (noFilter.value) {
      parts.push('--no-filter')
    }

    parts.push('--format json')
    return parts.join(' ')
  })

  /** Runs belonging to one repository, oldest first. */
  function runsFor(dir: string): RunState[] {
    return runs.value.filter((run) => run.repoDir === dir)
  }

  /** The live run of one repository, if it has one. */
  function liveRunFor(dir: string): RunState | null {
    return runs.value.find((run) => run.repoDir === dir && isLive(run)) ?? null
  }

  /** The run currently writing a session, if any. */
  function runForSession(sessionId: string): RunState | null {
    return runs.value.find((run) => run.sessionId === sessionId) ?? null
  }

  /** A live run for a session — the only case the session page shows a log. */
  function liveRunForSession(sessionId: string): RunState | null {
    const run = runForSession(sessionId)
    return run && isLive(run) ? run : null
  }

  function isRepoBusy(dir: string): boolean {
    return Boolean(liveRunFor(dir)) || starting.value.includes(dir)
  }

  /** Whether a run state is still producing output. */
  function isRunLive(entry: RunState): boolean {
    return isLive(entry)
  }

  /**
   * Repositories with a `startRun` call in flight.
   *
   * The run state does not exist until the call returns, so without this a second
   * click during that window would reach the main process — which refuses it with
   * an error toast for a task the user did start. The main process keeps the rule
   * authoritative; this keeps the UI from asking it a question it must say no to.
   */
  const starting = ref<string[]>([])

  /** True when the current options are enough to start a run. */
  const canStart = computed(() => {
    if (!repoDir.value || isRepoBusy(repoDir.value)) return false
    if (mode.value === 'range') return Boolean(from.value && to.value)
    if (mode.value === 'commit') return Boolean(commit.value)
    return true
  })

  const isScan = computed(() => mode.value === 'scan')

  /* ---- the active repository's run, as the workbench page shows it ---- */

  const currentRun = computed<RunState | null>(() => {
    const mine = runsFor(repoDir.value)
    return mine.find(isLive) ?? mine[mine.length - 1] ?? null
  })

  const running = computed(() => Boolean(liveRunFor(repoDir.value)))
  const startingRun = computed(() => starting.value.includes(repoDir.value))
  const cancelling = computed(() => Boolean(currentRun.value?.cancelling))
  const runId = computed(() => currentRun.value?.runId ?? null)
  const logs = computed(() => currentRun.value?.logs ?? [])
  const statusText = computed(() => currentRun.value?.statusText ?? '')
  const elapsedMs = computed(() => currentRun.value?.elapsedMs ?? 0)
  /** Why the last run failed, for the panel: the toast is gone in a few seconds. */
  const currentError = computed(() => currentRun.value?.error ?? '')

  /** Starts a review. Completion is handled by the push subscriptions. */
  async function start(): Promise<void> {
    if (!canStart.value) return
    const dir = repoDir.value

    // Recorded before the first await: `canStart` reads it, so a double click and
    // a click that races the IPC reply both stop here.
    starting.value = [...starting.value, dir]

    try {
      const started = await unwrap(window.ocr.startRun(options()))
      adopt(started.runId, {
        runId: started.runId,
        repoDir: dir,
        sessionId: null,
        phase: 'starting',
        statusText: '正在启动…',
        startedAt: Date.now(),
        command: `ocr ${started.invocation.args.join(' ')}`,
        mode: mode.value,
        cancelling: false
      })
      // The row for this run belongs to the repository it was started in, even if
      // the user moves on to another one while it works.
      repos.expandRepo(dir)
    } catch (err) {
      ui.notifyError(err)
    } finally {
      starting.value = starting.value.filter((entry) => entry !== dir)
    }
  }

  /** Stops one run; defaults to the active repository's. */
  async function cancel(target?: string): Promise<void> {
    const run = target
      ? runs.value.find((entry) => entry.runId === target)
      : liveRunFor(repoDir.value)

    if (!run || !isLive(run) || run.cancelling) return
    // Stays live until `run:done`: that is what keeps the button, the ticker and
    // the wait before a repository delete in step with the main process.
    patchRun(run.runId, { statusText: '正在中断…', cancelling: true })
    await unwrap(window.ocr.cancelRun(run.runId))
  }

  /**
   * Stops a run and waits for its process to be gone.
   *
   * Used before deleting a repository: the delete moves the session directory, and
   * a CLI process still writing into it would recreate files in a directory that
   * is supposed to be gone. Resolves as soon as the run is no longer live, so the
   * two operations stay ordered without guessing a delay.
   */
  async function cancelAndWait(target: string, timeoutMs = 5000): Promise<void> {
    await cancel(target)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const entry = runs.value.find((item) => item.runId === target)
      if (!entry || !isLive(entry)) return
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
  }

  /**
   * Re-attaches to runs the main process is still holding.
   *
   * A renderer reload — the dev server's HMR above all — forgets the runs while
   * the CLI processes keep going. Without this the rail would show a running task
   * as an ordinary old session and its completion would go unnoticed.
   */
  async function attachExisting(): Promise<void> {
    try {
      const list = await unwrap(window.ocr.listRuns())

      for (const entry of list) {
        if (known(entry.runId)) continue
        adopt(entry.runId, {
          runId: entry.runId,
          repoDir: entry.repoDir,
          sessionId: entry.sessionId ?? null,
          phase: 'running',
          statusText: '正在运行…',
          startedAt: entry.startedAt,
          command: entry.command,
          mode: entry.mode,
          cancelling: false,
          logs: ['· 界面已重新连接，此前输出未保留']
        })
      }

      if (list.length) ui.notify(`已重新连接 ${list.length} 个仍在运行的任务`, 'info')
    } catch {
      // An environment that cannot list runs simply has none.
    } finally {
      // This was the last chance to adopt a run: whatever is still stashed ended
      // before this window could listen, and would otherwise sit in memory forever.
      // Its session is not lost — the rail reads the list when the repository opens.
      early.clear()
    }
  }

  return {
    mode,
    from,
    to,
    commit,
    scanPath,
    background,
    exclude,
    effort,
    provider,
    model,
    concurrency,
    timeoutMinutes,
    maxTokensBudget,
    noFilter,
    noPlan,
    noDedup,
    noSummary,
    batch,
    branches,
    commits,
    refsLoading,
    refsError,
    preview,
    previewing,
    previewError,
    previewStale,
    runs,
    running,
    startingRun,
    cancelling,
    runId,
    logs,
    statusText,
    currentError,
    elapsedMs,
    isScan,
    repoDir,
    commandPreview,
    canStart,
    runsFor,
    liveRunFor,
    runForSession,
    liveRunForSession,
    isRepoBusy,
    isRunLive,
    options,
    resetFor,
    markStale,
    loadRefs,
    doPreview,
    start,
    cancel,
    cancelAndWait,
    attachExisting
  }
})
