import { app, net, protocol } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ManifestSchema, type Manifest } from '../shared/manifest'

/**
 * Character discovery and asset serving.
 *
 * Assets are served over a custom `dott-asset://` scheme rather than file://
 * because the renderer runs from http://localhost during development, and an
 * http origin cannot load file:// images. The custom scheme behaves identically
 * in dev and in a packaged build, so there is no path-handling divergence
 * between the two.
 */

export const ASSET_SCHEME = 'dott-asset'

/** Must run at module load, before app 'ready'. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

export function charactersRoot(): string {
  // Packaged builds ship characters/ as an extra resource; in dev the app path
  // is the repo root.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'characters')
    : path.join(app.getAppPath(), 'characters')
}

export function handleAssetRequests(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url)
    const character = url.hostname
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const root = path.resolve(charactersRoot(), character)
    const target = path.resolve(root, rel)

    // Path-traversal guard: a manifest is data, and data must not be able to
    // address arbitrary files on disk.
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(target)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

export function listCharacters(): string[] {
  const root = charactersRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort()
}

export function loadManifest(name: string): Manifest {
  const file = path.join(charactersRoot(), name, 'manifest.json')
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`invalid manifest ${file}:\n${detail}`)
  }
  if (parsed.data.name !== name) {
    throw new Error(
      `manifest name "${parsed.data.name}" does not match directory "${name}"`,
    )
  }
  return parsed.data
}

/** Base URL a renderer prefixes onto manifest-relative asset paths. */
export function assetBase(name: string): string {
  return `${ASSET_SCHEME}://${name}/`
}
