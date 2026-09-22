<script setup lang="ts">
import type { FileSnippet, ReviewComment } from '@shared/types'
import { computed, ref } from 'vue'
import { useResultsStore } from '../stores/results'
import { useUiStore } from '../stores/ui'
import { copyText } from '../utils/clipboard'
import { categoryClass, categoryLabel, severityClass, severityLabel } from '../utils/format'
import CodeView from './CodeView.vue'
import DiffBlock from './DiffBlock.vue'

const props = defineProps<{
  comment: ReviewComment
}>()

const results = useResultsStore()
const ui = useUiStore()

const key = computed(() => results.findingKey(props.comment))
const ignored = computed(() => results.isIgnored(key.value))
const severity = computed(() => severityClass(props.comment.severity))

/**
 * Splits the finding text on backticks so inline code renders as code.
 * The model writes identifiers in backticks, and plain text loses that emphasis.
 */
const contentParts = computed(() => {
  return props.comment.content.split('`').map((text, index) => ({
    text,
    code: index % 2 === 1
  }))
})

const lineRange = computed(() => {
  const { start_line: start, end_line: end } = props.comment
  if (!start) return ''
  return end && end !== start ? `L${start}–${end}` : `L${start}`
})

/* ---------------- working-tree context, fetched on demand ---------------- */

const snippet = ref<FileSnippet | null>(null)
const snippetLoading = ref(false)
const showContext = ref(false)

async function toggleContext(): Promise<void> {
  if (showContext.value) {
    showContext.value = false
    return
  }

  showContext.value = true
  if (snippet.value) return

  snippetLoading.value = true
  try {
    // `results.repoDir` is the repository this session belongs to — not the one
    // currently selected in the rail, which may have moved on.
    const repoDir = results.repoDir
    if (!repoDir) return
    const result = await window.ocr.readSnippet(
      repoDir,
      props.comment.path,
      props.comment.start_line,
      props.comment.end_line
    )
    if (!result.ok) throw new Error(result.error)
    snippet.value = result.data
  } catch (err) {
    ui.notifyError(err)
  } finally {
    snippetLoading.value = false
  }
}

/* ---------------- actions ---------------- */

async function copySuggestion(): Promise<void> {
  const text = props.comment.suggestion_code
  if (!text) return
  const ok = await copyText(text)
  ui.notify(ok ? '已复制建议代码' : '复制失败', ok ? 'ok' : 'error')
}

async function copyFinding(): Promise<void> {
  const { path, start_line, end_line, category, severity: sev, content, suggestion_code } =
    props.comment

  const parts = [
    `${path}:${start_line}${end_line && end_line !== start_line ? `-${end_line}` : ''}`,
    `[${severityLabel(sev)}] [${categoryLabel(category)}]`,
    '',
    content
  ]
  if (suggestion_code) parts.push('', '```', suggestion_code, '```')

  const ok = await copyText(parts.join('\n'))
  ui.notify(ok ? '已复制这条 finding' : '复制失败', ok ? 'ok' : 'error')
}

async function openInEditor(): Promise<void> {
  const repoDir = results.repoDir
  if (!repoDir) return

  const absolute = `${repoDir}\\${props.comment.path.split('/').join('\\')}`
  try {
    const message = await window.ocr.openInEditor(absolute, props.comment.start_line)
    if (message.ok) ui.notify(message.data, 'ok')
    else ui.notifyError(message.error)
  } catch (err) {
    ui.notifyError(err)
  }
}

async function revealInExplorer(): Promise<void> {
  const repoDir = results.repoDir
  if (!repoDir) return
  const absolute = `${repoDir}\\${props.comment.path.split('/').join('\\')}`
  const result = await window.ocr.openPath(absolute)
  if (result.ok && result.data) ui.notifyError(result.data)
}
</script>

<template>
  <article class="finding" :class="[`sev-${severity}`, { ignored }]">
    <header class="finding-head">
      <span class="chip sev" :class="`sev-${severity}`">{{ severityLabel(comment.severity) }}</span>
      <span class="chip" :class="`cat-${categoryClass(comment.category)}`">
        {{ categoryLabel(comment.category) }}
      </span>
      <span v-if="ignored" class="chip">已忽略</span>
      <span class="finding-lines">{{ lineRange }}</span>
    </header>

    <div class="finding-content">
      <template v-for="(part, index) in contentParts" :key="index">
        <code v-if="part.code">{{ part.text }}</code>
        <template v-else>{{ part.text }}</template>
      </template>
    </div>

    <DiffBlock
      :existing="comment.existing_code"
      :suggestion="comment.suggestion_code"
      :start-line="comment.start_line"
    />

    <div v-if="showContext" class="snippet-note" style="flex-direction: column; align-items: stretch">
      <div class="inline">
        <span v-if="snippetLoading" class="spinner" />
        <span v-if="snippet && snippet.missing">{{ snippet.error ?? '无法读取文件' }}</span>
        <span v-else-if="snippet" class="muted">
          工作区当前内容（审查后可能已改动）
        </span>
      </div>
      <div v-if="snippet && !snippet.missing" style="margin: 0 -12px -6px">
        <CodeView
          :snippet="snippet"
          :highlight-from="comment.start_line"
          :highlight-to="comment.end_line"
        />
      </div>
    </div>

    <div class="finding-actions">
      <button v-if="comment.suggestion_code" class="btn sm" @click="copySuggestion">
        复制建议代码
      </button>
      <button class="btn sm" @click="copyFinding">复制整条</button>
      <button class="btn sm" @click="toggleContext">
        {{ showContext ? '收起上下文' : '查看上下文' }}
      </button>
      <button class="btn sm" @click="openInEditor">在编辑器打开</button>
      <button class="btn sm ghost" @click="revealInExplorer">定位文件</button>
      <button class="btn sm ghost right" @click="results.toggleIgnored(key)">
        {{ ignored ? '取消忽略' : '标记忽略' }}
      </button>
    </div>
  </article>
</template>
