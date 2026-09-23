/**
 * One row of a dropdown: what choosing it writes, and what it reads as.
 *
 * Kept as a pair rather than a plain string because the value is not always
 * presentable — a commit is picked by full hash but shown as `abc1234 · subject`,
 * and the empty string is a real choice ("请选择…", "使用配置默认") rather than a
 * missing one.
 */
export interface SelectOption {
  value: string
  label: string
}

/**
 * What a closed dropdown shows.
 *
 * Falls back to the stored value when the list does not mention it: `ocr` accepts
 * protocol names and models this client has never heard of, and a control that
 * renders those as blank invites the user to overwrite them with something
 * arbitrary.
 */
export function optionLabel(options: SelectOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value
}
