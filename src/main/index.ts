import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { IPC } from '@shared/types'
import { ensureEnv } from './env'
import { cancelAllRuns, registerIpc } from './ipc'

/**
 * Application bootstrap.
 *
 * Environment probing (which git and which ocr we will use) is kicked off in the
 * background rather than awaited before the window opens: resolving git spins up
 * throwaway repositories, and the UI should not sit blank while that happens. The
 * renderer awaits `env:info`, which shares the same in-flight probe.
 */

let mainWindow: BrowserWindow | null = null

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
    // Window and taskbar icon. `resources/` sits beside the built main bundle
    // in development; a packaged build would have to copy it in explicitly.
    icon: path.join(__dirname, '../../resources/icon.png'),
    title: 'OcrLens',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Hardened defaults: the renderer never touches fs or child_process, it
      // only calls the typed surface exposed by the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerIpc(() => mainWindow)
  createWindow()

  // Warm the cache so the renderer's first env:info resolves immediately.
  void ensureEnv().catch((err) => console.error('environment probe failed:', err))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Reviews spawn git helpers; do not leave them running after the UI is gone.
  cancelAllRuns()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cancelAllRuns()
})
