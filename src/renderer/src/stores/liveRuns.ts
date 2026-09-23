import { ref } from 'vue'

/**
 * Which sessions currently have a review running behind them.
 *
 * A leaf module rather than part of the run store: the repository store has to ask
 * this question when it decides whether a session is worth naming yet, and it
 * cannot import the run store — the run store imports it.
 *
 * A run whose session id is not known yet is kept too: the CLI creates the session
 * file about a second before the client can match it to the run, and a list read in
 * that gap would otherwise hand a session that is still being written to the titler.
 */
export interface LiveRunRef {
  repoDir: string
  sessionId: string | null
  /** Epoch ms; a session that started no earlier than this belongs to that run. */
  startedAt: number
}

const liveRuns = ref<LiveRunRef[]>([])

/** Replaces the set; the run store is the only writer. */
export function syncLiveRuns(entries: LiveRunRef[]): void {
  liveRuns.value = entries.map((entry) => ({
    repoDir: entry.repoDir,
    sessionId: entry.sessionId,
    startedAt: entry.startedAt
  }))
}

function isSessionRunning(sessionId: string): boolean {
  return liveRuns.value.some((entry) => entry.sessionId === sessionId)
}

/**
 * Whether a listed session is the record of a run that is still going.
 *
 * `session_start_time` is stamped in whole seconds, so a session created by a run
 * can appear up to a second older than the run did; a session older than that is
 * somebody else's — most often an earlier review the CLI left unfinished, which is
 * exactly the record that is worth naming.
 */
export function isSessionInFlight(
  repoDir: string,
  sessionId: string,
  sessionStartedAt: number
): boolean {
  if (isSessionRunning(sessionId)) return true

  return liveRuns.value.some(
    (entry) =>
      entry.repoDir === repoDir &&
      !entry.sessionId &&
      Number.isFinite(sessionStartedAt) &&
      sessionStartedAt >= entry.startedAt - 1000
  )
}
