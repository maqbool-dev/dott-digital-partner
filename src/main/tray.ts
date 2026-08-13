import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import { ANIMATION_STATES, type AnimationState } from '../shared/states'
import { loadConfig, revealConfigFile, saveConfig } from './config'
import { listCharacters } from './characters'
import type { TypingStatus } from './sources/typing'
import type { SpotifyStatus } from './sources/spotify'

export interface TrayHandlers {
  onSize: (size: number) => void
  onToggleVisible: () => void
  onForceState: (state: AnimationState | null) => void
  onCharacter: (name: string) => void
  onToggleTyping: (on: boolean) => void | Promise<void>
  onOpenTypingPermission: () => void
  onToggleSpotify: (on: boolean) => void | Promise<void>
  onSpotifySignOut: () => void
  currentState: () => AnimationState
  forcedState: () => AnimationState | null
  typingStatus: () => TypingStatus
  spotifyStatus: () => SpotifyStatus
  isVisible: () => boolean
}

/**
 * The tray label is the only status surface until there's a settings window,
 * so a hook that failed or was denied has to be legible here -- silence would
 * read as "the feature doesn't work".
 */
const TYPING_STATUS_SUFFIX: Record<TypingStatus, string> = {
  off: '',
  starting: ' (starting…)',
  running: '',
  blocked: ' — needs permission',
  failed: ' — unavailable',
}

const SPOTIFY_STATUS_SUFFIX: Record<SpotifyStatus, string> = {
  off: '',
  connecting: ' (waiting for browser…)',
  connected: '',
  unconfigured: ' — needs setup',
  unauthorized: ' — sign in required',
  error: ' — offline',
}

const SIZE_PRESETS: ReadonlyArray<[string, number]> = [
  ['Tiny (110)', 110],
  ['Small (140)', 140],
  ['Medium (170)', 170],
  ['Large (240)', 240],
  ['Huge (340)', 340],
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
          label: `Typing reactivity${TYPING_STATUS_SUFFIX[h.typingStatus()]}`,
          type: 'checkbox',
          checked: cfg.integrations.typing,
          click: (item) => {
            void h.onToggleTyping(item.checked)
            rebuild()
          },
        },
        ...(h.typingStatus() === 'blocked'
          ? [
              {
                label: 'Open Input Monitoring settings…',
                click: () => h.onOpenTypingPermission(),
              },
            ]
          : []),
        {
          label: `Spotify reactivity${SPOTIFY_STATUS_SUFFIX[h.spotifyStatus()]}`,
          type: 'checkbox',
          checked: cfg.integrations.spotify,
          click: (item) => {
            void h.onToggleSpotify(item.checked)
            rebuild()
          },
        },
        ...(h.spotifyStatus() === 'connected' || h.spotifyStatus() === 'unauthorized'
          ? [
              {
                label: 'Sign out of Spotify',
                click: () => {
                  h.onSpotifySignOut()
                  rebuild()
                },
              },
            ]
          : []),
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
        {
          // Both integrations need values hand-edited into config.json, and the
          // path differs between a packaged build and `npm run dev`. Opening it
          // from the running instance removes the guesswork entirely.
          label: 'Edit config file…',
          click: () => void revealConfigFile(),
        },
        { type: 'separator' },
        { label: 'Quit Dott', role: 'quit' },
      ]),
    )
  }

  rebuild()
  return Object.assign(tray, { rebuild }) as Tray & { rebuild: () => void }
}
