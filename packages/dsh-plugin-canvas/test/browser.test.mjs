import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from '../../../upstream/deepseek-harness/node_modules/.pnpm/node_modules/esbuild/lib/main.js'
import { chromium } from '../../../upstream/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const browserPath = process.env.EMATE_CANVAS_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
test('real compiled native factory lazily loads offline, renders the focused annotation page, follows native theme and preserves legacy project data', { skip: !existsSync(browserPath) }, async t => {
  assert(existsSync(root + 'lib/assets/editor.js'), 'run the authorized module build before browser verification')
  const nativeModules = fileURLToPath(new URL('../../../upstream/deepseek-harness/node_modules/.pnpm/node_modules/', import.meta.url))
  const bootstrap = await build({ entryPoints: [root + 'test/browser-entry.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser',
    alias: { react: nativeModules + 'react', 'react-dom': nativeModules + 'react-dom' }, define: { 'process.env.NODE_ENV': '"production"' } })
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}body{--dsw-font-family:system-ui;--dsw-alias-bg-base:#fff;--dsw-alias-border-l1:#ddd;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#888;--dsw-alias-interactive-bg-hover:#eee}body[data-ds-dark-theme]{--dsw-alias-bg-base:#202020;--dsw-alias-border-l1:#444;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#999;--dsw-alias-interactive-bg-hover:#333}</style><button id="open">Open canvas</button><div id="root"></div><script type="module" src="/bootstrap.js"></script>'); return }
      if (req.url === '/bootstrap.js') { res.setHeader('content-type', 'text/javascript'); res.end(bootstrap.outputFiles[0].contents); return }
      const path = new URL(req.url, 'http://fixture').pathname
      if (!path.startsWith('/emate-canvas-assets/') || path.includes('..')) { res.writeHead(404); res.end(); return }
      res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'font/woff2')
      res.end(await readFile(root + 'lib/assets/' + path.slice('/emate-canvas-assets/'.length)))
    } catch { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ executablePath: browserPath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  t.after(async () => { await mkdir(root + '.test-artifacts', { recursive: true }); await page.screenshot({ path: root + '.test-artifacts/canvas-browser-last.png' }).catch(() => {}); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const outside = [], requested = [], errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('browser fixture:', error.message) })
  await page.route('**/*', route => {
    const url = route.request().url(); requested.push(url)
    if (!url.startsWith(origin)) { outside.push(url); return route.abort() }
    return route.continue()
  })
  await page.goto(origin)
  assert.equal(requested.some(url => url.includes('editor.js') || url.includes('/fonts/')), false)
  await page.getByRole('button', { name: 'Open canvas' }).click()
  await page.locator('.excalidraw').waitFor()
  const canvas = page.locator('.excalidraw canvas').last()
  const box = await canvas.boundingBox()
  assert(box)
  await page.getByRole('button', { name: '箭头', exact: true }).click()
  await page.mouse.move(box.x + 250, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 500, box.y + 320, { steps: 10 }); await page.mouse.up()
  await page.getByRole('button', { name: '文字', exact: true }).click()
  await page.mouse.click(box.x + 300, box.y + 350); await page.keyboard.type('Change this area'); await page.keyboard.press('Escape')
  await page.getByLabel('更多画布操作').click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.readCanvasFixture().pages[0].elements.some(element => element.type === 'arrow') && window.readCanvasFixture().pages[0].elements.some(element => element.type === 'text'))
  assert.equal(await page.getByRole('button', { name: '新增页面', exact: true }).count(), 0)
  assert.equal(await page.getByLabel('HTML 页面内容', { exact: true }).count(), 0)
  assert.equal(await page.locator('iframe').count(), 0)
  const legacy = await page.evaluate(() => window.readCanvasFixture().pages[1])
  assert.equal(legacy.slide, true); assert(legacy.html.includes('Legacy HTML'))
  const pngDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click()
  const png = await readFile(await (await pngDownload).path())
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  await page.getByLabel('项目名称').fill('Canvas browser proof')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.readCanvasFixture().title === 'Canvas browser proof')
  await page.getByLabel('更多画布操作').click()
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.waitForSelector('[data-emate-canvas][data-theme="dark"]')
  assert.equal(await page.locator('[data-emate-canvas]').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(32, 32, 32)')
  await page.getByLabel('选择画布页').selectOption('legacy')
  assert.equal(await page.locator('iframe').count(), 0)
  assert.equal(await page.evaluate(() => window.canvasAttacked), undefined)
  await page.getByLabel('选择画布页').selectOption('page-1')
  await page.setViewportSize({ width: 460, height: 900 })
  assert.deepEqual(outside, [])
  assert.deepEqual(errors, [])
  assert.deepEqual(await page.evaluate(() => window.readCanvasFixture().pages[1]), legacy)
  await mkdir(root + '.test-artifacts', { recursive: true })
  await page.screenshot({ path: root + '.test-artifacts/canvas-browser.png', fullPage: true })
  console.log(JSON.stringify({ claim: 'local-real-browser-component-not-installed-app', external_requests: outside.length, editor_loaded_after_gesture: true, page_errors: errors, hidden_legacy_pages_preserved: true, theme: 'native-dark' }))
})
