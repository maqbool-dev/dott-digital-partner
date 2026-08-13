import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * Local config. Deliberately hand-rolled rather than electron-store: it is
 * ~60 lines, has no ESM/CJS interop risk in the main bundle, and the atomic
 * write plus zod validation are the only two features actually needed.
 *
 * Position is stored as a display id plus ratios, never absolute pixels.
 * Absolute coordinates strand the companion off-screen the first time a
 * monitor is unplugged or a resolution changes.
 */

export const PositionSchema = z.object({
  displayId: z.number(),
  xRatio: z.number(),
  yRatio: z.number(),
})

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  characterName: z.string().default('dott'),
  /**
   * Window height in DIP. Width follows from the character's aspect ratio.
   *
   * 170 is deliberately modest: this thing sits on top of everything, all day.
   * Ambient presence is the goal, not a mascot that competes with the work.
   * Users who want more can scale up to 512 via ctrl+scroll or the tray.
   */
  size: z.number().min(64).max(512).default(170),
  position: PositionSchema.nullable().default(null),
  /** Every context integration is opt-in and off by default (FR-13). */
  integrations: z
    .object({
      typing: z.boolean().default(false),
      spotify: z.boolean().default(false),
    })
    .default({ typing: false, spotify: false }),
  /**
   * Spotify app credentials. The client ID is not a secret — PKCE exists so a
   * public client doesn't need one — so it belongs in plain config. The
   * refresh token does not: that lives OS-encrypted, see secure-store.ts.
   *
   * The port is configurable because Spotify demands an exact-match redirect
   * URI, so a port collision can only be resolved by changing both sides.
   */
  spotify: z
    .object({
      clientId: z.string().default(''),
      port: z.number().int().min(1024).max(65535).default(8888),
    })
    .default({ clientId: '', port: 8888 }),
  hotkey: z.string().default('CommandOrControl+Shift+D'),
  launchAtLogin: z.boolean().default(false),
})

export type Config = z.infer<typeof ConfigSchema>
export type Position = z.infer<typeof PositionSchema>

export const SIZE_MIN = 64
export const SIZE_MAX = 512

let cached: Config | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): Config {
  if (cached) return cached
  const file = configPath()
  let raw: unknown = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      // A corrupt config must never be fatal for a background app; fall back
      // to defaults and let the next save overwrite it.
      console.error('[config] unreadable, using defaults:', err)
      raw = {}
    }
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    console.error('[config] invalid, using defaults:', parsed.error.issues)
    cached = ConfigSchema.parse({})
  } else {
    cached = parsed.data
  }
  return cached
}

export function saveConfig(patch: Partial<Config>): Config {
  const next = ConfigSchema.parse({ ...loadConfig(), ...patch })
  cached = next
  const file = configPath()
  mkdirSync(path.dirname(file), { recursive: true })
  // Write-then-rename so a crash mid-write can't truncate the real file.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

export function clampSize(n: number): number {
  return Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)))
}
