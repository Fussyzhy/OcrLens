import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { RepoEntry, SessionListEntry } from '@shared/types'
import { unwrap } from '../utils/ipc'
import { useEnvStore } from './env'
import { useResultsStore } from './results'
import { useUiStore } from './ui'

/** How many repositories to fetch session lists for at once while searching. */
const SEARCH_CONCURRENCY = 4

/** Give up on automatic naming after this many failures in a row. */
const TITLE_FAILURE_LIMIT = 3

export interface SessionMatch {
  repo: RepoEntry
  session: SessionListEntry
}

/**
 * The repository / session tree shown in the left rail.
 *
 * Session lists are fetched lazily on expand, because discovery already knows the
 * counts from the filesystem — pulling full summaries for every repository at
 * startup would spawn one CLI process per repo for no visible benefit. Searching
 * by title is the one operation that legitimately needs all of them, so it loads
 * the rest on demand.
 *
 * `loadRecent` is the one other exception, and it is deliberately not wired into
 * this cache: the home page wants a handful of newest sessions per repository,
 * which is a capped read that must never be mistaken for the full list.
 */
export const useRepoStore = defineStore('repos', () => {
  const env = useEnvStore()
  const results = useResultsStore()
  const ui = useUiStore()

  const repos = ref<RepoEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Repo identifiers whose children are visible. */
  const expanded = ref<string[]>([])
  /** Session summaries keyed by repo identifier. */
  const sessions = ref<Record<string, SessionListEntry[]>>({})
  const loadingSessions = ref<string[]>([])
  const sessionErrors = ref<Record<string, string>>({})
  /** Session ids with an in-flight rename / generate / delete. */
  const busySessions = ref<string[]>([])
  /** How many operations are in flight per session id; see `withBusy`. */
  const busyCounts = new Map<string, number>()

  const activeRepoDir = ref<string | null>(null)
  const activeSessionId = ref<string | null>(null)
  const query = ref('')
  /** True while a search is fetching the session lists it needs. */
  const searchLoading = ref(false)
  /** In-flight `ensureAllSessionsLoaded` calls; the flag clears when this hits 0. */
  let searchLoads = 0

  /** Stable identifier for a repo: its path when known, else the storage key. */
  function repoKey(repo: RepoEntry): string {
    return repo.dir || repo.key
  }

  const activeRepo = computed<RepoEntry | null>(
    () => repos.value.find((r) => r.dir === activeRepoDir.value) ?? null
  )

  /**
   * Everything a search can match for one session.
   *
   * The title comes first because that is what the user is looking for, but the
   * branch, mode and timestamp stay searchable so a session that has no title yet
   * is still findable.
   */
  function sessionHaystack(session: SessionListEntry): string {
    return [
      session.title,
      session.review_mode,
      session.git_branch,
      session.model,
      session.start_time
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  }

  /** The primary label for a session: its title, or a sensible fallback. */
  function sessionLabel(session: SessionListEntry): string {
    if (session.title) return session.title
    const parts = [session.review_mode, session.git_branch].filter(Boolean)
    return parts.length ? parts.join(' · ') : session.session_id.slice(0, 8)
  }

  /** Sessions whose title or metadata match the query, across every repo. */
  const searchMatches = computed<SessionMatch[]>(() => {
    const needle = query.value.trim().toLowerCase()
    if (!needle) return []

    const out: SessionMatch[] = []
    for (const repo of repos.value) {
      for (const session of sessions.value[repoKey(repo)] ?? []) {
        if (sessionHaystack(session).includes(needle)) out.push({ repo, session })
      }
    }
    return out
  })

  /** Repos shown in the rail. Search results are a separate, flat list. */
  const visibleRepos = computed<RepoEntry[]>(() => repos.value)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    // The repository set may have changed; the home page's sweep included the
    // old one, so it has to be allowed to run again.
    recentLoaded = false
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
    // Opening a repository's history is what makes names worth paying for. The
    // naming queue is fed from here rather than from `loadSessions`, because a
    // search also loads session lists — and loading a list to match a string
    // must never cost one model call per session in every repository.
    enqueueTitles(repo.dir, sessions.value[key] ?? [])
  }

  /**
   * Fetches the session lists a search needs.
   *
   * Run with a small concurrency cap: each lookup spawns the CLI, so firing one
   * per repository at once would be rude on a machine with many repos.
   */
  async function ensureAllSessionsLoaded(): Promise<void> {
    const pending = repos.value.filter(
      (repo) =>
        repo.dir &&
        !sessions.value[repoKey(repo)] &&
        !loadingSessions.value.includes(repoKey(repo))
    )
    if (!pending.length) return

    // Counted, not a flag: typing re-enters this while the previous batch is
    // still fetching, and whichever call finished first used to clear
    // `searchLoading` while later ones were still spawning the CLI.
    searchLoads += 1
    searchLoading.value = true
    const queue = [...pending]

    try {
      const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const repo = queue.shift()
          if (!repo) return
          await loadSessions(repo)
        }
      })
      await Promise.all(workers)
    } finally {
      searchLoads -= 1
      if (searchLoads <= 0) {
        searchLoads = 0
        searchLoading.value = false
      }
    }
  }

  /* ---------------- recent activity (home page) ---------------- */

  /** Newest sessions across all repositories, for the landing page. */
  const recent = ref<SessionMatch[]>([])
  const recentLoading = ref(false)
  /** Set once a sweep has finished, so returning home does not respawn the CLI. */
  let recentLoaded = false

  /**
   * Reads the newest sessions from every repository, for the home page.
   *
   * This is the one place that lists sessions for repositories the user has not
   * opened, and it exists because an empty first screen is a worse outcome than
   * the handful of short-lived CLI processes it costs. Two deliberate limits:
   *
   * - it does **not** write into `sessions`. Those lists are unlimited; this one
   *   is capped per repository, and caching a capped list under the same key
   *   would silently truncate a later expand.
   * - it never queues titles, so opening the home page can never spend a model
   *   call — the whole point of the title queue is that only a deliberate look
   *   at a repository's history feeds it.
   */
  async function loadRecent(perRepo = 4, maxRepos = 8): Promise<void> {
    if (recentLoaded || recentLoading.value) return
    if (!repos.value.length) return

    recentLoading.value = true
    const queue = repos.value.filter((repo) => repo.dir && repo.exists).slice(0, maxRepos)
    const found: SessionMatch[] = []

    try {
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (;;) {
          const repo = queue.shift()
          if (!repo?.dir) return
          try {
            const list = await unwrap(window.ocr.listSessions(repo.dir, perRepo))
            for (const session of list) found.push({ repo, session })
          } catch {
            // A repository that cannot be listed any more (no sessions, path
            // gone) contributes nothing rather than failing the whole page.
          }
        }
      })
      await Promise.all(workers)

      found.sort(
        (a, b) =>
          new Date(b.session.start_time).getTime() - new Date(a.session.start_time).getTime()
      )
      recent.value = found.slice(0, 6)
      recentLoaded = true
    } finally {
      recentLoading.value = false
    }
  }

  /** Replaces one cached session so the rail updates without a full reload. */
  function patchSession(
    repoDir: string,
    sessionId: string,
    patch: (session: SessionListEntry) => SessionListEntry
  ): void {
    const repo = repos.value.find((r) => r.dir === repoDir)
    if (!repo) return
    const key = repoKey(repo)
    const list = sessions.value[key]
    if (!list) return
    sessions.value = {
      ...sessions.value,
      [key]: list.map((session) => (session.session_id === sessionId ? patch(session) : session))
    }
  }

  function isBusy(sessionId: string): boolean {
    return busySessions.value.includes(sessionId)
  }

  async function withBusy<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    // Ref-counted: two operations can overlap on one session (a title job that
    // is already draining when the user confirms a delete), and the old
    // `filter` removed *every* entry for the id, so whichever finished first
    // cleared the spinner while the other was still running.
    busyCounts.set(sessionId, (busyCounts.get(sessionId) ?? 0) + 1)
    if (!busySessions.value.includes(sessionId)) {
      busySessions.value = [...busySessions.value, sessionId]
    }
    try {
      return await fn()
    } finally {
      const remaining = (busyCounts.get(sessionId) ?? 1) - 1
      if (remaining > 0) {
        busyCounts.set(sessionId, remaining)
      } else {
        busyCounts.delete(sessionId)
        busySessions.value = busySessions.value.filter((id) => id !== sessionId)
      }
    }
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

  /**
   * Re-reads one repo's session list, e.g. after a run finishes.
   *
   * Loads even when the repo was never expanded: the new session has to be known
   * for it to be named, and a review that produced a session is worth showing in
   * the rail regardless of what was open at the time. This is also what names the
   * session a run just created, so it happens without any user action.
   */
  async function refreshSessions(repoDir: string): Promise<void> {
    const repo = repos.value.find((r) => r.dir === repoDir)
    if (!repo) return
    await loadSessions(repo, true)
    enqueueTitles(repoDir, sessions.value[repoKey(repo)] ?? [])
  }

  /* ---------------- titles ---------------- */

  /**
   * Renames a session by hand.
   *
   * Emptying the field does not leave the session nameless: it hands the session
   * back to automatic naming, which is the only way to ask for a fresh name
   * without a dedicated "regenerate" button.
   */
  async function renameSession(
    repoDir: string,
    sessionId: string,
    title: string
  ): Promise<boolean> {
    const outcome = await withBusy(sessionId, async () => {
      try {
        const saved = await unwrap(window.ocr.setSessionTitle(sessionId, title))
        patchSession(repoDir, sessionId, (session) => ({
          ...session,
          title: saved?.title,
          titleSource: saved?.source
        }))
        ui.notify(saved ? '标题已更新' : '已交回自动命名', 'ok')
        return { ok: true, cleared: !saved }
      } catch (err) {
        ui.notifyError(err)
        return { ok: false, cleared: false }
      }
    })

    if (outcome.cleared) {
      titleSeen.delete(sessionId)
      const repo = repos.value.find((r) => r.dir === repoDir)
      enqueueTitles(repoDir, repo ? sessions.value[repoKey(repo)] ?? [] : [])
    }

    return outcome.ok
  }

  /* ---------------- automatic naming ----------------
   *
   * Titles are produced without being asked for: any session the client learns
   * about that has no title yet is queued, including sessions that predate this
   * feature. There is deliberately no "generate" button — naming is a property of
   * the history list, not an action the user has to remember to take.
   *
   * Two safeguards keep that from becoming a nuisance:
   *
   * - the queue is drained strictly one at a time, so a first-run backfill of a
   *   long history never bursts the user's gateway;
   * - a run of consecutive failures trips a breaker for the rest of the app
   *   session, so a broken key or model cannot cause one failed request per
   *   session every time the list is read.
   *
   * A session that failed is not retried until the app restarts or the titling
   * settings change, which is also the natural recovery path.
   */

  interface TitleJob {
    repoDir: string
    sessionId: string
  }

  const titleQueue: TitleJob[] = []
  /** Sessions already queued or attempted during this app session. */
  const titleSeen = new Set<string>()
  let titleDraining = false
  let titleFailures = 0
  let titleBreakerOpen = false

  function enqueueTitles(repoDir: string, list: SessionListEntry[]): void {
    if (env.settings?.autoTitle === false) return
    if (titleBreakerOpen || !repoDir) return

    for (const session of list) {
      // A session that already carries a title is never re-named, which is what
      // protects names the user wrote by hand.
      if (session.title) continue
      if (titleSeen.has(session.session_id)) continue
      titleSeen.add(session.session_id)
      titleQueue.push({ repoDir, sessionId: session.session_id })
    }

    void drainTitles()
  }

  async function drainTitles(): Promise<void> {
    if (titleDraining) return
    titleDraining = true

    try {
      while (titleQueue.length && !titleBreakerOpen) {
        const job = titleQueue.shift()
        if (!job) break

        try {
          const result = await withBusy(job.sessionId, () =>
            unwrap(window.ocr.generateTitle(job.repoDir, job.sessionId))
          )
          titleFailures = 0
          patchSession(job.repoDir, job.sessionId, (session) => ({
            ...session,
            title: result.title,
            titleSource: result.applied ? 'ai' : session.titleSource
          }))
        } catch (err) {
          titleFailures += 1
          if (titleFailures >= TITLE_FAILURE_LIMIT) {
            titleBreakerOpen = true
            titleQueue.length = 0
            const reason = err instanceof Error ? err.message : String(err)
            ui.notifyError(
              `自动生成标题连续失败 ${TITLE_FAILURE_LIMIT} 次，已暂停：${reason}（可在设置页调整生成标题所用的渠道或模型后重试）`
            )
          }
        }
      }
    } finally {
      titleDraining = false
    }
  }

  // Changing how titles are produced is the user telling us to try again.
  //
  // One getter per field on purpose: a single getter returning an array is
  // compared by reference, so *any* replacement of `env.settings` — including an
  // unrelated `gitOverride` edit — looked like a change, resetting the failure
  // breaker and re-queueing every untitled session for a paid model call.
  watch(
    [
      () => env.settings?.autoTitle,
      () => env.settings?.titleProvider,
      () => env.settings?.titleModel
    ],
    () => {
      titleFailures = 0
      titleBreakerOpen = false
      titleSeen.clear()
      // Retry only the repositories whose history is actually open; titled
      // sessions are skipped by the check in `enqueueTitles`.
      for (const repo of repos.value) {
        if (!isExpanded(repo)) continue
        const list = sessions.value[repoKey(repo)]
        if (list?.length) enqueueTitles(repo.dir, list)
      }
    }
  )

  /* ---------------- deletion ---------------- */

  /**
   * Removes a session from history.
   *
   * The main process moves the record file into this client's trash rather than
   * unlinking it, so a mistake is recoverable; the destination is reported back.
   */
  async function deleteSession(repo: RepoEntry, session: SessionListEntry): Promise<boolean> {
    if (!repo.dir) {
      ui.notifyError('这个仓库的路径无法解析，无法删除会话。')
      return false
    }

    return withBusy(session.session_id, async () => {
      try {
        const result = await unwrap(window.ocr.deleteSession(repo.dir, session.session_id))

        // Drop it from the cached list immediately so the row disappears even if
        // the refresh below is slow.
        const key = repoKey(repo)
        const list = sessions.value[key] ?? []
        sessions.value = {
          ...sessions.value,
          [key]: list.filter((item) => item.session_id !== session.session_id)
        }

        if (activeSessionId.value === session.session_id) {
          activeSessionId.value = null
          results.clear()
          ui.showView('new-review')
        }

        await Promise.all([load(), refreshSessions(repo.dir)])
        ui.notify(`已删除该历史记录（已移到回收站：${result.trashedTo}）`, 'info')
        return true
      } catch (err) {
        ui.notifyError(err)
        return false
      }
    })
  }

  function clearSearch(): void {
    query.value = ''
  }

  return {
    repos,
    loading,
    error,
    expanded,
    sessions,
    loadingSessions,
    sessionErrors,
    busySessions,
    activeRepoDir,
    activeSessionId,
    activeRepo,
    query,
    searchLoading,
    visibleRepos,
    searchMatches,
    recent,
    recentLoading,
    repoKey,
    sessionLabel,
    sessionHaystack,
    load,
    isExpanded,
    loadSessions,
    toggleExpand,
    ensureAllSessionsLoaded,
    loadRecent,
    isBusy,
    openRepo,
    openSession,
    addRepo,
    removeRepo,
    refreshSessions,
    renameSession,
    deleteSession,
    clearSearch
  }
})
