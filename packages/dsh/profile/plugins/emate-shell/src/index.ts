import { readFileSync } from 'node:fs'

export const inject = ['webServer']

const assets = new Map([
  ['/assets/e-mate/logo.png', [readFileSync(new URL('./assets/emate-logo.png', import.meta.url)), 'image/png']],
  ['/assets/e-mate/mark.png', [readFileSync(new URL('./assets/emate-mark.png', import.meta.url)), 'image/png']],
  ['/assets/e-mate/team-hero.png', [readFileSync(new URL('./assets/e-mate-team-hero-transparent.png', import.meta.url)), 'image/png']],
  ['/assets/e-mate/xiaoxin-avatar.png', [readFileSync(new URL('./assets/xiaoxin-avatar.png', import.meta.url)), 'image/png']],
  ['/assets/e-mate/send.svg', [readFileSync(new URL('./assets/lucide-send.svg', import.meta.url)), 'image/svg+xml']],
])

const manifest = Buffer.from(`${JSON.stringify({
  id: 'e-mate',
  name: 'e-Mate',
  short_name: 'e-Mate',
  start_url: '/',
  display: 'standalone',
  background_color: '#f7f6f3',
  theme_color: '#f7f6f3',
  icons: [{ src: '/assets/e-mate/xiaoxin-avatar.png', sizes: '1332x1280', type: 'image/png', purpose: 'any' }],
})}\n`)

export function apply(ctx) {
  for (const [path, [body, contentType]] of assets) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        res.writeHead(200, {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': body.byteLength,
          'Content-Type': contentType,
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }), `emate-shell: ${path}`)
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/manifest.webmanifest',
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' })
        res.end()
        return
      }
      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': manifest.byteLength,
        'Content-Type': 'application/manifest+json; charset=utf-8',
      })
      res.end(req.method === 'HEAD' ? undefined : manifest)
    },
  }), 'emate-shell: web manifest')

}
