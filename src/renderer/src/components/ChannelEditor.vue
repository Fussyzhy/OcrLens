<script setup lang="ts">
import { isValidConfigKey } from '@shared/config-key'
import type { ProviderInfo, ProviderModelsRequest, ProviderSaveRequest } from '@shared/types'
import { computed, ref } from 'vue'

/**
 * The add / edit form for one channel.
 *
 * One component for both, because they differ in exactly two ways — the name is
 * fixed once the channel exists (it *is* the config key every other field hangs
 * off), and an existing channel already has a key the user should not have to
 * re-type. Everything else, including the model picker, is literally the same
 * job, and keeping two copies of it is how the old page ended up with a model
 * list in one place and a different one in another.
 */

const props = defineProps<{
  /** Existing channel when editing; null when creating one. */
  provider?: ProviderInfo | null
  /** Writes the form's values; returns false so the form stays open on failure. */
  onSubmit: (request: ProviderSaveRequest) => Promise<boolean>
}>()

const emit = defineEmits<{ cancel: [] }>()

const editing = computed(() => Boolean(props.provider))
const custom = computed(() => props.provider?.custom ?? true)

const name = ref(props.provider?.name ?? '')
const protocol = ref(props.provider?.protocol ?? 'openai')
const url = ref(props.provider?.url ?? '')
const apiKey = ref('')

/** The selected catalogue, in the order the user ticked it. */
const selected = ref<string[]>([...(props.provider?.models ?? [])])

/** Extra names typed by hand, for gateways that expose no catalogue. */
const manual = ref('')

const fetching = ref(false)
const fetchError = ref<string | null>(null)
/** Endpoint the last successful (or failed) fetch talked to, for the note. */
const fetchedFrom = ref<string | null>(null)
/** Candidates from the last fetch, plus whatever was already configured. */
const candidates = ref<string[]>([...(props.provider?.models ?? [])])

const PROTOCOLS = ['openai', 'openai-responses', 'anthropic', 'anthropic-bedrock']

/**
 * The protocol picker's options, including whatever this channel is set to.
 *
 * `LlmProtocol` deliberately allows values this list does not know (`ocr` adds
 * protocols over time), and a `<select>` whose value matches no option renders
 * blank — which would show a channel's protocol as unset, inviting the user to
 * overwrite it with something arbitrary.
 */
const protocolOptions = computed(() => {
  const current = protocol.value.trim()
  return current && !PROTOCOLS.includes(current) ? [current, ...PROTOCOLS] : PROTOCOLS
})

/**
 * A custom channel is the user's own endpoint and needs an address; a built-in one
 * may legitimately have none, because the CLI keeps its address in its own
 * catalogue (`bedrock` advertises none at all). Requiring one here left 保存渠道
 * disabled forever, so such a channel could not even have its key corrected.
 */
const needsUrl = computed(() => !editing.value || custom.value)

const canSubmit = computed(() => {
  if (!isValidConfigKey(name.value.trim())) return false
  if (needsUrl.value && !url.value.trim()) return false
  return true
})

/**
 * The catalogue in a stable order, with any selected model it did not mention
 * appended at the end.
 *
 * Every selection has to stay visible and untickable — it goes straight into the
 * config — but ticking one must not move it: when the ticked models were listed
 * first, each click shifted the grid under the pointer, so ticking a run of models
 * landed on the wrong ones.
 */
const candidateRows = computed(() => [
  ...candidates.value,
  ...selected.value.filter((model) => !candidates.value.includes(model))
])

function toggle(model: string): void {
  selected.value = selected.value.includes(model)
    ? selected.value.filter((item) => item !== model)
    : [...selected.value, model]
}

function selectAll(): void {
  selected.value = [...new Set([...selected.value, ...candidates.value])]
}

function clearAll(): void {
  selected.value = []
}

/** Folds the hand-typed names into the selection, keeping the typed order. */
function commitManual(): void {
  const names = manual.value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!names.length) return
  selected.value = [...new Set([...selected.value, ...names])]
  candidates.value = [...new Set([...candidates.value, ...names])]
  manual.value = ''
}

/**
 * Asks the gateway for its catalogue.
 *
 * The form's own values travel with the request, so this works before the
 * channel exists and without re-typing a key that is already stored (which the
 * renderer never receives in the first place).
 */
async function fetchModels(): Promise<void> {
  fetching.value = true
  fetchError.value = null
  try {
    const request: ProviderModelsRequest = {
      name: name.value.trim(),
      custom: custom.value,
      url: url.value.trim(),
      protocol: protocol.value,
      apiKey: apiKey.value.trim()
    }
    const result = await window.ocr.fetchProviderModels(request)
    if (!result.ok) throw new Error(result.error)
    if (!result.data.models.length) throw new Error('网关没有返回任何模型')

    candidates.value = result.data.models
    fetchedFrom.value = result.data.endpoint
  } catch (err) {
    fetchError.value = err instanceof Error ? err.message : String(err)
  } finally {
    fetching.value = false
  }
}

