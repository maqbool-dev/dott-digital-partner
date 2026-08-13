import {
  FALLBACK_STATE,
  IDLE_SIGNALS,
  MIN_DWELL_MS,
  resolveState,
  type AnimationState,
  type Signals,
} from './states'

/**
 * Holds the current signal set and enforces dwell time on transitions.
 *
 * Time is injected rather than read from Date.now() so the whole thing is
 * testable without fake timers. The only OS-aware part of the animation
 * pipeline is the sources that push signals in.
 */
export class StateMachine {
  private signals: Signals = { ...IDLE_SIGNALS }
  private current: AnimationState = FALLBACK_STATE
  private changedAt = Number.NEGATIVE_INFINITY

  constructor(private readonly minDwellMs: number = MIN_DWELL_MS) {}

  get state(): AnimationState {
    return this.current
  }

  /**
   * Merge new signals and return the resulting state.
   *
   * `dragged` bypasses dwell entirely: a drag is a direct manipulation and any
   * delay in responding to it feels broken in a way that a 250ms wait on an
   * ambient state does not.
   */
  update(patch: Partial<Signals>, now: number): AnimationState {
    this.signals = { ...this.signals, ...patch }
    return this.settle(now)
  }

  /**
   * Re-evaluate without changing signals. The caller ticks this so a state
   * that was blocked by dwell still lands once the window expires, instead of
   * waiting for the next unrelated signal change.
   */
  tick(now: number): AnimationState {
    return this.settle(now)
  }

  private settle(now: number): AnimationState {
    const target = resolveState(this.signals)
    if (target === this.current) return this.current

    const immediate = target === 'dragged' || this.current === 'dragged'
    if (!immediate && now - this.changedAt < this.minDwellMs) {
      return this.current
    }

    this.current = target
    this.changedAt = now
    return this.current
  }
}
