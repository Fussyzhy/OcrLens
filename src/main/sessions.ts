import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  CommentFilter,
  DeleteSessionResult,
  ReviewComment,
  SessionDetail,
  SessionItem,
  SessionListEntry,
  SessionSummary
} from '@shared/types'
import type { OcrContext } from './env'
import { execOcr, ocrSessionsDir } from './ocr'
import { parseJsonLoose } from './proc'
import { peekCwd } from './repos'
import { removeTitle, titlesFor } from './titles'

/**
 * Read access to persisted review sessions.
 *
 * Everything goes through the CLI's `--json` output rather than reading the
 * `.jsonl` files directly. The on-disk records carry internal fields
 * (`parentUuid`, `llm_request` payloads) whose shape is an implementation
 * detail; the JSON subcommands are the supported contract and are already
 * normalised by the CLI.
 */

/** Command timeout. Session reads touch many files, so allow generous headroom. */
const READ_TIMEOUT_MS = 120_000

function failed(args: string[], outcome: { code: number | null; stderr: string; error?: string }): Error {
  const detail = outcome.error ?? outcome.stderr.trim() ?? `exited ${outcome.code}`
  return new Error(`ocr ${args.join(' ')} failed: ${detail}`)
}

/**
 * Lists sessions for a repository, newest first.
 *
 * `limit = 0` means unlimited, matching the CLI. Returns [] when the directory is
 * not a repository the CLI recognises, since an empty sidebar is a better
 * outcome there than an error dialog.
 */
export async function listSessions(
  ctx: OcrContext,
  repoDir: string,
  limit = 0
): Promise<SessionListEntry[]> {
  const args = ['session', 'list', '--json', '--limit', String(limit), '--repo', repoDir]
  const result = await execOcr(ctx.launch, args, ctx.gitBinDir, { timeoutMs: READ_TIMEOUT_MS })

  if (result.code !== 0) {
    // A repo with no sessions yet is not an error worth surfacing.
    if (/no sessions|not a git repository/i.test(result.stderr)) return []
    throw failed(args, result)
  }

  const parsed = parseJsonLoose<SessionSummary[]>(result.stdout)
  const sessions = Array.isArray(parsed) ? parsed : []

  // Join this client's own titles onto the CLI's summaries. A session with no
  // stored title simply has none — the sidebar falls back to mode and branch.
  const titles = titlesFor(sessions.map((session) => session.session_id))

  return sessions.map((session) => {
    const stored = titles[session.session_id]
    return stored
      ? { ...session, title: stored.title, titleSource: stored.source }
      : { ...session }
  })
}

/** Reads a single session's summary plus its per-file items. */
export async function sessionDetail(
  ctx: OcrContext,
  repoDir: string,
  sessionId: string
): Promise<SessionDetail> {
  const args = ['session', 'show', sessionId, '--json', '--repo', repoDir]
  const result = await execOcr(ctx.launch, args, ctx.gitBinDir, { timeoutMs: READ_TIMEOUT_MS })
  if (result.code !== 0) throw failed(args, result)

  const parsed = parseJsonLoose<{ summary: SessionSummary; items?: SessionItem[] }>(result.stdout)
  return { summary: parsed.summary, items: parsed.items ?? [] }
}

/**
 * Reads every finding recorded in a session.
 *
 * Filtering is delegated to the CLI so its own severity/category vocabulary
 * decides what matches, and the renderer can additionally filter in-memory for
 * instant feedback without re-spawning a process.
 */
export async function sessionComments(
  ctx: OcrContext,
  repoDir: string,
  sessionId: string,
  filter?: CommentFilter
): Promise<ReviewComment[]> {
  const args = ['session', 'comments', sessionId, '--json', '--repo', repoDir]

  if (filter?.severity?.length) args.push('--severity', filter.severity.join(','))
  if (filter?.category?.length) args.push('--category', filter.category.join(','))

  const result = await execOcr(ctx.launch, args, ctx.gitBinDir, { timeoutMs: READ_TIMEOUT_MS })

  // A clean session legitimately exits non-zero with nothing to print.
  if (result.code !== 0) {
    if (!result.stdout.trim()) return []
    throw failed(args, result)
  }

  const parsed = parseJsonLoose<ReviewComment[]>(result.stdout)
  return Array.isArray(parsed) ? parsed : []
}

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

/** Client-side trash for deleted sessions. */
function trashDir(): string {
  return path.join(app.getPath('userData'), 'session-trash')
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Deletes a review session from the CLI's storage.
 *
 * Two decisions worth stating:
 *
 * 1. **The file is moved, not unlinked.** `ocr session` has no delete command, so
 *    this reaches into `~/.opencodereview/sessions` directly — the one operation
 *    in this client that could destroy data the CLI still considers valid. Moving
 *    it to a client-side trash folder removes it from history while keeping a
 *    mistake recoverable, and the caller is told exactly where it went.
 * 2. **The file is found by id, not by reconstructing the storage key.** The
 *    flattening of a repo path into a directory name is not reversible, so
 *    guessing it could delete another repository's session. The recorded `cwd` is
 *    checked against the expected repository before anything moves.
 */
export async function deleteSession(
  repoDir: string,
  sessionId: string
): Promise<DeleteSessionResult> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error(`会话 id 不合法：${sessionId}`)
  }

  const root = ocrSessionsDir()
  let keys: string[]
  try {
    keys = await fs.promises.readdir(root)
  } catch {
    throw new Error(`无法读取会话目录：${root}`)
  }

  let source: string | null = null
  for (const key of keys) {
    const candidate = path.join(root, key, `${sessionId}.jsonl`)
    try {
      const stat = await fs.promises.stat(candidate)
      if (stat.isFile()) {
        source = candidate
        break
      }
    } catch {
      // Not this directory.
    }
  }

  if (!source) {
    throw new Error(`找不到会话 ${sessionId} 的记录文件，可能已被删除。`)
  }

  // The recorded `cwd` is the only thing standing between a mis-identified file
  // and another repository's history, so an unreadable record stops the delete
  // instead of silently skipping the check (which is what `recorded &&` did:
  // "could not read it" quietly became "do not check it").
  const recorded = await peekCwd(source)
  if (!recorded) {
    throw new Error(
      `无法从会话 ${sessionId} 的记录里读出所属仓库，已中止删除。文件：${source}`
    )
  }
  if (!samePath(recorded, repoDir)) {
    throw new Error(
      `会话 ${sessionId} 记录的仓库是 ${recorded}，与当前仓库 ${repoDir} 不一致，已中止删除。`
    )
  }

  const trash = trashDir()
  await fs.promises.mkdir(trash, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(trash, `${stamp}__${sessionId}.jsonl`)

  try {
    await fs.promises.rename(source, target)
  } catch (err) {
    // A cross-device rename fails; fall back to copy-then-unlink.
    const reason = err instanceof Error ? err.message : String(err)
    if (!/EXDEV|cross-device/i.test(reason)) {
      throw new Error(`移动会话文件失败：${reason}`)
    }
    await fs.promises.copyFile(source, target)
    await fs.promises.unlink(source)
  }

  // The title belongs to a session that no longer exists; leaving it behind
  // accumulates orphan entries in session-titles.json forever.
  removeTitle(sessionId)

  return { sessionId, trashedTo: target }
}
