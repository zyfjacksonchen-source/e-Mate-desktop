import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
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
  const bootstrap = await build({ entryPoints: [root + 'test/browser-entry.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'esnext',
    alias: { react: nativeModules + 'react', 'react-dom': nativeModules + 'react-dom' }, define: { 'process.env.NODE_ENV': '"production"' } })
  const server = createServer(async (req, res) => {
    try {
      if (req.url.split('?')[0] === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}body{--dsw-font-family:system-ui;--dsw-alias-bg-base:#fff;--dsw-alias-border-l1:#ddd;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#888;--dsw-alias-interactive-bg-hover:#eee}body[data-ds-dark-theme]{--dsw-alias-bg-base:#202020;--dsw-alias-border-l1:#444;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#999;--dsw-alias-interactive-bg-hover:#333}</style><button id="open">Open canvas</button><div id="root"></div><script type="module" src="/bootstrap.js"></script>'); return }
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
  await page.waitForFunction(() => window.readCanvasFixture().pages[0].view.zoom > 0)
  // Native fit/scroll is persisted by the existing scene owner; use that transform for a real pointer gesture.
  await page.waitForTimeout(500)
  const view = await page.evaluate(() => window.readCanvasFixture().pages[0].view)
  const point = (x, y) => ({ x: box.x + (x + view.scrollX) * view.zoom, y: box.y + (y + view.scrollY) * view.zoom })
  const start = point(30, 40), end = point(160, 150)
  await page.getByRole('button', { name: '箭头', exact: true }).click()
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 10 }); await page.mouse.up()
  const oversized = '保留原图全部构图与人物，仅修改指定区域。'.repeat(80)
  await page.getByLabel('箭头标注要求').fill(oversized)
  assert.equal(await page.getByLabel('箭头标注要求').inputValue(), oversized)
  await page.getByRole('alert').filter({ hasText: '图片内放不下此标注' }).waitFor()
  assert(await page.getByRole('button', { name: '按标注修改', exact: true }).isDisabled())
  await page.getByLabel('图片修改需求').focus()
  assert.equal(await page.getByLabel('箭头标注要求').count(), 1, 'invalid input is retained after blur')
  assert.equal(await page.evaluate(() => window.readCanvasFixture().pages[0].elements.filter(item => item.type === 'rectangle').length), 0, 'invalid first label saves no empty box')
  await page.getByLabel('箭头标注要求').fill('仅将蓝色圆形改成绿色，保留橙色三角形、背景和整体布局，不添加其他元素。')
  assert.equal(await page.getByLabel('图片修改需求').inputValue(), '')
  await page.getByLabel('箭头标注要求').fill(oversized)
  await page.getByLabel('箭头标注要求').press('Escape')
  assert.equal(await page.getByLabel('箭头标注要求').count(), 0)
  await page.getByRole('button', { name: '按标注修改', exact: true }).click()
  await page.waitForFunction(() => window.canvasSubmissions.length === 1)
  const submission = await page.evaluate(() => window.canvasSubmissions[0])
  assert.equal(submission.intent.sourceIds.length, 2)
  assert(submission.instruction.includes('仅将蓝色圆形改成绿色，保留橙色三角形、背景和整体布局，不添加其他元素。'))
  const saved = await page.evaluate(() => window.readCanvasFixture().pages[0].elements)
  assert.equal(saved.find(item => item.type === 'arrow').points.length, 3)
  const label = saved.find(item => item.type === 'text' && item.customData?.emateAnnotationArrowId)
  const labelBox = saved.find(item => item.id === label.containerId)
  const image = saved.find(item => item.type === 'image')
  assert(labelBox && labelBox.backgroundColor === '#ffffff')
  assert.equal(label.strokeColor, '#1e1e1e')
  assert(label.text.includes('\n'), 'native bound text wraps long Chinese')
  assert(labelBox.x >= image.x && labelBox.y >= image.y)
  assert(labelBox.x + labelBox.width <= image.x + image.width + 1)
  assert(labelBox.y + labelBox.height <= image.y + image.height + 1)
  assert(labelBox.width * labelBox.height < image.width * image.height / 2)
  assert(saved.find(item => item.type === 'arrow').strokeWidth >= 4)

  await mkdir(root + '.test-artifacts', { recursive: true })
  await page.screenshot({ path: root + '.test-artifacts/canvas-annotation-submit.png' })
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
  await writeFile(root + '.test-artifacts/canvas-readable-export.png', png)
  assert.equal(png.readUInt32BE(16), 420, 'native export bounds are image width plus default 10px padding on each side')
  assert.equal(png.readUInt32BE(20), 320, 'native export bounds are image height plus default 10px padding on each side')
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
  // Opening the legacy page fits its viewport; its saved content must remain exact.
  const reopenedLegacy = await page.evaluate(() => window.readCanvasFixture().pages[1])
  assert.deepEqual({ ...reopenedLegacy, view: legacy.view }, legacy)
  await mkdir(root + '.test-artifacts', { recursive: true })
  await page.screenshot({ path: root + '.test-artifacts/canvas-browser.png', fullPage: true })

  for (const scenario of ['narrow', 'dark']) {
    const probe = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
    await probe.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
    await probe.goto(origin + '/?' + scenario)
    await probe.getByRole('button', { name: 'Open canvas' }).click()
    await probe.locator('.excalidraw').waitFor()
    await probe.waitForTimeout(500)
    const bounds = await probe.locator('.excalidraw canvas').last().boundingBox()
    const transform = await probe.evaluate(() => window.readCanvasFixture().pages[0].view)
    const toScreen = (x, y) => ({ x: bounds.x + (x + transform.scrollX) * transform.zoom, y: bounds.y + (y + transform.scrollY) * transform.zoom })
    if (scenario === 'dark') await probe.getByLabel('箭头颜色').fill('#ffffff')
    await probe.getByRole('button', { name: '箭头', exact: true }).click()
    const from = toScreen(20, 40), to = toScreen(scenario === 'narrow' ? 20 : 160, 200)
    await probe.mouse.move(from.x, from.y); await probe.mouse.down(); await probe.mouse.move(to.x, to.y, { steps: 10 }); await probe.mouse.up()
    await probe.getByLabel('箭头标注要求').fill(scenario === 'narrow' ? '请保留原图，仅修改蓝色圆形' : '圆形改绿')
    if (scenario === 'narrow') {
      await probe.getByRole('alert').filter({ hasText: '图片内放不下此标注' }).waitFor()
      assert.equal(await probe.getByLabel('箭头标注要求').inputValue(), '请保留原图，仅修改蓝色圆形')
      assert(await probe.getByRole('button', { name: '按标注修改', exact: true }).isDisabled())
    } else {
      await probe.getByLabel('箭头标注要求').press('Enter')
      await probe.getByLabel('更多画布操作').click()
      await probe.getByRole('button', { name: '保存', exact: true }).click()
      const elements = await probe.evaluate(() => window.readCanvasFixture().pages[0].elements)
      assert.equal(elements.find(item => item.type === 'arrow').strokeColor, '#ffffff', 'new native arrow preserves chosen color through curve conversion')
      const exportEvent = probe.waitForEvent('download')
      await probe.getByRole('button', { name: '导出 PNG', exact: true }).click()
      const exported = await readFile(await (await exportEvent).path())
      await writeFile(root + '.test-artifacts/canvas-dark-readable-export.png', exported)
      assert.equal(exported.readUInt32BE(16), 420)
      assert.equal(exported.readUInt32BE(20), 320)
    }
    await probe.screenshot({ path: root + '.test-artifacts/canvas-' + scenario + '-annotation.png' })
    await probe.close()
  }
  console.log(JSON.stringify({ claim: 'local-real-browser-component-not-installed-app', external_requests: outside.length, editor_loaded_after_gesture: true, page_errors: errors, hidden_legacy_pages_preserved: true, theme: 'native-dark' }))
})
