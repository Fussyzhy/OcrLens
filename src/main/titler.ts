import path from 'node:path'
import type { ReviewComment, TitleResult } from '@shared/types'
import { resolveLlmTarget } from './config'
import type { OcrContext } from './env'
import { complete } from './llm'
import { sessionComments, sessionDetail } from './sessions'
import { getTitle, normalizeTitle, setTitle } from './titles'

/**
 * AI-generated session titles.
 *
 * A review session is only identifiable by a UUID, which makes the history list
 * useless at a glance. After a run completes we ask the model — once — for a
 * short name describing what was reviewed, and store it against the session id.
 *
 * Naming always follows the channel and model ocr itself is configured with:
 * there is no separate titling route to keep in sync, so changing the route for
 * reviews changes it for names too. Titles the user renamed by hand are never
 * overwritten; the check happens in `titles.setTitle`, so it holds even if this
 * module is called with stale state.
 */

/** How many findings to summarise when asking for a name. */
const FINDING_SAMPLES = 6
/** How many changed paths to list. */
const FILE_SAMPLES = 12
/** Trim each sampled finding so the prompt stays small. */
const FINDING_CHARS = 90

const PROMPT_CHAR_BUDGET = 6000

/** Describes the review range in words a title can be built from. */
function describeScope(repoDir: string, detail: Awaited<ReturnType<typeof sessionDetail>>): string {
  const { summary } = detail
  const repoName = path.basename(repoDir.replace(/[\\/]+$/, '')) || repoDir
  const parts = [`仓库：${repoName}`, `模式：${summary.review_mode || '未知'}`]

  const manifest = summary.run_manifest
  const input = manifest?.input
  if (input?.resolved_base && input?.resolved_head) {
    parts.push(`范围：${input.resolved_base} → ${input.resolved_head}`)
  } else if (input?.exact_range) {
    parts.push(`范围：${input.exact_range}`)
  } else if (summary.git_branch) {
    parts.push(`分支：${summary.git_branch}`)
  }

  const files = detail.items
    .map((item) => item.new_path || item.file_path || item.old_path || '')
    .filter(Boolean)

  if (files.length) {
    const shown = files.slice(0, FILE_SAMPLES)
    const more = files.length > shown.length ? `\n（另有 ${files.length - shown.length} 个文件）` : ''
    parts.push(`改动文件（${files.length} 个）：\n${shown.map((f) => `- ${f}`).join('\n')}${more}`)
  }

  return parts.join('\n')
}

/** Builds the one-shot prompt. Kept small: this runs after every review. */
export function buildTitlePrompt(
  repoDir: string,
  detail: Awaited<ReturnType<typeof sessionDetail>>,
  comments: ReviewComment[]
): string {
  const lines: string[] = [describeScope(repoDir, detail)]

  if (comments.length) {
    const sampled = comments.slice(0, FINDING_SAMPLES).map((comment) => {
      const severity = comment.severity ? `[${comment.severity}]` : ''
      const category = comment.category ? `[${comment.category}]` : ''
      const text = comment.content.replace(/\s+/g, ' ').trim().slice(0, FINDING_CHARS)
      return `- ${severity}${category} ${text}`
    })
    const more = comments.length > sampled.length ? `\n（另有 ${comments.length - sampled.length} 条）` : ''
    lines.push(`发现的问题（共 ${comments.length} 条）：\n${sampled.join('\n')}${more}`)
  } else {
    lines.push('发现的问题：无')
  }

  const body = lines.join('\n\n').slice(0, PROMPT_CHAR_BUDGET)

  return [
    '为下面这次代码审查起一个简短的中文标题，用于在历史记录列表里辨认它。',
    '',
    body,
    '',
    '要求：',
    '1. 只输出标题本身，不要引号、不要句号、不要任何解释或前缀。',
    '2. 不超过 20 个汉字。',
    '3. 概括这次改动的主题（例如涉及的模块、功能或修复方向），不要罗列问题数量，不要写“代码审查报告”这类空话。'
  ].join('\n')
}

/**
 * Generates and stores a title for one session.
 *
 * Returns the title in effect afterwards, with `applied: false` when a title the
 * user wrote by hand was deliberately preserved.
 */
export async function generateTitle(
  ctx: OcrContext,
  repoDir: string,
  sessionId: string
): Promise<TitleResult> {
  const existing = getTitle(sessionId)
  if (existing?.source === 'user') {
    return { sessionId, title: existing.title, model: existing.model ?? '', applied: false }
  }

  const target = await resolveLlmTarget(ctx.launch, ctx.gitBinDir)

  // Read the session before calling the model so a failure to read does not cost
  // a request.
  const [detail, comments] = await Promise.all([
    sessionDetail(ctx, repoDir, sessionId),
    sessionComments(ctx, repoDir, sessionId)
  ])

  const prompt = buildTitlePrompt(repoDir, detail, comments)
  const reply = await complete(target, prompt, 1024)

  const title = normalizeTitle(reply.text)
  if (!title) {
    throw new Error(`模型返回了空标题：${reply.text.slice(0, 120)}`)
  }

  const outcome = setTitle(sessionId, title, 'ai', target.model)
  if (!outcome.applied) {
    // Raced with a manual rename between the check above and the write.
    return {
      sessionId,
      title: outcome.existing?.title ?? title,
      model: target.model,
      applied: false
    }
  }

  return { sessionId, title, model: target.model, applied: true }
}
