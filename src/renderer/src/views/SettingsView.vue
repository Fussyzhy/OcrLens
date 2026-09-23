<script setup lang="ts">
import type { ConfigBackup, OcrConfigView, ProviderInfo, ProviderSaveRequest } from '@shared/types'
import { computed, onMounted, ref } from 'vue'
import ChannelEditor from '../components/ChannelEditor.vue'
import ModelPicker from '../components/ModelPicker.vue'
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useUiStore } from '../stores/ui'
import { formatRelative } from '../utils/format'

const env = useEnvStore()
const repos = useRepoStore()
const ui = useUiStore()

const config = ref<OcrConfigView | null>(null)
const configLoading = ref(false)
const configError = ref<string | null>(null)
const backups = ref<ConfigBackup[]>([])

const testing = ref(false)
const testOutput = ref<string | null>(null)
const testOk = ref(false)

const busy = ref(false)

/* ---------------- git override ---------------- */

const gitOverrideDraft = ref('')

const activeProvider = computed(() => config.value?.providers.find((p) => p.active) ?? null)

/**
 * The models the picker offers: the active channel's catalogue, exactly the list
 * its editor ticks. Reading it from anywhere else is how the picker ended up
 * showing a different set than the channel it belongs to.
 */
const modelCatalogue = computed(() => activeProvider.value?.models ?? [])

/** Says where the list above came from, and what to do when there is none. */
const catalogueHint = computed(() => {
  const provider = activeProvider.value
  if (!provider) return '先在下面选择一个渠道'
  const count = modelCatalogue.value.length
  if (!count) return `渠道 ${provider.name} 还没有模型目录，可直接输入模型名`
  return `可选 ${count} 个模型，来自渠道 ${provider.name}`
})

/**
 * The channels worth a permanent row: everything the user created, plus any
 * built-in ocr already has a key for or is currently using.
 *
 * Custom and built-in channels are deliberately merged into one list. They said
 * the same thing about the places they are used — `provider` in config.json is
 * one key, and it does not care which table the name came from — so splitting
 * them into two tables with different columns only made the reader join them
 * back up by name.
 */
const configuredProviders = computed(() =>
  (config.value?.providers ?? []).filter((p) => p.custom || p.hasApiKey || p.active)
)

/**
 * Built-ins the CLI catalogue advertises that this client has not touched.
 *
 * There can be a hundred of them, so they stay behind a toggle rather than
 * padding the list with rows that all read "未设置密钥".
 */
const unconfiguredBuiltins = computed(() =>
  (config.value?.providers ?? []).filter((p) => !p.custom && !p.hasApiKey && !p.active)
)

const showBuiltins = ref(false)

const channelRows = computed(() =>
  showBuiltins.value
    ? [...configuredProviders.value, ...unconfiguredBuiltins.value]
    : configuredProviders.value
)

/** True for a row that is neither in use nor has a key: shown, but plainly idle. */
function isIdle(provider: ProviderInfo): boolean {
  return !provider.active && !provider.hasApiKey
}

async function loadConfig(): Promise<void> {
  configLoading.value = true
  configError.value = null
  try {
    const result = await window.ocr.readConfig()
    if (!result.ok) throw new Error(result.error)
    config.value = result.data
  } catch (err) {
    configError.value = err instanceof Error ? err.message : String(err)
  } finally {
    configLoading.value = false
  }
}

async function loadBackups(): Promise<void> {
  const result = await window.ocr.listBackups()
  backups.value = result.ok ? result.data : []
}

onMounted(async () => {
  gitOverrideDraft.value = env.settings?.gitOverride ?? ''
  await Promise.all([loadConfig(), loadBackups()])
})

/* ---------------- mutations ---------------- */

/**
 * Applies one config change and refreshes the view.
 *
 * Every write is preceded by a snapshot in the main process, so a bad key name
 * cannot leave the user without a working configuration.
 */
