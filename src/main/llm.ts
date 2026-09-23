import type { LlmProtocol } from '@shared/types'
import { asArray, asNumber, asString, authHeaders, describeError, isRecord } from './gateway'

/**
 * A minimal single-turn chat client for the protocols the ocr CLI supports.
 *
 * This exists because the CLI has no "ask the model something small" command, and
 * titling needs exactly one cheap completion. It deliberately stays tiny: no
 * streaming, no tools, no retries beyond a timeout, and every failure surfaces as
 * a message instead of a silent fallback to a bad title.
 */

export interface LlmTarget {
  /** Base URL exactly as configured, e.g. `http://host:48760/v1`. */
  url: string
  apiKey: string
  protocol: LlmProtocol
  model: string
  /**
   * Name of the ocr provider this target came from, when known.
   *
   * Only used to make failure messages point at something the user can find in
   * the settings page; a caller that has no provider name may omit it.
   */
  provider?: string
}

export interface LlmReply {
  text: string
  promptTokens?: number
  completionTokens?: number
}

const REQUEST_TIMEOUT_MS = 90_000

/* ------------------------------------------------------------------ *
 * Protocol-specific request shapes
 * ------------------------------------------------------------------ */

/** Builds the full endpoint for a protocol, tolerating version-suffixed bases. */
function endpoint(target: LlmTarget): string {
  const base = target.url.replace(/\/+$/, '')

  if (target.protocol === 'openai-responses') return `${base}/responses`

  if (target.protocol === 'anthropic') {
    // Anthropic's own base (`https://api.anthropic.com`) carries no version
    // segment while a custom gateway usually does, so add it only when missing.
    return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
  }

  return `${base}/chat/completions`
}

function buildBody(target: LlmTarget, prompt: string, maxTokens: number): unknown {
  if (target.protocol === 'openai-responses') {
    return {
      model: target.model,
      input: prompt,
      max_output_tokens: maxTokens
    }
  }

  if (target.protocol === 'anthropic') {
    return {
      model: target.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }
  }

  return {
    model: target.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens
  }
}

function buildHeaders(target: LlmTarget): Record<string, string> {
  // A completion sends a body, so it needs the content type; the credential
  // headers are the part every gateway call shares (see `gateway.ts`).
  return {
    'content-type': 'application/json',
    ...authHeaders(target.protocol, target.apiKey)
  }
}

/**
 * Pulls the assistant's answer out of a provider payload.
 *
 * The `/responses` shape is the subtle one: a reasoning model returns a
 * `reasoning` output item *and* a `message` item, and the convenience
 * top-level `output_text` concatenates both. Taking that shortcut would store the
 * model's private deliberation as the session title, so only `message` items are
 * read here.
 */
function extractText(payload: unknown): string | null {
  if (!isRecord(payload)) return null

  // OpenAI Responses
  for (const item of asArray(payload.output)) {
    if (!isRecord(item) || item.type !== 'message') continue
    const text = asArray(item.content)
      .filter(isRecord)
      .filter((part) => part.type === 'output_text' || part.type === 'text')
      .map((part) => asString(part.text) ?? '')
      .join('')
      .trim()
    if (text) return text
  }

  // OpenAI chat completions
  for (const choice of asArray(payload.choices)) {
    if (!isRecord(choice)) continue
    const message = choice.message
    if (isRecord(message)) {
      const content = asString(message.content)?.trim()
      if (content) return content
    }
    const legacy = asString(choice.text)?.trim()
    if (legacy) return legacy
  }

  // Anthropic messages
  const blocks = asArray(payload.content)
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text) ?? '')
    .join('')
    .trim()
  if (blocks) return blocks

  return null
}

/**
 * Sends one prompt and returns the answer.
 *
 * Throws with a descriptive message on transport, HTTP, or shape failures — the
 * caller decides whether that is worth surfacing to the user.
 */
export async function complete(
  target: LlmTarget,
  prompt: string,
  maxTokens = 256
): Promise<LlmReply> {
  const url = endpoint(target)

  if (target.protocol === 'anthropic-bedrock') {
    throw new Error('anthropic-bedrock 需要 AWS 签名，本客户端暂不支持用它生成标题。')
  }

  // Name the provider, not the model: the model is a field *within* a provider,
  // so "渠道 gpt-4o 没有配置 API 地址" sends the user looking in the wrong place.
  const where = target.provider ? `渠道 ${target.provider} ` : '该渠道 '
  if (!target.url.trim()) {
    throw new Error(`${where}没有配置 API 地址，无法生成标题。请在设置页检查该渠道的 API 地址。`)
  }
  if (!target.apiKey.trim()) {
    throw new Error(`${where}没有配置 API Key，无法生成标题。请在设置页填写。`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let raw: string
  let status: number
  let ok: boolean
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(target),
      body: JSON.stringify(buildBody(target, prompt, maxTokens)),
      signal: controller.signal
    })
    status = response.status
    ok = response.ok
    // Read the body while the abort timer is still armed. `fetch` resolves as
    // soon as the headers arrive, so clearing the timer here would leave a
    // server that stalls mid-body able to hang this request forever.
    raw = await response.text()
  } catch (err) {
    // An abort otherwise surfaces as an unhelpful "This operation was aborted".
    if (controller.signal.aborted) {
      throw new Error(`请求 ${url} 超时（${REQUEST_TIMEOUT_MS / 1000}s 内没有拿到完整响应）。`)
    }
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
    const described = describeError(payload)
    throw new Error(
      described ?? `HTTP ${status}：${raw.trim().slice(0, 300) || '(空响应)'}`
    )
  }

  // Read the text *before* judging the status: the Responses API reports
  // `status: "incomplete"` when `max_output_tokens` truncates an answer, and
  // that truncated message is still a perfectly good title. Only when there is
  // nothing usable does the status become the error.
  const text = extractText(payload)
  if (!text) {
    const described = describeError(payload)
    if (described) throw new Error(described)
    throw new Error(`无法从模型响应中取到文本：${raw.trim().slice(0, 300) || '(空响应)'}`)
  }

  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : undefined

  return {
    text,
    promptTokens: usage ? asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens) : undefined,
    completionTokens: usage
      ? asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens)
      : undefined
  }
}
