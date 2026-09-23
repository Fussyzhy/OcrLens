/**
 * Model catalogue lookup for the settings form.
 *
 * The form offers a provider's models as checkboxes, so it asks the gateway which
 * ids it actually serves instead of making the user type them. This stays a
 * read-only probe: one GET, no body, no retries, no cache — a settings page has to
 * show the catalogue as it is right now, and there is a manual fallback for the
 * gateways that answer with nothing useful.
 */

import { authHeaders, describeError, isRecord } from './gateway'

export interface ModelProbeTarget {
  /** Provider name, used only to make error messages point somewhere findable. */
  provider: string
  /** Base URL exactly as configured, e.g. `http://host:48760/v1`. */
  url: string
  /** Protocol string from the config; may be any string. */
  protocol: string
  /** Full API key. It stays in the main process; never return it to the renderer. */
  apiKey: string
}

const DEFAULT_TIMEOUT_MS = 20_000

/** Longer than any real model id; anything past this is a payload accident. */
const MAX_MODEL_ID_LENGTH = 200

/** The models endpoint for a protocol, tolerating version-suffixed base URLs. */
export function modelListEndpoint(target: { protocol: string; url: string }): string {
  const base = target.url.replace(/\/+$/, '')

  if (target.protocol === 'anthropic') {
    // Same rule as `endpoint()` in llm.ts: Anthropic's own base
    // (`https://api.anthropic.com`) carries no version segment while a custom
    // gateway usually does, so add `/v1` only when it is missing — a gateway
    // configured as `.../v1` would otherwise be asked for `/v1/v1/models`.
    return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
  }

  // `anthropic-bedrock` is refused by the caller before any request is built, but
  // this function stays total and predictable rather than throwing midway through
  // building a string: an unknown protocol therefore takes the OpenAI-compatible
  // path, exactly as `endpoint()` in llm.ts falls through to `/chat/completions`.
  return `${base}/models`
}

/** Reads a model id out of one catalogue entry, tolerating the keys gateways use. */
function entryToModelId(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() || undefined
  if (!isRecord(entry)) return undefined

  // The key order is a preference, not a whitelist: OpenAI/Anthropic answer with
  // `id`, Ollama-style catalogues answer with `name`, and some gateways fill in
  // both `name` and `model` (where `model` is the bare family without its tag).
  for (const key of ['id', 'name', 'model']) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Pulls model ids out of the many shapes gateways use. Pure, never throws. */
export function parseModelIds(payload: unknown): string[] {
  const ids = new Set<string>()

  const collect = (entries: unknown[]): void => {
    for (const entry of entries) {
      const id = entryToModelId(entry)
      if (!id || id.length > MAX_MODEL_ID_LENGTH) continue
      ids.add(id)
    }
  }

  try {
    if (Array.isArray(payload)) {
      // A bare array is both a whole response and a list nested below, so the
      // same collector serves every path.
      collect(payload)
    } else if (isRecord(payload)) {
      // `data` is the OpenAI/Anthropic envelope, `models` is what Ollama-style
      // gateways answer with. Both are read because a gateway may fill in either
      // one, and an entry may itself be a plain string in both.
      if (Array.isArray(payload.data)) collect(payload.data)
      if (Array.isArray(payload.models)) collect(payload.models)
    }
  } catch {
    // An exotic payload (a throwing accessor, say) must not take the settings form
    // down; an empty list is the safe answer and the caller reports it.
    return []
  }

  return [...ids].sort((a, b) => a.localeCompare(b))
}

/** GETs the gateway's model catalogue. Throws Error with a readable Chinese message. */
export async function fetchProviderModels(
  target: ModelProbeTarget,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string[]> {
  // Name the provider, not a model: the model is a field *within* a provider, so
  // naming one would send the user looking in the wrong place.
  const where = target.provider ? `渠道 ${target.provider} ` : '该渠道 '

  // Bedrock is refused first on purpose: the built-in catalogue lists it with an
  // empty base URL, so the missing-URL branch below would mask the real reason.
  if (target.protocol === 'anthropic-bedrock') {
    throw new Error(
      'anthropic-bedrock 需要 AWS 签名，本客户端无法获取它的模型列表。请在设置页手动填写模型名。'
    )
  }

  if (!target.url.trim()) {
    throw new Error(`${where}没有配置 API 地址，无法获取模型列表。请在设置页填写 API 地址。`)
  }
  if (!target.apiKey.trim()) {
    throw new Error(`${where}没有配置 API Key，无法获取模型列表。请在设置页填写密钥。`)
  }

  const url = modelListEndpoint(target)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let raw: string
  let status: number
  let ok: boolean
  try {
    // A catalogue read sends no body: some gateways reject a GET that carries one.
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders(target.protocol, target.apiKey) },
      signal: controller.signal
    })
    status = response.status
    ok = response.ok
    // Read the body while the abort timer is still armed. `fetch` resolves as soon
    // as the headers arrive, so clearing the timer here would leave a gateway that
    // stalls mid-body able to hang the settings form forever.
    raw = await response.text()
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`请求 ${url} 超时（${timeoutMs / 1000}s 内没有拿到响应）。`)
    }
    // Only our own timer aborting the signal means "timeout"; any other
    // AbortError is a transport failure and must not masquerade as one.
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`请求 ${url} 失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }

  let payload: unknown = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    // Fall through: a non-JSON body is reported using its raw text below.
  }

  if (!ok) {
    // Prefer the gateway's own message, but keep the status: a bare "invalid api
    // key" is only actionable next to the HTTP code that produced it.
    const described = describeError(payload)
    const detail = described ?? (raw.trim().slice(0, 300) || '(空响应)')
    throw new Error(`HTTP ${status}：${detail}`)
  }

  const ids = parseModelIds(payload)
  if (ids.length === 0) {
    // A real and common outcome, not a bug: several gateways expose no catalogue
    // at all, so the form offers hand-typed model names instead.
    throw new Error(`${where}的网关没有返回模型列表，请在设置页手动填写模型名。`)
  }

  return ids
}
