import type { ReviewComment, RunManifest, SessionSummary } from '@shared/types'
import { groupFindings } from './findings'
import {
  categoryLabel,
  formatDurationNs,
  modeLabel,
  severityLabel,
  severityRank,
  stateLabel
} from './format'

/**
 * Renders a session as a Markdown report.
 *
 * The document is written for a reader that is not this GUI: a person skimming a
 * pull request, or a coding agent asked to fix what ocr found. Every finding
 * therefore carries its file path, line range and the exact code involved, so the
 * reader never has to guess which lines are meant.
 *
 * Text in, text out — no store, no DOM, no IPC. The caller decides *which*
 * findings go in (the user's current filters); this module decides how they read.
 */

export interface MarkdownReportInput {
  repoDir: string
  sessionId: string
  summary: SessionSummary | null
  /** The findings to include — normally the ones currently on screen. */
  comments: ReviewComment[]
  /** How many findings the session holds in total, before filtering. */
  totalComments: number
  /** True when the caller dropped findings because of the current filters. */
  filtered: boolean
  /** True for findings the user marked as handled in the UI. */
  isIgnored?: (comment: ReviewComment) => boolean
  /** Overridable so tests can pin the "exported at" line. */
  generatedAt?: Date
}

export function buildSessionMarkdown(input: MarkdownReportInput): string {
  const { repoDir, sessionId, summary, comments, totalComments } = input
  const isIgnored = input.isIgnored ?? ((): boolean => false)
  const generatedAt = input.generatedAt ?? new Date()

  const manifest = summary?.run_manifest ?? null
  const groups = groupFindings(comments)
  const out: string[] = []

  /** Emits a labelled, fenced code block, when the model supplied code at all. */
  const pushCode = (label: string, code: string | undefined, path: string): void => {
    if (!code?.trim()) return
    out.push(`**${label}**`, '', codeBlock(code, languageHint(path)), '')
  }

  /* ---------------- title ---------------- */

  out.push(`# OCR 审查报告 · ${baseName(repoDir) || 'repository'}`, '')
  out.push('> 由 OcrLens 从 ocr 会话导出，可直接阅读，也可以整份交给编码 agent 处理。')
  out.push('> finding 由模型生成，存在误报可能：动手前请先核对对应代码。', '')

  /* ---------------- session facts ---------------- */

  out.push('## 会话信息', '')

  const facts: Array<[string, string]> = [['仓库', inline(repoDir)]]

  if (summary) {
    facts.push(['分支', inline(summary.git_branch || '未记录')])
    facts.push(['审查范围', `${modeLabel(summary.review_mode)}（${summary.review_mode}）`])
  }

  facts.push(['会话 ID', inline(sessionId)])

  if (summary?.start_time) facts.push(['开始时间', inline(summary.start_time)])

  if (summary?.model) {
    const provider = manifest?.execution?.provider
    facts.push([
      '模型',
      provider ? `${inline(summary.model)}（渠道 ${inline(provider)}）` : inline(summary.model)
    ])
  }

  if (summary?.duration_ns) facts.push(['耗时', formatDurationNs(summary.duration_ns)])

  const coverage = coverageText(summary, manifest)
  if (coverage) facts.push(['文件覆盖', coverage])

  if (manifest?.terminal_state) {
    facts.push(['终态', `${stateLabel(manifest.terminal_state)}（${manifest.terminal_state}）`])
  }

  if (manifest?.execution?.ocr_version) {
    facts.push(['ocr 版本', inline(manifest.execution.ocr_version)])
  }

  facts.push(['finding', findingCountText(comments.length, totalComments, input.filtered)])
  facts.push(['导出时间（本地）', formatLocalStamp(generatedAt)])

  for (const [label, value] of facts) out.push(`- **${label}**：${value}`)
  out.push('')

  /* ---------------- incomplete results ---------------- */

  const warnings: string[] = []
  const failedFiles = manifest?.coverage?.failed ?? []

  if (failedFiles.length) {
    const paths = failedFiles.map((file) => inline(file.path)).join('、')
    warnings.push(`${failedFiles.length} 个文件未能完成审查，结果并不完整：${paths}`)
  }
  if (manifest?.terminal_state && manifest.terminal_state !== 'complete') {
    warnings.push(`本次运行的终态是「${stateLabel(manifest.terminal_state)}」，结果可能不完整。`)
  }
  if (summary?.llm_failures) {
    warnings.push(`运行期间记录到 ${summary.llm_failures} 次模型调用失败。`)
  }

  if (warnings.length) {
    out.push('## ⚠ 结果不完整', '')
    for (const warning of warnings) out.push(`- ${warning}`)
    out.push('')
  }

  /* ---------------- overview ---------------- */

  if (!comments.length) {
    out.push('## 结果', '')
    out.push(
      input.filtered
        ? '当前筛选条件下没有 finding，因此这份报告是空的。'
        : '这个会话没有产生 finding。',
      ''
    )
  } else {
    out.push('## 概览', '')
    out.push(
      `共 ${comments.length} 条 finding，涉及 ${groups.length} 个文件：${severityBreakdown(comments)}。`,
      ''
    )
    out.push('| 文件 | 条数 | 最高严重度 |', '| --- | --- | --- |')
    for (const group of groups) {
      const count = group.comments.length
      out.push(`| ${tableCell(inline(group.path))} | ${count} | ${severityLabel(group.worst)} |`)
    }
    out.push('')

    /* ---------------- findings ---------------- */

    out.push('## 逐条 finding', '')

    let index = 0
    for (const group of groups) {
      out.push(`### ${inline(group.path)}（${group.comments.length} 条）`, '')

      for (const comment of group.comments) {
        index += 1
        const ignored = isIgnored(comment)
        const meta = [lineRange(comment), severityMeta(comment), categoryMeta(comment)]
          .filter(Boolean)
          .join(' · ')

        out.push(`#### ${index}. ${meta}${ignored ? ' · 已忽略' : ''}`, '')
        if (ignored) {
          out.push('> 用户在客户端把这条标记为已忽略，可能已经在别处处理过。', '')
        }

        out.push(comment.content.trim() || '（模型没有给出文字说明）', '')

        pushCode('现有代码', comment.existing_code, comment.path)
        pushCode('建议改为', comment.suggestion_code, comment.path)
      }
    }
  }

  /* ---------------- footer ---------------- */

  out.push('---', '')
  out.push('文件路径相对于仓库根目录；行号对应审查时的代码版本，之后可能已经变化。')

  return `${out.join('\n')}\n`
}

