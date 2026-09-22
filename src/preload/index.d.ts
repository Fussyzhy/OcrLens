import type { OcrApiSurface } from '@shared/api'

/**
 * Makes `window.ocr` visible to the renderer's TypeScript project.
 *
 * The interface is defined in shared/api so this file needs no Electron types.
 */
declare global {
  interface Window {
    ocr: OcrApiSurface
  }
}

export {}
