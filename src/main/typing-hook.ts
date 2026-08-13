/**
 * The keyboard hook. Runs as a separate utilityProcess, never in main.
 *
 * READ THIS FILE IF YOU ARE CHECKING WHAT DOTT DOES WITH YOUR KEYBOARD.
 * It is deliberately the shortest file in the repo, because the privacy claim
 * should be verifiable in about thirty seconds rather than taken on trust.
 *
 * The keydown handler ignores its event argument entirely. The only thing that
 * can ever leave this process is `{ t: <milliseconds> }` -- a timestamp. Key
 * codes, characters, modifiers and window titles are never read, stored, or
 * sent. Nothing here touches the network or the filesystem.
 *
 * Running it out-of-process buys two other things:
 *  - a crash in the native hook degrades Dott to `idle` instead of taking the
 *    whole app down (the reliability NFR)
 *  - the component that antivirus heuristics care about is isolated, and can
 *    later be replaced or signed separately without touching the app
 */
import { uIOhook } from 'uiohook-napi'

type Outbound = { t: number } | { status: 'ready' } | { status: 'error'; message: string }

const port = process.parentPort

function send(msg: Outbound): void {
  port.postMessage(msg)
}

try {
  // No parameter. There is nothing in the event we want.
  uIOhook.on('keydown', () => send({ t: Date.now() }))
  uIOhook.start()
  send({ status: 'ready' })
} catch (err) {
  // Overwhelmingly this means the OS denied event access (macOS Input
  // Monitoring). The supervisor turns it into a user-facing explanation.
  send({ status: 'error', message: err instanceof Error ? err.message : String(err) })
}

const shutdown = (): void => {
  try {
    uIOhook.stop()
  } catch {
    // Already stopped, or never started. Nothing useful to do while exiting.
  }
}

process.on('exit', shutdown)
process.on('SIGTERM', shutdown)