/** A file name for the report, e.g. `ocr-city-builder-2545dbf8-20260915-1119.md`. */
export function suggestReportFileName(
  input: Pick<MarkdownReportInput, 'repoDir' | 'sessionId' | 'summary'>
): string {
  const repo = fileSegment(baseName(input.repoDir) || 'repo')
  const session = fileSegment((input.sessionId ?? '').replace(/-/g, '').slice(0, 8) || 'session')
  const stamp = fileStamp(input.summary?.start_time)
  return `ocr-${repo}-${session}-${stamp}.md`
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

/** Last path segment, for any mix of separators. */
function baseName(target: string): string {
  return (target ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * Wraps a value in an inline code span.
 *
 * Falls back to plain text when the value itself contains a backtick, which
 * would otherwise produce a broken span.
 */
function inline(value: string): string {
  const text = value ?? ''
  return text.includes('`') ? text : `\`${text}\``
}

/** Escapes the one character that would break a Markdown table row. */
function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

function lineRange(comment: ReviewComment): string {
  const start = comment.start_line
  const end = comment.end_line
  if (!start) return '行号未记录'
  return end && end !== start ? `L${start}–L${end}` : `L${start}`
}

/** `高（high）` — the raw enum is kept so the text stays greppable. */
function severityMeta(comment: ReviewComment): string {
  return comment.severity
    ? `${severityLabel(comment.severity)}（${comment.severity}）`
    : severityLabel(undefined)
}

function categoryMeta(comment: ReviewComment): string {
  return comment.category
    ? `${categoryLabel(comment.category)}（${comment.category}）`
    : categoryLabel(undefined)
}

function severityBreakdown(comments: ReviewComment[]): string {
  const counts = new Map<string, number>()
  for (const comment of comments) {
    const key = comment.severity ?? 'unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.keys()]
    .sort((a, b) => severityRank(a) - severityRank(b))
    .map((key) => `${severityLabel(key === 'unknown' ? undefined : key)} ${counts.get(key)}`)
    .join(' · ')
}

function findingCountText(included: number, total: number, filtered: boolean): string {
  if (!filtered || total <= included) return `${included} 条`
  return `${included} 条 / 会话共 ${total} 条（已按界面筛选导出）`
}

function coverageText(summary: SessionSummary | null, manifest: RunManifest | null): string | null {
  if (!summary) return null

  const selected = manifest?.coverage?.selected?.length ?? summary.selected_files
  const completed = manifest?.coverage?.completed?.length ?? summary.completed_files
  if (!selected) return null

  const extras: string[] = []
  const failed = manifest?.coverage?.failed?.length ?? summary.failed_files
  const reused = manifest?.coverage?.reused?.length ?? summary.reused_files
  if (failed) extras.push(`失败 ${failed}`)
  if (reused) extras.push(`复用 ${reused}`)

  return `${completed}/${selected}${extras.length ? `（${extras.join(' · ')}）` : ''}`
}

/* ------------------------------------------------------------------ *
 * Code fences
 * ------------------------------------------------------------------ */

/**
 * A fence strictly longer than the longest backtick run inside `text`.
 *
 * Reviewed code frequently contains backticks (template literals, Markdown
 * itself), and a fixed ``` fence would end the block early and turn the rest of
 * the finding into prose.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function codeBlock(text: string, language: string): string {
  const body = text.replace(/^\n+/, '').replace(/\s+$/, '')
  const fence = fenceFor(body)
  return `${fence}${language}\n${body}\n${fence}`
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  vue: 'vue',
  svelte: 'svelte',
  go: 'go',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  c: 'c',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  ex: 'elixir',
  exs: 'elixir',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'md',
  markdown: 'md',
  txt: 'text'
}

function languageHint(filePath: string): string {
  const name = baseName(filePath)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? ''
}

/* ------------------------------------------------------------------ *
 * File naming
 * ------------------------------------------------------------------ */

/** Strips everything Windows treats as a separator or a reserved character. */
function fileSegment(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'ocr'
  )
}

/** `20260915-1119`, local time, taken from the session when it is readable. */
function fileStamp(iso: string | undefined): string {
  const parsed = iso ? new Date(iso) : new Date()
  const when = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  const pad = (value: number): string => String(value).padStart(2, '0')

  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}`
  )
}

/** `2026-09-15 11:19`, local time. */
function formatLocalStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
