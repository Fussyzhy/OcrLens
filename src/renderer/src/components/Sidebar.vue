<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { RepoEntry, SessionListEntry, SessionSummary } from '@shared/types'
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useUiStore } from '../stores/ui'
import { formatRelative, modeLabel, stateLabel } from '../utils/format'
import ConfirmDialog from './ConfirmDialog.vue'

const env = useEnvStore()
const repos = useRepoStore()
const ui = useUiStore()

/** Session currently being renamed in place, if any. */
const editingId = ref<string | null>(null)
const draft = ref('')
/**
 * The rename input, held as a plain variable rather than a template ref.
 *
 * A `ref` on an element inside `v-for` collects into an array, which would make
 * focusing the field awkward; a function ref sidesteps that.
 */
let inputEl: HTMLInputElement | null = null
/** Set when Escape abandons the edit, so the resulting blur does not save it. */
let renameAborted = false

/** Session queued for deletion, shown in a confirmation dialog. */
const pendingDelete = ref<{ repo: RepoEntry; session: SessionListEntry } | null>(null)
/** True while a confirmed delete is in flight; see `confirmDelete`. */
let deleting = false

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
  if (editingId.value === session.session_id) return
  void repos.openSession(repo, session.session_id)
}

/** Function ref: records the rename field once Vue mounts it. */
function setInputRef(el: unknown): void {
  inputEl = el instanceof HTMLInputElement ? el : null
}

/* ---------------- rename ---------------- */

function startRename(session: SessionListEntry): void {
  renameAborted = false
  editingId.value = session.session_id
  draft.value = session.title ?? ''
  void nextTick(() => {
    inputEl?.focus()
    inputEl?.select()
  })
}

function cancelRename(): void {
  renameAborted = true
  editingId.value = null
  draft.value = ''
}

async function commitRename(repo: RepoEntry, session: SessionListEntry): Promise<void> {
  if (renameAborted || editingId.value !== session.session_id) return

  const next = draft.value.trim()
  const current = session.title ?? ''
  editingId.value = null

  // Nothing changed: skip the round trip and the toast.
  if (next === current) return

  await repos.renameSession(repo.dir, session.session_id, next)
}

/* ---------------- delete ---------------- */

function askDelete(repo: RepoEntry, session: SessionListEntry): void {
  pendingDelete.value = { repo, session }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  if (!target || deleting) return
  // `busy` is a prop that only reaches the DOM on the next render, so this flag
  // — not the button's disabled state — is what stops a double click from
  // issuing two deletes.
  deleting = true
  // Kept mounted while the delete runs: clearing it first unmounted the dialog
  // before `busy` could ever be true, making its spinner/disable logic dead
  // code. `deleteSession` reports its own failures as toasts.
  try {
    await repos.deleteSession(target.repo, target.session)
  } finally {
    deleting = false
    pendingDelete.value = null
  }
}

/* ---------------- search ---------------- */

