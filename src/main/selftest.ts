import { app, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ANIMATION_STATES, type AnimationState } from '../shared/states'
import type { OverlayWindow } from './overlay-window'

/**
 * Headless verification of the overlay's window behaviour and render pipeline.
 *
 * Run with DOTT_SELFTEST=<outdir>. It drives the companion through every
 * animation state, captures each one, records the window flags and memory
 * footprint, then quits.
 *
 * This exists because the things most likely to break on this project are
 * exactly the things a unit test cannot see: whether the window is genuinely
 * transparent, genuinely on top, and whether the atlas actually painted. It
 * also does not need Screen Recording permission, since capturePage reads the
 * window's own compositor output rather than the desktop.
 *
 * On CI this is the natural body of the matrix smoke test: same script, two
 * OSes, compare the reports.
 */

const SETTLE_MS = 900
const STATE_MS = 550

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface SelfTestProbes {
  /** Records whether the input hook came up, so CI captures it per-OS. */
  typingStatus?: () => string
  spotifyStatus?: () => string
}

export async function runSelfTest(
  overlay: OverlayWindow,
  outDir: string,
  probes: SelfTestProbes = {},
): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const win = overlay.win

  // Give the renderer time to fetch the manifest and decode the first atlas.
  await sleep(SETTLE_MS)

  const captures: Record<string, unknown> = {}

  for (const state of ANIMATION_STATES) {
    win.webContents.send('dott:state', state as AnimationState)
    await sleep(STATE_MS)
    const img = await win.webContents.capturePage()
    const file = path.join(outDir, `state-${state}.png`)
    writeFileSync(file, img.toPNG())
    const size = img.getSize()
    const bitmap = img.toBitmap() // BGRA
    let opaque = 0
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i]! > 16) opaque++
    }
    const total = size.width * size.height
    captures[state] = {
      file: path.basename(file),
      size,
      // Proves two things at once: the sprite painted (coverage > 0) and the
      // window is really transparent (coverage well under 100%).
      opaqueCoverage: Number((opaque / Math.max(1, total)).toFixed(4)),
    }
  }

  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const metrics = app.getAppMetrics()
  const rssKb = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0)

  const report = {
    when: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    window: {
      bounds,
      isVisible: win.isVisible(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      isResizable: win.isResizable(),
      isMovable: win.isMovable(),
      isFocusable: win.isFocusable(),
      isFullScreenable: win.isFullScreenable(),
      hasShadow: win.hasShadow(),
    },
    display: {
      id: display.id,
      scaleFactor: display.scaleFactor,
      workArea: display.workArea,
    },
    sources: {
      // 'blocked' on a machine without the OS grant is the expected result and
      // is not a failure: it proves the hook reported cleanly instead of
      // taking the app down with it.
      typing: probes.typingStatus?.() ?? 'off',
      spotify: probes.spotifyStatus?.() ?? 'off',
    },
    memory: {
      processCount: metrics.length,
      // CAUTION: this sum overcounts badly -- workingSetSize counts shared
      // framework pages once per process, reporting ~435MB where the real
      // figure is ~90MB. It is recorded for trend comparison only. The Tauri
      // decision gate keys off phys_footprint (macOS) / Private Working Set
      // (Windows) instead. See EXECUTION-PLAN.md section 2.
      totalWorkingSetMB: Number((rssKb / 1024).toFixed(1)),
      byType: metrics.map((m) => ({
        type: m.type,
        mb: Number(((m.memory?.workingSetSize ?? 0) / 1024).toFixed(1)),
      })),
    },
    captures,
  }

  const reportFile = path.join(outDir, 'report.json')
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[selftest] wrote ${reportFile}`)
  console.log(`[selftest] idle RSS ${report.memory.totalWorkingSetMB}MB across ${metrics.length} processes`)
  app.exit(0)
}
