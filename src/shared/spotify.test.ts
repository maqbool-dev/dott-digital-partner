import { describe, expect, it } from 'vitest'
import { nextPollDelay, parsePlayback, POLL } from './spotify'

describe('parsePlayback', () => {
  it('reads is_playing from a 200', () => {
    expect(parsePlayback(200, { is_playing: true })).toEqual({ kind: 'playing' })
    expect(parsePlayback(200, { is_playing: false })).toEqual({ kind: 'stopped' })
  })

  it('treats 204 as stopped, not as an error', () => {
    // Spotify's "no active device" response. Misreading this as a fault would
    // put the most common non-playing state into error backoff.
    expect(parsePlayback(204, null)).toEqual({ kind: 'stopped' })
  })

  it('treats a missing or malformed body as stopped', () => {
    expect(parsePlayback(200, null)).toEqual({ kind: 'stopped' })
    expect(parsePlayback(200, 'nonsense')).toEqual({ kind: 'stopped' })
    expect(parsePlayback(200, {})).toEqual({ kind: 'stopped' })
  })

  it('flags 401 for a token refresh', () => {
    expect(parsePlayback(401, null)).toEqual({ kind: 'unauthorized' })
  })

  it('reads Retry-After on a 429', () => {
    expect(parsePlayback(429, null, '30')).toEqual({ kind: 'rateLimited', retryAfterSec: 30 })
    expect(parsePlayback(429, null, null)).toEqual({ kind: 'rateLimited' })
    expect(parsePlayback(429, null, 'soon')).toEqual({ kind: 'rateLimited' })
  })

  it('reports anything else as an error with its status', () => {
    expect(parsePlayback(500, null)).toEqual({ kind: 'error', status: 500 })
  })
})

describe('nextPollDelay', () => {
  it('polls fast while playing and slowly while stopped', () => {
    expect(nextPollDelay({ playing: true, consecutiveErrors: 0 })).toBe(POLL.playingMs)
    expect(nextPollDelay({ playing: false, consecutiveErrors: 0 })).toBe(POLL.stoppedMs)
  })

  it('backs off exponentially on repeated errors', () => {
    const delays = [1, 2, 3, 4].map((n) =>
      nextPollDelay({ playing: false, consecutiveErrors: n }),
    )
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000])
  })

  it('caps backoff', () => {
    expect(nextPollDelay({ playing: false, consecutiveErrors: 50 })).toBe(POLL.maxMs)
  })

  it('honours Retry-After over its own schedule, with margin', () => {
    expect(nextPollDelay({ playing: true, consecutiveErrors: 0, retryAfterSec: 30 })).toBe(31_000)
  })

  it('clamps an absurd or negative Retry-After', () => {
    // A bad value must not park polling for hours or schedule in the past.
    expect(nextPollDelay({ playing: false, consecutiveErrors: 0, retryAfterSec: 99_999 })).toBe(
      POLL.maxMs,
    )
    expect(nextPollDelay({ playing: false, consecutiveErrors: 0, retryAfterSec: -5 })).toBe(1_000)
  })
})
