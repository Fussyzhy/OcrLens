<script setup lang="ts">
import type { RepoEntry, SessionSummary } from '@shared/types'
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useUiStore } from '../stores/ui'
import { formatRelative, modeLabel, stateLabel } from '../utils/format'

const env = useEnvStore()
const repos = useRepoStore()
const ui = useUiStore()

/**
 * Resolves a session's outcome for the status dot.
 *
 * `run_manifest.terminal_state` is authoritative when present; older sessions
 * (`legacy: true`) have none, so we infer from the per-file counters instead of
 * showing everything as unknown.
 */
function sessionState(session: SessionSummary): string {
  const state = session.run_manifest?.terminal_state
  if (state) return state
  if (session.aborted) return 'aborted'
  if (session.selected_files > 0 && session.completed_files === 0 && session.failed_files > 0) {
    return 'failed'
  }
  return session.completed_files > 0 ? 'complete' : 'skipped'
}

function onSessionClick(repo: RepoEntry, session: SessionSummary): void {
  void repos.openSession(repo, session.session_id)
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <div class="brand">
        <span class="brand-dot" />
        <span>OCR Client</span>
        <span v-if="env.info?.ocrVersion" class="brand-version">v{{ env.info.ocrVersion }}</span>
      </div>

      <div class="search">
        <input v-model="repos.query" type="text" placeholder="搜索仓库或会话…" spellcheck="false" />
      </div>
    </div>

    <div class="tree">
      <div v-if="repos.loading && !repos.repos.length" class="empty">
        <span class="spinner" />
      </div>

      <div v-else-if="repos.error" class="empty">
        <p>无法读取仓库列表。</p>
        <p class="muted">{{ repos.error }}</p>
      </div>

      <div v-else-if="!repos.visibleRepos.length" class="empty">
        <p v-if="repos.query">没有匹配的仓库或会话。</p>
        <template v-else>
          <h2>还没有仓库</h2>
          <p>点下方「添加仓库」选择一个 git 仓库开始。</p>
        </template>
      </div>

      <template v-else>
        <div v-for="repo in repos.visibleRepos" :key="repos.repoKey(repo)" class="repo">
          <div
            class="repo-row"
            :class="{ active: repo.dir === repos.activeRepoDir }"
            @click="repos.openRepo(repo)"
          >
            <button
              class="chevron"
              :class="{ open: repos.isExpanded(repo) }"
              :title="repos.isExpanded(repo) ? '收起会话' : '展开会话'"
              @click.stop="repos.toggleExpand(repo)"
            >
              ▶
            </button>

            <span class="repo-name" :class="{ missing: !repo.exists }" :title="repo.dir || repo.key">
              {{ repo.name }}
            </span>

            <span v-if="repos.loadingSessions.includes(repos.repoKey(repo))" class="spinner" />
            <span v-else class="repo-count">{{ repo.sessionCount }}</span>
          </div>

          <div v-if="repos.isExpanded(repo)" class="sessions">
            <div v-if="repos.sessionErrors[repos.repoKey(repo)]" class="empty" style="padding: 8px">
              <p class="muted">{{ repos.sessionErrors[repos.repoKey(repo)] }}</p>
            </div>

            <template v-else>
              <div
                v-for="session in repos.sessions[repos.repoKey(repo)] ?? []"
                :key="session.session_id"
                class="session-row"
                :class="{ active: session.session_id === repos.activeSessionId }"
                :title="`${session.session_id}\n${session.git_branch}`"
                @click="onSessionClick(repo, session)"
              >
                <span class="status-dot" :class="sessionState(session)" />

                <div class="session-body">
                  <div class="session-title">
                    <span class="session-mode">{{ modeLabel(session.review_mode) }}</span>
                    <span class="session-findings" :class="{ has: session.total_comments > 0 }">
                      {{ session.total_comments }} 项
                    </span>
                  </div>
                  <div class="session-sub">
                    {{ formatRelative(session.start_time) }} · {{ stateLabel(sessionState(session)) }}
                  </div>
                </div>
              </div>

              <div
                v-if="!(repos.sessions[repos.repoKey(repo)] ?? []).length"
                class="empty"
                style="padding: 10px"
              >
                <p class="muted">暂无会话记录</p>
                <p class="muted">点仓库名可直接发起审查</p>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>

    <div class="sidebar-foot">
      <button class="btn sm" style="flex: 1" @click="repos.addRepo()">＋ 添加仓库</button>
      <button class="btn sm" title="刷新列表" @click="repos.load()">⟳</button>
      <button
        class="btn sm"
        title="设置"
        :class="{ primary: ui.view === 'settings' }"
        @click="ui.showView('settings')"
      >
        ⚙
      </button>
    </div>
  </aside>
</template>
