<script setup lang="ts">
import { computed, ref } from 'vue'
import FindingCard from '../components/FindingCard.vue'
import { useRepoStore } from '../stores/repos'
import { useResultsStore } from '../stores/results'
import { useRunStore } from '../stores/run'
import { useUiStore } from '../stores/ui'
import { copyText } from '../utils/clipboard'
import { buildSessionMarkdown, suggestReportFileName } from '../utils/markdown'
import {
  categoryLabel,
  formatDateTime,
  formatDurationNs,
  formatElapsedMs,
  modeLabel,
  severityLabel,
  stateLabel
} from '../utils/format'

const repos = useRepoStore()
const results = useResultsStore()
const run = useRunStore()
const ui = useUiStore()

/**
 * The run writing this session, if it is still alive.
 *
 * The rail opens a running task in its own session, so this page has to show the
 * live log rather than the "no findings" state a half-written session produces.
 */
const liveRun = computed(() => (results.sessionId ? run.liveRunForSession(results.sessionId) : null))

/**
 * A run that ended and left this session behind — interrupted above all.
 *
 * Its log exists only here: the CLI's aborted session has no `session_end` record,
 * so the window that watched it is the only place the output was ever collected.
 */
const keptRun = computed(() => {
  if (!results.sessionId) return null
  const entry = run.runForSession(results.sessionId)
  return entry && !run.isRunLive(entry) && entry.phase !== 'finished' ? entry : null
})

function stopRun(): void {
  if (liveRun.value) void run.cancel(liveRun.value.runId)
}

const summary = computed(() => results.summary)

const manifest = computed(() => summary.value?.run_manifest ?? null)

const coverage = computed(() => {
  const cov = manifest.value?.coverage
  if (!cov) return null
  return {
    selected: cov.selected?.length ?? 0,
    completed: cov.completed?.length ?? 0,
    failed: cov.failed?.length ?? 0,
    reused: cov.reused?.length ?? 0
  }
})

/** Files that failed, surfaced so a partial review is never mistaken for a clean one. */
const failedItems = computed(() => manifest.value?.coverage?.failed ?? [])

/** Label for the open session's repository, taken from the session itself. */
const repoName = computed(
  () => results.repoDir.split(/[\\/]/).filter(Boolean).pop() ?? repos.activeRepo?.name ?? ''
)

/* ---------------- Markdown export ---------------- */

const exporting = ref(false)

/** True when the filters hide findings, so "export" needs to say which set it means. */
const hiddenByFilter = computed(() => results.filtered.length !== results.comments.length)

/**
 * Renders the report the user is asking for.
 *
 * `visible` follows the filters, which is what "the results" means while looking
 * at a filtered list; `all` ignores them for when the report should be complete.
 */
function renderReport(scope: 'visible' | 'all'): string {
  const current = summary.value
  if (!current) return ''

  const comments = scope === 'visible' ? results.filtered : results.comments

  return buildSessionMarkdown({
    repoDir: results.repoDir,
    sessionId: results.sessionId,
    summary: current,
    comments,
    totalComments: results.comments.length,
    filtered: scope === 'visible' && hiddenByFilter.value,
    isIgnored: (comment) => results.isIgnored(results.findingKey(comment))
  })
}

async function exportMarkdown(scope: 'visible' | 'all'): Promise<void> {
  const content = renderReport(scope)
  if (!content || exporting.value) return

  exporting.value = true
  try {
    const reply = await window.ocr.exportSessionMarkdown({
      suggestedName: suggestReportFileName({
        repoDir: results.repoDir,
        sessionId: results.sessionId,
        summary: summary.value
      }),
      content
    })

    if (!reply.ok) throw new Error(reply.error)
    // A cancelled save dialog is an ordinary outcome, not a failure.
    if (reply.data.cancelled) return

    const scopeNote = scope === 'visible' ? '' : '（全部 finding）'
    ui.notify(`已导出${scopeNote} ${reply.data.filePath}`, 'ok', 9000)
  } catch (err) {
    ui.notifyError(err)
  } finally {
    exporting.value = false
  }
}

/** Same document, straight to the clipboard, for pasting into an agent session. */
async function copyMarkdown(): Promise<void> {
  const content = renderReport('visible')
  if (!content) return

  const ok = await copyText(content)
  ui.notify(
    ok ? `已复制 Markdown（${results.filtered.length} 条 finding）` : '复制失败',
    ok ? 'ok' : 'error'
  )
}
</script>

