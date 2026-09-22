/**
 * Shared contracts between the Electron main process and the renderer.
 *
 * Every structure here mirrors JSON that the `ocr` CLI actually emits. They were
 * derived from real output on this machine (`ocr session list/show/comments
 * --json`, `ocr review --preview --json`, JSONL session records) plus
 * `internal/model/review.go` in the upstream repo — not from documentation
 * guesses. Keep them in sync with the CLI; validate at the boundary instead of
 * trusting the shape blindly.
 */

/* ------------------------------------------------------------------ *
 * `ocr session list --json` / `ocr session show --json`
 * ------------------------------------------------------------------ */

/** One entry inside a run manifest's coverage buckets. */
export interface CoverageItem {
  item_id: string
  path: string
  fingerprint: string
  /** Present on `failed` entries, e.g. "provider". */
  classification?: string
  /** Present on `failed` entries, e.g. "provider or subtask request failed". */
  reason?: string
}

/**
 * A run manifest is embedded in every session summary. `schema_version` lets us
 * detect a future shape change instead of silently rendering blanks.
 */
export interface RunManifest {
  schema_version: string
  run_id: string
  /** "review" | "scan" */
  operation: string
  /** "complete" | "failed" | "skipped" | "aborted" | "partial" */
  terminal_state: string
  repository?: { identity_sha256?: string }
  input?: {
    mode?: string
    requested_head?: string
    resolved_base?: string
    resolved_head?: string
    exact_range?: string
    source_artifact_sha256?: string
  }
  execution?: {
    ocr_version?: string
    provider?: string
    model?: string
    configured_concurrency?: number
    rule_config_sha256?: string
    runtime_config_sha256?: string
  }
  coverage?: {
    selected?: CoverageItem[]
    completed?: CoverageItem[]
    reused?: CoverageItem[]
    failed?: CoverageItem[]
    waived?: CoverageItem[]
  }
  elapsed_ms?: number
}

/** A persisted review session, as summarised by the CLI. */
export interface SessionSummary {
  session_id: string
  /** Absolute path of the backing `.jsonl` file. */
  file_path: string
  /** Forward-slash absolute path of the reviewed repo. */
  repo_dir: string
  git_branch: string
  model: string
  /** "workspace" | "range" | "commit" | "scan" */
  review_mode: string
  /** ISO-8601 UTC, e.g. "2026-09-15T03:19:30Z". */
  start_time: string
  end_time: string
  duration_ns: number
  selected_files: number
  completed_files: number
  failed_files: number
  reused_files: number
  waived_files: number
  total_comments: number
  llm_failures: number
  aborted: boolean
  /** True for sessions written by an older ocr that lacked run manifests. */
  legacy: boolean
  run_manifest?: RunManifest | null
}

/** One per-file record from `ocr session show --json`. */
export interface SessionItem {
  /** "done" | "failed" | ... */
  type: string
  timestamp: string
  file_path: string
  old_path?: string
  new_path?: string
  fingerprint?: string
  comments?: number
  error?: string
}

export interface SessionDetail {
  summary: SessionSummary
  items: SessionItem[]
}

/* ------------------------------------------------------------------ *
 * Client-owned session titles
 *
 * ocr has no notion of a session title, so titles are stored by this client
 * under its own settings directory and joined onto session summaries by id.
 * ------------------------------------------------------------------ */

/** Where a title came from. A `user` title is never overwritten by the model. */
export type TitleSource = 'ai' | 'user'

export interface SessionTitle {
  title: string
  source: TitleSource
  /** ISO-8601, when the title was last written. */
  updatedAt: string
  /** Model that produced an AI title, kept for transparency. */
  model?: string
}

/** A session summary enriched with this client's own metadata. */
export interface SessionListEntry extends SessionSummary {
  title?: string
  titleSource?: TitleSource
}

/** Result of asking a model to name one session. */
export interface TitleResult {
  sessionId: string
  /** The title in effect afterwards. */
  title: string
  model: string
  /** False when a title the user wrote by hand was preserved instead. */
  applied: boolean
}

/**
 * Result of deleting a session.
 *
 * The backing file is moved rather than unlinked, so an accidental deletion
 * stays recoverable and the user can be told exactly where it went.
 */
export interface DeleteSessionResult {
  sessionId: string
  trashedTo: string
}

/* ------------------------------------------------------------------ *
 * `ocr session comments --json`
 * ------------------------------------------------------------------ */

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type Category =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'test'
  | 'style'
  | 'documentation'
  | 'other'

/**
 * A single review finding. Mirrors `model.LlmComment`.
 *
 * `category` and `severity` are omitempty upstream, so older sessions may omit
 * them entirely and the CLI's own filter would then exclude such a finding from
 * a filtered query. Treat both as optional and render an "unknown" state.
 */
export interface ReviewComment {
  path: string
  content: string
  /** The fixed code, when the model proposed one. */
  suggestion_code?: string
  /** The offending code, verbatim from the source at review time. */
  existing_code?: string
  start_line: number
  end_line: number
  /** Model reasoning. Omitted from most sessions. */
  thinking?: string
  category?: Category
  severity?: Severity
}

