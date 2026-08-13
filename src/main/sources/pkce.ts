import { createHash, randomBytes } from 'node:crypto'

/**
 * Authorization Code + PKCE helpers.
 *
 * PKCE exists so a public client can do OAuth without a client secret. That
 * matters here twice over: a desktop app cannot keep a secret (anyone can
 * unpack the binary), and this repo is public, so a secret in the source would
 * be a secret in everyone's clone.
 *
 * The client ID is not a secret and is fine to ship or commit.
 */

export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize'
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token'

/** Only what's needed to read playback state. Nothing that can modify anything. */
export const SPOTIFY_SCOPES = ['user-read-playback-state'] as const

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** RFC 7636 says 43–128 chars; 32 random bytes lands at 43. */
export function createVerifier(): string {
  return base64url(randomBytes(32))
}

export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export function createState(): string {
  return base64url(randomBytes(16))
}

/**
 * Spotify requires an exact-match redirect URI, and for loopback it must be
 * the literal `127.0.0.1` — `localhost` is rejected. That exactness is also
 * why the port is fixed and configurable rather than ephemeral: whatever is
 * used here has to be registered in the Spotify dashboard by hand.
 */
export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}

export function buildAuthUrl(opts: {
  clientId: string
  port: number
  challenge: string
  state: string
}): string {
  const url = new URL(SPOTIFY_AUTH_URL)
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(opts.port),
    code_challenge_method: 'S256',
    code_challenge: opts.challenge,
    state: opts.state,
    scope: SPOTIFY_SCOPES.join(' '),
  }).toString()
  return url.toString()
}
