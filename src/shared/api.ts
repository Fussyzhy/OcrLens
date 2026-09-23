import type {
  ActiveRunView,
  AppSettings,
  CommentFilter,
  ConfigBackup,
  ConfigTestResult,
  DeleteSessionResult,
  EnvInfo,
  ExportMarkdownRequest,
  ExportMarkdownResult,
  FileSnippet,
  GitRef,
  IpcResult,
  MutateResultView,
  OcrConfigView,
  Preview,
  ProviderModelsRequest,
  ProviderModelsResult,
  ProviderSaveRequest,
  ProviderSaveResult,
  RepoDeleteResult,
  RepoEntry,
  ReviewComment,
  ReviewOptions,
  RunLogLine,
  RunProgress,
  RunResult,
  RunSessionBound,
  SessionDetail,
  SessionListEntry,
  SessionTitle,
  TitleResult
} from './types'

/**
 * The contract of the object the preload script exposes as `window.ocr`.
 *
 * It lives in shared (rather than being inferred from the preload module) so the
 * renderer can type `window.ocr` without pulling Electron's Node-flavoured type
 * definitions into the web TypeScript project. The preload implementation is
 * annotated with this interface, so any drift is a compile error there.
 */

export interface InvocationView {
  command: 'review' | 'scan'
  args: string[]
}

export interface StartRunView {
  runId: string
  invocation: InvocationView
}

export interface GitCommitView {
  hash: string
  short: string
  subject: string
  meta: string
}

export type Unsubscribe = () => void

export interface OcrApiSurface {
  /* window chrome (the window is frameless; the renderer draws its own bar) */
  windowMinimize(): Promise<IpcResult<boolean>>
  /** Toggles between maximised and restored, resolving to the state it reached. */
  windowToggleMaximize(): Promise<IpcResult<boolean>>
  /** Read once on mount: a reload can land in an already maximised window. */
  windowIsMaximized(): Promise<IpcResult<boolean>>
  windowClose(): Promise<IpcResult<boolean>>
  /**
   * Fires on every maximise and restore, including the ones the OS starts —
   * a double-click on the drag region, Win+Up, or a snap.
   */
  onWindowMaximized(callback: (maximized: boolean) => void): Unsubscribe

  /* environment */
  envInfo(): Promise<IpcResult<EnvInfo>>
  refreshEnv(): Promise<IpcResult<EnvInfo>>

  /* repositories */
  listRepos(): Promise<IpcResult<RepoEntry[]>>
  addRepo(dir: string): Promise<IpcResult<RepoEntry | null>>
  /**
   * Renames a repository in the rail.
   *
   * The folder on disk is never touched, so the paths recorded inside its
   * sessions keep working; an empty name restores the folder name.
   */
  renameRepo(dir: string, name: string | null): Promise<IpcResult<string | null>>
  /**
   * Deletes a repository: every one of its sessions moves to this client's trash
   * and the repository stops appearing in the rail.
   */
  deleteRepo(dir: string): Promise<IpcResult<RepoDeleteResult>>
  /** Stores the order the user dragged repositories into. */
  reorderRepos(dirs: string[]): Promise<IpcResult<string[]>>
  pickRepo(): Promise<IpcResult<string | null>>

  /* sessions */
  listSessions(repoDir: string, limit?: number): Promise<IpcResult<SessionListEntry[]>>
  sessionDetail(repoDir: string, sessionId: string): Promise<IpcResult<SessionDetail>>
  sessionComments(
    repoDir: string,
    sessionId: string,
    filter?: CommentFilter
  ): Promise<IpcResult<ReviewComment[]>>
  /**
   * Removes one session from history.
   *
   * The underlying file is moved into this client's own trash folder rather than
   * unlinked, so the operation stays recoverable; `trashedTo` reports where.
   */
  deleteSession(repoDir: string, sessionId: string): Promise<IpcResult<DeleteSessionResult>>
  /** Stores the order the user dragged one repository's sessions into. */
  reorderSessions(repoDir: string, sessionIds: string[]): Promise<IpcResult<string[]>>

  /* session titles (client-owned; ocr has no title concept) */
  /** Renames a session. An empty title clears it. */
  setSessionTitle(sessionId: string, title: string): Promise<IpcResult<SessionTitle | null>>
  /**
   * Asks the model for a name for one session.
   *
   * Not a user-facing action — the renderer calls this from a background queue for
   * every session it learns about that has no title yet. Sessions the user renamed
   * by hand come back with `applied: false` instead of being overwritten.
   */
  generateTitle(repoDir: string, sessionId: string): Promise<IpcResult<TitleResult>>
  /**
   * Writes a rendered Markdown report, asking the user where to put it first.
   *
   * A cancelled dialog is a successful call with `cancelled: true` — it is a
   * normal outcome, not an error to show the user.
   */
  exportSessionMarkdown(
    request: ExportMarkdownRequest
  ): Promise<IpcResult<ExportMarkdownResult>>

  /* git */
  gitBranches(repoDir: string): Promise<IpcResult<GitRef[]>>
  gitCommits(repoDir: string, limit?: number): Promise<IpcResult<GitCommitView[]>>

  /* runs */
  previewRun(options: ReviewOptions): Promise<IpcResult<Preview>>
  startRun(options: ReviewOptions): Promise<IpcResult<StartRunView>>
  cancelRun(runId: string): Promise<IpcResult<boolean>>
  /** Runs still in flight in the main process; used to re-attach after a reload. */
  listRuns(): Promise<IpcResult<ActiveRunView[]>>
  onRunLog(callback: (line: RunLogLine) => void): Unsubscribe
  onRunProgress(callback: (progress: RunProgress) => void): Unsubscribe
  /** The session the run turned out to be writing, discovered while it ran. */
  onRunSession(callback: (bound: RunSessionBound) => void): Unsubscribe
  onRunDone(callback: (result: RunResult) => void): Unsubscribe

  /* config */
  readConfig(): Promise<IpcResult<OcrConfigView>>
  setConfig(key: string, value: string): Promise<IpcResult<MutateResultView>>
  unsetConfig(key: string): Promise<IpcResult<MutateResultView>>
  testConfig(): Promise<IpcResult<ConfigTestResult>>
  /** Creates or updates a whole channel in one batched, backed-up write. */
  saveProvider(request: ProviderSaveRequest): Promise<IpcResult<ProviderSaveResult>>
  /**
   * Asks a channel's gateway which models it serves.
   *
   * The form's current url/protocol/key travel with the request, so this also
   * works while a channel is still being created.
   */
  fetchProviderModels(
    request: ProviderModelsRequest
  ): Promise<IpcResult<ProviderModelsResult>>
  listBackups(): Promise<IpcResult<ConfigBackup[]>>
  restoreBackup(backupPath: string): Promise<IpcResult<{ ok: boolean; error?: string }>>

  /* app settings */
  getSettings(): Promise<IpcResult<AppSettings>>
  setSettings(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>

  /* shell + files */
  openPath(target: string): Promise<IpcResult<string | null>>
  openExternal(url: string): Promise<IpcResult<boolean>>
  openInEditor(filePath: string, line?: number): Promise<IpcResult<string>>
  readSnippet(
    repoDir: string,
    filePath: string,
    start: number,
    end: number
  ): Promise<IpcResult<FileSnippet>>
  readWholeFile(repoDir: string, filePath: string): Promise<IpcResult<FileSnippet>>
}
