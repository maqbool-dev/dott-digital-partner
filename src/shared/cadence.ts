import type { TypingLevel } from './states'

/**
 * Turns a stream of keystroke *timestamps* into a coarse typing level.
 *
 * No key values ever reach this file -- it counts events in a trailing window
 * and nothing else. That is the whole feature: a frequency counter, not a
 * logger.
 *
 * Thresholds are in keystrokes per minute. Converting from the more familiar
 * words-per-minute needs ~6 keystrokes per word (5 characters plus a space),
 * which is the step that's easy to get wrong: 280kpm sounds fast but is only
 * ~47wpm, i.e. ordinary typing, which would have left `typing_calm` almost
 * unreachable. 360kpm is ~60wpm.
 */
export const CADENCE = {
  /** Trailing window the rate is measured over. */
  windowMs: 3000,
  /** No keystroke for this long drops straight to `none`. */
  idleAfterMs: 2500,
  /** Rate at which `calm` becomes `fast`. ~60wpm. */
  fastEnterKpm: 360,
  /**
   * Rate at which `fast` falls back to `calm`. ~43wpm.
   *
   * The gap between enter and exit is not optional. With a single threshold,
   * typing that hovers near it flips the animation several times a second and
   * reads as a rendering bug rather than a reaction.
   */
  fastExitKpm: 260,
} as const

export class CadenceClassifier {
  private times: number[] = []
  private fast = false

  /** Record a keystroke. The argument is a timestamp and nothing else. */
  push(now: number): void {
    this.times.push(now)
    this.prune(now)
  }

  level(now: number): TypingLevel {
    this.prune(now)
    const last = this.times[this.times.length - 1]
    if (last === undefined || now - last >= CADENCE.idleAfterMs) {
      this.fast = false
      return 'none'
    }

    const kpm = (this.times.length * 60_000) / CADENCE.windowMs
    this.fast = this.fast ? kpm > CADENCE.fastExitKpm : kpm >= CADENCE.fastEnterKpm
    return this.fast ? 'fast' : 'calm'
  }

  reset(): void {
    this.times = []
    this.fast = false
  }

  private prune(now: number): void {
    const cutoff = now - CADENCE.windowMs
    let i = 0
    while (i < this.times.length && this.times[i]! < cutoff) i++
    if (i > 0) this.times.splice(0, i)
  }
}
