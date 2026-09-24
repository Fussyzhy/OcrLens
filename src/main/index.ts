import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/types'
import { ensureEnv } from './env'
import { appIcon } from './icon'
import { cancelAllRuns, registerIpc } from './ipc'
import { destroyTray, installCloseToTray, installTray, markQuitting } from './tray'

/**
 * Application bootstrap.
 *
 * Environment probing (which git and which ocr we will use) is kicked off in the
 * background rather than awaited before the window opens: resolving git spins up
 * throwaway repositories, and the UI should not sit blank while that happens. The
 * renderer awaits `env:info`, which shares the same in-flight probe.
 */

let mainWindow: BrowserWindow | null = null

/**
 * Pins the app's own data directory, then names the app.
 *
 * The order matters, and getting it wrong is silent. Electron derives the
 * `userData` path from the app name, and **`app.setName` invalidates that cached
 * path** — so name first leaves the directory at %APPDATA%\OcrLens, and every
 * file the README documents (%APPDATA%\ocr-client\settings.json,
 * session-titles.json, session-trash\, config-backups\) appears to be lost the
 * first time someone runs a packaged build. Reading the path first and pinning it
 * back with `setPath` keeps a development run and a packaged build on the one
 * directory, with no migration step.
 *
 * This is deliberately unconditional. `scripts/probe-rails.cjs` already points
 * `userData` at a throwaway directory before this module is ever loaded, so the
 * read below returns that directory and pinning it again is a no-op — the probe's
 * isolation survives. (Its comment "must happen before the app's own modules ask
 * for a path" is exactly this contract.)
 *
 * The cost of the rename is one orphaned %LOCALAPPDATA%\OcrLens cache directory;
 * caches live under the app name and are not what `userData` points at.
 */
const userDataDir = app.getPath('userData')
app.setPath('userData', userDataDir)
app.setName('OcrLens')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    // Frameless: the renderer draws the window's bar (components/TitleBar.vue)
    // and drives it over the window:* channels. `thickFrame` keeps its default,
    // so Windows still has the resize border, the shadow and Aero Snap.
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    // Window and taskbar icon (see appIcon in ./icon for the two locations).
    icon: appIcon(),
    title: 'OcrLens',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Hardened defaults: the renderer never touches fs or child_process, it
      // only calls the typed surface exposed by the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Closing the window hides it rather than ending the process (see the tray),
      // and the renderer keeps working while hidden: it owns the run log and the
      // title queue, so a throttled background page would stall them until the
      // window came back.
      backgroundThrottling: false
    }
  })

  // Avoid a flash of unstyled content while Vue mounts.
  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // The renderer draws the maximise button, so it has to hear about the state
  // changes it did not cause: a double-click on the drag region, Win+Up, a snap.
  const reportMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.windowMaximized, mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', reportMaximized)
  mainWindow.on('unmaximize', reportMaximized)

  // Any target="_blank" or window.open goes to the OS browser, never a new
  // Electron window with our privileges.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)

    // Development only: F12 toggles DevTools.
    //
    // The window is frameless and its menu bar is hidden, so there is no
    // View → Toggle Developer Tools to click. `preventDefault` keeps the key from
    // reaching the page (where F12 does nothing today, but a future renderer
    // binding should not have to compete with this), and auto-repeat is ignored so
    // holding the key does not flicker the panel open and shut.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12' || input.isAutoRepeat) return
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Close means "put it away": the tray owns the real exit. See main/tray.ts.
  installCloseToTray(mainWindow)
}

app.whenReady().then(() => {
  registerIpc(() => mainWindow)
  createWindow()
  // Created after the window so the tray's own 打开 has something to show; it
  // survives the window being hidden all day.
  installTray(
    () => mainWindow,
    () => createWindow()
  )

  // Warm the cache so the renderer's first env:info resolves immediately.
  void ensureEnv().catch((err) => console.error('environment probe failed:', err))

  app.on('activate', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (!existing) {
      createWindow()
      return
    }
    // Windows can activate a hidden window (a second launch, the tray), and it
    // must not come back as a taskbar entry with no window behind it.
    existing.show()
    existing.focus()
  })
})

app.on('window-all-closed', () => {
  // Reviews spawn git helpers; do not leave them running after the UI is gone.
  cancelAllRuns()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Set before anything else: the window's close handler consults it, and this is
  // the one place every quit path — tray, Alt+F4, OS shutdown — passes through.
  markQuitting()
  destroyTray()
  cancelAllRuns()
})
