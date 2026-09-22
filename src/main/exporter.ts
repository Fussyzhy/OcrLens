import { app, dialog, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExportMarkdownRequest, ExportMarkdownResult } from '@shared/types'

/**
 * Writes a rendered report to a file the user picks.
 *
 * The renderer hands over a finished document (it holds the session data and the
 * filter state, so it is the only party that knows what "the current results"
 * means). Everything else happens here: the destination always comes from a
 * native dialog, and the proposed name is sanitised, so a renderer bug can never
 * turn into a write to an unexpected path.
 */

/** Refuses implausible payloads rather than writing a multi-megabyte file by accident. */
const MAX_BYTES = 32 * 1024 * 1024

/** Keeps the save dialog readable and avoids hitting path-length limits. */
const MAX_NAME_LENGTH = 120

/**
 * Turns an arbitrary proposed name into a safe file name.
 *
 * Only the basename survives, so `../../etc/passwd` becomes `passwd`; Windows
 * shell metacharacters and trailing dots/spaces are dropped because Windows
 * silently mangles or refuses those.
 */
export function safeFileName(proposed: unknown): string {
  const raw = typeof proposed === 'string' ? proposed : ''

  let name = path
    .basename(raw.replace(/[\\/]+/g, path.sep))
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')

  if (!name) name = 'ocr-review.md'

  const withoutExtension = name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
  const capped = withoutExtension.slice(0, MAX_NAME_LENGTH).replace(/[. ]+$/, '').trim()
  return `${capped || 'ocr-review'}.md`
}

/** A directory that exists on every supported platform, with Documents preferred. */
function defaultDirectory(): string {
  for (const key of ['documents', 'downloads', 'home'] as const) {
    try {
      return app.getPath(key)
    } catch {
      // Not every platform defines every key; try the next one.
    }
  }
  return process.cwd()
}

export async function exportMarkdown(
  win: BrowserWindow | null,
  request: ExportMarkdownRequest
): Promise<ExportMarkdownResult> {
  const content = request?.content
  if (typeof content !== 'string') throw new Error('Export payload is missing its Markdown content')

  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_BYTES) {
    throw new Error(`Report is too large to export (${Math.round(bytes / 1024 / 1024)} MB)`)
  }

  const options = {
    title: '导出审查报告',
    defaultPath: path.join(defaultDirectory(), safeFileName(request.suggestedName)),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  }

  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)

  if (result.canceled || !result.filePath) return { filePath: null, bytes: 0, cancelled: true }

  // `showSaveDialog` honours the filter on most platforms, but a user who types
  // `report` in the field can still end up with an extension-less file.
  const target = result.filePath.toLowerCase().endsWith('.md')
    ? result.filePath
    : `${result.filePath}.md`

  try {
    await fs.writeFile(target, content, 'utf8')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not write ${target}: ${detail}`)
  }

  return { filePath: target, bytes, cancelled: false }
}
