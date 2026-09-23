import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ConfigBackup,
  ConfigTestResult,
  LlmProtocol,
  MutateResultView,
  OcrConfigView,
  ProviderInfo
} from '@shared/types'
import { execOcr, ocrConfigPath, ocrStateDir, type OcrLaunch } from './ocr'

/**
 * Management of the ocr CLI's own configuration (`~/.opencodereview/config.json`).
 *
 * Two rules govern everything here:
 *
 * 1. Secrets never leave the main process. The renderer only ever receives a
 *    masked hint and a boolean, so an API key cannot leak into a rendered page,
 *    a devtools panel, or a screenshot.
 * 2. Writes go through `ocr config set/unset` rather than editing the JSON
 *    directly, so the CLI stays the authority on its own schema. We still take a
 *    backup first, because a mistyped key name could otherwise leave the user
 *    without a working config.
 */

interface RawProviderEntry {
  api_key?: string
  url?: string
  protocol?: string
  model?: string
  models?: string[]
  [key: string]: unknown
}

interface RawOcrConfig {
  provider?: string
  model?: string
  providers?: Record<string, RawProviderEntry>
  custom_providers?: Record<string, RawProviderEntry>
  llm?: { language?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** Reads and parses the config file, tolerating absence and corruption. */
function readRawConfig(): { config: RawOcrConfig; parseError?: string; exists: boolean } {
  const file = ocrConfigPath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { config: {}, exists: false }
  }
  try {
    return { config: JSON.parse(text) as RawOcrConfig, exists: true }
  } catch (err) {
    return {
      config: {},
      exists: true,
      parseError: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Renders a key as a non-reversible hint: first 4 and last 4 characters.
 * Short keys are fully masked so the hint cannot become the secret.
 */
export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined
  if (key.length <= 12) return '•'.repeat(key.length)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * Parses the fixed-width table printed by `ocr llm providers`.
 *
 * Example rows:
 *   "  anthropic            anthropic          https://api.anthropic.com"
 *   "  bedrock              anthropic-bedrock  "        (empty base URL)
 */
function parseBuiltinProviders(output: string): ProviderInfo[] {
  const out: ProviderInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!/^\s{2}\S/.test(line)) continue
    const match = /^\s{2}(\S+)\s{2,}(\S+)\s*(.*)$/.exec(line)
    if (!match) continue
    const [, name, protocol, url] = match
    if (!name || name === 'NAME') continue
    out.push({
      name,
      custom: false,
      builtin: true,
      protocol,
      url: url.trim() || undefined,
      models: [],
      hasApiKey: false,
      active: false
    })
  }
  return out
}

/**
 * Protocols this client's minimal LLM client actually implements.
 *
 * `LlmProtocol` is deliberately open-ended because the CLI adds protocols over
 * time, but an unknown value used to fall through every branch in `llm.ts` and
 * take the OpenAI `/chat/completions` path — a wrong URL and wrong auth scheme
 * reported as a confusing gateway error. Better to refuse up front.
 * `anthropic-bedrock` is listed because `llm.ts` rejects it with its own
 * specific message rather than pretending to support it.
 */
const SUPPORTED_PROTOCOLS = new Set([
  'openai',
  'anthropic',
  'openai-responses',
  'anthropic-bedrock'
])

/**
 * Built-in provider catalogue cache.
 *
 * `ocr llm providers` spawns a CLI process (30s timeout). Titling resolves a
 * target per session, so without this a first-run backfill of a long history
 * would spawn one extra process per session for information that only changes
 * when the user edits the config. A short TTL bounds staleness for config edits
 * made in a terminal, and every write path here invalidates it outright.
 */
const BUILTIN_CACHE_MS = 60_000
let builtinCache: { key: string; at: number; providers: ProviderInfo[] } | null = null

/** Drops the catalogue cache after anything that could change the config. */
export function invalidateBuiltinProviders(): void {
  builtinCache = null
}

function launchKey(launch: OcrLaunch | null): string {
  return launch ? `${launch.exe}\u0000${launch.prefix.join('\u0000')}` : ''
}

/** Reads the CLI's built-in provider catalogue, reusing a recent answer. */
async function builtinProviders(
  launch: OcrLaunch,
  gitBinDir: string | null
): Promise<ProviderInfo[]> {
  const key = launchKey(launch)
  if (builtinCache && builtinCache.key === key && Date.now() - builtinCache.at < BUILTIN_CACHE_MS) {
    return builtinCache.providers
  }

  const listed = await execOcr(launch, ['llm', 'providers'], gitBinDir, { timeoutMs: 30_000 })
  const providers = parseBuiltinProviders(listed.stdout || listed.stderr)
  builtinCache = { key, at: Date.now(), providers }
  return providers
}

/** Reads the CLI config plus the built-in provider catalogue. */
export async function readConfigView(
  launch: OcrLaunch | null,
  gitBinDir: string | null
): Promise<OcrConfigView> {
  const { config, parseError } = readRawConfig()

  const activeProvider = config.provider ?? ''
  // `ocr config set model X` writes X into the active provider's own entry (not
  // the top-level key), and `resolveLlmTarget` prefers that entry, so the entry
  // is what is actually in effect. Showing the top-level key alone made the
  // settings page keep displaying the previous model after a switch while
  // reviews and titles already used the new one.
  const activeEntry: RawProviderEntry =
    config.custom_providers?.[activeProvider] ?? config.providers?.[activeProvider] ?? {}
  const activeModel = (activeEntry.model || config.model || '').trim()

  const providers: ProviderInfo[] = []

  // Built-in providers advertised by the CLI.
  if (launch) {
    providers.push(...(await builtinProviders(launch, gitBinDir)))
  }

  const mergeEntry = (name: string, entry: RawProviderEntry, custom: boolean): void => {
    const existing = providers.find((p) => p.name === name && p.custom === custom)
    const value: ProviderInfo = {
      name,
      custom,
      builtin: !custom,
      url: entry.url ?? existing?.url,
      protocol: entry.protocol ?? existing?.protocol,
      defaultModel: entry.model,
      models: Array.isArray(entry.models) ? entry.models.filter((m) => typeof m === 'string') : (existing?.models ?? []),
      hasApiKey: Boolean(entry.api_key),
      apiKeyMask: maskKey(entry.api_key),
      active: name === activeProvider
    }
    if (existing) Object.assign(existing, value)
    else providers.push(value)
  }

  for (const [name, entry] of Object.entries(config.providers ?? {})) {
    if (entry && typeof entry === 'object') mergeEntry(name, entry, false)
  }
  for (const [name, entry] of Object.entries(config.custom_providers ?? {})) {
    if (entry && typeof entry === 'object') mergeEntry(name, entry, true)
  }

  for (const provider of providers) {
    provider.active = provider.name === activeProvider
  }
  providers.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    if (a.custom !== b.custom) return a.custom ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return {
    provider: activeProvider,
    model: activeModel,
    language: config.llm?.language,
    providers,
    configPath: ocrConfigPath(),
    parseError
  }
}

/** Everything needed to call the configured model directly. */
export interface ResolvedLlmTarget {
  provider: string
  protocol: LlmProtocol
  url: string
  apiKey: string
  model: string
}

/**
 * Resolves the raw connection details for the configured provider.
 *
 * Titling needs this because it talks to the model itself: unlike the renderer,
 * which only ever sees `apiKeyMask`, the caller here receives the real key. That
 * is why this lives in the main process next to the rest of the config handling
 * rather than being derived from the masked view.
 *
 * There is deliberately no provider/model override: callers follow whatever ocr
 * is configured with, so there is exactly one route in the app and no second one
 * to drift out of date.
 */
export async function resolveLlmTarget(
  launch: OcrLaunch | null,
  gitBinDir: string | null
): Promise<ResolvedLlmTarget> {
  const { config } = readRawConfig()

  const provider = (config.provider || '').trim()
  if (!provider) {
    throw new Error('ocr 配置里没有指定渠道，无法生成标题。')
  }

  const entry: RawProviderEntry =
    config.custom_providers?.[provider] ?? config.providers?.[provider] ?? {}

  let url = entry.url?.trim() ?? ''
  // The protocol comes from a hand-editable JSON file, so it is an arbitrary
  // string at this point; `?? undefined` here was a no-op that made it look
  // validated when it was not.
  let protocol = entry.protocol?.trim() || undefined

  // Built-in providers keep their base URL and protocol inside the CLI, not in
  // config.json, so fall back to the catalogue only when the file is silent.
  if ((!url || !protocol) && launch) {
    const view = await readConfigView(launch, gitBinDir)
    const info = view.providers.find((p) => p.name === provider)
    url = url || info?.url || ''
    protocol = protocol ?? (info?.protocol as LlmProtocol | undefined)
  }

  const resolved = (protocol ?? 'openai').trim()
  if (!SUPPORTED_PROTOCOLS.has(resolved)) {
    throw new Error(
      `渠道 ${provider} 的协议「${resolved}」本客户端不支持，无法生成标题（支持：` +
        `${[...SUPPORTED_PROTOCOLS].join('、')}）。请在设置页改用它支持的渠道。`
    )
  }

  const model = (entry.model || config.model || '').trim()
  if (!model) throw new Error('没有可用的模型名，无法生成标题。')

  return {
    provider,
    protocol: resolved as LlmProtocol,
    url,
    apiKey: entry.api_key?.trim() ?? '',
    model
  }
}

/** Directory holding our own config backups, kept out of ocr's state dir. */
function backupDir(): string {
  return path.join(app.getPath('userData'), 'config-backups')
}

/**
 * Copies the current config aside before a mutating operation.
 *
 * Returns the backup path, or null when there was nothing to back up.
 */
export async function backupConfig(): Promise<string | null> {
  const source = ocrConfigPath()
  if (!fs.existsSync(source)) return null

  const dir = backupDir()
  await fs.promises.mkdir(dir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `config-${stamp}.json`)
  await fs.promises.copyFile(source, target)

  await pruneBackups(50)
  return target
}

/** Keeps the backup directory bounded. */
async function pruneBackups(keep: number): Promise<void> {
  try {
    const dir = backupDir()
    const entries = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith('config-') && name.endsWith('.json'))
      .sort()
      .reverse()
    for (const stale of entries.slice(keep)) {
      await fs.promises.rm(path.join(dir, stale), { force: true })
    }
  } catch {
    // Pruning is best-effort; never fail a write because of it.
  }
}

export async function listBackups(): Promise<ConfigBackup[]> {
  try {
    const dir = backupDir()
    const names = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith('config-') && name.endsWith('.json'))
      .sort()
      .reverse()

    const out: ConfigBackup[] = []
    for (const name of names) {
      const full = path.join(dir, name)
      const stat = await fs.promises.stat(full)
      out.push({ path: full, createdAt: stat.mtime.toISOString(), size: stat.size })
    }
    return out
  } catch {
    return []
  }
}

