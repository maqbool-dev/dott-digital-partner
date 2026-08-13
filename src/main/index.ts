import { app, globalShortcut, ipcMain } from 'electron'
import path from 'node:path'
import { StateMachine } from '../shared/state-machine'
import type { AnimationState } from '../shared/states'
import {
  assetBase,
  handleAssetRequests,
  loadManifest,
  registerAssetScheme,
} from './characters'
import { clampSize, loadConfig, saveConfig } from './config'
import { OverlayWindow, preloadFile } from './overlay-window'
import { runSelfTest } from './selftest'
import { createTray } from './tray'
import type { BootPayload } from '../preload/index'

// Must happen before 'ready'.
registerAssetScheme()

// A second instance would spawn a second companion fighting over the same
// config file.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

let overlay: OverlayWindow | null = null
let tray: (Electron.Tray & { rebuild: () => void }) | null = null
let manifest = null as ReturnType<typeof loadManifest> | null
let forced: AnimationState | null = null
const machine = new StateMachine()

function pushState(): void {
  if (!overlay || overlay.win.isDestroyed()) return
  overlay.win.webContents.send('dott:state', machine.state)
  tray?.rebuild()
}

function bootPayload(): BootPayload {
  const cfg = loadConfig()
  return {
    manifest: manifest!,
    assetBase: assetBase(cfg.characterName),
    state: machine.state,
    size: cfg.size,
  }
}

function loadCharacter(name: string): void {
  // A broken character must not take the app down; fall back to whatever is
  // already loaded, or to dott.
  try {
    manifest = loadManifest(name)
    saveConfig({ characterName: name })
  } catch (err) {
    console.error(`[character] failed to load "${name}":`, err)
    if (!manifest) throw err
    return
  }
  overlay?.setManifest(manifest)
  if (overlay && !overlay.win.isDestroyed()) {
    overlay.win.webContents.send('dott:character', bootPayload())
  }
}

function registerHotkey(): void {
  const { hotkey } = loadConfig()
  globalShortcut.unregisterAll()
  const ok = globalShortcut.register(hotkey, () => {
    overlay?.toggleVisible()
    tray?.rebuild()
  })
  if (!ok) console.error(`[hotkey] could not register "${hotkey}" (already taken?)`)
}

app.whenReady().then(() => {
  handleAssetRequests()

  // Tray-only app: no dock icon, no application menu.
  app.dock?.hide()

  const cfg = loadConfig()
  try {
    manifest = loadManifest(cfg.characterName)
  } catch (err) {
    console.error('[boot] character failed to load:', err)
    app.exit(1)
    return
  }

  overlay = new OverlayWindow(manifest, preloadFile())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void overlay.win.loadURL(rendererUrl)
  } else {
    void overlay.win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  overlay.win.once('ready-to-show', () => {
    overlay?.reveal()
    const outDir = process.env.DOTT_SELFTEST
    if (outDir && overlay) void runSelfTest(overlay, outDir)
  })

  ipcMain.handle('dott:boot', () => bootPayload())

  ipcMain.on('dott:set-interactive', (_e, interactive: boolean) => {
    overlay?.setInteractive(Boolean(interactive))
  })

  ipcMain.on('dott:drag-start', () => {
    overlay?.startDrag()
    machine.update({ dragging: true }, Date.now())
    pushState()
  })

  ipcMain.on('dott:drag-end', () => {
    overlay?.endDrag()
    machine.update({ dragging: false }, Date.now())
    pushState()
  })

  ipcMain.on('dott:nudge-size', (_e, delta: number) => {
    const size = overlay?.nudgeSize(Number(delta) || 0)
    if (size != null) overlay?.win.webContents.send('dott:size', size)
    tray?.rebuild()
  })

  tray = createTray({
    onSize: (size) => {
      const applied = overlay?.applySize(clampSize(size))
      if (applied != null) overlay?.win.webContents.send('dott:size', applied)
    },
    onToggleVisible: () => overlay?.toggleVisible(),
    onForceState: (state) => {
      forced = state
      machine.update({ forced: state }, Date.now())
      pushState()
    },
    onCharacter: (name) => loadCharacter(name),
    currentState: () => machine.state,
    forcedState: () => forced,
    isVisible: () => overlay?.win.isVisible() ?? false,
  }) as Electron.Tray & { rebuild: () => void }

  registerHotkey()

  // Dwell-blocked transitions still need to land once their window expires,
  // so the machine is ticked rather than only being poked by signal changes.
  // 200ms is well under human perception for an ambient state change and costs
  // nothing measurable.
  const ticker = setInterval(() => {
    const before = machine.state
    if (machine.tick(Date.now()) !== before) pushState()
  }, 200)

  app.on('will-quit', () => {
    clearInterval(ticker)
    globalShortcut.unregisterAll()
  })
})

app.on('second-instance', () => overlay?.reveal())

// A tray app must survive all windows closing.
app.on('window-all-closed', () => {})
