import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GitRef, Preview, ReviewMode, ReviewOptions, RunResult } from '@shared/types'
import { unwrap } from '../utils/ipc'
import { useRepoStore } from './repos'
import { useResultsStore } from './results'
import { useUiStore } from './ui'

/** Keeps the progress log bounded during long reviews. */
const MAX_LOG_LINES = 600

/**
 * The "new review" workbench: options, preview, and the live run.
 *
 * Run events arrive on push channels from the main process. They are subscribed
 * once, when this store is first instantiated, and filtered by run id so a stale
 * run cannot corrupt the current panel.
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

  /* ---------------- run ---------------- */

  const running = ref(false)
  const runId = ref<string | null>(null)
  const logs = ref<string[]>([])
  const statusText = ref('')
  const lastResult = ref<RunResult | null>(null)
  const startedAt = ref<number | null>(null)
  const elapsedMs = ref(0)
  /**
   * The repository the in-flight run belongs to.
   *
   * Captured at start rather than read from the active repo later, so switching
   * repositories mid-run cannot make the completion handler open a session
   * against the wrong directory.
   */
  const runRepoDir = ref('')

  let elapsedTimer: number | null = null

  const isScan = computed(() => mode.value === 'scan')
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

  /** True when the current options are enough to start a run. */
  const canStart = computed(() => {
    if (!repoDir.value || running.value) return false
    if (mode.value === 'range') return Boolean(from.value && to.value)
    if (mode.value === 'commit') return Boolean(commit.value)
    return true
  })

  /* ---------------- live run events ---------------- */

  window.ocr.onRunLog((line) => {
    if (line.runId !== runId.value) return
    const next = [...logs.value, line.text]
    logs.value = next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
  })

  window.ocr.onRunProgress((progress) => {
    if (progress.runId !== runId.value) return
    if (progress.phase === 'starting') statusText.value = '正在启动…'
    else if (progress.phase === 'running') statusText.value = '正在收集结果…'
    else if (progress.phase === 'finished') statusText.value = '已完成'
    else if (progress.phase === 'cancelled') statusText.value = '已取消'
    else if (progress.phase === 'failed') statusText.value = '失败'
    if (progress.message && progress.phase === 'starting') {
      logs.value = [...logs.value, `$ ${progress.message}`]
    }
  })

  window.ocr.onRunDone(async (result) => {
    if (result.runId !== runId.value) return

    stopTimer()
    running.value = false
    lastResult.value = result

    const dir = runRepoDir.value || repoDir.value

    if (result.cancelled) {
      statusText.value = '已取消'
      ui.notify('审查已取消', 'info')
      return
    }

    if (result.sessionId) {
      statusText.value = '已完成'
      // Surface the session immediately: the whole point of the panel.
      repos.activeSessionId = result.sessionId
      await repos.refreshSessions(dir)
      await results.load(dir, result.sessionId)
      ui.showView('results')
      ui.notify('审查完成，已打开结果', 'ok')
      return
    }

    if (result.error) {
      statusText.value = '失败'
      ui.notifyError(result.error)
      return
    }

    // A clean exit with no session is not a failure: ocr found nothing to
    // review (no changed files, or every change was filtered out).
    if (result.exitCode === 0) {
      statusText.value = '无可审查内容'
      ui.notify('没有需要审查的改动', 'info')
      return
    }

    statusText.value = '失败'
    ui.notifyError(`ocr 退出码 ${result.exitCode}`)
  })

  /* ---------------- actions ---------------- */

  function startTimer(): void {
    startedAt.value = Date.now()
    elapsedMs.value = 0
    stopTimer()
    elapsedTimer = window.setInterval(() => {
      if (startedAt.value) elapsedMs.value = Date.now() - startedAt.value
    }, 500)
  }

  function stopTimer(): void {
    if (elapsedTimer !== null) {
      window.clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

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

    // The run panel reports the last outcome persistently, so it has to be
    // cleared when moving to another repository — but not while a run is
    // in flight, or the user would lose the log they are watching.
    if (!running.value) {
      statusText.value = ''
      logs.value = []
      lastResult.value = null
    }

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

  /** Starts the review. Completion is handled by the push subscription. */
  async function start(): Promise<void> {
    if (!canStart.value) return

    running.value = true
    logs.value = []
    lastResult.value = null
    statusText.value = '正在启动…'
    runRepoDir.value = repoDir.value
    startTimer()

    try {
      const started = await unwrap(window.ocr.startRun(options()))
      runId.value = started.runId
    } catch (err) {
      running.value = false
      stopTimer()
      statusText.value = '启动失败'
      ui.notifyError(err)
    }
  }

  async function cancel(): Promise<void> {
    if (!runId.value) return
    await unwrap(window.ocr.cancelRun(runId.value))
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
    running,
    runId,
    logs,
    statusText,
    lastResult,
    elapsedMs,
    isScan,
    repoDir,
    commandPreview,
    canStart,
    options,
    resetFor,
    markStale,
    loadRefs,
    doPreview,
    start,
    cancel
  }
})