async function applySet(key: string, value: string, successMessage: string): Promise<boolean> {
  busy.value = true
  try {
    const result = await window.ocr.setConfig(key, value)
    if (!result.ok || !result.data.ok) {
      throw new Error(result.ok ? result.data.error ?? '设置失败' : result.error)
    }
    ui.notify(successMessage, 'ok')
    await Promise.all([loadConfig(), loadBackups()])
    return true
  } catch (err) {
    ui.notifyError(err)
    return false
  } finally {
    busy.value = false
  }
}

/**
 * Switching the route is also the recovery path for automatic titling.
 *
 * The history store keeps a failure breaker for the rest of the app session, so
 * a wrong key or a model that cannot answer would otherwise stay broken until
 * the app restarts — and the title settings that used to clear it are gone. Any
 * change that could plausibly fix the request clears it here.
 */
async function activateProvider(provider: ProviderInfo): Promise<void> {
  if (await applySet('provider', provider.name, `已切换到渠道 ${provider.name}`)) {
    repos.retryTitles()
  }
}

async function applyModel(): Promise<void> {
  if (!config.value?.model) return
  if (await applySet('model', config.value.model, `已设置模型 ${config.value.model}`)) {
    repos.retryTitles()
  }
}

/** Channel whose editor is open inside its own row, if any. */
const editTarget = ref<ProviderInfo | null>(null)

/** Clicking 编辑 on the open row closes it again, like any other disclosure. */
function beginEdit(provider: ProviderInfo): void {
  editTarget.value = editTarget.value?.name === provider.name ? null : provider
}

/**
 * Opens a channel's editor without the toggle behaviour.
 *
 * For links that *promise* to take the user somewhere ("去渠道里添加"), a second
 * click must not undo the first: with `beginEdit`, clicking such a link while that
 * channel's editor happened to be open closed it instead, which is the opposite of
 * what the sentence says.
 */
function openEdit(provider: ProviderInfo): void {
  editTarget.value = provider
}

/* The create form lives in a `<details>`. Cancelling clears it by remounting the
 * editor (see `createKey`) so a typed-and-abandoned API key does not stay in the
 * DOM behind the fold. */
const createDetails = ref<HTMLDetailsElement | null>(null)
const createKey = ref(0)

function closeCreate(): void {
  createKey.value += 1
  createDetails.value?.removeAttribute('open')
}

/**
 * Writes a whole channel — new or existing — and refreshes what the page shows.
 *
 * One batched write rather than one per field: the main process takes a single
 * config backup for the lot, and a failure part-way through comes back saying
 * which keys landed instead of leaving the form to guess. The editor stays open
 * on failure, which is why this reports success rather than throwing.
 */
async function saveProvider(request: ProviderSaveRequest): Promise<boolean> {
  busy.value = true
  try {
    const result = await window.ocr.saveProvider(request)
    if (!result.ok) throw new Error(result.error)
    if (!result.data.ok) {
      const written = result.data.keys.length ? `（已写入 ${result.data.keys.join('、')}）` : ''
      throw new Error(`${result.data.error ?? '保存失败'}${written}`)
    }

    ui.notify(`渠道 ${request.name} 已保存`, 'ok')
    await Promise.all([loadConfig(), loadBackups()])

    // Close the editor that submitted, not whichever one happens to be open: a
    // channel's editor can be open while the create form is submitted, and closing
    // that one instead would leave the create form (API key included) sitting in the
    // DOM as if it had never been sent.
    if (editTarget.value?.name === request.name) editTarget.value = null
    else closeCreate()

    // A changed url, protocol, model list or key is the likeliest fix for
    // automatic naming having given up earlier in this app session.
    repos.retryTitles()
    return true
  } catch (err) {
    ui.notifyError(err)
    return false
  } finally {
    busy.value = false
  }
}

async function removeProvider(provider: ProviderInfo): Promise<void> {
  busy.value = true
  try {
    const result = await window.ocr.unsetConfig(`custom_providers.${provider.name}`)
    if (!result.ok || !result.data.ok) {
      throw new Error(result.ok ? result.data.error ?? '删除失败' : result.error)
    }
    ui.notify(`已删除渠道 ${provider.name}`, 'ok')
    await Promise.all([loadConfig(), loadBackups()])
  } catch (err) {
    ui.notifyError(err)
  } finally {
    busy.value = false
  }
}

