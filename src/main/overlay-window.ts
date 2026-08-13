import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { aspectRatio, type Manifest } from '../shared/manifest'
import { clampSize, loadConfig, saveConfig, type Position } from './config'

/**
 * The overlay window and every platform quirk that goes with it.
 *
 * The quirks are the actual content of this file; the window creation itself is
 * three lines. Each one below cost real debugging time somewhere, so they are
 * documented rather than left as mystery flags.
 */

export class OverlayWindow {
  readonly win: BrowserWindow
  private dragTimer: NodeJS.Timeout | null = null
  private lastCursor: { x: number; y: number } | null = null

  constructor(
    private manifest: Manifest,
    preloadPath: string,
  ) {
    const size = loadConfig().size
    const { width, height } = this.dimensionsFor(size)

    this.win = new BrowserWindow({
      width,
      height,
      transparent: true,
      frame: false,
      // Windows cannot natively resize a transparent window at all, so resizing
      // is done entirely through setBounds(). Declaring it non-resizable up
      // front keeps the two platforms on the same code path.
      resizable: false,
      // We implement dragging ourselves (cursor polling in startDrag) so the
      // native drag machinery stays out of the way.
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      // A companion that takes keyboard focus would steal it from the editor
      // the user is typing in — an instant-uninstall bug.
      // NOTE: verify on Windows; some Electron versions have treated
      // focusable:false as "no input at all" there.
      focusable: false,
      fullscreenable: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The overlay is almost never the focused window. Chromium would
        // throttle its timers to ~1fps, freezing the animation.
        backgroundThrottling: false,
      },
    })

    // 'screen-saver' is the level that actually floats above full-screen-ish
    // windows; the default 'floating' loses to too many things.
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Click-through by default. `forward: true` keeps mousemove flowing to the
    // renderer so it can still detect hover over the sprite and re-enable
    // mouse events for the hit region only.
    this.win.setIgnoreMouseEvents(true, { forward: true })

    // Never navigate the overlay anywhere; open external links in the browser.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    this.restorePosition()
  }

  private dimensionsFor(size: number): { width: number; height: number } {
    const height = clampSize(size)
    return { width: Math.round(height * aspectRatio(this.manifest)), height }
  }

  setManifest(manifest: Manifest): void {
    this.manifest = manifest
    this.applySize(loadConfig().size)
  }

  /** Resize about the bottom-centre anchor so Dott's feet stay put. */
  applySize(next: number): number {
    const size = clampSize(next)
    const { width, height } = this.dimensionsFor(size)
    const b = this.win.getBounds()
    const cx = b.x + b.width / 2
    const bottom = b.y + b.height
    this.win.setBounds({
      x: Math.round(cx - width / 2),
      y: Math.round(bottom - height),
      width,
      height,
    })
    saveConfig({ size })
    this.persistPosition()
    return size
  }

  nudgeSize(delta: number): number {
    return this.applySize(loadConfig().size + delta)
  }

  setInteractive(interactive: boolean): void {
    this.win.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  /**
   * Drag by polling the OS cursor from the main process rather than trusting
   * renderer screenX/screenY. getCursorScreenPoint() and setBounds() are both
   * in DIP, so this stays correct under mixed-DPI multi-monitor setups where
   * renderer coordinates would need manual scale-factor conversion.
   */
  startDrag(): void {
    if (this.dragTimer) return
    this.lastCursor = screen.getCursorScreenPoint()
    this.dragTimer = setInterval(() => {
      const p = screen.getCursorScreenPoint()
      const prev = this.lastCursor
      if (!prev) return
      const dx = p.x - prev.x
      const dy = p.y - prev.y
      if (dx !== 0 || dy !== 0) {
        const b = this.win.getBounds()
        this.win.setBounds({ ...b, x: b.x + dx, y: b.y + dy })
        this.lastCursor = p
      }
    }, 16)
  }

  endDrag(): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    this.lastCursor = null
    this.persistPosition()
  }

  /** Store display id + ratios, never absolute pixels. */
  private persistPosition(): void {
    const b = this.win.getBounds()
    const display = screen.getDisplayMatching(b)
    const wa = display.workArea
    saveConfig({
      position: {
        displayId: display.id,
        xRatio: (b.x - wa.x) / Math.max(1, wa.width),
        yRatio: (b.y - wa.y) / Math.max(1, wa.height),
      },
    })
  }

  private restorePosition(): void {
    const cfg = loadConfig()
    const b = this.win.getBounds()
    const saved: Position | null = cfg.position
    const displays = screen.getAllDisplays()
    // If the saved display is gone (laptop undocked), fall back to primary
    // rather than restoring onto coordinates that no longer exist.
    const display =
      displays.find((d) => d.id === saved?.displayId) ?? screen.getPrimaryDisplay()
    const wa = display.workArea

    let x: number
    let y: number
    if (saved) {
      x = Math.round(wa.x + saved.xRatio * wa.width)
      y = Math.round(wa.y + saved.yRatio * wa.height)
    } else {
      // First run: bottom-right, clear of the corner.
      x = wa.x + wa.width - b.width - 32
      y = wa.y + wa.height - b.height - 32
    }

    // Clamp so at least part of the companion is always reachable.
    x = Math.min(Math.max(x, wa.x - b.width / 2), wa.x + wa.width - b.width / 2)
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - b.height / 2)
    this.win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height })
  }

  toggleVisible(): boolean {
    if (this.win.isVisible()) {
      this.win.hide()
      return false
    }
    this.win.showInactive()
    this.win.setAlwaysOnTop(true, 'screen-saver')
    return true
  }

  /** showInactive, never show: showing must not pull focus from the editor. */
  reveal(): void {
    this.win.showInactive()
  }

  destroy(): void {
    this.endDrag()
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}

export function preloadFile(): string {
  return path.join(__dirname, '../preload/index.js')
}
