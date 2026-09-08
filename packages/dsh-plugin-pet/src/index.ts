/** Fixed offline component assets served only through the existing native webServer. */
import { lstat, readFile } from 'node:fs/promises'
import { ASSET_FILES, ASSET_PREFIX } from './assets.ts'
import { DEFAULT_SETTINGS, PET_SETTINGS_NAMESPACE } from './settings.ts'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
export const inject = ['webServer', 'settings']
const schema = z.object({ enabled: z.boolean().default(DEFAULT_SETTINGS.enabled), position: z.object({ x: z.number().min(0).max(1).default(0.97), y: z.number().min(0).max(1).default(0.97) }).default(DEFAULT_SETTINGS.position) })
export function apply(ctx: any): void {
  ctx.settings.register(settingsNamespace(PET_SETTINGS_NAMESPACE), schema)
  for (const file of ASSET_FILES) {
    const asset = new URL(`./assets/${file}`, import.meta.url)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ASSET_PREFIX + file, async handler(req: any, res: any) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return }
      const controller = new AbortController()
      const cancelled = () => { if (!res.writableFinished) controller.abort() }
      res.once('close', cancelled)
      try {
        const info = await lstat(asset)
        const maxBytes = file.endsWith('.json') ? 64 * 1024 : 32 * 1024 * 1024
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) throw new Error('Unavailable asset')
        const body = req.method === 'HEAD' ? undefined : await readFile(asset, { signal: controller.signal })
        res.writeHead(200, { 'Content-Type': file.endsWith('.json') ? 'application/json' : 'image/webp', 'Content-Length': info.size, 'Cache-Control': file.endsWith('.json') ? 'no-cache' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
        res.end(body)
      } catch { if (!res.destroyed) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end() } }
      finally { res.off('close', cancelled) }
    } }), `e-mate-pet: fixed asset ${file}`)
  }
}