async function submit(): Promise<void> {
  commitManual()
  if (!canSubmit.value) return

  await props.onSubmit({
    name: name.value.trim(),
    custom: custom.value,
    url: url.value.trim(),
    protocol: protocol.value,
    apiKey: apiKey.value.trim() || undefined,
    // Copied, not passed as-is: a `ref`'s value is a reactive proxy, and the
    // structured clone behind IPC refuses proxies with "An object could not be
    // cloned." — an array nested one level down is refused just the same, which is
    // why every field that leaves this component has to be plain data.
    models: [...selected.value]
  })
}
</script>

<template>
  <form class="channel-edit" @submit.prevent="submit()">
    <div class="row">
      <div class="field">
        <label class="field-label">渠道名</label>
        <input
          v-if="!editing"
          v-model="name"
          type="text"
          placeholder="my-gateway"
          spellcheck="false"
        />
        <div v-else class="inline">
          <span class="mono">{{ provider?.name }}</span>
          <span class="chip">{{ custom ? '自定义' : '内置' }}</span>
          <span class="muted">渠道名是配置键，建好后不能改</span>
        </div>
      </div>

      <div class="field">
        <label class="field-label">协议</label>
        <select v-model="protocol">
          <option v-for="item in protocolOptions" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
    </div>

    <div class="field">
      <label class="field-label">API 地址</label>
      <input
        v-model="url"
        type="text"
        placeholder="https://gateway.internal.com/v1"
        spellcheck="false"
      />
      <div v-if="editing && !custom" class="field-hint">
        内置渠道的地址由 ocr 自己维护，留空即沿用；填写会覆盖它。
      </div>
    </div>

    <div class="field">
      <label class="field-label">API Key{{ editing ? '（留空则不修改）' : '（可留空，稍后再填）' }}</label>
      <input v-model="apiKey" type="password" placeholder="粘贴密钥" spellcheck="false" />
      <div v-if="editing && provider?.apiKeyMask" class="field-hint">
        当前密钥：{{ provider.apiKeyMask }}
      </div>
    </div>

    <div class="field">
      <div class="models-head">
        <label class="field-label" style="margin: 0">模型目录</label>
        <button type="button" class="btn sm" :disabled="fetching" @click="fetchModels()">
          <span v-if="fetching" class="spinner" />
          {{ fetching ? '获取中…' : '一键获取模型列表' }}
        </button>
        <span v-if="candidateRows.length" class="muted models-picked">
          已选 {{ selected.length }} 个
        </span>
        <template v-if="candidates.length">
          <button type="button" class="link-btn" @click="selectAll()">全选</button>
          <button type="button" class="link-btn" @click="clearAll()">清空</button>
        </template>
      </div>

      <!-- A failed fetch has to be visible even when a catalogue is already on
           screen (editing an existing channel is exactly that case): otherwise the
           button just returns to its normal label and nothing was said. -->
      <div v-if="fetchError" class="models-note models-note-error" style="margin-top: 8px">
        {{ fetchError }}
      </div>

      <!-- Two different empty states: nothing asked yet, versus a gateway that
           answered with nothing (which is when hand-typing is the way out). -->
      <div v-else-if="!candidates.length" class="models-note" style="margin-top: 8px">
        <template v-if="fetchedFrom">网关没有返回模型列表，请在下面手动填写。</template>
        <template v-else>
          点「一键获取模型列表」从网关读取可选模型，也可以直接手动填写。
        </template>
      </div>

      <div v-if="candidates.length" class="models-grid" style="margin-top: 8px">
        <label v-for="model in candidateRows" :key="model" class="model-option">
          <input
            type="checkbox"
            :checked="selected.includes(model)"
            @change="toggle(model)"
          />
          <span :title="model">{{ model }}</span>
        </label>
      </div>

      <div class="inline" style="margin-top: 8px">
        <input
          v-model="manual"
          type="text"
          placeholder="手动补充模型名，逗号分隔"
          spellcheck="false"
          @keydown.enter.prevent="commitManual()"
        />
        <button type="button" class="btn sm" @click="commitManual()">添加</button>
      </div>

      <div v-if="selected.length" class="field-hint">
        将写入：{{ selected.join('、') }}
      </div>
    </div>

    <div class="inline">
      <button class="btn primary" type="submit" :disabled="!canSubmit">
        {{ editing ? '保存渠道' : '创建渠道' }}
      </button>
      <button class="btn" type="button" @click="emit('cancel')">取消</button>
      <span v-if="!canSubmit" class="muted">
        {{
          needsUrl
            ? '需要渠道名与 API 地址（名称限字母、数字、下划线、点和连字符）'
            : '名称限字母、数字、下划线、点和连字符'
        }}
      </span>
    </div>
  </form>
</template>