/** Filters accepted by `ocr session comments --json`. */
export interface CommentFilter {
  severity?: Severity[]
  category?: Category[]
}

/* ------------------------------------------------------------------ *
 * Exporting a session as a Markdown document
 * ------------------------------------------------------------------ */

/**
 * A request to write a rendered report to disk.
 *
 * The renderer owns the rendering: it already holds the session summary and the
 * findings plus the user's current filter state, so the file matches what is on
 * screen. The main process contributes only what the renderer must not have —
 * a native save dialog and the write itself.
 */
export interface ExportMarkdownRequest {
  /**
   * File name proposed in the save dialog. A bare name, not a path: the main
   * process strips any directory part and drops characters Windows rejects.
   */
  suggestedName: string
  /** The complete Markdown document. */
  content: string
}

export interface ExportMarkdownResult {
  /** Absolute path of the written file; null when the user cancelled. */
  filePath: string | null
  bytes: number
  cancelled: boolean
}

/* ------------------------------------------------------------------ *
 * `ocr review --preview` / `ocr scan --preview`
 * ------------------------------------------------------------------ */

/** Why a file was excluded. Mirrors `model.ExcludeReason`. */
export type ExcludeReason =
  | 'user_exclude'
  | 'unsupported_ext'
  | 'default_path'
  | 'secret_exclude'
  | 'provider_directory'
  | 'deleted'
  | 'binary'
  | 'too_large'

export interface PreviewEntry {
  path: string
  /** e.g. "added" | "modified" | "deleted". */
  status: string
  insertions: number
  deletions: number
  will_review: boolean
  exclude_reason?: ExcludeReason
}

export interface Preview {
  files: PreviewEntry[]
  total_insertions: number
  total_deletions: number
  total_files: number
  reviewable_count: number
  excluded_count: number
}

/* ------------------------------------------------------------------ *
 * Application-level models
 * ------------------------------------------------------------------ */

/**
 * A repository known to the client.
 *
 * `key` is ocr's own session-directory name for the repo (the absolute path with
 * separators and drive colon replaced by `-`/`_`). We keep it because it is the
 * only stable identifier the CLI's storage uses across platforms.
 */
export interface RepoEntry {
  key: string
  /** Absolute Windows path, reconstructed from the key. Empty if not decodable. */
  dir: string
  /** Human-friendly label (folder basename, or git remote repo name). */
  name: string
  /** Extra context shown under the name, e.g. the git branch. */
  subtitle?: string
  sessionCount: number
  lastActivity?: string
  /** False when the decoded directory no longer exists on disk. */
  exists: boolean
  /** True when the client added it manually rather than discovering it. */
  manual?: boolean
}

export type ReviewMode = 'workspace' | 'range' | 'commit' | 'scan'

/** Everything needed to build an `ocr review` / `ocr scan` invocation. */
export interface ReviewOptions {
  repoDir: string
  mode: ReviewMode
  /** range mode */
  from?: string
  to?: string
  /** commit mode */
  commit?: string
  /** scan mode: comma-separated repo-relative paths */
  scanPath?: string
  background?: string
  backgroundFile?: string
  exclude?: string
  effort?: '' | 'low' | 'medium' | 'high'
  provider?: string
  model?: string
  concurrency?: number
  timeoutMinutes?: number
  maxTokensBudget?: number
  noFilter?: boolean
  /** scan-only switches */
  noPlan?: boolean
  noDedup?: boolean
  noSummary?: boolean
  batch?: '' | 'none' | 'by-language' | 'by-directory'
}