/** Restores a backup over the live config (itself snapshotted first). */
export async function restoreBackup(backupPath: string): Promise<{ ok: boolean; error?: string }> {
  const expectedDir = path.resolve(backupDir())
  const resolved = path.resolve(backupPath)

  // Refuse to copy arbitrary files over the config.
  if (!resolved.startsWith(expectedDir + path.sep)) {
    return { ok: false, error: 'Refusing to restore a file outside the backup directory' }
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: 'Backup file no longer exists' }
  }

  try {
    await fs.promises.mkdir(ocrStateDir(), { recursive: true })
    await backupConfig()
    await fs.promises.copyFile(resolved, ocrConfigPath())
    invalidateBuiltinProviders()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type MutateResult = MutateResultView

/**
 * Sets one config key via the CLI.
 *
 * `key` is validated against a conservative pattern so a caller cannot smuggle
 * extra CLI flags through it.
 */
export async function configSet(
  launch: OcrLaunch | null,
  gitBinDir: string | null,
  key: string,
  value: string
): Promise<MutateResult> {
  if (!launch) return { ok: false, output: '', error: 'ocr CLI not available' }
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    return { ok: false, output: '', error: `Invalid config key: ${key}` }
  }

  const backupPath = await backupConfig()
  const result = await execOcr(launch, ['config', 'set', key, value], gitBinDir, { timeoutMs: 30_000 })
  const output = (result.stdout + result.stderr).trim()

  if (result.code !== 0) {
    return { ok: false, output, backupPath, error: output || `ocr config set exited ${result.code}` }
  }
  invalidateBuiltinProviders()
  return { ok: true, output, backupPath }
}

