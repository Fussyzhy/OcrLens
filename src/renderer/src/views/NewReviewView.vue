<script setup lang="ts">
import type { GitRef, ReviewMode } from '@shared/types'
import { computed, onMounted, watch } from 'vue'
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useRunStore } from '../stores/run'
import { excludeReasonLabel, formatDateFromMs, formatDurationMs } from '../utils/format'

const env = useEnvStore()
const repos = useRepoStore()
const run = useRunStore()

const repo = computed(() => repos.activeRepo)

/** Branch option label. Shows the tip date so the recency ordering is visible. */
function branchLabel(branch: GitRef): string {
  const suffix = branch.current ? '（当前）' : formatDateFromMs(branch.committedAt)
  return suffix ? `${branch.name} — ${suffix}` : branch.name
}

const MODES: { value: ReviewMode; title: string; desc: string }[] = [
  { value: 'workspace', title: '工作区', desc: '暂存 + 未暂存 + 未跟踪的改动' },
  { value: 'range', title: '分支区间', desc: '对比两个分支（merge-base）' },
  { value: 'commit', title: '单提交', desc: '某个提交相对其父提交' },
  { value: 'scan', title: '全量扫描', desc: '整份文件，不需要 diff' }
]

/** Repos that failed to resolve cannot be reviewed. */
const repoUsable = computed(() => Boolean(run.repoDir))

function selectMode(mode: ReviewMode): void {
  run.mode = mode
  run.markStale()
}

/** Changing any option invalidates a previously previewed file list. */
watch(
  () => [
    run.mode,
    run.from,
    run.to,
    run.commit,
    run.scanPath,
    run.exclude,
    run.effort,
    run.concurrency,
    run.timeoutMinutes,
    run.maxTokensBudget,
    run.noFilter,
    run.noPlan,
    run.noDedup,
    run.noSummary,
    run.batch
  ],
  () => run.markStale()
)

watch(
  () => repos.activeRepoDir,
  (dir) => run.resetFor(dir)
)

onMounted(() => {
  if (repos.activeRepoDir) run.resetFor(repos.activeRepoDir)
})

async function start(): Promise<void> {
  await run.start()
}
</script>

