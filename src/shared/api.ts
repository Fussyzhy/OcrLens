import type {
  AppSettings,
  CommentFilter,
  ConfigBackup,
  ConfigTestResult,
  EnvInfo,
  ExportMarkdownRequest,
  ExportMarkdownResult,
  FileSnippet,
  GitRef,
  IpcResult,
  MutateResultView,
  OcrConfigView,
  Preview,
  RepoEntry,
  ReviewComment,
  ReviewOptions,
  RunLogLine,
  RunProgress,
  RunResult,
  SessionDetail,
  SessionSummary
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
  /* environment */
  envInfo(): Promise<IpcResult<EnvInfo>>
  refreshEnv(): Promise<IpcResult<EnvInfo>>

  /* repositories */
  listRepos(): Promise<IpcResult<RepoEntry[]>>
  addRepo(dir: string): Promise<IpcResult<RepoEntry | null>>
  removeRepo(dir: string): Promise<IpcResult<boolean>>
  pickRepo(): Promise<IpcResult<string | null>>

  /* sessions */
  listSessions(repoDir: string, limit?: number): Promise<IpcResult<SessionSummary[]>>
  sessionDetail(repoDir: string, sessionId: string): Promise<IpcResult<SessionDetail>>
  sessionComments(
    repoDir: string,
    sessionId: string,
    filter?: CommentFilter
  ): Promise<IpcResult<ReviewComment[]>>
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
  onRunLog(callback: (line: RunLogLine) => void): Unsubscribe
  onRunProgress(callback: (progress: RunProgress) => void): Unsubscribe
  onRunDone(callback: (result: RunResult) => void): Unsubscribe

  /* config */
  readConfig(): Promise<IpcResult<OcrConfigView>>
  setConfig(key: string, value: string): Promise<IpcResult<MutateResultView>>
  unsetConfig(key: string): Promise<IpcResult<MutateResultView>>
  testConfig(): Promise<IpcResult<ConfigTestResult>>
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