async function runTest(): Promise<void> {
  testing.value = true
  testOutput.value = null
  try {
    const result = await window.ocr.testConfig()
    if (!result.ok) throw new Error(result.error)
    testOk.value = result.data.ok
    testOutput.value = result.data.output
  } catch (err) {
    testOk.value = false
    testOutput.value = err instanceof Error ? err.message : String(err)
  } finally {
    testing.value = false
  }
}

async function saveGitOverride(): Promise<void> {
  try {
    await env.setOverride({ gitOverride: gitOverrideDraft.value.trim() || null })
    ui.notify('已更新 git 路径并重新探测', 'ok')
  } catch (err) {
    ui.notifyError(err)
  }
}

async function clearGitOverride(): Promise<void> {
  gitOverrideDraft.value = ''
  await saveGitOverride()
}

async function restore(backup: ConfigBackup): Promise<void> {
  busy.value = true
  try {
    const result = await window.ocr.restoreBackup(backup.path)
    if (!result.ok || !result.data.ok) {
      throw new Error(result.ok ? result.data.error ?? '恢复失败' : result.error)
    }
    ui.notify('已恢复该备份', 'ok')
    await Promise.all([loadConfig(), loadBackups()])
  } catch (err) {
    ui.notifyError(err)
  } finally {
    busy.value = false
  }
}

async function openConfigFile(): Promise<void> {
  if (!config.value) return
  const result = await window.ocr.openPath(config.value.configPath)
  if (result.ok && result.data) ui.notifyError(result.data)
}

async function openSessionsDir(): Promise<void> {
  if (!env.info) return
  const result = await window.ocr.openPath(env.info.sessionsDir)
  if (result.ok && result.data) ui.notifyError(result.data)
}

async function reprobe(): Promise<void> {
  await env.load(true)
  gitOverrideDraft.value = env.settings?.gitOverride ?? ''
  ui.notify('环境已重新探测', 'ok')
}
</script>

