/**
 * The animation-state vocabulary, shared by main and renderer.
 *
 * This file is deliberately character-agnostic: it names states, not art. A
 * character manifest must supply every state listed here (validated at load),
 * which is what lets a new character drop in without a code change.
 */

export const ANIMATION_STATES = [
  'idle',
  'typing_calm',
  'typing_fast',
  'music_reactive',
  'dragged',
] as const

export type AnimationState = (typeof ANIMATION_STATES)[number]

/** The state used whenever anything at all goes wrong. Must always exist. */
export const FALLBACK_STATE: AnimationState = 'idle'

export const MOTIONS = ['none', 'breathe', 'bob', 'shake'] as const
export type Motion = (typeof MOTIONS)[number]

/**
 * Music and typing can be true at the same instant, so "what is Dott doing" is
 * a priority question, not a boolean one. Highest priority wins.
 *
 * Ordering rationale: being picked up dominates everything (it's a direct user
 * action). Typing outranks music because typing is also a direct interaction
 * and changes far more often -- if music won, the companion would look inert
 * for the whole time a track was playing.
 */
export const STATE_PRIORITY: readonly AnimationState[] = [
  'dragged',
  'typing_fast',
  'typing_calm',
  'music_reactive',
  'idle',
]

/**
 * Minimum time a state must be held before another may replace it. Without
 * this, a single keystroke during music playback causes a visible snap out of
 * and back into the music state, which reads as a rendering bug.
 */
export const MIN_DWELL_MS = 250

export type TypingLevel = 'none' | 'calm' | 'fast'

export interface Signals {
  /** User is dragging the companion right now. */
  dragging: boolean
  /** Typing cadence bucket, from the input source (M2). */
  typing: TypingLevel
  /** Media is playing, from the Spotify source (M3). */
  music: boolean
  /** Tray "preview state" override, for art review. Bypasses everything. */
  forced: AnimationState | null
}

export const IDLE_SIGNALS: Signals = {
  dragging: false,
  typing: 'none',
  music: false,
  forced: null,
}

/** Pure priority resolution. No timing, no OS, trivially testable. */
export function resolveState(s: Signals): AnimationState {
  if (s.forced) return s.forced
  if (s.dragging) return 'dragged'
  if (s.typing === 'fast') return 'typing_fast'
  if (s.typing === 'calm') return 'typing_calm'
  if (s.music) return 'music_reactive'
  return 'idle'
}