/** Result of probing the local environment at startup. */
export interface EnvInfo {
  /** Absolute path of the resolved ocr executable, if found. */
  ocrPath: string | null
  /** How it will be launched — surfaced for diagnostics. */
  ocrLaunchKind: 'native' | 'node-launcher' | 'shim' | 'none'
  ocrVersion: string | null
  /** Absolute path of the chosen git, if found. */
  gitPath: string | null
  gitVersion: string | null
  /**
   * The git that would have been used without our correction. Populated when we
   * had to override a broken MSYS2 git, so the UI can explain what happened.
   */
  rejectedGit?: { path: string; observedToplevel: string } | null
  sessionsDir: string
  configPath: string
  /** Human-readable problems worth showing in the UI. */
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * Config management (`~/.opencodereview/config.json` + `ocr config set`)
 * ------------------------------------------------------------------ */

/**
 * Supported wire protocols.
 *
 * Observed values: `openai`, `anthropic`, `openai-responses`, `anthropic-bedrock`.
 * Kept as a union with an escape hatch because the CLI adds protocols over time.
 */
export type LlmProtocol = 'openai' | 'anthropic' | 'openai-responses' | 'anthropic-bedrock' | (string & {})

export interface ProviderInfo {
  /** Provider id, e.g. "anthropic", "openai", or a custom gateway name. */
  name: string
  /** True when declared under `custom_providers`. */
  custom: boolean
  /** Base URL as configured (custom) or advertised (built-in). */
  url?: string
  protocol?: LlmProtocol
  /** Default model recorded on the provider entry, if any. */
  defaultModel?: string
  /** Model catalogue for the picker. Empty for built-ins unless configured. */
  models: string[]
  /** Whether an API key is currently stored. The key itself never reaches the renderer. */
  hasApiKey: boolean
  /** Masked form for display, e.g. "duos…9f2a". Never the full key. */
  apiKeyMask?: string
  /** True when the CLI ships this provider; false for user-defined gateways. */
  builtin: boolean
  /** True for the provider currently selected in the config. */
  active: boolean
}

export interface OcrConfigView {
  /** Currently active provider id. */
  provider: string
  /** Currently active model. */
  model: string
  providers: ProviderInfo[]
  /** UI language recorded in the CLI config, e.g. "中文". */
  language?: string
  configPath: string
  /** Set when the file existed but could not be parsed. */
  parseError?: string
}

/* ------------------------------------------------------------------ *
 * Running a review
 * ------------------------------------------------------------------ */

export interface RunLogLine {
  runId: string
  stream: 'stdout' | 'stderr'
  text: string
}

export interface RunResult {
  runId: string
  exitCode: number | null
  /** Session id parsed out of the run, so the UI can open results immediately. */
  sessionId?: string
  error?: string
  /** True when the user cancelled the run. */
  cancelled?: boolean
}

/** Payload pushed over IPC while a run is in flight. */
export interface RunProgress {
  runId: string
  phase: 'starting' | 'running' | 'finished' | 'failed' | 'cancelled'
  message?: string
}

export interface GitRef {
  name: string
  /** True for the currently checked-out branch. */
  current: boolean
  kind: 'local' | 'remote'
  /** Committer date of the branch tip, epoch milliseconds. Used for ordering. */
  committedAt?: number
}

/* ------------------------------------------------------------------ *
 * IPC surface
 * ------------------------------------------------------------------ */

/** Channel names, kept in one place so main and preload cannot drift apart. */
export const IPC = {
  envInfo: 'env:info',
  envRefresh: 'env:refresh',
  repoList: 'repo:list',
  repoAdd: 'repo:add',
  repoRemove: 'repo:remove',
  repoPick: 'repo:pick',
  sessionList: 'session:list',
  sessionDetail: 'session:detail',
  sessionComments: 'session:comments',
  sessionExportMarkdown: 'session:exportMarkdown',
  sessionDelete: 'session:delete',
  titleSet: 'title:set',
  titleGenerate: 'title:generate',
  gitBranches: 'git:branches',
  gitCommits: 'git:commits',
  previewRun: 'run:preview',
  startRun: 'run:start',
  cancelRun: 'run:cancel',
  runLog: 'run:log',
  runDone: 'run:done',
  runProgress: 'run:progress',
  configRead: 'config:read',
  configSet: 'config:set',
  configUnset: 'config:unset',
  configTest: 'config:test',
  configBackups: 'config:backups',
  configRestore: 'config:restore',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  openPath: 'shell:openPath',
  openExternal: 'shell:openExternal',
  openInEditor: 'shell:openInEditor',
  readSnippet: 'fs:snippet',
  readWholeFile: 'fs:wholeFile'
} as const

/**
 * Client-owned settings, mirroring the main process's persisted file.
 *
 * Stored under Electron's userData directory rather than inside
 * `~/.opencodereview`, which belongs to the CLI.
 */
export interface AppSettings {
  /** Explicit path to a git.exe; overrides environment probing. */
  gitOverride?: string | null
  /** Explicit path to the ocr binary or its npm shim. */
  ocrOverride?: string | null
  /** Repositories the user pinned by hand (absolute paths). */
  manualRepos: string[]
  /** Repositories the user hid from the sidebar. */
  ignoredRepos: string[]
  /** Ask the model for a session title after every completed review. */
  autoTitle: boolean
  /** Provider used for titling; empty means "whatever ocr is configured with". */
  titleProvider?: string | null
  /** Model used for titling; empty means "whatever ocr is configured with". */
  titleModel?: string | null
}

export interface ConfigTestResult {
  ok: boolean
  /** Raw output from `ocr llm test`, trimmed for display. */
  output: string
}

/** Outcome of a `ocr config set` / `unset` call. */
export interface MutateResultView {
  ok: boolean
  /** Raw CLI output, shown to the user when something goes wrong. */
  output: string
  /** Where the pre-write snapshot was saved, when one was taken. */
  backupPath?: string | null
  error?: string
}

export interface ConfigBackup {
  path: string
  createdAt: string
  size: number
}

/** A window of source lines around a finding, read from the working tree. */
export interface FileSnippet {
  path: string
  /** 1-based first line of `lines`. */
  startLine: number
  lines: string[]
  /** True when the file could not be read (deleted, binary, outside repo). */
  missing?: boolean
  error?: string
}

/**
 * Envelope for every IPC call.
 *
 * Errors are returned rather than thrown so the renderer can render a message
 * instead of an unhandled promise rejection — the ocr CLI reports many ordinary
 * situations through non-zero exit codes.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
