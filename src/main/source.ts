import fs from 'node:fs'
import path from 'node:path'
import type { FileSnippet } from '@shared/types'

/**
 * Reads source context around a finding from the working tree.
 *
 * A finding records the code as it looked *at review time*. The file may have
 * changed since, so callers must present these lines as "current file content"
 * rather than implying they are the reviewed revision. Where a session has a
 * recorded `resolved_base`, a future version could read from git instead; that
 * needs the git plumbing path and is out of scope for now.
 */

/** Refuses to escape the repository root. */
function resolveInside(repoDir: string, relative: string): string | null {
  const root = path.resolve(repoDir)
  // Findings use forward slashes regardless of platform.
  const target = path.resolve(root, relative.split('/').join(path.sep))
  const withSep = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(withSep)) return null
  return target
}

/** Heuristic binary check on a small prefix, so we never render mojibake. */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000)
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

/**
 * Returns `context` lines on each side of the finding, clamped to the file.
 *
 * `startLine`/`endLine` are 1-based and come straight from the finding.
 */
export async function readSnippet(
  repoDir: string,
  filePath: string,
  startLine: number,
  endLine: number,
  context = 6
): Promise<FileSnippet> {
  const absolute = resolveInside(repoDir, filePath)
  if (!absolute) {
    return { path: filePath, startLine, lines: [], missing: true, error: 'Path escapes the repository' }
  }

  let buffer: Buffer
  try {
    buffer = await fs.promises.readFile(absolute)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      path: filePath,
      startLine,
      lines: [],
      missing: true,
      error: code === 'ENOENT' ? 'File no longer exists in the working tree' : String(err)
    }
  }

  if (looksBinary(buffer)) {
    return { path: filePath, startLine, lines: [], missing: true, error: 'Binary file' }
  }

  const all = buffer.toString('utf8').split(/\r?\n/)
  const from = Math.max(1, startLine - context)
  const to = Math.min(all.length, Math.max(endLine, startLine) + context)

  return {
    path: filePath,
    startLine: from,
    lines: all.slice(from - 1, to)
  }
}

/** Reads a whole file for the "full file" view. Refuses anything oversized. */
export async function readWholeFile(
  repoDir: string,
  filePath: string,
  maxBytes = 2 * 1024 * 1024
): Promise<FileSnippet> {
  const absolute = resolveInside(repoDir, filePath)
  if (!absolute) {
    return { path: filePath, startLine: 1, lines: [], missing: true, error: 'Path escapes the repository' }
  }

  try {
    const stat = await fs.promises.stat(absolute)
    if (stat.size > maxBytes) {
      return {
        path: filePath,
        startLine: 1,
        lines: [],
        missing: true,
        error: `File is ${(stat.size / 1024 / 1024).toFixed(1)} MB; too large to display`
      }
    }
  } catch (err) {
    return { path: filePath, startLine: 1, lines: [], missing: true, error: String(err) }
  }

  return readSnippet(repoDir, filePath, 1, Number.MAX_SAFE_INTEGER, 0)
}
