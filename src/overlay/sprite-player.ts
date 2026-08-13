import type { Manifest, StateSpec } from '../shared/manifest'
import type { AnimationState, Motion } from '../shared/states'

/**
 * Idle breathing is duty-cycled rather than left running.
 *
 * A CSS transform animation is compositor-driven, but "cheap per frame" is not
 * "free": an animation that never stops makes the GPU and renderer processes
 * produce a frame at display refresh rate forever, which measured at ~6.8% CPU
 * on an idle machine -- over twice the NFR budget, burned while the user isn't
 * even looking.
 *
 * One breath every seven seconds is still legibly alive, and the ~74% of the
 * time with no animation at all composites nothing.
 *
 * Only applied to `breathe`. `bob` and `shake` belong to states that exist only
 * while the user is actively playing music or typing, where continuous motion
 * is the point and the cost is bounded by the activity itself.
 */
const BREATH_MS = 1800
const BREATH_REST_MS = 5200

/**
 * Plays a state's atlas by moving background-position.
 *
 * Two deliberate choices:
 *
 * - Frame stepping uses a timer, not requestAnimationFrame or a CSS steps()
 *   animation. Sequences are arbitrary (typing_fast is a ping-pong 1,2,0,2),
 *   and CSS steps() can only walk an atlas in order. A timer at the state's fps
 *   fires at most 14 times a second, which is far cheaper than a 60Hz rAF loop
 *   that would recompute the same value 4 times out of 5 anyway.
 *
 * - Single-frame states run NO timer at all. A companion sitting perfectly
 *   still while nothing is happening is the correct behaviour and it is how the
 *   idle CPU budget is actually met; the CSS `motion` animation supplies the
 *   pulse of life, on the compositor.
 */
export class SpritePlayer {
  private spec: StateSpec | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private motionTimer: ReturnType<typeof setTimeout> | null = null
  private cursor = 0

  constructor(
    private readonly el: HTMLElement,
    private manifest: Manifest,
    private assetBase: string,
  ) {}

  setCharacter(manifest: Manifest, assetBase: string): void {
    this.manifest = manifest
    this.assetBase = assetBase
    this.spec = null
  }

  play(state: AnimationState): void {
    const spec = this.manifest.states[state]
    if (!spec) {
      console.error(`[sprite] no such state "${state}"`)
      return
    }
    if (this.spec === spec) return
    this.spec = spec
    this.cursor = 0

    this.el.style.backgroundImage = `url("${this.assetBase}${spec.atlas}")`

    this.layout()
    this.stop()
    if (spec.sequence.length > 1) {
      this.timer = setInterval(() => this.step(), 1000 / spec.fps)
    }
    this.applyMotion(spec.motion)
  }

  private applyMotion(motion: Motion): void {
    this.stopMotion()
    if (motion !== 'breathe') {
      this.setMotionClass(motion)
      return
    }
    const breathe = (): void => {
      this.setMotionClass('breathe')
      this.motionTimer = setTimeout(() => {
        this.setMotionClass('none')
        this.motionTimer = setTimeout(breathe, BREATH_REST_MS)
      }, BREATH_MS)
    }
    breathe()
  }

  private setMotionClass(motion: Motion): void {
    this.el.dataset.motion = motion
    // Force a reflow so re-applying the same class restarts the animation
    // instead of being treated as a no-op change.
    void this.el.offsetWidth
  }

  private stopMotion(): void {
    if (this.motionTimer) {
      clearTimeout(this.motionTimer)
      this.motionTimer = null
    }
  }

  /** Recompute atlas geometry for the current element size. */
  layout(): void {
    const spec = this.spec
    if (!spec) return
    const w = this.el.clientWidth
    const h = this.el.clientHeight
    this.el.style.backgroundSize = `${w * spec.frameCount}px ${h}px`
    this.paint()
  }

  private step(): void {
    const spec = this.spec
    if (!spec) return
    this.cursor = (this.cursor + 1) % spec.sequence.length
    this.paint()
  }

  private paint(): void {
    const spec = this.spec
    if (!spec) return
    const frame = spec.sequence[this.cursor] ?? 0
    this.el.style.backgroundPositionX = `${-frame * this.el.clientWidth}px`
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  destroy(): void {
    this.stop()
    this.stopMotion()
  }
}