<template>
  <div class="view-head">
    <div style="min-width: 0">
      <h1>{{ repo?.name ?? '新建审查' }}</h1>
      <div class="sub mono">{{ run.repoDir || '未选择仓库' }}</div>
    </div>
    <button
      v-if="!repo?.exists && repo"
      class="btn sm right"
      title="该目录在磁盘上不存在"
    >
      目录不存在
    </button>
  </div>

  <div class="view-body">
    <div v-if="!repoUsable" class="empty">
      <h2>请先在左栏选择一个仓库</h2>
      <p>点仓库名即可进入它的审查配置。</p>
    </div>

    <template v-else>
      <div v-for="(warning, index) in env.warnings" :key="index" class="banner warn">
        <span>⚠</span>
        <span>{{ warning }}</span>
      </div>

      <div v-if="!env.hasOcr" class="banner error">
        <span>✕</span>
        <span>
          未找到 ocr 命令，无法发起审查。请先执行
          <span class="mono">npm install -g @alibaba-group/open-code-review</span>
        </span>
      </div>

      <!-- 1. Mode -->
      <div class="card">
        <div class="card-head">审查范围</div>
        <div class="card-body">
          <div class="modes">
            <label
              v-for="option in MODES"
              :key="option.value"
              class="mode"
              :class="{ selected: run.mode === option.value }"
            >
              <input
                type="radio"
                name="review-mode"
                :value="option.value"
                :checked="run.mode === option.value"
                @change="selectMode(option.value)"
              />
              <div class="mode-title">{{ option.title }}</div>
              <div class="mode-desc">{{ option.desc }}</div>
            </label>
          </div>

          <!-- Mode-specific inputs -->
          <div v-if="run.mode === 'range'" class="row" style="margin-top: 16px">
            <div class="field" style="margin-bottom: 0">
              <label class="field-label">基准分支 (--from)</label>
              <select v-model="run.from">
                <option value="">请选择…</option>
                <option v-for="branch in run.branches" :key="branch.name" :value="branch.name">
                  {{ branchLabel(branch) }}
                </option>
              </select>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label class="field-label">目标分支 (--to)</label>
              <select v-model="run.to">
                <option value="">请选择…</option>
                <option v-for="branch in run.branches" :key="branch.name" :value="branch.name">
                  {{ branchLabel(branch) }}
                </option>
              </select>
            </div>
          </div>

          <div v-else-if="run.mode === 'commit'" class="field" style="margin-top: 16px; margin-bottom: 0">
            <label class="field-label">提交 (--commit)</label>
            <select v-model="run.commit">
              <option value="">请选择…</option>
              <option v-for="item in run.commits" :key="item.hash" :value="item.hash">
                {{ item.short }} · {{ item.subject }} — {{ item.meta }}
              </option>
            </select>
            <div class="field-hint">只显示最近 60 个提交；需要更早的提交请直接粘贴完整 hash。</div>
          </div>

          <div v-else-if="run.mode === 'scan'" class="field" style="margin-top: 16px; margin-bottom: 0">
            <label class="field-label">扫描路径 (--path，可留空表示整库)</label>
            <input
              v-model="run.scanPath"
              type="text"
              placeholder="例如 src/main,src/renderer"
              spellcheck="false"
            />
            <div class="field-hint">多个路径用逗号分隔。</div>
          </div>

          <div v-if="run.refsLoading" class="field-hint" style="margin-top: 10px">
            <span class="spinner" /> 正在读取 git 分支与提交…
          </div>
          <div v-else-if="run.refsError" class="field-hint" style="margin-top: 10px; color: #ff9b96">
            {{ run.refsError }}
          </div>
        </div>
      </div>

      <!-- 2. Context + advanced -->
      <div class="card">
        <div class="card-head">参数</div>
        <div class="card-body">
          <div class="field">
            <label class="field-label">需求背景（可选，会作为审查上下文）</label>
            <textarea
              v-model="run.background"
              placeholder="例如：给登录接口加限流；这次改动引入了 UV 密度归一开关…"
            />
          </div>

          <details class="advanced">
            <summary>高级选项</summary>

            <div class="row">
              <div class="field">
                <label class="field-label">审查力度 (--effort)</label>
                <select v-model="run.effort">
                  <option value="">使用配置默认</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>

              <div class="field">
                <label class="field-label">并发 (--concurrency)</label>
                <input v-model.number="run.concurrency" type="text" placeholder="默认 8" />
              </div>

              <div class="field">
                <label class="field-label">单任务超时分钟 (--timeout)</label>
                <input v-model.number="run.timeoutMinutes" type="text" placeholder="默认 15" />
              </div>
            </div>

            <div class="row">
              <div class="field">
                <label class="field-label">Token 上限 (--max-tokens-budget)</label>
                <input v-model.number="run.maxTokensBudget" type="text" placeholder="0 = 不限制" />
              </div>

              <div class="field">
                <label class="field-label">排除规则 (--exclude)</label>
                <input
                  v-model="run.exclude"
                  type="text"
                  placeholder="**/generated/*,**/testdata/*"
                  spellcheck="false"
                />
              </div>
            </div>

            <div class="row">
              <div class="field">
                <label class="field-label">本次使用的 provider（可选）</label>
                <input v-model="run.provider" type="text" placeholder="留空 = 用配置里的" spellcheck="false" />
              </div>
              <div class="field">
                <label class="field-label">本次使用的 model（可选）</label>
                <input v-model="run.model" type="text" placeholder="留空 = 用配置里的" spellcheck="false" />
              </div>
            </div>

            <div class="switches">
              <label v-if="!run.isScan" class="checkbox">
                <input v-model="run.noFilter" type="checkbox" />
                关闭结果后过滤 (--no-filter)
              </label>

              <template v-else>
                <label class="checkbox">
                  <input v-model="run.noPlan" type="checkbox" />
                  跳过 PLAN 预处理 (--no-plan)
                </label>
                <label class="checkbox">
                  <input v-model="run.noDedup" type="checkbox" />
                  跳过去重 (--no-dedup)
                </label>
                <label class="checkbox">
                  <input v-model="run.noSummary" type="checkbox" />
                  跳过项目总结 (--no-summary)
                </label>
                <label class="checkbox">
                  <span>分批策略</span>
                  <select v-model="run.batch" style="width: auto">
                    <option value="">默认</option>
                    <option value="none">none</option>
                    <option value="by-language">by-language</option>
                    <option value="by-directory">by-directory</option>
                  </select>
                </label>
              </template>
            </div>
          </details>
        </div>
      </div>

      <!-- 3. Preview -->
      <div class="card">
        <div class="card-head">
          待审文件预览
          <span class="muted" style="font-weight: 400; font-size: 11px">不消耗额度</span>
          <button class="btn sm right" :disabled="run.previewing || run.running" @click="run.doPreview()">
            <span v-if="run.previewing" class="spinner" />
            {{ run.previewing ? '预览中…' : '预览' }}
          </button>
        </div>

        <div v-if="run.previewError" class="card-body">
          <div class="banner error" style="margin-bottom: 0">
            <span>✕</span>
            <span>{{ run.previewError }}</span>
          </div>
        </div>

        <div v-else-if="!run.preview" class="card-body">
          <p class="muted" style="margin: 0">
            点「预览」先看看哪些文件会被审查、哪些被排除。这一步不调用模型。
          </p>
        </div>

        <template v-else>
          <div class="card-body" style="padding-bottom: 10px">
            <div class="inline">
              <span class="pill">共 {{ run.preview.total_files }} 个文件</span>
              <span class="pill">待审 {{ run.preview.reviewable_count }}</span>
              <span class="pill">排除 {{ run.preview.excluded_count }}</span>
              <span class="pill add">+{{ run.preview.total_insertions }}</span>
              <span class="pill del">−{{ run.preview.total_deletions }}</span>
              <span v-if="run.previewStale" class="pill" style="color: #ffc078">
                选项已改动，建议重新预览
              </span>
            </div>
          </div>

          <div class="preview-scroll">
            <table class="preview-table">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>状态</th>
                  <th class="num">+</th>
                  <th class="num">−</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="file in run.preview.files"
                  :key="file.path"
                  :class="{ excluded: !file.will_review }"
                >
                  <td>{{ file.path }}</td>
                  <td>{{ file.status }}</td>
                  <td class="num add">{{ file.insertions || '' }}</td>
                  <td class="num del">{{ file.deletions || '' }}</td>
                  <td>{{ file.will_review ? '' : excludeReasonLabel(file.exclude_reason) }}</td>
                </tr>
                <tr v-if="!run.preview.files.length">
                  <td colspan="5" class="muted">没有检测到需要审查的改动。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- 4. Start / progress -->
      <div class="card">
        <div class="card-head">
          运行
          <!-- Kept visible after the run ends: the toast is transient, so the panel
               itself has to say how the last run finished. -->
          <span v-if="run.statusText" class="right inline muted">
            <span v-if="run.running" class="spinner" />
            <span>
              {{ run.statusText }}
              <template v-if="run.running"> · {{ formatDurationMs(run.elapsedMs) }}</template>
            </span>
          </span>
        </div>

        <div class="card-body">
          <div class="field">
            <label class="field-label">将要执行的命令</label>
            <div class="mono muted" style="overflow-wrap: anywhere">{{ run.commandPreview }}</div>
          </div>

          <div class="inline">
            <button class="btn primary" :disabled="!run.canStart" @click="start">
              {{ run.running ? '审查进行中…' : '启动审查' }}
            </button>
            <button v-if="run.running" class="btn danger" @click="run.cancel()">取消</button>
            <span v-if="run.isScan" class="muted">全量扫描可能运行较久，且消耗较多额度。</span>
          </div>
        </div>

        <div v-if="run.logs.length || run.running" class="log">
          <div v-if="!run.logs.length" class="log-empty">等待输出…</div>
          <div v-for="(line, index) in run.logs" :key="index" class="log-line">{{ line }}</div>
        </div>
      </div>
    </template>
  </div>
</template>