export async function configUnset(
  launch: OcrLaunch | null,
  gitBinDir: string | null,
  key: string
): Promise<MutateResult> {
  if (!launch) return { ok: false, output: '', error: 'ocr CLI not available' }
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    return { ok: false, output: '', error: `Invalid config key: ${key}` }
  }

  const backupPath = await backupConfig()
  const result = await execOcr(launch, ['config', 'unset', key], gitBinDir, { timeoutMs: 30_000 })
  const output = (result.stdout + result.stderr).trim()

  if (result.code !== 0) {
    return { ok: false, output, backupPath, error: output || `ocr config unset exited ${result.code}` }
  }
  invalidateBuiltinProviders()
  return { ok: true, output, backupPath }
}

/** Runs `ocr llm test` to verify the active provider/model actually responds. */
export async function testConnection(
  launch: OcrLaunch | null,
  gitBinDir: string | null
): Promise<ConfigTestResult> {
  if (!launch) return { ok: false, output: 'ocr CLI not available' }

  // A live round trip can be slow on a cold gateway.
  const result = await execOcr(launch, ['llm', 'test'], gitBinDir, { timeoutMs: 120_000 })
  const output = (result.stdout + result.stderr).trim()
  return { ok: result.code === 0, output: output || `exited ${result.code}` }
}
