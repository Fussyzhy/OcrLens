import type { IpcResult } from '@shared/types'

/**
 * Unwraps an IPC envelope, turning `{ ok: false }` into a thrown error.
 *
 * Call sites that want to show a message can catch it; call sites that do not
 * care still get a rejected promise instead of a silent undefined.
 */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.data
}
