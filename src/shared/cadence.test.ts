import { describe, expect, it } from 'vitest'
import { CADENCE, CadenceClassifier } from './cadence'

/** Feed `count` evenly spaced keystrokes ending at `end`. */
function type(c: CadenceClassifier, count: number, end: number, spacingMs: number): void {
  for (let i = count - 1; i >= 0; i--) c.push(end - i * spacingMs)
}

/** Keystrokes/minute -> spacing between them. */
const spacingFor = (kpm: number): number => 60_000 / kpm

describe('CadenceClassifier', () => {
  it('reports none before anything is typed', () => {
    expect(new CadenceClassifier().level(1000)).toBe('none')
  })

  it('reports calm for ordinary typing', () => {
    const c = new CadenceClassifier()
    type(c, 15, 10_000, spacingFor(300)) // ~50wpm
    expect(c.level(10_000)).toBe('calm')
  })

  it('reports fast once the enter threshold is crossed', () => {
    const c = new CadenceClassifier()
    type(c, 40, 10_000, spacingFor(500)) // ~83wpm
    expect(c.level(10_000)).toBe('fast')
  })

  it('drops to none after the idle timeout', () => {
    const c = new CadenceClassifier()
    type(c, 40, 10_000, spacingFor(500))
    expect(c.level(10_000)).toBe('fast')
    expect(c.level(10_000 + CADENCE.idleAfterMs)).toBe('none')
  })

  it('does not flap between calm and fast at the boundary', () => {
    // The reason the exit threshold is lower than the enter threshold: a rate
    // sitting between them must hold whichever state it is already in.
    const between = (CADENCE.fastEnterKpm + CADENCE.fastExitKpm) / 2
    const spacing = spacingFor(between)

    const rising = new CadenceClassifier()
    type(rising, 30, 10_000, spacing)
    expect(rising.level(10_000)).toBe('calm')

    const falling = new CadenceClassifier()
    type(falling, 60, 9_000, spacingFor(600)) // clearly fast first
    expect(falling.level(9_000)).toBe('fast')
    type(falling, 30, 12_000, spacing) // then decay into the band
    expect(falling.level(12_000)).toBe('fast')
  })

  it('forgets keystrokes older than the window', () => {
    const c = new CadenceClassifier()
    type(c, 60, 10_000, spacingFor(600))
    expect(c.level(10_000)).toBe('fast')
    // A single fresh keystroke much later: the old burst must not still count.
    c.push(30_000)
    expect(c.level(30_000)).toBe('calm')
  })

  it('resets cleanly', () => {
    const c = new CadenceClassifier()
    type(c, 40, 10_000, spacingFor(500))
    c.reset()
    expect(c.level(10_000)).toBe('none')
  })
})
