/**
 * Copies text to the clipboard.
 *
 * `navigator.clipboard` needs a secure context, which both `file://` (production)
 * and the Vite dev server satisfy in Chromium — but the async API can still be
 * rejected by permissions policy, so there is a synchronous fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