<template>
  <div class="view-head">
    <button class="btn sm ghost" title="返回配置" @click="ui.showView('new-review')">‹ 新建审查</button>
    <div style="min-width: 0">
      <h1>{{ repoName }}</h1>
      <div class="sub">
        <template v-if="summary">
          {{ modeLabel(summary.review_mode) }} · {{ summary.git_branch || '无分支' }} ·
          {{ formatDateTime(summary.start_time) }}
        </template>
        <template v-else>会话 {{ results.sessionId }}</template>
      </div>
    </div>

    <!-- Export controls. A report can be handed to a person or to an agent, so
         the button says which findings would go in rather than leaving the
         filter state to be guessed. Hidden while the run is still writing: there
         is no report yet. -->
    <div v-if="summary && !results.loading && !liveRun" class="inline head-actions">
      <span v-if="hiddenByFilter" class="muted nowrap" style="font-size: 11px">
        当前筛选 {{ results.filtered.length }}/{{ results.comments.length }}
      </span>
      <button
        class="btn sm ghost"
        :disabled="exporting"
        title="复制 Markdown 到剪贴板"
        @click="copyMarkdown"
      >
        复制 MD
      </button>
      <button
        v-if="hiddenByFilter"
        class="btn sm ghost"
        :disabled="exporting"
        title="忽略筛选，导出这个会话的全部 finding"
        @click="exportMarkdown('all')"
      >
        导出全部
      </button>
      <button
        class="btn sm"
        :disabled="exporting"
        title="导出为 Markdown 文档"
        @click="exportMarkdown('visible')"
      >
        <span v-if="exporting" class="spinner" />
        {{ exporting ? '导出中…' : '导出 MD' }}
      </button>
    </div>
  </div>

  <div class="view-body">
    <!-- A running task lives in its session: this is the record the rail opens, so
         the log belongs here rather than in whichever page started the review. -->
    <div v-if="liveRun" class="card run-live" :data-run-id="liveRun.runId">
      <div class="card-head">
        <span class="spinner" />
        <span>{{ liveRun.statusText }}</span>
        <span class="muted right inline">
          {{ modeLabel(liveRun.mode) }} · {{ formatElapsedMs(liveRun.elapsedMs) }}
          <button
            class="btn sm danger"
            style="margin-left: 10px"
            :disabled="liveRun.cancelling"
            @click="stopRun()"
          >
            {{ liveRun.cancelling ? '正在中断…' : '停止' }}
          </button>
        </span>
      </div>
      <div class="run-live-command mono muted">{{ liveRun.command }}</div>
      <!-- A session still being written may not read back cleanly; that is the
           run being unfinished, not a failure worth an error banner. -->
      <div v-if="results.error" class="run-live-command muted">
        会话内容要在运行结束后才能完整读取。
      </div>
      <div class="log">
        <div v-if="!liveRun.logs.length" class="log-empty">等待输出…</div>
        <div v-for="(line, index) in liveRun.logs" :key="index" class="log-line">{{ line }}</div>
      </div>
    </div>

    <!-- The CLI's interrupted session keeps no `session_end` record, so this log is
         the only account of what the stopped run managed to do. -->
    <div v-else-if="keptRun" class="card run-live">
      <div class="card-head">
        <span>{{ keptRun.phase === 'cancelled' ? '这次运行已中断' : '这次运行没有正常结束' }}</span>
        <span class="muted right inline">
          {{ modeLabel(keptRun.mode) }} · {{ formatElapsedMs(keptRun.elapsedMs) }}
        </span>
      </div>
      <div class="run-live-command mono muted">{{ keptRun.command }}</div>
      <!-- The toast that carried this is long gone; without it the log ends for no
           visible reason. -->
      <div v-if="keptRun.error" class="run-live-command">
        <span class="muted">失败原因：</span>{{ keptRun.error }}
      </div>
      <div class="log">
        <div v-if="!keptRun.logs.length" class="log-empty">没有保留输出</div>
        <div v-for="(line, index) in keptRun.logs" :key="index" class="log-line">{{ line }}</div>
      </div>
    </div>

    <div v-if="results.loading" class="empty">
      <span class="spinner" /> <span style="margin-left: 8px">正在读取会话…</span>
    </div>

    <div v-else-if="results.error && !liveRun" class="banner error">
      <span>✕</span>
      <span>{{ results.error }}</span>
    </div>

    <template v-else-if="summary">
      <!-- Session facts worth seeing before the findings. -->
      <div class="summary-bar">
        <div class="metric">
          <span class="metric-value">{{ summary.total_comments }}</span>
          <span class="metric-label">findings</span>
        </div>
        <div class="metric">
          <span class="metric-value">{{ formatDurationNs(summary.duration_ns) }}</span>
          <span class="metric-label">耗时</span>
        </div>
        <div class="metric">
          <span class="metric-value">{{ summary.model || '—' }}</span>
          <span class="metric-label">模型</span>
        </div>
        <div v-if="coverage" class="metric">
          <span class="metric-value">{{ coverage.completed }}/{{ coverage.selected }}</span>
          <span class="metric-label">文件覆盖</span>
        </div>
        <div v-if="manifest" class="metric">
          <span class="metric-value">{{ stateLabel(manifest.terminal_state) }}</span>
          <span class="metric-label">终态</span>
        </div>
        <div v-if="manifest?.execution?.ocr_version" class="metric">
          <span class="metric-value">{{ manifest.execution.ocr_version }}</span>
          <span class="metric-label">ocr 版本</span>
        </div>
      </div>

      <div v-if="failedItems.length" class="banner warn">
        <span>⚠</span>
        <div>
          <div>{{ failedItems.length }} 个文件未能完成审查，结果并不完整：</div>
          <div class="mono" style="margin-top: 4px">
            {{ failedItems.map((item) => item.path).join(', ') }}
          </div>
        </div>
      </div>

      <div v-if="summary.llm_failures" class="banner warn">
        <span>⚠</span>
        <span>本次运行记录到 {{ summary.llm_failures }} 次模型调用失败。</span>
      </div>

      <!-- Filters -->
      <div v-if="results.comments.length" class="card">
        <div class="card-body filter-grid">
          <div class="filter-row">
            <span class="muted" style="min-width: 40px">严重度</span>
            <div class="sev-toggles">
              <button
                v-for="key in results.severityKeys"
                :key="key"
                class="sev-toggle"
                :class="[`sev-${key}`, { on: results.severityEnabled[key] }]"
                @click="results.toggleSeverity(key)"
              >
                {{ severityLabel(key === 'unknown' ? undefined : key) }}
                <span class="muted">{{ results.counts[key] }}</span>
              </button>
            </div>
          </div>

          <div class="filter-row">
            <span class="muted" style="min-width: 40px">类别</span>
            <div class="sev-toggles">
              <button
                v-for="key in results.categoryKeys"
                :key="key"
                class="sev-toggle"
                :class="{ on: results.categoryEnabled[key] }"
                @click="results.toggleCategory(key)"
              >
                {{ categoryLabel(key) }}
                <span class="muted">{{ results.categoryCounts[key] }}</span>
              </button>
            </div>
          </div>

          <div class="filter-row filter-row--wide">
            <input
              v-model="results.search"
              type="text"
              placeholder="在 finding 内容与代码中搜索…"
              spellcheck="false"
            />
            <button class="btn sm" @click="results.resetFilters()">重置筛选</button>
            <span class="muted nowrap">显示 {{ results.filtered.length }} / {{ results.comments.length }}</span>
          </div>
        </div>
      </div>

      <!-- Findings grouped by file -->
      <div v-if="!results.comments.length && liveRun" class="empty">
        <h2>审查进行中…</h2>
        <p>运行结束后结果会出现在这里，期间可以先看上面的实时日志。</p>
      </div>

      <div v-else-if="!results.comments.length" class="empty">
        <h2>这个会话没有产生 finding</h2>
        <p>可能是改动本身没有问题，也可能选中的文件都被排除了。</p>
      </div>

      <div v-else-if="!results.groups.length" class="empty">
        <h2>当前筛选条件下没有结果</h2>
        <p>试试重置筛选，或检查是否把所有严重度都关掉了。</p>
      </div>

      <template v-else>
        <!-- One full-width column (see .findings-grid in styles.css): the code
             context beside a finding is what needs the room, so the grid is not
             split into two as soon as the pane is wide. -->
        <div class="findings-grid">
          <div v-for="group in results.groups" :key="group.path" class="file-group">
            <div class="file-head" @click="results.toggleFile(group.path)">
              <span class="chevron" :class="{ open: !results.isCollapsed(group.path) }" />
              <span class="file-path" :title="group.path">{{ group.path }}</span>
              <span class="file-count">{{ group.comments.length }} 项</span>
            </div>

            <template v-if="!results.isCollapsed(group.path)">
              <FindingCard
                v-for="comment in group.comments"
                :key="results.findingKey(comment)"
                :comment="comment"
              />
            </template>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
