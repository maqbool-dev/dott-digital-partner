import { dialog, shell } from 'electron'
import { createServer, type Server } from 'node:http'
import { nextPollDelay, parsePlayback, POLL } from '../../shared/spotify'
import { configPath, revealConfigFile } from '../config'
import { clearSecret, canStoreSecrets, loadSecret, saveSecret } from '../secure-store'
import {
  buildAuthUrl,
  challengeFor,
  createState,
  createVerifier,
  redirectUri,
  SPOTIFY_TOKEN_URL,
} from './pkce'

export type SpotifyStatus =
  | 'off'
  /** Waiting for the user to finish authorising in their browser. */
  | 'connecting'
  /** Polling successfully. */
  | 'connected'
  /** No client ID configured — needs one-time setup. */
  | 'unconfigured'
  /** Authorisation failed or was revoked. */
  | 'unauthorized'
  /** Network or server trouble. Retrying with backoff. */
  | 'error'

const TOKEN_SECRET = 'spotify-refresh-token'
const PLAYER_URL = 'https://api.spotify.com/v1/me/player'
const AUTH_TIMEOUT_MS = 3 * 60_000

const DASHBOARD_URL = 'https://developer.spotify.com/dashboard'

/**
 * Spotify now-playing detection.
 *
 * Chosen over OS "now playing" APIs because it behaves identically on both
 * platforms — the macOS equivalent (MediaRemote) is a private framework, which
 * is fragile across OS updates and not App-Store-safe.
 *
 * Everything here fails soft: any error path ends with `playing = false`, so a
 * dropped connection makes Dott go idle rather than misbehave.
 */
export class SpotifySource {
  private status: SpotifyStatus = 'off'
  private accessToken: string | null = null
  private accessExpiresAt = 0
  private refreshToken: string | null = null
  private playing = false
  private consecutiveErrors = 0
  private pollTimer: NodeJS.Timeout | null = null
  private authServer: Server | null = null
  private authTimer: NodeJS.Timeout | null = null
  private stopped = true

  constructor(
    private readonly onChange: () => void,
    private readonly getSettings: () => { clientId: string; port: number },
  ) {}

  getStatus(): SpotifyStatus {
    return this.status
  }

  /** True only while a track is actually playing. */
  isPlaying(): boolean {
    return this.status === 'connected' && this.playing
  }

  /**
   * @param interactive true when the user just clicked the toggle — the only
   * time it's appropriate to open a browser window or show a dialog.
   */
  async enable(interactive: boolean): Promise<boolean> {
    const { clientId } = this.getSettings()
    if (!clientId) {
      this.setStatus('unconfigured')
      if (interactive) await this.explainSetup()
      return false
    }

    this.stopped = false
    this.refreshToken = loadSecret(TOKEN_SECRET)

    if (!this.refreshToken) {
      if (!interactive) {
        // Boot with no stored token: don't hijack the screen with a browser
        // window the user didn't ask for.
        this.setStatus('unauthorized')
        return false
      }
      const ok = await this.authorize()
      if (!ok) return false
    }

    this.schedulePoll(0)
    return true
  }

  disable(): void {
    this.stopped = true
    this.clearTimers()
    this.closeAuthServer()
    this.playing = false
    this.accessToken = null
    this.consecutiveErrors = 0
    this.setStatus('off')
  }

  /** Forget the stored token; the next enable() re-authorises from scratch. */
  signOut(): void {
    clearSecret(TOKEN_SECRET)
    this.refreshToken = null
    this.disable()
  }

  // ---------------------------------------------------------------- polling

  private schedulePoll(delayMs: number): void {
    this.clearPollTimer()
    if (this.stopped) return
    this.pollTimer = setTimeout(() => void this.poll(), delayMs)
  }

