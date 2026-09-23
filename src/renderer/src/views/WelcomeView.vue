<script setup lang="ts">
import { computed, watch } from 'vue'
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useUiStore } from '../stores/ui'
import { formatRelative, modeLabel, sessionState, stateLabel } from '../utils/format'
import logoUrl from '../assets/ocrlens-logo.png'

/**
 * The landing page.
 *
 * It used to be a logo and two buttons, which left the first screen of a
 * maximised window almost entirely empty. It is now a real dashboard: what the
 * last reviews were, whether the environment is actually healthy, and what to
 * do next — the three questions someone opening this app has.
 */

const env = useEnvStore()
const repos = useRepoStore()
const ui = useUiStore()

/**
 * Recent history is read once, when this page is first shown.
 *
 * This is the only place the client lists sessions for repositories the user
 * has not opened, so it goes through `repos.loadRecent` — which caps the fetch,
 * keeps it out of the rail's cache, and never queues title generation.
 *
 * A watcher rather than `onMounted`: this component mounts during the very
 * first render, while `App.vue` is still awaiting the environment and repo
 * probes, so at mount time there are no repositories to read yet. Watching the
 * list also covers a repository being added from this page.
 */
watch(
  () => repos.repos.length,
  (count) => {
    if (count) void repos.loadRecent()
  },
  { immediate: true }
)

/** Repositories whose directory still resolves on disk. */
const usableRepos = computed(() => repos.repos.filter((repo) => repo.exists))
const missingRepos = computed(() => repos.repos.length - usableRepos.value.length)

