/**
 * Pure Spotify logic: response interpretation and poll scheduling.
 *
 * Deliberately free of Node and Electron imports so the decision-making can be
 * tested without a network, a token, or a browser. Everything that touches the
 * OS lives in src/main/sources/spotify.ts.
 */

export type PlaybackResult =
  /** Something is actively playing. */
  | { kind: 'playing' }
  /** Connected and working, but nothing is playing (paused, stopped, or no device). */
  | { kind: 'stopped' }
  /** Access token expired or revoked — refresh, don't retry. */
  | { kind: 'unauthorized' }
  /** Hit the rate limiter. Retry-After is authoritative when present. */
  | { kind: 'rateLimited'; retryAfterSec?: number }
  /** Anything else: server error, network failure, garbage body. */
  | { kind: 'error'; status: number }

/**
 * Interpret a `GET /v1/me/player` response.
 *
 * The case worth knowing about is **204 No Content**, which Spotify returns
 * when no device is active. It carries no body, so treating "not 200" as an
 * error would misreport the single most common non-playing state as a fault
 * and drive pointless backoff.
 */
export function parsePlayback(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): PlaybackResult {
  if (status === 204) return { kind: 'stopped' }

  if (status === 200) {
    if (typeof body !== 'object' || body === null) return { kind: 'stopped' }
    const b = body as { is_playing?: unknown }
    return b.is_playing === true ? { kind: 'playing' } : { kind: 'stopped' }
  }

  if (status === 401) return { kind: 'unauthorized' }

  if (status === 429) {
    const raw = retryAfterHeader != null ? Number(retryAfterHeader) : NaN
    return Number.isFinite(raw) && raw >= 0
      ? { kind: 'rateLimited', retryAfterSec: raw }
      : { kind: 'rateLimited' }
  }

  return { kind: 'error', status }
}

export const POLL = {
  /** While playing: fast enough that pausing feels responsive. */
  playingMs: 4_000,
  /**
   * While stopped: slow. Nothing is going to change without the user acting,
   * and this is the state the app sits in for most of the day.
   */
  stoppedMs: 30_000,
  /** First retry delay after a failure; doubles from here. */
  errorBaseMs: 5_000,
  /** Ceiling for both backoff and rate-limit waits. */
  maxMs: 60_000,
} as const

/**
 * How long to wait before the next poll.
 *
 * Adaptive rather than fixed because a constant 4s poll would be the single
 * largest idle cost in the app — 900 needless HTTPS requests an hour while
 * nothing plays, against a <2–3% CPU budget.
 */
export function nextPollDelay(opts: {
  playing: boolean
  consecutiveErrors: number
  retryAfterSec?: number
}): number {
  if (opts.retryAfterSec != null) {
    // Honour the server. Clamp so a hostile or absurd value can't park polling
    // for hours, and add a second of margin so we don't retry a tick early.
    return Math.min(POLL.maxMs, Math.max(0, opts.retryAfterSec) * 1000 + 1_000)
  }

  if (opts.consecutiveErrors > 0) {
    const backoff = POLL.errorBaseMs * 2 ** (opts.consecutiveErrors - 1)
    return Math.min(POLL.maxMs, backoff)
  }

  return opts.playing ? POLL.playingMs : POLL.stoppedMs
}
