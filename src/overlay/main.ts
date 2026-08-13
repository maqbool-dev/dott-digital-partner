import type { BootPayload, DottApi } from '../preload/index'
import type { Manifest } from '../shared/manifest'
import type { AnimationState } from '../shared/states'
import { SpritePlayer } from './sprite-player'

declare global {
  interface Window {
    dott: DottApi
  }
}

const spriteEl = document.getElementById('sprite') as HTMLDivElement
const hitEl = document.getElementById('hit') as HTMLDivElement
const api = window.dott

let player: SpritePlayer | null = null
let manifest: Manifest | null = null
let state: AnimationState = 'idle'
let interactive = false
let dragging = false

/**
 * Position the hit region from the current state's manifest hitBox.
 *
 * This is what makes FR-3 real: the window is click-through everywhere, and
 * only the rectangle Dott actually occupies swallows clicks. Using the whole
 * window would block a column of the user's screen — the exact thing the
 * requirement exists to prevent.
 */
function layoutHit(): void {
  if (!manifest) return
  const box = manifest.states[state]?.hitBox
  if (!box) return
  hitEl.style.left = `${box.x * 100}%`
  hitEl.style.top = `${box.y * 100}%`
  hitEl.style.width = `${box.w * 100}%`
  hitEl.style.height = `${box.h * 100}%`
}

function setInteractive(next: boolean): void {
  if (next === interactive) return
  interactive = next
  api.setInteractive(next)
}

function pointInHit(x: number, y: number): boolean {
  const r = hitEl.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function apply(payload: BootPayload): void {
  manifest = payload.manifest
  state = payload.state
  if (!player) {
    player = new SpritePlayer(spriteEl, payload.manifest, payload.assetBase)
  } else {
    player.setCharacter(payload.manifest, payload.assetBase)
  }
  player.play(state)
  layoutHit()
}

async function boot(): Promise<void> {
  apply(await api.boot())

  api.onState((next) => {
    state = next
    player?.play(next)
    layoutHit()
  })

  api.onCharacter((payload) => apply(payload))

  api.onSize(() => {
    // The window resize event also fires; this exists so a size change with no
    // visual resize (same aspect) still relayouts.
    player?.layout()
    layoutHit()
  })
}

window.addEventListener('resize', () => {
  player?.layout()
  layoutHit()
})

/**
 * Hover tracking. With setIgnoreMouseEvents(true, {forward: true}) the window
 * passes clicks through but still receives mousemove, so the renderer can watch
 * the cursor and flip interactivity on only while it is over Dott.
 */
window.addEventListener('mousemove', (e) => {
  if (dragging) return
  setInteractive(pointInHit(e.clientX, e.clientY))
})

// Fast exits can outrun mousemove; make leaving the window unconditionally
// return to click-through so the overlay can never get stuck grabbing input.
document.addEventListener('mouseleave', () => {
  if (!dragging) setInteractive(false)
})

hitEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  dragging = true
  hitEl.classList.add('dragging')
  // Pointer capture keeps move/up events coming even when the cursor leaves the
  // window mid-drag, which it will, constantly.
  hitEl.setPointerCapture(e.pointerId)
  api.dragStart()
  e.preventDefault()
})

const endDrag = (e: PointerEvent): void => {
  if (!dragging) return
  dragging = false
  hitEl.classList.remove('dragging')
  if (hitEl.hasPointerCapture(e.pointerId)) hitEl.releasePointerCapture(e.pointerId)
  api.dragEnd()
  setInteractive(pointInHit(e.clientX, e.clientY))
}

hitEl.addEventListener('pointerup', endDrag)
hitEl.addEventListener('pointercancel', endDrag)

// Cmd/Ctrl + wheel resizes. Plain wheel is left alone so scrolling over Dott
// still reaches whatever is underneath him.
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    if (!pointInHit(e.clientX, e.clientY)) return
    e.preventDefault()
    api.nudgeSize(e.deltaY < 0 ? 12 : -12)
  },
  { passive: false },
)

void boot()
