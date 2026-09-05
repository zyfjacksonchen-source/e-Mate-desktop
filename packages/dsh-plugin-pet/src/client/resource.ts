import { ASSET_PREFIX, validateBase, validateOffice, type Atlas, type BaseManifest, type OfficeManifest } from '../assets.ts'
export interface LoadedPet { readonly base: BaseManifest; readonly baseUrl: string; readonly office?: OfficeManifest; readonly officeUrl?: string; readonly extensionStatus: 'ready' | 'unavailable'; dispose(): void }
export interface AssetIO { fetch(path: string, signal: AbortSignal): Promise<Uint8Array>; image(bytes: Uint8Array): Promise<{ width: number; height: number; dispose(): void }>; digest(bytes: Uint8Array): Promise<string>; url(bytes: Uint8Array): string; revoke(url: string): void }
async function manifest(io: AssetIO, file: string, signal: AbortSignal): Promise<unknown> {
  const bytes = await io.fetch(ASSET_PREFIX + file, signal)
  if (bytes.length > 64 * 1024) throw new Error('Pet manifest exceeded bounds')
  signal.throwIfAborted()
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
async function loadAtlas(io: AssetIO, atlas: Atlas, signal: AbortSignal): Promise<string> {
  const bytes = await io.fetch(ASSET_PREFIX + atlas.file + '?sha256=' + atlas.sha256, signal)
  signal.throwIfAborted()
  if (bytes.length !== atlas.bytes || await io.digest(bytes) !== atlas.sha256) throw new Error('Pet atlas integrity mismatch')
  signal.throwIfAborted()
  const decoded = await io.image(bytes)
  try { if (decoded.width !== atlas.width || decoded.height !== atlas.height) throw new Error('Pet atlas decoded geometry mismatch') }
  finally { decoded.dispose() }
  signal.throwIfAborted()
  return io.url(bytes)
}
/** Fail base closed; only an invalid optional extension falls back to valid v2. */
export async function loadPet(io: AssetIO, signal: AbortSignal): Promise<LoadedPet> {
  const base = validateBase(await manifest(io, 'xiaoxin-v2.json', signal))
  const baseUrl = await loadAtlas(io, base.atlas, signal)
  let officeUrl: string | undefined
  try {
    let office: OfficeManifest | undefined
    try {
      office = validateOffice(await manifest(io, 'xiaoxin-office.json', signal), base)
      officeUrl = await loadAtlas(io, office.atlas, signal)
    } catch { signal.throwIfAborted(); office = undefined }
    signal.throwIfAborted()
    const urls = [baseUrl, ...(officeUrl === undefined ? [] : [officeUrl])]
    let disposed = false
    return { base, baseUrl, ...(office === undefined ? {} : { office, officeUrl: officeUrl! }), extensionStatus: office === undefined ? 'unavailable' : 'ready', dispose() { if (disposed) return; disposed = true; for (const url of urls) io.revoke(url) } }
  } catch (error) { io.revoke(baseUrl); if (officeUrl !== undefined) io.revoke(officeUrl); throw error }
}
export const browserAssetIO: AssetIO = {
  async fetch(path, signal) {
    const response = await fetch(path, { signal, credentials: 'same-origin', redirect: 'error', cache: path.includes('?sha256=') ? 'force-cache' : 'no-cache' })
    if (!response.ok || new URL(response.url).origin !== location.origin) throw new Error('Pet asset unavailable')
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Pet asset stream unavailable')
    const chunks: Uint8Array[] = []; let length = 0
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 32 * 1024 * 1024) throw new Error('Pet asset exceeded bounds'); chunks.push(chunk.value) } }
    finally { await reader.cancel() }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }; return bytes
  },
  async image(bytes) { const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' })); return { width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() } },
  async digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), byte => byte.toString(16).padStart(2, '0')).join('') },
  url: bytes => URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' })),
  revoke: url => URL.revokeObjectURL(url),
}
