<script setup lang="ts">
import { computed, useId } from 'vue'
import { useAnchoredMenu } from '../composables/useAnchoredMenu'

/**
 * The 当前模型 field of the settings page: a text box with the active channel's
 * catalogue beneath it.
 *
 * This replaces an `<input list>` + `<datalist>`. A datalist filters its own
 * entries by what is already in the field, so a channel with eight models offered
 * exactly the one that was already selected — the list looked out of step with the
 * catalogue its editor ticks. It was also the only control on the page drawn by
 * the OS rather than by the theme, which is what made it look foreign.
 *
 * Typing stays possible: a gateway that documents its models nowhere is exactly
 * why the channel editor has a 手动补充 box, and a model that is not in the
 * catalogue has to remain usable. The list itself is not filtered by what is typed
 * — so it is not advertised as autocomplete — and Enter therefore only ever picks
 * a row the user moved to, never one left highlighted from before (see `onInput`).
 */
const props = defineProps<{
  modelValue: string
  /** The active channel's catalogue, as its editor has it. */
  models: string[]
  /** The accessible name; the field label's own text. */
  label?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const id = useId()
const menuId = `${id}-list`

/** How tall the list may grow before it scrolls. */
const menuMinWidth = 240

/** The active channel's catalogue, as the channel editor has it. */
const catalogue = computed<string[]>(() => props.models.map((name) => name.trim()).filter(Boolean))

/**
 * What the list shows: the catalogue, with the model in use in front when the
 * catalogue does not mention it. A name typed by hand has to stay visible and stay
 * marked as the current one instead of silently missing from the list.
 */
const rows = computed<string[]>(() => {
  const current = props.modelValue.trim()
  return current && !catalogue.value.includes(current)
    ? [current, ...catalogue.value]
    : catalogue.value
})

const selected = computed(() => rows.value.indexOf(props.modelValue.trim()))

const { open, highlighted, menuStyle, bindRoot, bindAnchor, bindMenu, toggle, choose, setHighlight, onKeydown } =
  useAnchoredMenu({
    count: () => rows.value.length,
    selected: () => selected.value,
    onPick: (index) => {
      const name = rows.value[index]
      if (name !== undefined) emit('update:modelValue', name)
    },
    minWidth: () => menuMinWidth
  })

/**
 * Keeps the highlight where the text now is.
 *
 * Without this the highlight stayed on whatever was selected when the list opened,
 * so typing a name that is not in the catalogue and pressing Enter replaced what
 * had just been typed with an unrelated model.
 *
 * The row is worked out from the text in the event rather than from `rows`:
 * `props.modelValue` only arrives once the parent has re-rendered, which is the
 * tick *after* this handler, so `rows` here is still the list from before the
 * keystroke. A name the catalogue does not know becomes the front row, which is
 * exactly where `rows` is about to put it.
 */
function onInput(event: Event): void {
  const typed = (event.target as HTMLInputElement).value
  emit('update:modelValue', typed)
  const index = catalogue.value.indexOf(typed.trim())
  setHighlight(index >= 0 ? index : 0)
}

function optionId(index: number): string {
  return `${id}-option-${index}`
}
</script>

<template>
  <div :ref="bindRoot" class="picker">
    <div class="picker-field">
      <input
        :ref="bindAnchor"
        :value="modelValue"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="模型名"
        role="combobox"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="open ? menuId : undefined"
        :aria-activedescendant="open && highlighted >= 0 ? optionId(highlighted) : undefined"
        :aria-label="label"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="picker-toggle"
        aria-haspopup="listbox"
        aria-label="展开模型列表"
        :title="models.length ? `从 ${models.length} 个可选模型中选择` : '这个渠道还没有模型目录'"
        @click="toggle"
      >
        <span class="picker-chevron" aria-hidden="true" />
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="open"
        :ref="bindMenu"
        :id="menuId"
        class="picker-menu"
        role="listbox"
        :aria-label="label"
        :style="menuStyle"
      >
        <p v-if="!rows.length" class="picker-empty" role="presentation">
          这个渠道还没有模型目录。可以直接输入模型名，或者在下面的渠道里用「编辑」拉取。
        </p>
        <button
          v-for="(name, index) in rows"
          :id="optionId(index)"
          :key="name"
          type="button"
          class="picker-item"
          :class="{ current: index === selected, active: index === highlighted }"
          role="option"
          :aria-selected="index === selected"
          @click="choose(index)"
          @pointermove="highlighted = index"
        >
          <span class="picker-label" :title="name">{{ name }}</span>
          <span v-if="index === selected" class="picker-tick" aria-hidden="true">✓</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