/** Path shown under a stat, shortened to its last segment for the card width. */
function leaf(path: string | null | undefined): string {
  if (!path) return ''
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

const ocrNote = computed(() => {
  if (!env.info?.ocrPath) return 'npm i -g @alibaba-group/open-code-review'
  return env.info.ocrPath
})

const gitNote = computed(() => {
  const path = env.info?.gitPath
  return path ? path : '未在 PATH 中找到可用的 git'
})
</script>

<template>
  <div class="view-body home">
    <!-- ---------------- hero ---------------- -->
    <section class="hero">
      <div class="hero-mark">
        <img :src="logoUrl" alt="" width="72" height="72" />
      </div>
      <h1>OcrLens</h1>
      <p class="hero-sub">
        open-code-review CLI 的可视化外壳：选仓库与审查范围、免费预览待审文件，
        再把 finding 按文件与严重度摊开来看。
      </p>

      <div class="hero-actions">
        <button class="btn primary" @click="repos.addRepo()">＋ 添加仓库</button>
        <button class="btn" @click="ui.showView('settings')">环境与渠道设置</button>
        <button class="btn ghost" :disabled="env.loading" @click="env.load(true)">
          {{ env.loading ? '探测中…' : '重新探测环境' }}
        </button>
      </div>

      <div class="hero-pills">
        <span v-if="env.info?.ocrVersion" class="pill">ocr v{{ env.info.ocrVersion }}</span>
        <span class="pill">git {{ env.hasGit ? '已就绪' : '未找到' }}</span>
        <span class="pill" :title="env.info?.sessionsDir ?? ''">
          会话目录 {{ leaf(env.info?.sessionsDir) || '—' }}
        </span>
      </div>
    </section>

    <!-- ---------------- environment ---------------- -->
    <div v-if="env.warnings.length" class="stack" style="margin-bottom: 18px">
      <div v-for="(warning, index) in env.warnings" :key="index" class="banner warn">
        <span>⚠</span>
        <span>{{ warning }}</span>
      </div>
    </div>

    <div v-if="!env.hasOcr" class="banner error">
      <span>✕</span>
      <div>
        <div>未找到 ocr 命令，无法发起审查。</div>
        <div class="mono" style="margin-top: 6px">
          npm install -g @alibaba-group/open-code-review
        </div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat" :class="env.hasOcr ? 'ok' : 'bad'">
        <span class="stat-icon">◎</span>
        <div class="stat-body">
          <div class="stat-label">ocr CLI</div>
          <div class="stat-value">{{ env.info?.ocrVersion ? `v${env.info.ocrVersion}` : '未找到' }}</div>
          <div class="stat-note" :title="ocrNote">{{ leaf(env.info?.ocrPath) || '需要全局安装' }}</div>
        </div>
      </div>

      <div class="stat" :class="env.hasGit ? 'ok' : 'bad'">
        <span class="stat-icon">⑂</span>
        <div class="stat-body">
          <div class="stat-label">git</div>
          <div class="stat-value">{{ env.hasGit ? '已就绪' : '未找到' }}</div>
          <div class="stat-note" :title="gitNote">{{ leaf(env.info?.gitPath) || '未在 PATH 中找到' }}</div>
        </div>
      </div>

      <div class="stat" :class="usableRepos.length ? 'ok' : ''">
        <span class="stat-icon">▤</span>
        <div class="stat-body">
          <div class="stat-label">仓库</div>
          <div class="stat-value">{{ usableRepos.length }} 个</div>
          <div class="stat-note">
            {{ missingRepos ? `${missingRepos} 个目录已不存在` : '目录均可访问' }}
          </div>
        </div>
      </div>

      <div class="stat" :class="env.warnings.length ? 'bad' : 'ok'">
        <span class="stat-icon">{{ env.warnings.length ? '⚠' : '✓' }}</span>
        <div class="stat-body">
          <div class="stat-label">环境检查</div>
          <div class="stat-value">{{ env.warnings.length ? `${env.warnings.length} 条告警` : '无告警' }}</div>
          <div class="stat-note">git 解析与 ocr 定位</div>
        </div>
      </div>
    </div>

    <!-- ---------------- recent + next steps ---------------- -->
    <div class="home-cols">
      <div class="card">
        <div class="card-head">
          最近审查
          <span v-if="repos.recent.length" class="muted" style="font-weight: 400; font-size: 11px">
            共 {{ repos.recent.length }} 条
          </span>
          <button class="btn sm right" @click="ui.showView('settings')">查看历史设置</button>
        </div>

        <div class="card-body">
          <div v-if="repos.recentLoading" class="home-list">
            <div v-for="n in 4" :key="n" class="skeleton" :style="{ width: `${92 - n * 9}%` }" />
          </div>

          <div v-else-if="repos.error" class="muted" style="font-size: 12px">
            无法读取仓库列表：{{ repos.error }}
          </div>

          <div v-else-if="!repos.recent.length" class="muted" style="font-size: 12px">
            <p style="margin: 0 0 6px">还没有审查记录。</p>
            <p style="margin: 0">
              在左栏点一个仓库名即可配置并启动第一次审查；已经在终端里跑过
              <span class="mono">ocr review</span> 的仓库会自动出现在左栏。
            </p>
          </div>

          <div v-else class="home-list">
            <button
              v-for="(entry, index) in repos.recent"
              :key="entry.session.session_id"
              class="home-item"
              :style="{ '--row-i': Math.min(index, 10) }"
              :title="`${repos.sessionLabel(entry.session)}\n${entry.session.session_id}`"
              @click="repos.openSession(entry.repo, entry.session.session_id)"
            >
              <span class="status-dot" :class="sessionState(entry.session)" />
              <span style="min-width: 0; flex: 1">
                <span class="home-item-title" :class="{ untitled: !entry.session.title }">
                  {{ repos.sessionLabel(entry.session) }}
                </span>
                <span class="home-item-meta">
                  {{ entry.repo.name }} · {{ modeLabel(entry.session.review_mode) }} ·
                  {{ formatRelative(entry.session.start_time) }} ·
                  {{ stateLabel(sessionState(entry.session)) }}
                </span>
              </span>
              <span v-if="entry.session.total_comments > 0" class="chip">{{ entry.session.total_comments }} 项</span>
            </button>
          </div>
        </div>
      </div>

      <div class="card" v-if="false">
        <div class="card-head">开始一次审查</div>
        <div class="card-body">
          <ol class="steps">
            <li><span>在左栏点仓库名，进入它的审查配置；点展开箭头可以翻它的历史会话。</span></li>
            <li><span>选审查范围：<strong>工作区</strong>（默认）、分支区间、单提交或全量扫描。</span></li>
            <li>
              <span>
                点<strong>预览</strong>先确认哪些文件会被审、哪些被排除 —— 这一步不调用模型，不消耗额度。
              </span>
            </li>
            <li>
              <span>
                点<strong>启动审查</strong>，完成后自动跳到结果页，在那里按文件、严重度和类别筛。
              </span>
            </li>
          </ol>

          <p class="field-hint" style="margin-top: 14px">
            会话标题由模型自动生成并缓存在本机，也可以就地重命名；重命名过的标题不会被自动覆盖。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
