import { describe, expect, it } from 'vitest'
import { StateMachine } from './state-machine'
import { resolveState, type Signals } from './states'

const S = (p: Partial<Signals> = {}): Signals => ({
  dragging: false,
  typing: 'none',
  music: false,
  forced: null,
  ...p,
})

describe('resolveState', () => {
  it('falls back to idle with no signals', () => {
    expect(resolveState(S())).toBe('idle')
  })

  it('ranks typing above music when both are active', () => {
    // The case the priority table exists for: without it, the companion looks
    // inert for the whole duration of a track.
    expect(resolveState(S({ music: true, typing: 'calm' }))).toBe('typing_calm')
    expect(resolveState(S({ music: true, typing: 'fast' }))).toBe('typing_fast')
  })

  it('ranks dragging above everything', () => {
    expect(resolveState(S({ dragging: true, music: true, typing: 'fast' }))).toBe('dragged')
  })

  it('lets a forced state override every signal', () => {
    expect(resolveState(S({ dragging: true, forced: 'music_reactive' }))).toBe('music_reactive')
  })
})

describe('StateMachine dwell', () => {
  it('holds a state for the dwell window before allowing a change', () => {
    const m = new StateMachine(250)
    expect(m.update({ music: true }, 1000)).toBe('music_reactive')
    // A single keystroke 100ms later must not snap the animation.
    expect(m.update({ typing: 'calm' }, 1100)).toBe('music_reactive')
    // Once the window expires the pending state lands, without needing a new
    // signal — this is why the main process ticks the machine.
    expect(m.tick(1300)).toBe('typing_calm')
  })

  it('bypasses dwell for drag start and drag end', () => {
    const m = new StateMachine(250)
    m.update({ music: true }, 1000)
    // Direct manipulation must respond immediately, dwell or not.
    expect(m.update({ dragging: true }, 1050)).toBe('dragged')
    expect(m.update({ dragging: false }, 1060)).toBe('music_reactive')
  })

  it('is stable when the resolved state has not changed', () => {
    const m = new StateMachine(250)
    m.update({ typing: 'calm' }, 0)
    expect(m.tick(10_000)).toBe('typing_calm')
    expect(m.tick(20_000)).toBe('typing_calm')
  })

  it('starts idle', () => {
    expect(new StateMachine().state).toBe('idle')
  })
})
