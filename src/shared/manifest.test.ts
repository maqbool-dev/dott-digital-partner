import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ManifestSchema } from './manifest'

const dott = JSON.parse(
  readFileSync(path.join(__dirname, '../../characters/dott/manifest.json'), 'utf8'),
)

describe('manifest contract', () => {
  it('accepts the generated dott manifest', () => {
    // Guards the design<->engine boundary: if pack-sprites.py ever emits
    // something the app can't load, this fails at build time rather than as a
    // blank window at runtime.
    expect(ManifestSchema.safeParse(dott).success).toBe(true)
  })

  it('rejects a character missing a required state', () => {
    const broken = structuredClone(dott)
    delete broken.states.typing_fast
    const result = ManifestSchema.safeParse(broken)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('typing_fast')
  })

  it('rejects a sequence pointing past the end of the atlas', () => {
    const broken = structuredClone(dott)
    broken.states.idle.sequence = [0, 99]
    const result = ManifestSchema.safeParse(broken)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('99')
  })

  it('rejects a non-kebab-case character name', () => {
    expect(ManifestSchema.safeParse({ ...dott, name: 'Dott Two' }).success).toBe(false)
  })
})
