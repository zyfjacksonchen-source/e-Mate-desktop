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
test('real compiled native factory lazily loads offline, draws, saves and isolates project scripts', { skip: !existsSync(browserPath) }, async t => {
  assert(existsSync(root + 'lib/assets/editor.js'), 'run the authorized module build before browser verification')
  const nativeModules = fileURLToPath(new URL('../../../upstream/deepseek-harness/node_modules/.pnpm/node_modules/', import.meta.url))
  const bootstrap = await build({ entryPoints: [root + 'test/browser-entry.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser',
    alias: { react: nativeModules + 'react', 'react-dom': nativeModules + 'react-dom' }, define: { 'process.env.NODE_ENV': '"production"' } })
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style><button id="open">Open canvas</button><div id="root"></div><script type="module" src="/bootstrap.js"></script>'); return }
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
  await page.mouse.click(box.x + 100, box.y + 100)
  await page.keyboard.press('r')
  await page.mouse.move(box.x + 400, box.y + 180); await page.mouse.down(); await page.mouse.move(box.x + 700, box.y + 340, { steps: 10 }); await page.mouse.up()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.readCanvasFixture().pages[0].elements.some(element => element.type === 'rectangle'))
  const pngDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click()
  const png = await readFile(await (await pngDownload).path())
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  await page.getByLabel('项目名称').fill('Canvas browser proof')
  await page.getByRole('button', { name: '新增页面' }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.readCanvasFixture().pages.length === 2)
  await page.locator('summary').filter({ hasText: 'HTML 页面内容' }).click()
  await page.evaluate(() => { window.opaqueScriptResult = null; addEventListener('message', event => { if (event.data?.type === 'canvas-opaque-proof') window.opaqueScriptResult = event.data }) })
  await page.getByLabel('HTML 页面内容', { exact: true }).fill('<h1>Isolated preview</h1><script>let isolated=false,topIsolated=false;try { parent.canvasAttacked = true } catch { isolated=true }try { top.canvasAttacked = true } catch { topIsolated=true }top.postMessage({type:"canvas-opaque-proof",isolated,topIsolated,title:document.querySelector("h1").textContent},"*")</script><img src="https://outside.invalid/leak">')
  await page.getByRole('button', { name: 'HTML 预览', exact: true }).click()
  await page.waitForFunction(() => window.opaqueScriptResult?.title === 'Isolated preview')
  assert.equal(await page.evaluate(() => window.canvasAttacked), undefined)
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
  assert.deepEqual(await page.evaluate(() => [window.opaqueScriptResult.isolated, window.opaqueScriptResult.topIsolated]), [true, true])
  const slidesDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出幻灯片', exact: true }).click()
  const slides = await readFile(await (await slidesDownload).path(), 'utf8')
  assert(slides.includes('sandbox="allow-scripts"') && slides.includes('data:image/png;base64,'))
  await page.getByRole('button', { name: '全屏播放', exact: true }).click()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByRole('button', { name: '退出播放', exact: true }).click()
  await page.setViewportSize({ width: 460, height: 900 })
  await page.waitForFunction(() => window.opaqueScriptResult?.title === 'Isolated preview')
  assert.deepEqual(outside, [])
  assert.deepEqual(errors, [])
  await mkdir(root + '.test-artifacts', { recursive: true })
  await page.screenshot({ path: root + '.test-artifacts/canvas-browser.png', fullPage: true })
  await page.evaluate(() => { window.navigationAttempted = false; addEventListener('message', event => { if (event.data === 'canvas-nav-attempt') window.navigationAttempted = true }) })
  if (!await page.getByLabel('HTML 页面内容', { exact: true }).isVisible()) await page.locator('summary').filter({ hasText: 'HTML 页面内容' }).click()
  await page.getByLabel('HTML 页面内容', { exact: true }).fill(`<script>top.postMessage('canvas-nav-attempt','*');location.href='${origin}/must-not-navigate'</script>`)
  await page.waitForFunction(() => window.navigationAttempted)
  await page.waitForTimeout(250)
  assert.equal(requested.some(url => url.includes('/must-not-navigate')), false)
  console.log(JSON.stringify({ claim: 'local-real-browser-component-not-installed-app', external_requests: outside.length, editor_loaded_after_gesture: true, page_errors: errors, pages: 2 }))
})