  private async poll(): Promise<void> {
    if (this.stopped) return

    const token = await this.validAccessToken()
    if (!token) {
      // validAccessToken has already set the status and cleaned up.
      if (!this.stopped && this.status === 'error') {
        this.consecutiveErrors++
        this.schedulePoll(nextPollDelay({ playing: false, consecutiveErrors: this.consecutiveErrors }))
      }
      return
    }

    let result
    try {
      const res = await fetch(PLAYER_URL, { headers: { Authorization: `Bearer ${token}` } })
      // 204 has no body, and an error page may not be JSON either.
      const body = res.status === 200 ? await res.json().catch(() => null) : null
      result = parsePlayback(res.status, body, res.headers.get('retry-after'))
    } catch (err) {
      console.error('[spotify] poll failed:', err)
      result = { kind: 'error' as const, status: 0 }
    }

    if (this.stopped) return

    switch (result.kind) {
      case 'playing':
      case 'stopped': {
        const wasPlaying = this.playing
        this.playing = result.kind === 'playing'
        this.consecutiveErrors = 0
        this.setStatus('connected')
        if (wasPlaying !== this.playing) this.onChange()
        this.schedulePoll(nextPollDelay({ playing: this.playing, consecutiveErrors: 0 }))
        return
      }
      case 'unauthorized': {
        // Force a refresh on the next tick rather than retrying the same
        // dead token.
        this.accessToken = null
        this.accessExpiresAt = 0
        this.playing = false
        this.consecutiveErrors++
        this.schedulePoll(nextPollDelay({ playing: false, consecutiveErrors: this.consecutiveErrors }))
        return
      }
      case 'rateLimited': {
        this.playing = false
        this.schedulePoll(nextPollDelay({ playing: false, consecutiveErrors: 0, retryAfterSec: result.retryAfterSec }))
        return
      }
      case 'error': {
        this.playing = false
        this.consecutiveErrors++
        this.setStatus('error')
        this.schedulePoll(nextPollDelay({ playing: false, consecutiveErrors: this.consecutiveErrors }))
        return
      }
    }
  }

  // ----------------------------------------------------------------- tokens

