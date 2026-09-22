import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RepoEntry, SessionSummary } from '@shared/types'
import { unwrap } from '../utils/ipc'
import { useResultsStore } from './results'
import { useUiStore } from './ui'

/**
 * The repository / session tree shown in the left rail.
 *
 * Session lists are fetched lazily on expand, because discovery already knows the
 * counts from the filesystem — pulling full summaries for every repository at
 * startup would spawn one CLI process per repo for no visible benefit.
 */
export const useRepoStore = defineStore('repos', () => {
  const results = useResultsStore()
  const ui = useUiStore()

  const repos = ref<RepoEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Repo identifiers whose children are visible. */
  const expanded = ref<string[]>([])
  /** Session summaries keyed by repo identifier. */
  const sessions = ref<Record<string, SessionSummary[]>>({})
  const loadingSessions = ref<string[]>([])
  const sessionErrors = ref<Record<string, string>>({})

  const activeRepoDir = ref<string | null>(null)
  const activeSessionId = ref<string | null>(null)
  const query = ref('')

  /** Stable identifier for a repo: its path when known, else the storage key. */
  function repoKey(repo: RepoEntry): string {
    return repo.dir || repo.key
  }

  const activeRepo = computed<RepoEntry | null>(
    () => repos.value.find((r) => r.dir === activeRepoDir.value) ?? null
  )

  /** Repos matching the search box. Matching a session keeps its repo visible. */
  const visibleRepos = computed<RepoEntry[]>(() => {
    const needle = query.value.trim().toLowerCase()
    if (!needle) return repos.value

    return repos.value.filter((repo) => {
      if (repo.name.toLowerCase().includes(needle)) return true
      if (repo.dir.toLowerCase().includes(needle)) return true
      const list = sessions.value[repoKey(repo)] ?? []
      return list.some((s) => sessionLabel(s).toLowerCase().includes(needle))
    })
  })

  /** One-line description of a session, used for search and display. */
  function sessionLabel(session: SessionSummary): string {
    return [
      session.review_mode,
      session.git_branch,
      session.model,
      session.start_time
    ]
      .filter(Boolean)
      .join(' ')
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      repos.value = await unwrap(window.ocr.listRepos())
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      repos.value = []
    } finally {
      loading.value = false
    }
  }

  function isExpanded(repo: RepoEntry): boolean {
    return expanded.value.includes(repoKey(repo))
  }

  async function loadSessions(repo: RepoEntry, force = false): Promise<void> {
    const key = repoKey(repo)
    if (!repo.dir) return
    if (sessions.value[key] && !force) return
    if (loadingSessions.value.includes(key)) return

    loadingSessions.value = [...loadingSessions.value, key]
    sessionErrors.value = { ...sessionErrors.value, [key]: '' }

    try {
      // limit 0 = unlimited, matching the CLI.
      const list = await unwrap(window.ocr.listSessions(repo.dir, 0))
      sessions.value = { ...sessions.value, [key]: list }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sessionErrors.value = { ...sessionErrors.value, [key]: message }
    } finally {
      loadingSessions.value = loadingSessions.value.filter((k) => k !== key)
    }
  }

  async function toggleExpand(repo: RepoEntry): Promise<void> {
    const key = repoKey(repo)
    if (expanded.value.includes(key)) {
      expanded.value = expanded.value.filter((k) => k !== key)
      return
    }
    expanded.value = [...expanded.value, key]
    await loadSessions(repo)
  }

  /** Clicking a repo name opens the "new review" workbench for it. */
  function openRepo(repo: RepoEntry): void {
    activeRepoDir.value = repo.dir || null
    activeSessionId.value = null
    results.clear()
    ui.showView('new-review')
  }

  /** Clicking a session opens its results, read-only. */
  async function openSession(repo: RepoEntry, sessionId: string): Promise<void> {
    activeRepoDir.value = repo.dir || null
    activeSessionId.value = sessionId
    ui.showView('results')
    await results.load(repo.dir, sessionId)
  }

  /** Pins a repository picked from disk. */
  async function addRepo(): Promise<void> {
    const picked = await unwrap(window.ocr.pickRepo())
    if (!picked) return

    const repo = await unwrap(window.ocr.addRepo(picked))
    await load()

    if (repo?.dir) {
      activeRepoDir.value = repo.dir
      ui.showView('new-review')
    }
    ui.notify(`已添加仓库：${picked}`, 'ok')
  }

  /** Hides a repository from the rail without deleting its session history. */
  async function removeRepo(repo: RepoEntry): Promise<void> {
    if (!repo.dir) {
      ui.notifyError('这个仓库的路径无法解析，无法移除记录。')
      return
    }
    await unwrap(window.ocr.removeRepo(repo.dir))

    if (activeRepoDir.value === repo.dir) {
      activeRepoDir.value = null
      results.clear()
      ui.showView('welcome')
    }
    await load()
    ui.notify(`已从侧栏移除：${repo.name}（会话记录保留在磁盘上）`, 'info')
  }

  /** Re-reads one repo's session list, e.g. after a run finishes. */
  async function refreshSessions(repoDir: string): Promise<void> {
    const repo = repos.value.find((r) => r.dir === repoDir)
    if (repo) await loadSessions(repo, true)
  }

  return {
    repos,
    loading,
    error,
    expanded,
    sessions,
    loadingSessions,
    sessionErrors,
    activeRepoDir,
    activeSessionId,
    activeRepo,
    query,
    visibleRepos,
    repoKey,
    sessionLabel,
    load,
    isExpanded,
    loadSessions,
    toggleExpand,
    openRepo,
    openSession,
    addRepo,
    removeRepo,
    refreshSessions
  }
})
