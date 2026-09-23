/**
 * Shared pieces for talking to a model gateway.
 *
 * `llm.ts` (one completion) and `models.ts` (a catalogue read) hit the same gateways
 * and parse the same loosely-shaped JSON, so the narrowing rules and the
 * error-message rules live here once. They had already drifted — the catalogue's
 * own copy could not read a Responses-API failure, so one broken gateway produced
 * two different explanations depending on which call reached it first.
 *
 * Only parsing lives here. Each caller keeps its own request: one POSTs a prompt,
 * the other GETs a list, and their timeouts and headers differ for real reasons.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The version segment Anthropic's API requires on every request. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The credential headers for a protocol.
 *
 * Returned separately from the rest so each caller can add what its own request
 * needs (a completion sends `content-type`, a catalogue read sends `accept`)
 * without repeating the protocol branch.
 */
export function authHeaders(protocol: string, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
  }
  return { authorization: `Bearer ${apiKey}` }
}

/** Turns a provider error payload into a readable message. */
export function describeError(payload: unknown): string | null {
  if (!isRecord(payload)) return null

  const error = payload.error
  if (isRecord(error)) {
    const message = asString(error.message)?.trim() ?? asString(error.type)?.trim()
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error.trim()

  // The Responses API reports failures through `status`/`incomplete_details`.
  if (payload.status === 'failed' || payload.status === 'incomplete') {
    const details = payload.incomplete_details
    if (isRecord(details)) {
      const reason = asString(details.reason)
      if (reason) return `模型返回 ${payload.status}：${reason}`
    }
    return `模型返回 ${payload.status}`
  }

  return null
}