// Titles live in session summaries that are only fetched when a repo is expanded,
// so a search has to pull the missing ones before it can match anything.
watch(
  () => repos.query,
  (value) => {
    if (value.trim()) void repos.ensureAllSessionsLoaded()
  }
)
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <div class="brand">
        <span class="brand-dot" />
        <span>OcrLens</span>
        <span v-if="env.info?.ocrVersion" class="brand-version">v{{ env.info.ocrVersion }}</span>
      </div>

      <div class="search">
        <input
          v-model="repos.query"
          type="search"
          placeholder="搜索标题或会话…"
          spellcheck="false"
          aria-label="搜索审查历史标题"
        />
        <button v-if="repos.query" class="search-clear" title="清除搜索" @click="repos.clearSearch()">
          ✕
        </button>
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

      <!-- Search results: a flat list, because a title match is what the user is
           after and burying it inside a collapsed repo would hide it. -->
      <template v-else-if="repos.query.trim()">
        <!-- One loading state only: the empty state below used to render
             "搜索中…" alongside this while the same fetch was still running. -->
        <div v-if="repos.searchLoading" class="search-state">
          <span class="spinner" />
          <span>正在读取历史记录…</span>
        </div>

        <div v-else-if="!repos.searchMatches.length" class="empty">
          <p>没有匹配的审查历史。</p>
          <p class="muted">可以试试标题、分支名或审查模式。</p>
        </div>

        <button
          v-for="match in repos.searchMatches"
          :key="match.session.session_id"
          class="search-hit"
          :class="{ active: match.session.session_id === repos.activeSessionId }"
          :data-session-id="match.session.session_id"
          @click="repos.openSession(match.repo, match.session.session_id)"
        >
          <span class="status-dot" :class="sessionState(match.session)" />
          <span class="hit-body">
            <span class="hit-title" :class="{ untitled: !match.session.title }">
              {{ repos.sessionLabel(match.session) }}
            </span>
            <span class="hit-meta">
              {{ match.repo.name }} · {{ formatRelative(match.session.start_time) }}
              <template v-if="match.session.total_comments > 0">
                · {{ match.session.total_comments }} 项
              </template>
            </span>
          </span>
        </button>
      </template>

      <div v-else-if="!repos.visibleRepos.length" class="empty">
        <h2>还没有仓库</h2>
        <p>点下方「添加仓库」选择一个 git 仓库开始。</p>
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
                :class="{
                  active: session.session_id === repos.activeSessionId,
                  busy: repos.isBusy(session.session_id)
                }"
                :title="`${repos.sessionLabel(session)}\n${session.session_id}\n${session.git_branch}`"
                :data-session-id="session.session_id"
                @click="onSessionClick(repo, session)"
              >
                <span class="status-dot" :class="sessionState(session)" />

                <div class="session-body">
                  <!-- Renaming happens in place: the row is the only place the
                       title appears, so a modal would hide the context. -->
                  <input
                    v-if="editingId === session.session_id"
                    :ref="setInputRef"
                    v-model="draft"
                    class="rename-input"
                    placeholder="留空则让模型重新命名"
                    spellcheck="false"
                    @click.stop
                    @keydown.enter.prevent="commitRename(repo, session)"
                    @keydown.esc.prevent="cancelRename()"
                    @blur="commitRename(repo, session)"
                  />

                  <template v-else>
                    <div class="session-title">
                      <span class="session-name" :class="{ untitled: !session.title }">
                        {{ repos.sessionLabel(session) }}
                      </span>
                      <span class="session-findings" :class="{ has: session.total_comments > 0 }">
                        {{ session.total_comments }}
                      </span>
                    </div>
                    <div class="session-sub">
                      <template v-if="session.title">{{ modeLabel(session.review_mode) }} · </template>
                      {{ formatRelative(session.start_time) }} ·
                      {{ stateLabel(sessionState(session)) }}
                    </div>
                  </template>
                </div>

                <div v-if="editingId !== session.session_id" class="session-actions" @click.stop>
                  <!-- Busy covers rename, title generation and deletion, so the
                       label must not claim it is always a title job. -->
                  <span v-if="repos.isBusy(session.session_id)" class="spinner" title="正在处理…" />
                  <template v-else>
                    <button class="icon-btn" title="重命名" @click="startRename(session)">✎</button>
                    <button class="icon-btn danger" title="删除该历史记录" @click="askDelete(repo, session)">
                      ✕
                    </button>
                  </template>
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

    <ConfirmDialog
      v-if="pendingDelete"
      title="删除这条审查历史？"
      :message="`「${repos.sessionLabel(pendingDelete.session)}」将从历史记录中移除。`"
      :detail="`${pendingDelete.session.session_id}\n${pendingDelete.session.git_branch}`"
      confirm-label="删除"
      danger
      :busy="repos.isBusy(pendingDelete.session.session_id)"
      @confirm="confirmDelete()"
      @cancel="pendingDelete = null"
    />
  </aside>
</template>
