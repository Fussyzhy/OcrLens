import path from 'node:path'
import { app } from 'electron'

/**
 * Where the app icon lives, in the two shapes this app runs in.
 *
 * Packaged, electron-builder copies `resources/icon.png` to the app's resources
 * directory (`extraResources` in electron-builder.yml), i.e. beside `app.asar`
 * rather than inside it, and `process.resourcesPath` is that directory.
 *
 * Unpackaged (`yarn dev`, `yarn start`, and the `smoke`/`probe`/`video` scripts,
 * which all load `out/` directly), the main bundle is `out/main/index.js`, so the
 * project root is two levels up from `__dirname`.
 *
 * Getting this wrong is silent: the tray falls back to an empty image and the
 * window quietly keeps the default Electron icon, so both call sites go through
 * here instead of duplicating the path.
 */
export function appIcon(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'icon.png')
  }
  return path.join(__dirname, '../../resources/icon.png')
}
