<script setup lang="ts">
import type { ConfigBackup, OcrConfigView, ProviderInfo } from '@shared/types'
import { computed, onMounted, ref } from 'vue'
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

/* ---------------- new provider form ---------------- */

const draftName = ref('')
const draftUrl = ref('')
const draftProtocol = ref('openai')
const draftModels = ref('')
const draftKey = ref('')

/* ---------------- git override ---------------- */

const gitOverrideDraft = ref('')

const activeProvider = computed(() => config.value?.providers.find((p) => p.active) ?? null)

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

/** One click on a model chip both names the model and applies it. */
async function pickModel(name: string): Promise<void> {
  if (!config.value || config.value.model === name) return
  config.value.model = name
  await applyModel()
}

async function keyPathFor(provider: ProviderInfo): Promise<string> {
  return provider.custom
    ? `custom_providers.${provider.name}.api_key`
    : `providers.${provider.name}.api_key`
}

const keyTarget = ref<ProviderInfo | null>(null)
const keyDraft = ref('')

function beginSetKey(provider: ProviderInfo): void {
  keyTarget.value = provider
  keyDraft.value = ''
}

async function saveKey(): Promise<void> {
  const provider = keyTarget.value
  if (!provider || !keyDraft.value.trim()) return

  const ok = await applySet(
    await keyPathFor(provider),
    keyDraft.value.trim(),
    `已更新 ${provider.name} 的 API Key`
  )
  if (ok) {
    keyTarget.value = null
    keyDraft.value = ''
    // A missing key is the likeliest reason titling gave up; let it try again.
    repos.retryTitles()
  }
}

async function createProvider(): Promise<void> {
  const name = draftName.value.trim()
  if (!name) {
    ui.notifyError('请填写渠道名')
    return
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    ui.notifyError('渠道名只能包含字母、数字、下划线、点和连字符（它会成为配置键的一部分）')
    return
  }
  if (!draftUrl.value.trim()) {
    ui.notifyError('请填写 API 地址')
    return
  }

  // Written field by field so a failure part-way through is visible rather than
  // silently producing a half-configured provider.
  if (!(await applySet(`custom_providers.${name}.url`, draftUrl.value.trim(), '已写入地址'))) return
  if (!(await applySet(`custom_providers.${name}.protocol`, draftProtocol.value, '已写入协议'))) return

  if (draftModels.value.trim()) {
    if (!(await applySet(`custom_providers.${name}.models`, draftModels.value.trim(), '已写入模型目录'))) {
      return
    }
  }
  if (draftKey.value.trim()) {
    if (!(await applySet(`custom_providers.${name}.api_key`, draftKey.value.trim(), '已写入密钥'))) return
  }

  ui.notify(`渠道 ${name} 已创建`, 'ok')
  draftName.value = ''
  draftUrl.value = ''
  draftModels.value = ''
  draftKey.value = ''
  draftProtocol.value = 'openai'
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
                <div class="inline">
                  <input
                    v-model="config.model"
                    type="text"
                    list="model-options"
                    spellcheck="false"
                  />
                  <button class="btn sm" :disabled="busy" @click="applyModel">应用</button>
                </div>
                <datalist id="model-options">
                  <option
                    v-for="name in activeProvider?.models ?? []"
                    :key="name"
                    :value="name"
                  />
                </datalist>
              </div>
            </div>

            <!-- The catalogue as buttons: switching a model for this channel is
                 the same one-line config write as typing it and pressing 应用. -->
            <div v-if="activeProvider?.models?.length" class="field">
              <label class="field-label">该渠道的模型（点击即切换）</label>
              <div class="model-chips">
                <button
                  v-for="name in activeProvider.models"
                  :key="name"
                  type="button"
                  class="model-chip"
                  :class="{ current: config.model === name }"
                  :disabled="busy"
                  @click="pickModel(name)"
                >
                  {{ name }}
                </button>
              </div>
            </div>

            <div class="inline">
              <button class="btn sm" :disabled="testing" @click="runTest">
                <span v-if="testing" class="spinner" />
                {{ testing ? '测试中…' : '测试连通性 (ocr llm test)' }}
              </button>
              <span class="muted">会真实调用一次模型</span>
            </div>

            <!-- Where a switched model lands is invisible in config.json (it goes
                 into the active channel's own entry), so say it once here. -->
            <p class="field-hint">
              模型和密钥都记在渠道自己名下：切换渠道时会各自带出，不会互相覆盖。
            </p>
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
              :class="{ current: provider.active, idle: isIdle(provider) }"
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
                <button class="btn sm ghost" :disabled="busy" @click="beginSetKey(provider)">
                  设置密钥
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

              <!-- The key editor opens inside its own row. The old floating card
                   could sit several rows away from the channel it edited. -->
              <div v-if="keyTarget?.name === provider.name" class="channel-key">
                <div class="field">
                  <label class="field-label">为 {{ provider.name }} 设置 API Key</label>
                  <input
                    v-model="keyDraft"
                    type="password"
                    placeholder="粘贴密钥后保存"
                    spellcheck="false"
                  />
                  <div class="field-hint">
                    密钥只写入 ocr 配置文件，不会回传到界面；保存前会自动备份 config.json。
                  </div>
                </div>
                <div class="inline">
                  <button
                    class="btn sm primary"
                    :disabled="busy || !keyDraft.trim()"
                    @click="saveKey"
                  >
                    保存
                  </button>
                  <button class="btn sm" @click="keyTarget = null">取消</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Creating a channel is a rare, multi-field operation, so it stays
               folded away instead of holding a third of the page open. -->
          <details class="advanced">
            <summary>新增自定义渠道</summary>
            <div class="row">
              <div class="field">
                <label class="field-label">渠道名</label>
                <input v-model="draftName" type="text" placeholder="my-gateway" spellcheck="false" />
              </div>
              <div class="field">
                <label class="field-label">协议</label>
                <select v-model="draftProtocol">
                  <option value="openai">openai</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic">anthropic</option>
                  <option value="anthropic-bedrock">anthropic-bedrock</option>
                </select>
              </div>
            </div>

            <div class="field">
              <label class="field-label">API 地址</label>
              <input
                v-model="draftUrl"
                type="text"
                placeholder="https://gateway.internal.com/v1"
                spellcheck="false"
              />
            </div>

            <div class="row">
              <div class="field">
                <label class="field-label">模型目录（逗号分隔，可留空）</label>
                <input
                  v-model="draftModels"
                  type="text"
                  placeholder="gpt-4o,claude-opus-4"
                  spellcheck="false"
                />
              </div>
              <div class="field">
                <label class="field-label">API Key（可留空，稍后再填）</label>
                <input v-model="draftKey" type="password" spellcheck="false" />
              </div>
            </div>

            <div class="field-hint" style="margin-bottom: 12px">
              渠道名只能包含字母、数字、下划线、点和连字符，它会成为 config.json 里的键。
            </div>

            <button class="btn primary" :disabled="busy" @click="createProvider">创建渠道</button>
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
