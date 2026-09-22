<script setup lang="ts">
import { computed } from 'vue'

/**
 * Side-by-side view of the offending code and the suggested replacement.
 *
 * Line numbers are both anchored at `startLine`, because a suggestion replaces the
 * recorded range rather than continuing after it — numbering the suggestion from
 * the same base is what makes the two columns line up visually.
 */
const props = defineProps<{
  existing?: string
  suggestion?: string
  startLine?: number
}>()

function splitLines(text: string | undefined): string[] {
  if (!text) return []
  // Drop a single trailing newline so we do not render a phantom last line.
  return text.replace(/\r?\n$/, '').split(/\r?\n/)
}

const existingLines = computed(() => splitLines(props.existing))
const suggestionLines = computed(() => splitLines(props.suggestion))
const base = computed(() => props.startLine ?? 1)

/** Both sides present? Only then do the colours mean "before / after". */
const twoColumn = computed(
  () => existingLines.value.length > 0 && suggestionLines.value.length > 0
)
</script>

<template>
  <div
    v-if="existingLines.length || suggestionLines.length"
    class="diff"
    :class="{ single: !twoColumn }"
  >
    <div v-if="existingLines.length" class="diff-col remove">
      <div class="diff-col-head">{{ twoColumn ? '现有代码' : '代码片段' }}</div>
      <pre class="code"><span
        v-for="(line, index) in existingLines"
        :key="index"
        class="code-line"
        :class="twoColumn ? 'removed' : 'context'"
      ><span class="line-no">{{ base + index }}</span><span class="line-text">{{ line }}</span></span></pre>
    </div>

    <div v-if="suggestionLines.length" class="diff-col add">
      <div class="diff-col-head">建议改为</div>
      <pre class="code"><span
        v-for="(line, index) in suggestionLines"
        :key="index"
        class="code-line added"
      ><span class="line-no">{{ base + index }}</span><span class="line-text">{{ line }}</span></span></pre>
    </div>
  </div>
</template>
