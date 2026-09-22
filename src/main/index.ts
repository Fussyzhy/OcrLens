import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
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
    autoHideMenuBar: true,
    backgroundColor: '#101014',
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
