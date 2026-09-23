<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { RepoEntry, SessionListEntry, SessionSummary } from '@shared/types'
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useUiStore } from '../stores/ui'
import { formatRelative, modeLabel, sessionState, stateLabel } from '../utils/format'
import ConfirmDialog from './ConfirmDialog.vue'
import logoUrl from '../assets/ocrlens-logo.png'

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

function onSessionClick(repo: RepoEntry, session: SessionSummary): void {
  // `dragging` is still set for the tick after a drop, which is when a stray
  // click would otherwise open the row that was just moved.
  if (dragging || editingId.value === session.session_id) return
  void repos.openSession(repo, session.session_id)
}

/** Repo-row click: ignored while a drag is settling or the name is being edited. */
function openRepoRow(repo: RepoEntry): void {
  if (dragging || editingRepoDir.value === repo.dir || !repo.dir) return
  repos.openRepo(repo)
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

/* ---------------- repository rename ---------------- */

/** Repository being renamed in place, if any. */
const editingRepoDir = ref<string | null>(null)
const repoDraft = ref('')
/** See `inputEl`: a function ref, because the row lives inside `v-for`. */
let repoInputEl: HTMLInputElement | null = null
let repoRenameAborted = false

/** Repository queued for deletion, shown in a confirmation dialog. */
const pendingRepoDelete = ref<RepoEntry | null>(null)
/**
 * Set while the delete is in flight.
 *
 * A `ref`, not a plain flag: it is bound to the dialog's `busy` prop, and a plain
 * variable never triggers the render that would show it — the dialog would sit
 * there looking idle while the whole history is moving.
 */
const deletingRepo = ref(false)

function setRepoInputRef(el: unknown): void {
  repoInputEl = el instanceof HTMLInputElement ? el : null
}

function startRepoRename(repo: RepoEntry): void {
  if (!repo.dir) return
  repoRenameAborted = false
  editingRepoDir.value = repo.dir
  repoDraft.value = repo.name
  void nextTick(() => {
    repoInputEl?.focus()
    repoInputEl?.select()
  })
}

function cancelRepoRename(): void {
  repoRenameAborted = true
  editingRepoDir.value = null
  repoDraft.value = ''
}

async function commitRepoRename(repo: RepoEntry): Promise<void> {
  if (repoRenameAborted || editingRepoDir.value !== repo.dir) return

  const next = repoDraft.value.trim()
  const current = repo.name
  editingRepoDir.value = null
  if (next === current) return

  await repos.renameRepo(repo, next)
}

function askDeleteRepo(repo: RepoEntry): void {
  pendingRepoDelete.value = repo
}

async function confirmDeleteRepo(): Promise<void> {
  const target = pendingRepoDelete.value
  if (!target || deletingRepo.value) return
  // Same reasoning as `confirmDelete` above: the dialog's `busy` prop only
  // reaches the DOM on the next render, so this flag is what stops a double
  // click from issuing two deletes.
  deletingRepo.value = true
  try {
    await repos.deleteRepo(target)
  } finally {
    deletingRepo.value = false
    pendingRepoDelete.value = null
  }
}

/* ---------------- drag ordering ---------------- */

const dragRepoKey = ref<string | null>(null)
const repoDrop = ref<{ key: string; after: boolean } | null>(null)
const dragSessionId = ref<string | null>(null)
/** Repository the dragged session belongs to; drops are only legal inside it. */
const dragSessionRepoKey = ref<string | null>(null)
const sessionDrop = ref<{ id: string; after: boolean } | null>(null)

/**
 * True for the length of a drag, plus one tick after it ends.
 *
 * A drag that starts on a row can still deliver a click to that row, which would
 * open the very session the user was reordering.
 */
let dragging = false

function clearDrag(): void {
  dragRepoKey.value = null
  repoDrop.value = null
  dragSessionId.value = null
  dragSessionRepoKey.value = null
  sessionDrop.value = null
}

function onDragEnd(): void {
  clearDrag()
  window.setTimeout(() => {
    dragging = false
  }, 0)
}

/**
 * Which half of the row the pointer is over: a drop lands above or below it.
 *
 * The element to measure is passed in because a repository's drop zone is its
 * whole block — including the expanded session list — while the line the user
 * aims at belongs to the title row inside it.
 */
function dropAfter(event: DragEvent, box?: Element | null): boolean {
  const target = box ?? (event.currentTarget as HTMLElement | null)
  if (!target) return false
  const rect = target.getBoundingClientRect()
  return event.clientY > rect.top + rect.height / 2
}

function onRepoDragStart(repo: RepoEntry, event: DragEvent): void {
  dragRepoKey.value = repos.repoKey(repo)
  dragging = true
  // Some payload is required for the drag to start in Chromium.
  event.dataTransfer?.setData('text/plain', repo.name)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onRepoDragOver(repo: RepoEntry, event: DragEvent): void {
  const key = repos.repoKey(repo)
  if (!dragRepoKey.value || key === dragRepoKey.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const block = event.currentTarget as HTMLElement | null
  repoDrop.value = { key, after: dropAfter(event, block?.querySelector('.repo-row')) }
}

function onRepoDrop(): void {
  const from = dragRepoKey.value
  const target = repoDrop.value
  clearDrag()
  if (from && target) void repos.reorderRepos(from, target.key, target.after)
}

function onSessionDragStart(repo: RepoEntry, session: SessionListEntry, event: DragEvent): void {
  dragSessionId.value = session.session_id
  dragSessionRepoKey.value = repos.repoKey(repo)
  dragging = true
  event.dataTransfer?.setData('text/plain', repos.sessionLabel(session))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  // The repo row above would otherwise claim the drag and reorder repositories.
  event.stopPropagation()
}

function onSessionDragOver(repo: RepoEntry, session: SessionListEntry, event: DragEvent): void {
  if (!dragSessionId.value || dragSessionId.value === session.session_id) return
  // Sessions can only be arranged within their own repository: the order is
  // stored per repository, and moving a session between repositories is not a
  // thing the CLI's storage supports.
  if (dragSessionRepoKey.value !== repos.repoKey(repo)) return

  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  sessionDrop.value = { id: session.session_id, after: dropAfter(event) }
}

function onSessionDrop(repo: RepoEntry): void {
  // A repository dragged over an expanded session list is still over that
  // repository's whole block — the drop zone includes the list (see `dropAfter`),
  // and the `.stop` on the session row means this handler sees it first. Without
  // this the repository order silently ignored the drop while the insert line was
  // showing.
  if (dragRepoKey.value) {
    onRepoDrop()
    return
  }

  const from = dragSessionId.value
  const target = sessionDrop.value
  clearDrag()
  if (from && target) void repos.reorderSessions(repo, from, target.id, target.after)
}

const repoDropClass = (repo: RepoEntry): Record<string, boolean> => {
  const key = repos.repoKey(repo)
  return {
    'drop-above': repoDrop.value?.key === key && !repoDrop.value.after,
    'drop-below': repoDrop.value?.key === key && repoDrop.value.after,
    dragging: dragRepoKey.value === key
  }
}

const sessionDropClass = (session: SessionListEntry): Record<string, boolean> => {
  return {
    'drop-above': sessionDrop.value?.id === session.session_id && !sessionDrop.value.after,
    'drop-below': sessionDrop.value?.id === session.session_id && sessionDrop.value.after,
    dragging: dragSessionId.value === session.session_id
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
        <img class="brand-mark" :src="logoUrl" alt="" width="26" height="26" />
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
          v-for="(match, matchIndex) in repos.searchMatches"
          :key="match.session.session_id"
          class="search-hit"
          :class="{ active: match.session.session_id === repos.activeSessionId }"
          :data-session-id="match.session.session_id"
          :style="{ '--row-i': Math.min(matchIndex, 10) }"
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
        <div
          v-for="repo in repos.visibleRepos"
          :key="repos.repoKey(repo)"
          class="repo"
          :class="repoDropClass(repo)"
          @dragover="onRepoDragOver(repo, $event)"
          @drop.stop.prevent="onRepoDrop()"
        >
          <div
            class="repo-row"
            :class="{ active: repo.dir === repos.activeRepoDir }"
            :draggable="editingRepoDir !== repo.dir"
            @click="openRepoRow(repo)"
            @dragstart="onRepoDragStart(repo, $event)"
            @dragend="onDragEnd()"
          >
            <button
              class="chevron"
              :class="{ open: repos.isExpanded(repo) }"
              :title="repos.isExpanded(repo) ? '收起会话' : '展开会话'"
              :aria-expanded="repos.isExpanded(repo)"
              @click.stop="repos.toggleExpand(repo)"
            />

            <!-- Renaming happens in the row, like a session's, so the list the
                 name belongs to stays visible. -->
            <input
              v-if="editingRepoDir === repo.dir"
              :ref="setRepoInputRef"
              v-model="repoDraft"
              class="rename-input repo-rename"
              placeholder="留空则恢复文件夹名"
              spellcheck="false"
              @click.stop
              @keydown.enter.prevent="commitRepoRename(repo)"
              @keydown.esc.prevent="cancelRepoRename()"
              @blur="commitRepoRename(repo)"
            />

            <template v-else>
              <span class="repo-name" :class="{ missing: !repo.exists }" :title="repo.dir || repo.key">
                {{ repo.name }}
              </span>

              <span v-if="repos.loadingSessions.includes(repos.repoKey(repo))" class="spinner" />
              <span v-else class="repo-count">{{ repo.sessionCount }}</span>

              <div class="repo-actions" @click.stop>
                <button class="icon-btn" title="重命名项目" @click="startRepoRename(repo)">✎</button>
                <button
                  class="icon-btn danger"
                  title="删除项目及其全部审查历史"
                  @click="askDeleteRepo(repo)"
                >
                  ✕
                </button>
              </div>
            </template>
          </div>

          <div v-if="repos.isExpanded(repo)" class="sessions">
            <div v-if="repos.sessionErrors[repos.repoKey(repo)]" class="empty" style="padding: 8px">
              <p class="muted">{{ repos.sessionErrors[repos.repoKey(repo)] }}</p>
            </div>

            <template v-else>
              <div
                v-for="(session, sessionIndex) in repos.visibleSessions(repo)"
                :key="session.session_id"
                class="session-row"
                :class="[
                  {
                    active: session.session_id === repos.activeSessionId,
                    busy: repos.isBusy(session.session_id)
                  },
                  sessionDropClass(session)
                ]"
                :style="{ '--row-i': Math.min(sessionIndex, 12) }"
                :title="`${repos.sessionLabel(session)}\n${session.session_id}\n${session.git_branch}`"
                :data-session-id="session.session_id"
                :draggable="editingId !== session.session_id"
                @click="onSessionClick(repo, session)"
                @dragstart="onSessionDragStart(repo, session, $event)"
                @dragover="onSessionDragOver(repo, session, $event)"
                @drop.stop.prevent="onSessionDrop(repo)"
                @dragend="onDragEnd()"
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

              <!-- A long history would otherwise push every other repository off
                   the rail; the newest handful is what a review workflow wants. -->
              <button
                v-if="repos.hiddenSessionCount(repo) > 0 || repos.isFullHistory(repo)"
                class="sessions-more"
                @click.stop="repos.toggleFullHistory(repo)"
              >
                {{
                  repos.isFullHistory(repo)
                    ? '收起'
                    : `展开其余 ${repos.hiddenSessionCount(repo)} 个会话`
                }}
              </button>

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
      <button class="btn sm foot-icon" title="刷新列表" aria-label="刷新列表" @click="repos.load()">
        ⟳
      </button>
      <button
        class="btn sm foot-icon"
        title="设置"
        aria-label="设置"
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

    <!-- Deleting a repository takes its whole history with it, so the dialog says
         how much is about to move instead of asking a vague "are you sure". -->
    <ConfirmDialog
      v-if="pendingRepoDelete"
      title="删除这个项目？"
      :message="`「${pendingRepoDelete.name}」及其 ${pendingRepoDelete.sessionCount} 条审查历史都会被移入回收站，侧栏不再显示该项目。`"
      :detail="pendingRepoDelete.dir || pendingRepoDelete.key"
      confirm-label="删除项目"
      danger
      :busy="deletingRepo"
      @confirm="confirmDeleteRepo()"
      @cancel="pendingRepoDelete = null"
    />
  </aside>
</template>
