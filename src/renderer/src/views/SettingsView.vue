<script setup lang="ts">
import type { ConfigBackup, OcrConfigView, ProviderInfo } from '@shared/types'
import { computed, onMounted, ref } from 'vue'
import { useEnvStore } from '../stores/env'
import { useUiStore } from '../stores/ui'
import { formatRelative } from '../utils/format'

const env = useEnvStore()
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

const customProviders = computed(() => config.value?.providers.filter((p) => p.custom) ?? [])

const builtinProviders = computed(() => config.value?.providers.filter((p) => !p.custom) ?? [])

/** Built-ins that already have a stored key, plus the active one, are worth listing. */
const configuredBuiltins = computed(() =>
  builtinProviders.value.filter((p) => p.hasApiKey || p.active)
)

const unconfiguredBuiltins = computed(() =>
  builtinProviders.value.filter((p) => !p.hasApiKey && !p.active)
)

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

async function activateProvider(provider: ProviderInfo): Promise<void> {
  await applySet('provider', provider.name, `已切换到渠道 ${provider.name}`)
}

async function applyModel(): Promise<void> {
  if (!config.value?.model) return
  await applySet('model', config.value.model, `已设置模型 ${config.value.model}`)
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

/* ---------------- session titles ---------------- */

/**
 * A stored `titleProvider` that is no longer among the configured providers.
 *
 * `titleProvider` is a persisted string, so deleting a provider (or editing
 * ocr's config elsewhere) can leave it pointing at nothing. The `<select>` would
 * then have no matching option and render blank, hiding the fact that automatic
 * naming is broken; this is what the placeholder option below shows.
 */
const staleTitleProvider = computed<string | null>(() => {
  const name = env.settings?.titleProvider
  if (!name) return null
  return (config.value?.providers ?? []).some((provider) => provider.name === name) ? null : name
})

/**
 * Every write here goes through `unwrap`, so `{ ok: false }` rejects.
 *
 * Unhandled, that was an unhandled rejection plus a control left showing a value
 * the store never accepted; and when `setSettings` succeeded but the follow-up
 * `envInfo()` failed there was no feedback at all.
 */
async function toggleAutoTitle(enabled: boolean): Promise<void> {
  try {
    await env.setOverride({ autoTitle: enabled })
    ui.notify(enabled ? '已开启自动生成标题' : '已关闭自动生成标题', 'ok')
  } catch (err) {
    ui.notifyError(err)
  }
}

async function setTitleProvider(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  try {
    await env.setOverride({ titleProvider: value || null })
    ui.notify('已更新生成标题的渠道', 'ok')
  } catch (err) {
    ui.notifyError(err)
  }
}

async function setTitleModel(event: Event): Promise<void> {
  const value = (event.target as HTMLInputElement).value.trim()
  try {
    await env.setOverride({ titleModel: value || null })
    ui.notify('已更新生成标题的模型', 'ok')
  } catch (err) {
    ui.notifyError(err)
  }
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
        <span v-if="configLoading" class="spinner" style="margin-left: 8px" />
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

          <div class="row">
            <div class="field">
              <label class="field-label">当前渠道</label>
              <div class="inline">
                <span class="pill">{{ config.provider || '未设置' }}</span>
                <span v-if="activeProvider" class="muted">
                  {{ activeProvider.protocol ?? '' }}
                </span>
              </div>
            </div>

            <div class="field">
              <label class="field-label">当前模型</label>
              <div class="inline">
                <input v-model="config.model" type="text" list="model-options" spellcheck="false" />
                <button class="btn sm" :disabled="busy" @click="applyModel">应用</button>
              </div>
              <datalist id="model-options">
                <option
                  v-for="name in activeProvider?.models ?? []"
                  :key="name"
                  :value="name"
                />
              </datalist>
              <div v-if="activeProvider?.models?.length" class="field-hint">
                该渠道目录：{{ activeProvider.models.join('、') }}
              </div>
            </div>
          </div>

          <div class="inline" style="margin-bottom: 16px">
            <button class="btn sm" :disabled="testing" @click="runTest">
              <span v-if="testing" class="spinner" />
              {{ testing ? '测试中…' : '测试连通性 (ocr llm test)' }}
            </button>
            <span class="muted">会真实调用一次模型</span>
          </div>

          <div
            v-if="testOutput"
            class="banner"
            :class="testOk ? 'ok' : 'error'"
            style="white-space: pre-wrap; display: block"
          >
            {{ testOutput }}
          </div>

          <!-- custom providers -->
          <h3 style="font-size: 13px; margin: 18px 0 8px">自定义渠道</h3>
          <div v-if="!customProviders.length" class="muted">还没有自定义渠道。</div>

          <table v-else class="preview-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>协议</th>
                <th>地址</th>
                <th>API Key</th>
                <th>模型</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="provider in customProviders" :key="provider.name">
                <td>
                  {{ provider.name }}
                  <span v-if="provider.active" class="chip" style="margin-left: 6px">当前</span>
                </td>
                <td>{{ provider.protocol ?? '—' }}</td>
                <td style="overflow-wrap: anywhere">{{ provider.url ?? '—' }}</td>
                <td>{{ provider.apiKeyMask ?? '未设置' }}</td>
                <td>{{ provider.models.length ? provider.models.join(', ') : '—' }}</td>
                <td class="nowrap">
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
                    class="btn sm ghost"
                    :disabled="busy || provider.active"
                    title="当前使用的渠道不能直接删除"
                    @click="removeProvider(provider)"
                  >
                    删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="keyTarget" class="card" style="margin-top: 12px; background: var(--bg-elev-2)">
            <div class="card-body">
              <div class="field">
                <label class="field-label">为 {{ keyTarget.name }} 设置 API Key</label>
                <input v-model="keyDraft" type="password" placeholder="粘贴密钥后保存" spellcheck="false" />
                <div class="field-hint">
                  密钥只写入 ocr 配置文件，不会回传到界面；保存前会自动备份 config.json。
                </div>
              </div>
              <div class="inline">
                <button class="btn sm primary" :disabled="busy || !keyDraft.trim()" @click="saveKey">
                  保存
                </button>
                <button class="btn sm" @click="keyTarget = null">取消</button>
              </div>
            </div>
          </div>

          <!-- built-ins already in use -->
          <template v-if="configuredBuiltins.length">
            <h3 style="font-size: 13px; margin: 18px 0 8px">已配置的内置渠道</h3>
            <table class="preview-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议</th>
                  <th>地址</th>
                  <th>API Key</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="provider in configuredBuiltins" :key="provider.name">
                  <td>
                    {{ provider.name }}
                    <span v-if="provider.active" class="chip" style="margin-left: 6px">当前</span>
                  </td>
                  <td>{{ provider.protocol ?? '—' }}</td>
                  <td style="overflow-wrap: anywhere">{{ provider.url ?? '—' }}</td>
                  <td>{{ provider.apiKeyMask ?? '未设置' }}</td>
                  <td class="nowrap">
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
                  </td>
                </tr>
              </tbody>
            </table>
          </template>

          <!-- create provider -->
          <h3 style="font-size: 13px; margin: 18px 0 8px">新增自定义渠道</h3>
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

          <button class="btn primary" :disabled="busy" @click="createProvider">创建渠道</button>

          <div v-if="unconfiguredBuiltins.length" class="field-hint" style="margin-top: 14px">
            还可选择的内置渠道共 {{ unconfiguredBuiltins.length }} 个，例如
            {{ unconfiguredBuiltins.slice(0, 8).map((p) => p.name).join('、') }}…
          </div>
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

    <!-- ---------------- session titles ---------------- -->
    <div class="card">
      <div class="card-head">
        历史记录标题
        <span class="muted" style="font-weight: 400; font-size: 11px">
          自动调用模型，为每条审查记录生成标题
        </span>
      </div>
      <div class="card-body">
        <label class="checkbox" style="margin-bottom: 6px">
          <input
            type="checkbox"
            :checked="env.settings?.autoTitle !== false"
            @change="toggleAutoTitle(($event.target as HTMLInputElement).checked)"
          />
          <span>自动生成标题</span>
        </label>
        <p class="field-hint" style="margin-bottom: 14px">
          开启后无需任何操作：每次审查结束会自动为这条记录起名，历史里还没有标题的旧记录也会在左侧列表读到它们时依次补上（一次一条，不会突发请求）。
          手动重命名过的标题永远不会被自动覆盖；把标题清空即可让它重新自动命名。
        </p>

        <div class="row">
          <label class="field">
            <span class="field-label">生成标题使用的渠道</span>
            <select :value="env.settings?.titleProvider ?? ''" @change="setTitleProvider($event)">
              <option value="">
                跟随 ocr 当前渠道{{ config?.provider ? `（${config.provider}）` : '（未设置）' }}
              </option>
              <option v-if="staleTitleProvider" :value="staleTitleProvider">
                {{ staleTitleProvider }}（已不存在）
              </option>
              <option v-for="provider in config?.providers ?? []" :key="provider.name" :value="provider.name">
                {{ provider.name }}{{ provider.custom ? '（自定义）' : '' }}
              </option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">模型</span>
            <input
              type="text"
              :value="env.settings?.titleModel ?? ''"
              :placeholder="`跟随 ocr 当前模型${config?.model ? `（${config.model}）` : '（未设置）'}`"
              spellcheck="false"
              @change="setTitleModel($event)"
            />
          </label>
        </div>

        <p class="field-hint">
          起名是件小事，指定一个便宜的小模型即可。改动这里也会清除之前的失败计数，让没能生成的记录重新尝试。
        </p>
      </div>
    </div>
  </div>
</template>
