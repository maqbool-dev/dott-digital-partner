import { dialog, shell, systemPreferences, utilityProcess } from 'electron'
import path from 'node:path'
import { CadenceClassifier } from '../../shared/cadence'
import type { TypingLevel } from '../../shared/states'

export type TypingStatus =
  /** Integration is off (the default). */
  | 'off'
  /** Child spawned, waiting for it to report in. */
  | 'starting'
  /** Receiving keystroke timestamps. */
  | 'running'
  /** The OS refused event access. Needs a permission grant, not a retry. */
  | 'blocked'
  /** The hook died repeatedly. Dott stays on idle; the app is unaffected. */
  | 'failed'

/** Restart delays, then give up. A hook that dies four times is broken. */
const RESTART_DELAYS_MS = [500, 2000, 5000]

const MAC_INPUT_MONITORING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'

/**
 * Owns the keyboard-hook child process and converts its timestamps into a
 * typing level.
 *
 * Everything here is defensive by design: the PRD requires that a typing-hook
 * failure degrade to `idle` rather than crash the app, so no failure path in
 * this file is allowed to throw into the caller.
 */
export class TypingSource {
  private child: Electron.UtilityProcess | null = null
  private readonly cadence = new CadenceClassifier()
  private status: TypingStatus = 'off'
  private restarts = 0
  private stopping = false

  constructor(private readonly onChange: () => void) {}

  getStatus(): TypingStatus {
    return this.status
  }

  /** Current cadence bucket, or `none` whenever the source isn't healthy. */
  level(now: number): TypingLevel {
    if (this.status !== 'running') return 'none'
    return this.cadence.level(now)
  }

  /**
   * @param interactive true when the user just clicked the toggle, which is
   * the only time it's appropriate to put a permission dialog on screen. At
   * boot we start silently and let the tray show the status instead of
   * ambushing the user with a system prompt they didn't ask for.
   */
  async enable(interactive: boolean): Promise<boolean> {
    if (this.child) return true

    if (interactive && process.platform === 'darwin' && !this.hasMacTrust()) {
      await this.explainMacPermission()
      return false
    }

    this.restarts = 0
    this.spawn()
    return true
  }

  disable(): void {
    this.stopping = true
    this.child?.kill()
    this.child = null
    this.cadence.reset()
    this.setStatus('off')
    this.stopping = false
  }

  private spawn(): void {
    this.stopping = false
    // Built as a second main-process entry point; see electron.vite.config.ts.
    const entry = path.join(__dirname, 'typing-hook.js')

    let child: Electron.UtilityProcess
    try {
      child = utilityProcess.fork(entry, [], { serviceName: 'dott-input-hook' })
    } catch (err) {
      console.error('[typing] could not start the input hook:', err)
      this.setStatus('failed')
      return
    }

    this.child = child
    this.setStatus('starting')

    child.on('message', (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return
      const m = msg as { t?: number; status?: string; message?: string }

      if (typeof m.t === 'number') {
        this.cadence.push(m.t)
        return
      }
      if (m.status === 'ready') {
        this.restarts = 0
        this.setStatus('running')
        return
      }
      if (m.status === 'error') {
        console.error('[typing] hook reported:', m.message)
        // On macOS a start failure is almost always a denied Input Monitoring
        // grant, which restarting cannot fix.
        this.setStatus(process.platform === 'darwin' ? 'blocked' : 'failed')
        this.child = null
        child.kill()
      }
    })

    child.on('exit', (code) => {
      if (this.stopping || this.status === 'blocked') return
      this.child = null
      this.cadence.reset()

      const delay = RESTART_DELAYS_MS[this.restarts]
      if (delay === undefined) {
        console.error(`[typing] hook exited (${code}); giving up after ${this.restarts} restarts`)
        this.setStatus('failed')
        return
      }
      console.error(`[typing] hook exited (${code}); restarting in ${delay}ms`)
      this.restarts++
      this.setStatus('starting')
      setTimeout(() => {
        if (!this.stopping && !this.child) this.spawn()
      }, delay)
    })
  }

  /** Tray escape hatch once the grant has been refused or revoked. */
  openPermissionSettings(): void {
    if (process.platform === 'darwin') void shell.openExternal(MAC_INPUT_MONITORING_PANE)
  }

  private hasMacTrust(): boolean {
    // Reports Accessibility trust, which is not exactly the Input Monitoring
    // grant uiohook needs -- but it's the only signal Electron exposes, and a
    // machine with neither is the common case. If it's wrong, the child's
    // start error is the backstop.
    try {
      return systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      return false
    }
  }

  /**
   * Explain before the OS asks, per FR-12. A cold system permission dialog
   * requesting keyboard access, triggered by a cartoon character, is how an
   * app gets deleted -- and rightly so.
   */
  private async explainMacPermission(): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Open System Settings', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Dott needs permission to sense typing',
      message: 'Dott can react to how fast you type. macOS has to allow that first.',
      detail:
        'Dott records only the TIME of each keystroke — never which keys you press.\n\n' +
        'It is a speed counter, not a keylogger: no characters, no passwords, no ' +
        'window titles. Nothing is written to disk and nothing is sent anywhere. ' +
        'The code that touches the keyboard runs in its own process whose only ' +
        'output is a timestamp — it is a few dozen lines, in src/main/typing-hook.ts.\n\n' +
        'Grant Dott "Input Monitoring", then switch this on again. You can revoke ' +
        'it at any time, and Dott simply goes back to idle.',
    })
    if (response === 0) {
      void shell.openExternal(MAC_INPUT_MONITORING_PANE)
    }
  }

  private setStatus(next: TypingStatus): void {
    if (this.status === next) return
    this.status = next
    this.onChange()
  }
}
