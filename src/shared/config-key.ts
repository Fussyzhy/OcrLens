/**
 * What may appear in an ocr config key, and therefore in a channel name.
 *
 * Shared rather than duplicated because three places have to agree: the main
 * process builds dotted keys from a channel name and hands them to the CLI, and the
 * settings form refuses to submit a name the write would reject. When the two rules
 * were written out separately, a channel name could pass the form and fail the
 * write — or worse, pass validation somewhere that then smuggled extra characters
 * into `ocr config set`.
 */
export const CONFIG_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/

/** True when `value` is usable as a config key or a channel name. */
export function isValidConfigKey(value: string): boolean {
  return CONFIG_KEY_PATTERN.test(value)
}