  private async validAccessToken(): Promise<string | null> {
    // 30s of margin so a token doesn't expire mid-flight.
    if (this.accessToken && Date.now() < this.accessExpiresAt - 30_000) return this.accessToken
    if (!this.refreshToken) {
      this.setStatus('unauthorized')
      return null
    }

    const { clientId } = this.getSettings()
    try {
      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: clientId,
        }),
      })

      if (res.status === 400 || res.status === 401) {
        // The refresh token itself is dead — revoked, or the client ID
        // changed. Retrying can never fix this, so drop it and stop.
        console.error('[spotify] refresh token rejected; sign-in required')
        clearSecret(TOKEN_SECRET)
        this.refreshToken = null
        this.setStatus('unauthorized')
        return null
      }
      if (!res.ok) {
        this.setStatus('error')
        return null
      }

      const json = (await res.json()) as {
        access_token?: string
        expires_in?: number
        refresh_token?: string
      }
      if (!json.access_token) {
        this.setStatus('error')
        return null
      }

      this.accessToken = json.access_token
      this.accessExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000
      // Spotify may rotate the refresh token; persist the new one or the next
      // launch silently fails to authorise.
      if (json.refresh_token && json.refresh_token !== this.refreshToken) {
        this.refreshToken = json.refresh_token
        saveSecret(TOKEN_SECRET, json.refresh_token)
      }
      return this.accessToken
    } catch (err) {
      console.error('[spotify] token refresh failed:', err)
      this.setStatus('error')
      return null
    }
  }

  // ------------------------------------------------------------------- auth

  private async authorize(): Promise<boolean> {
    const { clientId, port } = this.getSettings()
    const verifier = createVerifier()
    const state = createState()
    this.setStatus('connecting')

    const challenge = challengeFor(verifier)
    const code = await this.awaitCallback({ port, state, clientId, challenge }).catch(
      (err: unknown) => {
        console.error('[spotify] authorisation failed:', err)
        return null
      },
    )

    if (!code) {
      this.setStatus('unauthorized')
      return false
    }

    try {
      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(port),
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
      if (!res.ok) {
        console.error('[spotify] token exchange failed:', res.status, await res.text())
        this.setStatus('unauthorized')
        return false
      }
      const json = (await res.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }
      if (!json.access_token || !json.refresh_token) {
        this.setStatus('unauthorized')
        return false
      }

      this.accessToken = json.access_token
      this.accessExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000
      this.refreshToken = json.refresh_token

      if (!saveSecret(TOKEN_SECRET, json.refresh_token) && canStoreSecrets() === false) {
        // Session-only rather than plaintext on disk. Say so, don't hide it.
        console.warn('[spotify] OS encryption unavailable; not storing the token')
      }
      return true
    } catch (err) {
      console.error('[spotify] token exchange failed:', err)
      this.setStatus('unauthorized')
      return false
    } finally {
      this.closeAuthServer()
    }
  }

  /**
   * Run a loopback HTTP server just long enough to catch the redirect.
   *
   * The `state` check is the CSRF defence: without it, any page the user
   * visits could hit this port with an attacker's code and silently bind their
   * Spotify account to it.
   */
  private awaitCallback(opts: {
    port: number
    state: string
    clientId: string
    challenge: string
  }): Promise<string | null> {
    const { port, state, clientId, challenge } = opts
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }

        const err = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const returned = url.searchParams.get('state')

        const done = (message: string, ok: boolean): void => {
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><meta charset="utf-8"><title>Dott</title>` +
              `<body style="font:16px/1.5 system-ui;padding:3rem;text-align:center">` +
              `<h1 style="font-size:1.25rem">${message}</h1>` +
              `<p style="color:#666">You can close this tab.</p>`,
          )
        }

        if (err || !code) {
          done('Dott could not connect to Spotify.', false)
          this.closeAuthServer()
          resolve(null)
          return
        }
        if (returned !== state) {
          console.error('[spotify] state mismatch; rejecting callback')
          done('Dott could not connect to Spotify.', false)
          this.closeAuthServer()
          resolve(null)
          return
        }

        done('Dott is connected to Spotify.', true)
        this.closeAuthServer()
        resolve(code)
      })

      server.on('error', (e: NodeJS.ErrnoException) => {
        this.closeAuthServer()
        if (e.code === 'EADDRINUSE') {
          void dialog.showMessageBox({
            type: 'error',
            title: 'Port already in use',
            message: `Dott needs port ${port} to complete the Spotify sign-in.`,
            detail:
              `Something else on this machine is already using 127.0.0.1:${port}.\n\n` +
              `Change "spotify.port" in:\n     ${configPath()}\n\n` +
              `then register the matching redirect URI in your Spotify app ` +
              `settings — the two have to be identical.`,
          })
        }
        reject(e)
      })

      this.authServer = server
      server.listen(port, '127.0.0.1', () => {
        void shell.openExternal(buildAuthUrl({ clientId, port, challenge, state }))
      })

      // Don't leave a listening socket open forever if the user abandons the
      // browser tab.
      this.authTimer = setTimeout(() => {
        this.closeAuthServer()
        resolve(null)
      }, AUTH_TIMEOUT_MS)
    })
  }

  private closeAuthServer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
    if (this.authServer) {
      this.authServer.close()
      this.authServer = null
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private clearTimers(): void {
    this.clearPollTimer()
    this.closeAuthServer()
  }

  private async explainSetup(): Promise<void> {
    const { port } = this.getSettings()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Open Spotify dashboard', 'Open config file', 'Not now'],
      defaultId: 0,
      cancelId: 2,
      title: 'Connect Dott to Spotify',
      message: 'Dott needs a free Spotify app of your own before it can see what you play.',
      detail:
        'Spotify requires each installation to use its own app credentials — there ' +
        'is no shared key an open-source project can ship.\n\n' +
        '1. Create an app at developer.spotify.com/dashboard\n' +
        `2. Add this exact redirect URI:\n     ${redirectUri(port)}\n` +
        // Naming the file without naming its path sends people hunting, and the
        // path differs between a packaged build and `npm run dev`.
        `3. Set "spotify.clientId" to the Client ID in:\n     ${configPath()}\n` +
        '4. Turn this toggle on again\n\n' +
        'Dott asks only for permission to read what is playing. It cannot change ' +
        'playback, see your library, or read anything about your account.',
    })
    if (response === 0) void shell.openExternal(DASHBOARD_URL)
    if (response === 1) void revealConfigFile()
  }

  private setStatus(next: SpotifyStatus): void {
    if (this.status === next) return
    this.status = next
    this.onChange()
  }
}

export { POLL }
