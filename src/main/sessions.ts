import type {
  CommentFilter,
  ReviewComment,
  SessionDetail,
  SessionItem,
  SessionSummary
} from '@shared/types'
import type { OcrContext } from './env'
import { execOcr } from './ocr'
import { parseJsonLoose } from './proc'

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
): Promise<SessionSummary[]> {
  const args = ['session', 'list', '--json', '--limit', String(limit), '--repo', repoDir]
  const result = await execOcr(ctx.launch, args, ctx.gitBinDir, { timeoutMs: READ_TIMEOUT_MS })

  if (result.code !== 0) {
    // A repo with no sessions yet is not an error worth surfacing.
    if (/no sessions|not a git repository/i.test(result.stderr)) return []
    throw failed(args, result)
  }

  const parsed = parseJsonLoose<SessionSummary[]>(result.stdout)
  return Array.isArray(parsed) ? parsed : []
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
