import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import { ANIMATION_STATES, type AnimationState } from '../shared/states'
import { loadConfig, saveConfig } from './config'
import { listCharacters } from './characters'

export interface TrayHandlers {
  onSize: (size: number) => void
  onToggleVisible: () => void
  onForceState: (state: AnimationState | null) => void
  onCharacter: (name: string) => void
  currentState: () => AnimationState
  forcedState: () => AnimationState | null
  isVisible: () => boolean
}

const SIZE_PRESETS: ReadonlyArray<[string, number]> = [
  ['Small (120)', 120],
  ['Medium (240)', 240],
  ['Large (360)', 360],
  ['Huge (480)', 480],
]

function trayIcon(): Electron.NativeImage {
  const file = path.join(__dirname, '../../build/tray.png')
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return nativeImage.createEmpty()
  return img.resize({ width: 18, height: 18 })
}

export function createTray(h: TrayHandlers): Tray {
  const tray = new Tray(trayIcon())
  tray.setToolTip('Dott — desk companion')

  const rebuild = (): void => {
    const cfg = loadConfig()
    const forced = h.forcedState()

    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Dott — ${h.currentState()}`, enabled: false },
        { type: 'separator' },
        {
          label: h.isVisible() ? 'Hide companion' : 'Show companion',
          accelerator: cfg.hotkey,
          click: () => {
            h.onToggleVisible()
            rebuild()
          },
        },
        {
          label: 'Size',
          submenu: SIZE_PRESETS.map(([label, size]) => ({
            label,
            type: 'radio' as const,
            checked: cfg.size === size,
            click: () => {
              h.onSize(size)
              rebuild()
            },
          })),
        },
        {
          label: 'Character',
          submenu: listCharacters().map((name) => ({
            label: name,
            type: 'radio' as const,
            checked: cfg.characterName === name,
            click: () => {
              h.onCharacter(name)
              rebuild()
            },
          })),
        },
        { type: 'separator' },
        {
          // Art-review affordance: forces a state so every animation can be
          // eyeballed without needing Spotify running or typing at 90wpm.
          label: 'Preview state',
          submenu: [
            {
              label: 'Automatic',
              type: 'radio' as const,
              checked: forced === null,
              click: () => {
                h.onForceState(null)
                rebuild()
              },
            },
            { type: 'separator' as const },
            ...ANIMATION_STATES.map((s) => ({
              label: s,
              type: 'radio' as const,
              checked: forced === s,
              click: () => {
                h.onForceState(s)
                rebuild()
              },
            })),
          ],
        },
        { type: 'separator' },
        {
          label: 'Typing reactivity',
          type: 'checkbox',
          checked: cfg.integrations.typing,
          // M2. Kept visible but disabled so the privacy-sensitive feature is
          // discoverable before it is implemented, not bolted on silently.
          enabled: false,
          click: () => {},
        },
        {
          label: 'Spotify reactivity',
          type: 'checkbox',
          checked: cfg.integrations.spotify,
          enabled: false, // M3
          click: () => {},
        },
        { type: 'separator' },
        {
          label: 'Launch at login',
          type: 'checkbox',
          checked: cfg.launchAtLogin,
          click: (item) => {
            saveConfig({ launchAtLogin: item.checked })
            app.setLoginItemSettings({ openAtLogin: item.checked })
            rebuild()
          },
        },
        { type: 'separator' },
        { label: 'Quit Dott', role: 'quit' },
      ]),
    )
  }

  rebuild()
  return Object.assign(tray, { rebuild }) as Tray & { rebuild: () => void }
}
