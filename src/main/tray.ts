import { app, BrowserWindow, Menu, Notification, Tray, nativeImage } from 'electron'
import { appIcon } from './icon'

/**
 * The tray icon, and the rule that closing the window only puts it away.
 *
 * A review runs for minutes inside `ocr` and the window is merely a view of it, so
 * the close button hides the window instead of ending the process; quitting is an
 * explicit choice in the tray menu. `quitting` is the flag that lets the very same
 * close path through when the app really is going away — the tray's own 退出, an
 * OS shutdown, Alt+F4 after `before-quit` has already fired.
 *
 * Deliberately a separate module from `index.ts`: the window creates the tray and
 * the tray needs the window back, and passing the two callbacks in keeps that from
 * becoming an import cycle.
 */

let tray: Tray | null = null
let quitting = false
let toldAboutTray = false

/** Leaves with the process: a tray that outlives it is a ghost icon on Windows. */
export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/**
 * Brings the window back, creating it if something already destroyed it.
 *
 * A hidden window has no taskbar button, so this is the only way back in — which
 * is also why the tray is created even when the window failed to open.
 */
function showWindow(getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * The tray's own copy of the icon.
 *
 * `resources/icon.png` is a 1254px square fit for the taskbar and the installer;
 * handed to the tray as-is, Windows scales it down badly, so it is resized once
 * here. An empty image (a build that forgot to copy the file) is reported rather
 * than thrown: the tray still works, it just has no picture.
 */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(appIcon())
  if (image.isEmpty()) {
    console.error(`tray icon not found at ${appIcon()}`)
    return image
  }
  return image.resize({ width: 16, height: 16 })
}

export function installTray(
  getWindow: () => BrowserWindow | null,
  createWindow: () => void
): void {
  if (tray) return

  tray = new Tray(trayImage())
  tray.setToolTip('OcrLens')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 OcrLens', click: () => showWindow(getWindow, createWindow) },
      { type: 'separator' },
      {
        label: '退出 OcrLens',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )

  // Left click is the obvious way back; the menu is on the right button.
  tray.on('click', () => showWindow(getWindow, createWindow))
  tray.on('double-click', () => showWindow(getWindow, createWindow))
}

/**
 * Makes the window's close button hide it instead of ending the process.
 *
 * Installed on the window rather than on the renderer's close button, so every way
 * of closing it behaves the same: the title bar's ✕, Alt+F4, the taskbar menu, and
 * `win.close()` from anywhere in the main process.
 */
export function installCloseToTray(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (quitting) return

    event.preventDefault()
    win.hide()

    // A window that vanishes while a review is still running reads as a crash, so
    // say once per app run where it went — after that the tray icon is the answer.
    if (!toldAboutTray) {
      toldAboutTray = true
      if (Notification.isSupported()) {
        new Notification({
          title: 'OcrLens 仍在运行',
          body: '窗口已最小化到托盘。点击托盘图标回到窗口，或从托盘菜单退出。',
          silent: true
        }).show()
      }
    }
  })
}

/** Lets the next close through; called from `before-quit`. */
export function markQuitting(): void {
  quitting = true
}
