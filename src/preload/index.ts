import { contextBridge, ipcRenderer } from 'electron'
import type { Manifest } from '../shared/manifest'
import type { AnimationState } from '../shared/states'

/**
 * The entire main<->renderer surface. contextIsolation is on and there is no
 * node integration in the overlay, so this is the only channel that exists.
 */

export interface BootPayload {
  manifest: Manifest
  assetBase: string
  state: AnimationState
  size: number
}

const api = {
  /** Fetch character + initial state. Called once on load. */
  boot: (): Promise<BootPayload> => ipcRenderer.invoke('dott:boot'),

  /** Animation state pushed from the main-process state machine. */
  onState: (cb: (state: AnimationState) => void): (() => void) => {
    const h = (_e: unknown, state: AnimationState): void => cb(state)
    ipcRenderer.on('dott:state', h)
    return () => ipcRenderer.off('dott:state', h)
  },

  /** Character swapped from the tray; renderer re-boots its sprite. */
  onCharacter: (cb: (p: BootPayload) => void): (() => void) => {
    const h = (_e: unknown, p: BootPayload): void => cb(p)
    ipcRenderer.on('dott:character', h)
    return () => ipcRenderer.off('dott:character', h)
  },

  /** Window size changed (tray preset, or ctrl+wheel). */
  onSize: (cb: (size: number) => void): (() => void) => {
    const h = (_e: unknown, size: number): void => cb(size)
    ipcRenderer.on('dott:size', h)
    return () => ipcRenderer.off('dott:size', h)
  },

  /**
   * Toggle whether the window swallows clicks. The renderer calls this on
   * enter/leave of the sprite's hit region, which is what makes the overlay
   * click-through everywhere except Dott himself.
   */
  setInteractive: (interactive: boolean): void =>
    ipcRenderer.send('dott:set-interactive', interactive),

  dragStart: (): void => ipcRenderer.send('dott:drag-start'),
  dragEnd: (): void => ipcRenderer.send('dott:drag-end'),
  nudgeSize: (delta: number): void => ipcRenderer.send('dott:nudge-size', delta),
}

export type DottApi = typeof api

contextBridge.exposeInMainWorld('dott', api)
