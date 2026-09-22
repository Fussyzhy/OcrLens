import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ReviewComment, SessionSummary } from '@shared/types'
import { groupFindings } from '../utils/findings'
import { severityRank } from '../utils/format'
import { unwrap } from '../utils/ipc'

/**
 * The currently open session's findings.
 *
 * Filter state is data-driven rather than a fixed enum: `category` and `severity`
 * are `omitempty` upstream, so older sessions may omit them entirely. Building the
 * toggle set from what the session actually contains keeps unlabelled findings
 * visible (under "未分级") instead of silently hiding them behind a filter that
 * looks enabled.
 */
export const useResultsStore = defineStore('results', () => {
  const repoDir = ref('')
  const sessionId = ref('')
  const summary = ref<SessionSummary | null>(null)
  const comments = ref<ReviewComment[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Severity key -> enabled. Keys include 'unknown' for unlabelled findings. */
  const severityEnabled = ref<Record<string, boolean>>({})
  const categoryEnabled = ref<Record<string, boolean>>({})
  const search = ref('')
  const collapsedFiles = ref<string[]>([])
  /** Findings the user marked as handled, keyed by `findingKey`. */
  const ignored = ref<string[]>([])

  /** Stable identity for a finding across reloads of the same session. */
  function findingKey(comment: ReviewComment): string {
    return [comment.path, comment.start_line, comment.end_line, comment.category ?? '', comment.content.slice(0, 32)].join('|')
  }

  /** The severity bucket a finding belongs to for filtering purposes. */
  function severityBucket(comment: ReviewComment): string {
    return comment.severity ?? 'unknown'
  }

  const counts = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const comment of comments.value) {
      const key = severityBucket(comment)
      out[key] = (out[key] ?? 0) + 1
    }
    return out
  })

  const categoryCounts = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const comment of comments.value) {
      const key = comment.category ?? 'other'
      out[key] = (out[key] ?? 0) + 1
    }
    return out
  })

  /** Severity buckets present in this session, worst first. */
  const severityKeys = computed<string[]>(() =>
    Object.keys(counts.value).sort((a, b) => severityRank(a) - severityRank(b))
  )

  /** Category buckets present in this session, by descending count. */
  const categoryKeys = computed<string[]>(() =>
    Object.keys(categoryCounts.value).sort((a, b) => categoryCounts.value[b] - categoryCounts.value[a])
  )

  const filtered = computed<ReviewComment[]>(() => {
    const query = search.value.trim().toLowerCase()

    return comments.value.filter((comment) => {
      if (!severityEnabled.value[severityBucket(comment)]) return false
      if (!categoryEnabled.value[comment.category ?? 'other']) return false
      if (query) {
        const haystack = `${comment.path}\n${comment.content}\n${comment.existing_code ?? ''}\n${comment.suggestion_code ?? ''}`
        if (!haystack.toLowerCase().includes(query)) return false
      }
      return true
    })
  })

  /** Findings grouped by file, groups ordered by their worst severity. */
  const groups = computed(() => groupFindings(filtered.value))

  function setSeverityKeys(keys: string[]): void {
    const next: Record<string, boolean> = {}
    for (const key of keys) next[key] = true
    severityEnabled.value = next
  }

  function setCategoryKeys(keys: string[]): void {
    const next: Record<string, boolean> = {}
    for (const key of keys) next[key] = true
    categoryEnabled.value = next
  }

  function toggleSeverity(key: string): void {
    severityEnabled.value = { ...severityEnabled.value, [key]: !severityEnabled.value[key] }
  }

  function toggleCategory(key: string): void {
    categoryEnabled.value = { ...categoryEnabled.value, [key]: !categoryEnabled.value[key] }
  }

  function toggleFile(filePath: string): void {
    collapsedFiles.value = collapsedFiles.value.includes(filePath)
      ? collapsedFiles.value.filter((p) => p !== filePath)
      : [...collapsedFiles.value, filePath]
  }

  function isCollapsed(filePath: string): boolean {
    return collapsedFiles.value.includes(filePath)
  }

  function toggleIgnored(key: string): void {
    ignored.value = ignored.value.includes(key)
      ? ignored.value.filter((k) => k !== key)
      : [...ignored.value, key]
  }

  function isIgnored(key: string): boolean {
    return ignored.value.includes(key)
  }

  function resetFilters(): void {
    setSeverityKeys(severityKeys.value)
    setCategoryKeys(categoryKeys.value)
    search.value = ''
  }

  /** Loads a session's summary and findings. */
  async function load(nextRepoDir: string, nextSessionId: string): Promise<void> {
    loading.value = true
    error.value = null

    repoDir.value = nextRepoDir
    sessionId.value = nextSessionId
    collapsedFiles.value = []
    ignored.value = []

    try {
      // Always read the unfiltered set; filtering happens in-memory so toggles
      // feel instant and a session with unlabelled findings stays intact.
      const [detail, list] = await Promise.all([
        unwrap(window.ocr.sessionDetail(nextRepoDir, nextSessionId)),
        unwrap(window.ocr.sessionComments(nextRepoDir, nextSessionId))
      ])

      summary.value = detail.summary
      comments.value = list

      setSeverityKeys(Object.keys(counts.value).sort((a, b) => severityRank(a) - severityRank(b)))
      setCategoryKeys(Object.keys(categoryCounts.value).sort((a, b) => categoryCounts.value[b] - categoryCounts.value[a]))
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      summary.value = null
      comments.value = []
    } finally {
      loading.value = false
    }
  }

  function clear(): void {
    repoDir.value = ''
    sessionId.value = ''
    summary.value = null
    comments.value = []
    error.value = null
  }

  return {
    repoDir,
    sessionId,
    summary,
    comments,
    loading,
    error,
    severityEnabled,
    categoryEnabled,
    severityKeys,
    categoryKeys,
    counts,
    categoryCounts,
    search,
    filtered,
    groups,
    findingKey,
    severityBucket,
    toggleSeverity,
    toggleCategory,
    toggleFile,
    isCollapsed,
    toggleIgnored,
    isIgnored,
    resetFilters,
    load,
    clear
  }
})