<template>
  <div class="view-head">
    <h1>设置</h1>
    <button class="btn sm right" :disabled="env.loading" @click="reprobe">
      {{ env.loading ? '探测中…' : '重新探测环境' }}
    </button>
  </div>

  <div class="view-body">
    <!-- ---------------- environment ---------------- -->
    <div class="card">
      <div class="card-head">环境诊断</div>
      <div class="card-body">
        <div v-for="(warning, index) in env.warnings" :key="index" class="banner warn">
          <span>⚠</span>
          <span>{{ warning }}</span>
        </div>

        <dl v-if="env.info" class="kv">
          <dt>ocr 命令</dt>
          <dd>{{ env.info.ocrPath ?? '未找到' }}</dd>

          <dt>启动方式</dt>
          <dd>
            {{ env.info.ocrLaunchKind }}
            <span v-if="env.info.ocrLaunchKind === 'native'" class="muted">
              （直接调用 Go 二进制，绕开 npm shim 与更新检查）
            </span>
          </dd>

          <dt>ocr 版本</dt>
          <dd>{{ env.info.ocrVersion ?? '未知' }}</dd>

          <dt>git 命令</dt>
          <dd>{{ env.info.gitPath ?? '未找到' }}</dd>

          <dt>git 版本</dt>
          <dd>{{ env.info.gitVersion ?? '未知' }}</dd>

          <dt v-if="env.info.rejectedGit">被忽略的 git</dt>
          <dd v-if="env.info.rejectedGit" style="color: #ffc078">
            {{ env.info.rejectedGit.path }} — 它把仓库根解析成
            <span class="mono">{{ env.info.rejectedGit.observedToplevel }}</span>
          </dd>

          <dt>会话目录</dt>
          <dd>{{ env.info.sessionsDir }}</dd>

          <dt>配置文件</dt>
          <dd>{{ env.info.configPath }}</dd>
        </dl>

        <div class="inline" style="margin-top: 14px">
          <button class="btn sm" @click="openConfigFile">打开 config.json</button>
          <button class="btn sm" @click="openSessionsDir">打开会话目录</button>
        </div>
      </div>
    </div>

    <!-- ---------------- git override ---------------- -->
    <div class="card">
      <div class="card-head">git 路径覆盖</div>
      <div class="card-body">
        <p class="muted" style="margin-top: 0">
          如果自动探测选错了 git（典型症状是审查报
          <span class="mono">GetFileAttributesEx C:\home\admin</span>），在这里指定
          <span class="mono">git.exe</span> 的完整路径。留空则恢复自动探测。
        </p>
        <div class="inline">
          <input
            v-model="gitOverrideDraft"
            type="text"
            placeholder="C:\Program Files\Git\cmd\git.exe"
            spellcheck="false"
            style="flex: 1"
          />
          <button class="btn sm primary" :disabled="busy" @click="saveGitOverride">保存并重探</button>
          <button class="btn sm" :disabled="busy" @click="clearGitOverride">清除</button>
        </div>
      </div>
    </div>

    <!-- ---------------- providers ---------------- -->
    <div class="card">
      <div class="card-head">
        渠道与模型
        <span class="card-head-note">审查用它跑模型，自动标题也跟随它</span>
        <span v-if="configLoading" class="spinner right" />
      </div>

      <div class="card-body">
        <div v-if="configError" class="banner error">
          <span>✕</span>
          <span>{{ configError }}</span>
        </div>

        <template v-if="config">
          <div v-if="config.parseError" class="banner error">
            <span>✕</span>
            <span>config.json 解析失败：{{ config.parseError }}</span>
          </div>

          <!-- The one block that answers "what is in use right now", kept apart
               from the list below because it is read far more often than edited. -->
          <div class="current-route">
            <div class="row">
              <div class="field">
                <label class="field-label">当前渠道</label>
                <div class="inline">
                  <span class="pill">{{ config.provider || '未设置' }}</span>
                  <span v-if="activeProvider" class="chip">
                    {{ activeProvider.custom ? '自定义' : '内置' }}
                  </span>
                  <span v-if="activeProvider?.protocol" class="muted">
                    {{ activeProvider.protocol }}
                  </span>
                </div>
              </div>

              <div class="field">
                <label class="field-label">当前模型</label>
                <ModelPicker v-model="config.model" :models="modelCatalogue" label="当前模型" />
                <p class="field-hint hint-row">
                  <span>{{ catalogueHint }}</span>
                  <button
                    v-if="activeProvider && !modelCatalogue.length"
                    type="button"
                    class="link-btn"
                    @click="openEdit(activeProvider)"
                  >
                    去渠道里添加
                  </button>
                </p>
              </div>
            </div>

            <!-- The catalogue offered here is the active channel's own, read-only:
                 editing it stays where the channel is (see the 渠道 rows below).
                 One source, so the picker and the editor cannot drift apart. -->
            <div class="inline">
              <button class="btn sm" :disabled="testing" @click="runTest">
                <span v-if="testing" class="spinner" />
                {{ testing ? '测试中…' : '测试连通性 (ocr llm test)' }}
              </button>
              <span class="muted">会真实调用一次模型</span>
            </div>

            <!-- Where a switched model lands is invisible in config.json (it goes
                 into the active channel's own entry), so say it once here. -->
            <div class="hint-row" style="margin-top: 6px">
              <p class="field-hint">
                模型和密钥都记在渠道自己名下：切换渠道时会各自带出，不会互相覆盖。
              </p>
              <button class="btn sm right" :disabled="busy" @click="applyModel">应用</button>
            </div>

          </div>
          <div
            v-if="testOutput"
            class="banner"
            :class="testOk ? 'ok' : 'error'"
            style="white-space: pre-wrap; display: block"
          >
            {{ testOutput }}
          </div>

          <!-- One list for every channel, custom or built-in: `provider` in
               config.json names one of these and does not care which it is. -->
          <div class="section-head">
            <h3>渠道</h3>
            <button
              v-if="unconfiguredBuiltins.length"
              type="button"
              class="link-btn"
              :aria-pressed="showBuiltins"
              @click="showBuiltins = !showBuiltins"
            >
              {{
                showBuiltins
                  ? '隐藏未配置的内置渠道'
                  : `显示未配置的内置渠道（${unconfiguredBuiltins.length}）`
              }}
            </button>
          </div>

          <div v-if="!channelRows.length" class="muted">
            还没有可用渠道，展开下方的「新增自定义渠道」添加一个。
          </div>

          <div v-else class="channel-list">
            <div
              v-for="provider in channelRows"
              :key="provider.name"
              class="channel-row"
              :class="{
                current: provider.active,
                idle: isIdle(provider),
                editing: editTarget?.name === provider.name
              }"
            >
              <span
                class="channel-dot"
                :class="provider.active ? 'current' : provider.hasApiKey ? 'ready' : 'idle'"
                :title="provider.hasApiKey ? '密钥已设置' : '未设置密钥'"
              />
              <div class="channel-main">
                <div class="channel-name">
                  <span>{{ provider.name }}</span>
                  <span v-if="provider.active" class="chip current">当前</span>
                  <span class="chip">{{ provider.custom ? '自定义' : '内置' }}</span>
                </div>
                <div class="channel-meta">
                  <span>{{ provider.protocol ?? '未知协议' }}</span>
                  <span>·</span>
                  <span class="mono">{{ provider.url ?? '使用内置地址' }}</span>
                  <span>·</span>
                  <span :title="provider.models.join('、')">
                    {{ provider.models.length ? `${provider.models.length} 个模型` : '未配置模型' }}
                  </span>
                  <span>·</span>
                  <span>{{ provider.apiKeyMask ?? '未设置密钥' }}</span>
                </div>
              </div>
              <div class="channel-actions">
                <button
                  class="btn sm ghost"
                  :disabled="busy || provider.active"
                  @click="activateProvider(provider)"
                >
                  设为当前
                </button>
                <button class="btn sm ghost" :disabled="busy" @click="beginEdit(provider)">
                  编辑
                </button>
                <button
                  v-if="provider.custom"
                  class="btn sm ghost"
                  :disabled="busy || provider.active"
                  title="当前使用的渠道不能直接删除"
                  @click="removeProvider(provider)"
                >
                  删除
                </button>
              </div>

              <!-- The editor opens inside its own row. A floating card could sit
                   several rows away from the channel it was editing, and the
                   masked key it has to show belongs next to that channel. -->
              <ChannelEditor
                v-if="editTarget?.name === provider.name"
                :key="provider.name"
                :provider="provider"
                :on-submit="saveProvider"
                @cancel="editTarget = null"
              />
            </div>
          </div>

          <!-- Creating a channel is a rare, multi-field operation, so it stays
               folded away instead of holding a third of the page open. -->
          <details ref="createDetails" class="advanced">
            <summary>新增自定义渠道</summary>
            <ChannelEditor
              :key="createKey"
              :on-submit="saveProvider"
              @cancel="closeCreate()"
            />
          </details>
        </template>
      </div>
    </div>

    <!-- ---------------- backups ---------------- -->
    <div class="card">
      <div class="card-head">
        配置备份
        <span class="muted" style="font-weight: 400; font-size: 11px">
          每次写入 config.json 前自动创建，最多保留 50 份
        </span>
      </div>
      <div class="card-body">
        <div v-if="!backups.length" class="muted">还没有备份（尚未通过本客户端修改过配置）。</div>

        <table v-else class="preview-table">
          <thead>
            <tr>
              <th>时间</th>
              <th class="num">大小</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="backup in backups" :key="backup.path">
              <td>{{ formatRelative(backup.createdAt) }}</td>
              <td class="num">{{ (backup.size / 1024).toFixed(1) }} KB</td>
              <td class="nowrap">
                <button class="btn sm ghost" :disabled="busy" @click="restore(backup)">恢复</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
