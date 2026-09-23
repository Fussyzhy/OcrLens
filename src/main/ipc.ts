import { spawn } from 'node:child_process'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  type CommentFilter,
  type ExportMarkdownRequest,
  type ReviewOptions,
  type RunLogLine,
  type RunProgress,
  type RunResult
} from '@shared/types'
import {
  configSet,
  configUnset,
  listBackups,
  readConfigView,
  restoreBackup,
  testConnection
} from './config'
import { envInfo, ensureEnv, gitPath, ocrContext, refreshEnv, tryOcrContext, type OcrContext } from './env'
import { exportMarkdown } from './exporter'
import { listBranches, listCommits } from './git'
import { addRepo, listRepos, removeRepo } from './repos'
import { previewRun, startRun, type RunHandle } from './runner'
import { deleteSession, listSessions, sessionComments, sessionDetail } from './sessions'
import { readSettings, writeSettings } from './settings'
import { readSnippet, readWholeFile } from './source'
import { generateTitle } from './titler'
import { getTitle, removeTitle, setTitle } from './titles'

/**
 * IPC surface.
 *
 * Every handler is wrapped so failures come back as `{ ok: false, error }`
 * rather than a rejected promise. The ocr CLI signals many ordinary situations
 * with a non-zero exit code, so "it failed" is a routine outcome the UI has to
 * render, not an exception.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown

function handle(channel: string, fn: AnyFn): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** In-flight runs, so the UI can cancel one by id. */
const activeRuns = new Map<string, RunHandle>()

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /** Pushes an event to the renderer if a window is still alive. */
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /* ---- window chrome ---- */

  // The window is frameless (see createWindow), so these are the only way to
  // resize or close it. They go through the same wrapper as everything else,
  // which keeps the "no handler ever rejects" rule intact.
  handle(IPC.windowMinimize, () => {
    getWindow()?.minimize()
    return true
  })

  handle(IPC.windowToggleMaximize, () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)

  handle(IPC.windowClose, () => {
    getWindow()?.close()
    return true
  })

  /** Resolves the environment first, so handlers need not care about ordering. */
  const ctx = async (): Promise<OcrContext> => {
    await ensureEnv()
    return ocrContext()
  }

  /* ---------------- environment ---------------- */

  handle(IPC.envInfo, async () => envInfo() ?? (await ensureEnv()))
  handle(IPC.envRefresh, async () => refreshEnv())

  /* ---------------- repositories ---------------- */

  handle(IPC.repoList, async () => listRepos())

  handle(IPC.repoAdd, async (dir: string) => {
    const result = await addRepo(dir)
    if (!result.ok) throw new Error(result.error ?? 'Could not add the repository')
    return result.repo ?? null
  })

  handle(IPC.repoRemove, async (dir: string) => {
    removeRepo(dir)
    return true
  })

  handle(IPC.repoPick, async () => {
    const win = getWindow()
    const options = {
      title: 'Select a git repository',
      properties: ['openDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  /* ---------------- sessions ---------------- */

  handle(IPC.sessionList, async (repoDir: string, limit = 0) =>
    listSessions(await ctx(), repoDir, limit)
  )

  handle(IPC.sessionDetail, async (repoDir: string, sessionId: string) =>
    sessionDetail(await ctx(), repoDir, sessionId)
  )

  handle(IPC.sessionComments, async (repoDir: string, sessionId: string, filter?: CommentFilter) =>
    sessionComments(await ctx(), repoDir, sessionId, filter)
  )

  /**
   * Writes a report the renderer has already rendered.
   *
   * The content is opaque here on purpose — the main process has no opinion on
   * Markdown, and the renderer is the only side that knows which findings the
   * user is currently looking at.
   */
  handle(IPC.sessionExportMarkdown, async (request: ExportMarkdownRequest) =>
    exportMarkdown(getWindow(), request)
  )

  handle(IPC.sessionDelete, async (repoDir: string, sessionId: string) =>
    deleteSession(repoDir, sessionId)
  )

  /* ---------------- session titles ---------------- */

  handle(IPC.titleSet, async (sessionId: string, title: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话 id')
    // Checked like the id above: `title.trim()` on a non-string threw a native
    // TypeError, which came back as an unreadable runtime error.
    if (typeof title !== 'string') throw new Error('标题必须是字符串')

    if (!title.trim()) {
      removeTitle(sessionId)
      return null
    }

    const outcome = setTitle(sessionId, title, 'user')
    if (!outcome.applied) throw new Error('标题不能为空。')
    return getTitle(sessionId) ?? null
  })

  handle(IPC.titleGenerate, async (repoDir: string, sessionId: string) =>
    generateTitle(await ctx(), repoDir, sessionId)
  )

  /* ---------------- git ---------------- */

  handle(IPC.gitBranches, async (repoDir: string) => {
    await ensureEnv()
    const git = gitPath()
    if (!git) throw new Error('No usable git found')
    return listBranches(git, repoDir)
  })

  handle(IPC.gitCommits, async (repoDir: string, limit?: number) => {
    await ensureEnv()
    const git = gitPath()
    if (!git) throw new Error('No usable git found')
    return listCommits(git, repoDir, limit ?? 50)
  })

  /* ---------------- runs ---------------- */

  handle(IPC.previewRun, async (options: ReviewOptions) => previewRun(await ctx(), options))

  handle(IPC.startRun, async (options: ReviewOptions) => {
    const context = await ctx()

    // Events can fire before `startRun` returns, so buffer until we know the id.
    const earlyLogs: RunLogLine[] = []
    let earlyProgress: RunProgress | null = null
    let earlyResult: RunResult | null = null
    let run: RunHandle | null = null

    const created = startRun(context, options, {
      onLog: (line) => (run ? send(IPC.runLog, line) : earlyLogs.push(line)),
      onProgress: (progress) => (run ? send(IPC.runProgress, progress) : (earlyProgress = progress)),
      onDone: (result) => {
        if (run) activeRuns.delete(run.runId)
        if (run) send(IPC.runDone, result)
        else earlyResult = result
      }
    })

    run = created
    activeRuns.set(created.runId, created)

    for (const line of earlyLogs) send(IPC.runLog, line)
    if (earlyProgress) send(IPC.runProgress, earlyProgress)
    if (earlyResult) send(IPC.runDone, earlyResult)

    return { runId: created.runId, invocation: created.invocation }
  })

  handle(IPC.cancelRun, async (runId: string) => {
    const run = activeRuns.get(runId)
    if (!run) return false
    run.cancel()
    return true
  })

  /* ---------------- config ---------------- */

  handle(IPC.configRead, async () => {
    await ensureEnv()
    const context = tryOcrContext()
    return readConfigView(context?.launch ?? null, context?.gitBinDir ?? null)
  })

  handle(IPC.configSet, async (key: string, value: string) => {
    await ensureEnv()
    const context = tryOcrContext()
    return configSet(context?.launch ?? null, context?.gitBinDir ?? null, key, value)
  })

  handle(IPC.configUnset, async (key: string) => {
    await ensureEnv()
    const context = tryOcrContext()
    return configUnset(context?.launch ?? null, context?.gitBinDir ?? null, key)
  })

  handle(IPC.configTest, async () => {
    await ensureEnv()
    const context = tryOcrContext()
    return testConnection(context?.launch ?? null, context?.gitBinDir ?? null)
  })

  handle(IPC.configBackups, async () => listBackups())
  handle(IPC.configRestore, async (backupPath: string) => restoreBackup(backupPath))

  /* ---------------- app settings ---------------- */

  handle(IPC.settingsGet, async () => readSettings())

  handle(IPC.settingsSet, async (patch: Record<string, unknown>) => {
    // Only fields this app owns may be written from the renderer.
    const allowed: Record<string, unknown> = {}
    for (const key of ['gitOverride', 'ocrOverride']) {
      if (key in patch) allowed[key] = patch[key]
    }

    const saved = writeSettings(allowed)

    // A changed binary path invalidates the cached environment.
    if ('gitOverride' in patch || 'ocrOverride' in patch) {
      await refreshEnv()
    }
    return saved
  })

  /* ---------------- shell / filesystem ---------------- */

  handle(IPC.openPath, async (target: string) => (await shell.openPath(target)) || null)
  handle(IPC.openExternal, async (url: string) => {
    await shell.openExternal(url)
    return true
  })

  /**
   * Opens a file at a line in the user's editor.
   *
   * Prefers the `code` CLI, which is installed on this machine and understands a
   * `file:line` suffix. Falls back to the OS default handler.
   */
  handle(IPC.openInEditor, async (filePath: string, line?: number) => {
    for (const command of ['code', 'code-insiders', 'cursor']) {
      const ok = await canSpawn(command, line ? ['-g', `${filePath}:${line}`] : [filePath])
      if (ok) return `Opened with ${command}`
    }

    const error = await shell.openPath(filePath)
    if (error) throw new Error(error)
    return 'Opened with the default application'
  })

  handle(IPC.readSnippet, async (repoDir: string, filePath: string, start: number, end: number) =>
    readSnippet(repoDir, filePath, start, end)
  )

  handle(IPC.readWholeFile, async (repoDir: string, filePath: string) =>
    readWholeFile(repoDir, filePath)
  )
}

/**
 * Probes whether a command can be started.
 *
 * `shell: true` is required because these are `.cmd` shims on Windows, and the
 * arguments here are editor invocations rather than user-controlled shell text.
 */
function canSpawn(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', shell: true })
      child.on('error', () => finish(false))
      child.on('spawn', () => finish(true))
    } catch {
      finish(false)
    }
  })
}

/** Cancels every running review; used when the window is closing. */
export function cancelAllRuns(): void {
  for (const run of activeRuns.values()) run.cancel()
  activeRuns.clear()
}
