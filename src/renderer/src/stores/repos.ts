import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RepoEntry, SessionListEntry } from '@shared/types'
import { unwrap } from '../utils/ipc'
import { isSessionInFlight } from './liveRuns'
import { useResultsStore } from './results'
import { useUiStore } from './ui'

/** How many repositories to fetch session lists for at once while searching. */
const SEARCH_CONCURRENCY = 4

/** Give up on automatic naming after this many failures in a row. */
const TITLE_FAILURE_LIMIT = 3

/**
 * Sessions a repository shows before the user asks for the rest.
 *
 * A repository with years of history would otherwise push every other repository
 * off the rail, and the newest handful is what a review workflow actually reaches
 * for. The rest stay one click away.
 */
const SESSION_PREVIEW_LIMIT = 6

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
  const results = useResultsStore()
  const ui = useUiStore()

  const repos = ref<RepoEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Repo identifiers whose children are visible. */
  const expanded = ref<string[]>([])
  /** Repo identifiers showing their whole history rather than a preview. */
  const fullHistory = ref<string[]>([])
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

  /**
   * Opens a repository's history and feeds the naming queue, the one path both the
   * click and a started run take.
   *
   * The naming queue is fed from here rather than from `loadSessions`, because a
   * search also loads session lists — and loading a list to match a string must
   * never cost one model call per session in every repository.
   */
  async function expandAndLoad(repo: RepoEntry, force = false): Promise<void> {
    const key = repoKey(repo)
    if (!expanded.value.includes(key)) expanded.value = [...expanded.value, key]
    await loadSessions(repo, force)
    enqueueTitles(repo.dir, sessions.value[key] ?? [])
  }

  async function toggleExpand(repo: RepoEntry): Promise<void> {
    const key = repoKey(repo)
    if (expanded.value.includes(key)) {
      expanded.value = expanded.value.filter((k) => k !== key)
      // Collapsing is also how the rail is kept short, so reopening starts from
      // the preview again instead of restoring a hundred rows.
      fullHistory.value = fullHistory.value.filter((k) => k !== key)
      return
    }
    await expandAndLoad(repo)
  }

  /** Every session currently cached for one repository, in display order. */
  function sessionsFor(repo: RepoEntry): SessionListEntry[] {
    return sessions.value[repoKey(repo)] ?? []
  }

  function isFullHistory(repo: RepoEntry): boolean {
    return fullHistory.value.includes(repoKey(repo))
  }

  /** Rows to render: the preview, or everything once the user asked for it. */
  function visibleSessions(repo: RepoEntry): SessionListEntry[] {
    const list = sessionsFor(repo)
    return isFullHistory(repo) ? list : list.slice(0, SESSION_PREVIEW_LIMIT)
  }

  /** How many rows the "展开其余 n 个会话" button would add. */
  function hiddenSessionCount(repo: RepoEntry): number {
    return Math.max(0, sessionsFor(repo).length - SESSION_PREVIEW_LIMIT)
  }

  function toggleFullHistory(repo: RepoEntry): void {
    const key = repoKey(repo)
    fullHistory.value = fullHistory.value.includes(key)
      ? fullHistory.value.filter((k) => k !== key)
      : [...fullHistory.value, key]
  }

  /* ---------------- ordering ---------------- */

  /**
   * Moves `from` next to `to`, before or after it.
   *
   * Returns a new array; an unknown id leaves the order untouched, so a stale
   * drag (the row disappeared under the cursor) cannot scramble the list.
   */
  function moveWithin(list: string[], from: string, to: string, after: boolean): string[] {
    if (from === to) return list
    const index = list.indexOf(from)
    const target = list.indexOf(to)
    if (index === -1 || target === -1) return list

    const next = [...list]
    next.splice(index, 1)
    const at = next.indexOf(to)
    next.splice(after ? at + 1 : at, 0, from)
    return next
  }

  /**
   * Stores a dragged repository order.
   *
   * The list is reordered in place first so the row follows the cursor without
   * waiting for the filesystem write; a failed write reloads instead of leaving
   * the rail showing an order that was never saved.
   */
  async function reorderRepos(fromKey: string, toKey: string, after: boolean): Promise<void> {
    const before = repos.value
    const keys = before.map((repo) => repoKey(repo))
    const next = moveWithin(keys, fromKey, toKey, after)
    if (next === keys || next.join('\u0000') === keys.join('\u0000')) return

    const byKey = new Map(before.map((repo) => [repoKey(repo), repo]))
    const ordered = next
      .map((key) => byKey.get(key))
      .filter((repo): repo is RepoEntry => repo !== undefined)
    if (ordered.length !== before.length) return

    repos.value = ordered

    try {
      await unwrap(window.ocr.reorderRepos(ordered.map((repo) => repo.dir || repo.key)))
    } catch (err) {
      ui.notifyError(err)
      await load()
    }
  }

  /** Stores a dragged order for one repository's sessions. */
  async function reorderSessions(
    repo: RepoEntry,
    fromId: string,
    toId: string,
    after: boolean
  ): Promise<void> {
    const key = repoKey(repo)
    const list = sessions.value[key]
    if (!list) return

    const ids = list.map((session) => session.session_id)
    const next = moveWithin(ids, fromId, toId, after)
    if (next.join('\u0000') === ids.join('\u0000')) return

    const byId = new Map(list.map((session) => [session.session_id, session]))
    const ordered = next
      .map((id) => byId.get(id))
      .filter((session): session is SessionListEntry => session !== undefined)
    if (ordered.length !== list.length) return

    sessions.value = { ...sessions.value, [key]: ordered }

    if (!repo.dir) return
    try {
      await unwrap(window.ocr.reorderSessions(repo.dir, next))
    } catch (err) {
      ui.notifyError(err)
      await loadSessions(repo, true)
    }
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

  /**
   * Renames a repository in the rail.
   *
   * Only this client's label changes — the folder and the paths recorded inside
   * its sessions are untouched, which is why a rename can never orphan history.
   * An empty name restores the folder name.
   */
  async function renameRepo(repo: RepoEntry, name: string): Promise<boolean> {
    if (!repo.dir) {
      ui.notifyError('这个仓库的路径无法解析，无法重命名。')
      return false
    }

    try {
      const saved = await unwrap(window.ocr.renameRepo(repo.dir, name))
      const label = saved ?? repo.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? repo.name

      repos.value = repos.value.map((entry) =>
        repoKey(entry) === repoKey(repo) ? { ...entry, name: label } : entry
      )
      // The home page holds its own copies of these entries.
      recent.value = recent.value.map((match) =>
        repoKey(match.repo) === repoKey(repo) ? { ...match, repo: { ...match.repo, name: label } } : match
      )

      ui.notify(name.trim() ? `已重命名为「${label}」` : `已恢复原名「${label}」`, 'ok')
      return true
    } catch (err) {
      ui.notifyError(err)
      return false
    }
  }

  /**
   * Deletes a repository and its whole history.
   *
   * The main process moves every one of its session files into this client's
   * trash before the repository is hidden, so this is recoverable rather than
   * destructive — the confirmation dialog is there because it is still a lot to
   * undo by hand, not because the data is gone.
   */
  async function deleteRepo(repo: RepoEntry): Promise<boolean> {
    if (!repo.dir) {
      ui.notifyError('这个仓库的路径无法解析，无法删除。')
      return false
    }

    const key = repoKey(repo)
    try {
      const result = await unwrap(window.ocr.deleteRepo(repo.dir))

      expanded.value = expanded.value.filter((k) => k !== key)
      fullHistory.value = fullHistory.value.filter((k) => k !== key)
      const remaining = { ...sessions.value }
      delete remaining[key]
      sessions.value = remaining
      // The home page holds its own copies of these entries (see `renameRepo`).
      // It re-reads them whenever a repository is added or removed — except when
      // the last one goes, which leaves the length at 0 and the watcher quiet, so
      // the entries for the deleted repository would stay on screen and clickable.
      recent.value = recent.value.filter((match) => repoKey(match.repo) !== key)

      if (activeRepoDir.value === repo.dir) {
        activeRepoDir.value = null
        activeSessionId.value = null
        results.clear()
        ui.showView('welcome')
      }

      await load()

      const skipped = result.skipped.length
        ? `；有 ${result.skipped.length} 条记录没能移入回收站，仍留在磁盘上`
        : ''
      ui.notify(
        `已删除「${repo.name}」：${result.trashed} 条历史已移入回收站${skipped}`,
        skipped ? 'error' : 'info',
        skipped ? 9000 : 5200
      )
      return true
    } catch (err) {
      ui.notifyError(err)
      return false
    }
  }

  /**
   * Re-reads one repo's session list, e.g. after a run finishes or names itself.
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
    // The home page keeps its own capped copy of the newest sessions; a run that
    // just produced one would not be in it. Marking the sweep stale re-reads it on
    // the next visit instead of spawning a CLI process per repository right now.
    recentLoaded = false
  }

  /**
   * Makes sure a repository's children are on screen, e.g. for a run just started.
   *
   * Deliberately not forced: `refreshSessions` reads the list again the moment the
   * run's session is known, and that is the only moment a new row can appear.
   */
  function expandRepo(repoDir: string): void {
    const repo = repos.value.find((r) => r.dir === repoDir)
    if (!repo) return
    void expandAndLoad(repo)
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
   * feature. There is deliberately no "generate" button and no setting to turn it
   * off — naming is a property of the history list, not an action the user has to
   * remember to take, and the model that names a session is the channel ocr is
   * already configured with (see `generateTitle` in the main process).
   *
   * Two safeguards keep that from becoming a nuisance:
   *
   * - the queue is drained strictly one at a time, so a first-run backfill of a
   *   long history never bursts the user's gateway;
   * - a run of consecutive failures trips a breaker for the rest of the app
   *   session, so a broken key or model cannot cause one failed request per
   *   session every time the list is read.
   *
   * A session that failed is not retried until the app restarts or `retryTitles`
   * is called. The settings page calls it whenever the channel, the model or an
   * API key changes, which is the fix a user reaches for first and therefore the
   * recovery path this breaker has to have.
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
    if (titleBreakerOpen || !repoDir) return

    for (const session of list) {
      // A session that already carries a title is never re-named, which is what
      // protects names the user wrote by hand.
      if (session.title) continue
      if (titleSeen.has(session.session_id)) continue
      // A session with a run behind it has no content to name yet: the file exists
      // from the first second, but it is empty until the review produces findings.
      // Naming it now would spend a model call on nothing and freeze a meaningless
      // name in place for the rest of the session. The check covers the second
      // before the run is matched to its session, when the id alone is not enough.
      if (isSessionInFlight(repoDir, session.session_id, Date.parse(session.start_time))) continue
      titleSeen.add(session.session_id)
      titleQueue.push({ repoDir, sessionId: session.session_id })
    }

    void drainTitles()
  }

  /**
   * Names one session ahead of the queue.
   *
   * Called when a run finishes: that session is the row the user is looking at,
   * and waiting behind a backfill of an old history is the wrong order. The job
   * jumps the queue but the queue is still drained one at a time.
   *
   * A job already waiting is moved rather than skipped — a refresh that reached the
   * session list first must not be able to park this one at the back, which is the
   * whole point of the call. A job already being named cannot be promoted.
   */
  function queueTitleNow(repoDir: string, sessionId: string): void {
    if (titleBreakerOpen || !repoDir) return

    const waiting = titleQueue.findIndex((job) => job.sessionId === sessionId)
    if (waiting >= 0) {
      const [job] = titleQueue.splice(waiting, 1)
      titleQueue.unshift(job)
      return
    }

    if (titleSeen.has(sessionId)) return

    const repo = repos.value.find((entry) => entry.dir === repoDir)
    const known = repo
      ? (sessions.value[repoKey(repo)] ?? []).find((entry) => entry.session_id === sessionId)
      : undefined
    if (known?.title) return

    titleSeen.add(sessionId)
    titleQueue.unshift({ repoDir, sessionId })
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
              `自动生成标题连续失败 ${TITLE_FAILURE_LIMIT} 次，已暂停：${reason}（在设置页检查「渠道与模型」的密钥或模型后会重试）`
            )
          }
        }
      }
    } finally {
      titleDraining = false
    }
  }

  /**
   * Clears the failure breaker and retries the histories already on screen.
   *
   * Called after the user changes the channel, the model or an API key: those are
   * the changes that can fix a titling request, and without this a key corrected
   * in the settings page would only take effect on the next app start. Only
   * expanded repositories are queued, and titled sessions are skipped by the
   * check in `enqueueTitles`, so this cannot re-bill a working history.
   */
  function retryTitles(): void {
    titleFailures = 0
    titleBreakerOpen = false
    titleSeen.clear()
    for (const repo of repos.value) {
      if (!isExpanded(repo)) continue
      const list = sessions.value[repoKey(repo)]
      if (list?.length) enqueueTitles(repo.dir, list)
    }
  }

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
    renameRepo,
    deleteRepo,
    reorderRepos,
    reorderSessions,
    sessionsFor,
    visibleSessions,
    hiddenSessionCount,
    isFullHistory,
    toggleFullHistory,
    refreshSessions,
    expandRepo,
    renameSession,
    deleteSession,
    retryTitles,
    queueTitleNow,
    clearSearch
  }
})
