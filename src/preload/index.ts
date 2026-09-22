import { contextBridge, ipcRenderer } from 'electron'
import type {
  GitCommitView,
  InvocationView,
  OcrApiSurface,
  StartRunView,
  Unsubscribe
} from '@shared/api'
import { IPC, type IpcResult } from '@shared/types'

/**
 * The only bridge between the renderer and the outside world.
 *
 * Everything is an explicit, typed function — the renderer gets no `require`, no
 * `fs`, and no `child_process`. Failures arrive as `{ ok: false, error }` values
 * so the UI can surface them without try/catch noise at every call site.
 *
 * The object is annotated with `OcrApiSurface`, so if this implementation and the
 * declared contract drift apart the build fails here.
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

/** Subscribes to a main-process push channel; returns an unsubscribe function. */
function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: OcrApiSurface = {
  /* environment */
  envInfo: () => invoke(IPC.envInfo),
  refreshEnv: () => invoke(IPC.envRefresh),

  /* repositories */
  listRepos: () => invoke(IPC.repoList),
  addRepo: (dir: string) => invoke(IPC.repoAdd, dir),
  removeRepo: (dir: string) => invoke(IPC.repoRemove, dir),
  pickRepo: () => invoke(IPC.repoPick),

  /* sessions */
  listSessions: (repoDir: string, limit = 0) => invoke(IPC.sessionList, repoDir, limit),
  sessionDetail: (repoDir: string, sessionId: string) =>
    invoke(IPC.sessionDetail, repoDir, sessionId),
  sessionComments: (repoDir: string, sessionId: string, filter) =>
    invoke(IPC.sessionComments, repoDir, sessionId, filter),
  exportSessionMarkdown: (request) => invoke(IPC.sessionExportMarkdown, request),

  /* git */
  gitBranches: (repoDir: string) => invoke(IPC.gitBranches, repoDir),
  gitCommits: (repoDir: string, limit?: number) => invoke(IPC.gitCommits, repoDir, limit),

  /* runs */
  previewRun: (options) => invoke(IPC.previewRun, options),
  startRun: (options) => invoke(IPC.startRun, options),
  cancelRun: (runId: string) => invoke(IPC.cancelRun, runId),
  onRunLog: (callback) => subscribe(IPC.runLog, callback),
  onRunProgress: (callback) => subscribe(IPC.runProgress, callback),
  onRunDone: (callback) => subscribe(IPC.runDone, callback),

  /* config */
  readConfig: () => invoke(IPC.configRead),
  setConfig: (key: string, value: string) => invoke(IPC.configSet, key, value),
  unsetConfig: (key: string) => invoke(IPC.configUnset, key),
  testConfig: () => invoke(IPC.configTest),
  listBackups: () => invoke(IPC.configBackups),
  restoreBackup: (backupPath: string) => invoke(IPC.configRestore, backupPath),

  /* app settings */
  getSettings: () => invoke(IPC.settingsGet),
  setSettings: (patch) => invoke(IPC.settingsSet, patch),

  /* shell + files */
  openPath: (target: string) => invoke(IPC.openPath, target),
  openExternal: (url: string) => invoke(IPC.openExternal, url),
  openInEditor: (filePath: string, line?: number) => invoke(IPC.openInEditor, filePath, line),
  readSnippet: (repoDir: string, filePath: string, start: number, end: number) =>
    invoke(IPC.readSnippet, repoDir, filePath, start, end),
  readWholeFile: (repoDir: string, filePath: string) =>
    invoke(IPC.readWholeFile, repoDir, filePath)
}

export type { GitCommitView, InvocationView, StartRunView }

contextBridge.exposeInMainWorld('ocr', api)
