<script setup lang="ts">
import { computed, useId } from 'vue'
import { useAnchoredMenu } from '../composables/useAnchoredMenu'
import { optionLabel, type SelectOption } from '../utils/select'

/**
 * The app's dropdown, in place of a native `<select>`.
 *
 * A native select's popup is drawn by the OS: on Windows it arrives in its own
 * light grey, ignoring every token this app is built from, and it is the one
 * control on a page that cannot be styled. This is the same control as the model
 * picker (see ModelPicker.vue) — same list, same keyboard, same placement — with
 * the text box replaced by a fixed label.
 *
 * Values keep working the way a select's do: the empty string is an ordinary,
 * selectable value, and a value the list does not mention is still shown rather
 * than rendered blank (`ocr` accepts protocols and models this client has never
 * heard of).
 */
const props = defineProps<{
  modelValue: string
  options: SelectOption[]
  /** The accessible name; the field label's own text. */
  label?: string
  disabled?: boolean
  /** Raise the list's width above the control's, for long labels. */
  menuMinWidth?: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const id = useId()
const menuId = `${id}-list`

const selected = computed(() =>
  props.options.findIndex((option) => option.value === props.modelValue)
)

const shown = computed(() => optionLabel(props.options, props.modelValue))

const { open, highlighted, menuStyle, bindRoot, bindAnchor, bindMenu, toggle, choose, onKeydown } =
  useAnchoredMenu({
    count: () => props.options.length,
    selected: () => selected.value,
    onPick: (index) => {
      const option = props.options[index]
      if (option) emit('update:modelValue', option.value)
    },
    minWidth: () => props.menuMinWidth ?? 0
  })

function optionId(index: number): string {
  return `${id}-option-${index}`
}
</script>

<template>
  <div :ref="bindRoot" class="picker">
    <button
      :ref="bindAnchor"
      type="button"
      class="picker-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? menuId : undefined"
      :aria-activedescendant="open && highlighted >= 0 ? optionId(highlighted) : undefined"
      :aria-label="label"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="picker-value" :class="{ empty: modelValue === '' }">{{ shown }}</span>
      <span class="picker-chevron" aria-hidden="true" />
    </button>

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
        <button
          v-for="(option, index) in options"
          :id="optionId(index)"
          :key="option.value === '' ? `empty-${index}` : option.value"
          type="button"
          class="picker-item"
          :class="{ current: option.value === modelValue, active: index === highlighted }"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="choose(index)"
          @pointermove="highlighted = index"
        >
          <span class="picker-label" :title="option.label">{{ option.label }}</span>
          <span v-if="option.value === modelValue" class="picker-tick" aria-hidden="true">✓</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
