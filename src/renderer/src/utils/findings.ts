import type { ReviewComment } from '@shared/types'
import { severityRank } from './format'

/** Findings for one file, ordered worst-first. */
export interface FileGroup {
  path: string
  comments: ReviewComment[]
  /** Severity of the most urgent finding in the group. */
  worst: string | undefined
}

/**
 * Groups findings by file, worst file first and by line within a file.
 *
 * Shared by the results view and the Markdown export so a report can never
 * disagree with the screen about what order findings come in.
 */
export function groupFindings(comments: ReviewComment[]): FileGroup[] {
  const byPath = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    const list = byPath.get(comment.path)
    if (list) list.push(comment)
    else byPath.set(comment.path, [comment])
  }

  const result: FileGroup[] = []
  for (const [path, list] of byPath) {
    const sorted = [...list].sort((a, b) => a.start_line - b.start_line)
    const worst = sorted.reduce<string | undefined>((acc, comment) => {
      const severity = comment.severity
      if (!severity) return acc
      if (!acc || severityRank(severity) < severityRank(acc)) return severity
      return acc
    }, undefined)
    result.push({ path, comments: sorted, worst })
  }

  return result.sort((a, b) => {
    const diff = severityRank(a.worst) - severityRank(b.worst)
    if (diff !== 0) return diff
    return a.path.localeCompare(b.path)
  })
}
