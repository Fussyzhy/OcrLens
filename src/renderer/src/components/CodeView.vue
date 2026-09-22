<script setup lang="ts">
import type { FileSnippet } from '@shared/types'
import { computed } from 'vue'

/**
 * Numbered source lines with an optional highlighted range.
 *
 * Used for the working-tree context around a finding. The caller is responsible
 * for labelling this as current file content — it is not necessarily the revision
 * that was reviewed.
 */
const props = defineProps<{
  snippet: FileSnippet
  /** Inclusive line range to highlight. */
  highlightFrom?: number
  highlightTo?: number
}>()

interface RenderedLine {
  number: number
  text: string
  highlighted: boolean
}

const lines = computed<RenderedLine[]>(() => {
  const from = props.highlightFrom ?? -1
  const to = props.highlightTo ?? from

  return props.snippet.lines.map((text, index) => {
    const number = props.snippet.startLine + index
    return {
      number,
      text,
      highlighted: number >= from && number <= to
    }
  })
})
</script>

<template>
  <div class="diff single">
    <div class="diff-col">
      <pre class="code"><span
        v-for="line in lines"
        :key="line.number"
        class="code-line"
        :class="line.highlighted ? 'added' : 'context'"
      ><span class="line-no">{{ line.number }}</span><span class="line-text">{{ line.text }}</span></span></pre>
    </div>
  </div>
</template>
