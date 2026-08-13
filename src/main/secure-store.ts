import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Encrypted-at-rest storage for the one secret Dott holds: a Spotify refresh
 * token. Backed by the OS keystore via Electron's safeStorage — Keychain on
 * macOS, DPAPI on Windows.
 *
 * If the platform cannot encrypt, this stores **nothing**. Writing a
 * long-lived refresh token to a plaintext file in the user's home directory
 * would be worse than making them re-authorise each launch, and the PRD's
 * privacy requirement says never plaintext without qualification.
 */

function secretPath(name: string): string {
  return path.join(app.getPath('userData'), `${name}.bin`)
}

export function canStoreSecrets(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** @returns whether it was actually persisted. */
export function saveSecret(name: string, value: string): boolean {
  if (!canStoreSecrets()) return false
  try {
    const file = secretPath(name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, safeStorage.encryptString(value), { mode: 0o600 })
    return true
  } catch (err) {
    console.error(`[secure-store] could not save "${name}":`, err)
    return false
  }
}

export function loadSecret(name: string): string | null {
  if (!canStoreSecrets()) return null
  const file = secretPath(name)
  if (!existsSync(file)) return null
  try {
    return safeStorage.decryptString(readFileSync(file))
  } catch (err) {
    // Usually means a different machine, a different user, or a reset
    // keychain. The blob is useless now, so drop it and re-authorise.
    console.error(`[secure-store] could not read "${name}", discarding:`, err)
    clearSecret(name)
    return null
  }
}

export function clearSecret(name: string): void {
  try {
    rmSync(secretPath(name), { force: true })
  } catch (err) {
    console.error(`[secure-store] could not clear "${name}":`, err)
  }
}
