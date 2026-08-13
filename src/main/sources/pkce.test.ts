import { describe, expect, it } from 'vitest'
import {
  buildAuthUrl,
  challengeFor,
  createVerifier,
  redirectUri,
  SPOTIFY_SCOPES,
} from './pkce'

describe('PKCE', () => {
  it('matches the RFC 7636 test vector', () => {
    // Appendix B. If this breaks, the token exchange will fail server-side
    // with an error that says nothing useful.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('generates verifiers in the legal length range', () => {
    const v = createVerifier()
    expect(v.length).toBeGreaterThanOrEqual(43)
    expect(v.length).toBeLessThanOrEqual(128)
  })

  it('generates base64url with no padding', () => {
    for (let i = 0; i < 20; i++) {
      expect(createVerifier()).toMatch(/^[A-Za-z0-9\-_]+$/)
    }
  })

  it('generates a distinct verifier each time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createVerifier()))
    expect(seen.size).toBe(50)
  })

  it('uses the literal loopback IP, which Spotify requires over localhost', () => {
    expect(redirectUri(8888)).toBe('http://127.0.0.1:8888/callback')
  })
})

describe('buildAuthUrl', () => {
  const url = new URL(
    buildAuthUrl({ clientId: 'abc123', port: 8888, challenge: 'chal', state: 'st8' }),
  )

  it('requests S256, never plain', () => {
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
  })

  it('carries the state parameter for CSRF protection', () => {
    expect(url.searchParams.get('state')).toBe('st8')
  })

  it('requests only read scopes', () => {
    const scopes = url.searchParams.get('scope')!.split(' ')
    expect(scopes).toEqual([...SPOTIFY_SCOPES])
    expect(scopes.every((s) => s.startsWith('user-read-'))).toBe(true)
  })

  it('never includes a client secret', () => {
    // The entire point of PKCE for a public, open-source client.
    expect(url.searchParams.get('client_secret')).toBeNull()
  })
})
