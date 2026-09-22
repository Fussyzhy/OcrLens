import type { Category, SessionSummary, Severity } from '@shared/types'

/**
 * Display helpers.
 *
 * Labels are Chinese to match the working language of the reviews this client
 * displays; the code itself stays in English.
 */

/** Orders severities by urgency, most severe first. */
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low']

const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低'
}

const CATEGORY_LABELS: Record<string, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
  test: '测试',
  style: '风格',
  documentation: '文档',
  other: '其他'
}

/** Review-mode labels, matching the CLI's `review_mode` values. */
const MODE_LABELS: Record<string, string> = {
  workspace: '工作区',
  range: '分支区间',
  commit: '单提交',
  scan: '全量扫描'
}

/** Terminal states from `run_manifest.terminal_state`. */
const STATE_LABELS: Record<string, string> = {
  complete: '完成',
  failed: '失败',
  skipped: '跳过',
  aborted: '中断',
  partial: '部分完成'
}

export function severityRank(severity: string | undefined): number {
  const index = SEVERITY_ORDER.indexOf((severity ?? '') as Severity)
  return index === -1 ? SEVERITY_ORDER.length : index
}

export function severityLabel(severity: string | undefined): string {
  if (!severity) return '未分级'
  return SEVERITY_LABELS[severity] ?? severity
}

/** CSS class suffix for a severity; falls back to `unknown`. */
export function severityClass(severity: string | undefined): string {
  return severity && severity in SEVERITY_LABELS ? severity : 'unknown'
}

export function categoryLabel(category: string | undefined): string {
  if (!category) return '未分类'
  return CATEGORY_LABELS[category] ?? category
}

export function categoryClass(category: string | undefined): string {
  return category && category in CATEGORY_LABELS ? category : 'other'
}

export function modeLabel(mode: string | undefined): string {
  if (!mode) return '未知'
  return MODE_LABELS[mode] ?? mode
}

export function stateLabel(state: string | undefined): string {
  if (!state) return '未知'
  return STATE_LABELS[state] ?? state
}

/**
 * Resolves a session's outcome for the status dot.
 *
 * `run_manifest.terminal_state` is authoritative when present; older sessions
 * (`legacy: true`) have none, so the per-file counters are used to infer one
 * instead of showing everything as unknown. Shared by the rail and the home
 * page so a session cannot be "完成" in one place and "跳过" in the other.
 */
export function sessionState(session: SessionSummary): string {
  const state = session.run_manifest?.terminal_state
  if (state) return state
  if (session.aborted) return 'aborted'
  if (session.selected_files > 0 && session.completed_files === 0 && session.failed_files > 0) {
    return 'failed'
  }
  return session.completed_files > 0 ? 'complete' : 'skipped'
}

/** Formats a nanosecond duration from a session summary. */
export function formatDurationNs(ns: number | undefined): string {
  if (!ns || ns <= 0) return '—'
  return formatDurationMs(ns / 1e6)
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`
}

/** Short absolute timestamp, e.g. "09-22 11:23". */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Compact date from epoch milliseconds, e.g. "2026-09-22". */
export function formatDateFromMs(ms: number | undefined): string {
  if (!ms) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''

  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Coarse relative time, good enough for a history list. */
export function formatRelative(iso: string | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  const diff = Date.now() - then
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`

  const months = Math.round(days / 30)
  return months < 12 ? `${months} 个月前` : `${Math.round(months / 12)} 年前`
}

/** Truncates text on a word-ish boundary for compact displays. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

/** The one-line gist of a finding, used in dense lists. */
export function findingSummary(content: string, max = 160): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return truncate(flat, max)
}

/** Reason a file was skipped, in words. */
export function excludeReasonLabel(reason: string | undefined): string {
  const labels: Record<string, string> = {
    user_exclude: '规则排除',
    unsupported_ext: '不支持的类型',
    default_path: '默认排除目录',
    secret_exclude: '疑似凭据',
    provider_directory: '依赖目录',
    deleted: '已删除',
    binary: '二进制',
    too_large: '文件过大'
  }
  if (!reason) return '—'
  return labels[reason] ?? reason
}

export const ALL_SEVERITIES: Severity[] = SEVERITY_ORDER
export const ALL_CATEGORIES: Category[] = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other'
]
