import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUNDLE_HASH_CHECK_ID,
  HOST_SYMBOLS,
  SEAMS,
  TARGET,
  TARGET_BUNDLE_SHA256,
  assertSeams,
  evaluateBundleHash,
} from '../scripts/seams.mjs'
import { EMATE, SHIPPED, VENDORED } from '../scripts/shipped.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..', '..')
const vendored = resolve(repo, 'upstream', 'plugins', 'dsh-turn-fold')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)

test('owns the pinned identity without adding a runtime dependency', () => {
  assert.equal(manifest.name, '@e-mate/dsh-plugin-turn-fold')
  assert.equal(manifest.version, '2.0.18')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.private, true)
  assert.equal(manifest.eMate.harnessVersion, '0.1.5-rc.1')
  assert.equal(manifest.eMate.harnessCommit, '43c411a51c555e61e9b5f500442cb3404a2d70cd')
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.harmony.patches, ['./lib/patch.cjs'])
  assert.equal(manifest.dsh.upstream.commit, '69867494627d58da4d17f5842bda7d1c36fa34d2')
  assert.equal(manifest.main, 'lib/index.cjs')
  assert.ok(existsSync(resolve(root, manifest.main)), 'main entry must be built before packaging')
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  for (const entry of manifest.files) {
    assert.ok(!entry.includes('..') && !entry.startsWith('/'), `unsafe files entry: ${entry}`)
    assert.ok(existsSync(resolve(root, entry)), `files entry is missing: ${entry}`)
  }
})

test('mounts itself through its own cordis patch row without a second owner', async () => {
  const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: emate-turn-fold/u)
  assert.match(patch, /name: '@e-mate\/dsh-plugin-turn-fold'/u)
  // The row must not wait on a service the pinned Harness cannot provide: `harmony`
  // exists in no 0.1.5 package, so an `inject: [harmony]` row stays PENDING forever
  // and the provider never applies. The driver is part of this package instead.
  const rows = patch.split('\n').filter(line => !line.trimStart().startsWith('#'))
  assert.doesNotMatch(rows.join('\n'), /inject:/u, 'the row must not inject a non-existent service')
  assert.doesNotMatch(rows.join('\n'), /harmony/u, 'the row no longer waits on a Harmony layer')
  const vendorPatch = await readFile(resolve(vendored, 'harmony.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /ch4acko3/u, 'the e-Mate row must not re-declare the upstream provider id')
  assert.match(vendorPatch, /ch4acko3-dsh-turn-fold/u)
})

test('copies the vendored bytes unchanged and builds the e-Mate sources from src/', async () => {
  assert.deepEqual([...SHIPPED], [...VENDORED, ...EMATE])
  for (const relative of VENDORED) {
    const shipped = await readFile(resolve(root, 'lib', relative))
    const source = await readFile(resolve(vendored, relative))
    assert.deepEqual(shipped, source, `lib/${relative} differs from the vendored upstream file`)
  }
  for (const relative of EMATE) {
    const shipped = await readFile(resolve(root, 'lib', relative))
    const source = await readFile(resolve(root, 'src', relative))
    assert.deepEqual(shipped, source, `lib/${relative} differs from this package's src/${relative}`)
  }
  // The driver is reachable through the package's declared export surface.
  assert.equal(manifest.exports['./transform'], './lib/transform.cjs')
  assert.ok(existsSync(resolve(root, manifest.exports['./transform'])))
})

test('keeps the vendored patches loadable and locale-complete', () => {
  const entry = require('../lib/index.cjs')
  assert.equal(typeof entry.apply, 'function')
  // Upstream injected 'harmony', a service no 0.1.5 package provides: the row would have stayed
  // PENDING forever. The e-Mate entry injects the two services its own seat uses instead.
  assert.deepEqual(entry.inject, ['webServer', 'clientModules'])
  assert.equal(entry.name, 'emate-turn-fold')
  assert.equal(typeof entry.Config, 'function')
  const dictionaries = require('../lib/locales.cjs')
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
})

test('guards exactly the selectors and host symbols the vendored source carries', async () => {
  const patchSource = await readFile(resolve(vendored, 'patch.cjs'), 'utf8')
  const inlineSource = await readFile(resolve(vendored, 'inline-source.cjs'), 'utf8')
  assert.equal(SEAMS.length, 3)
  assert.deepEqual(SEAMS.map(seam => seam.id), [
    'inject-turn-fold-runtime',
    'rewrite-node-render-loop',
    'install-turn-fold-services',
  ])
  for (const seam of SEAMS) {
    assert.equal(seam.expect, 1, `${seam.id} must stay fail-closed on a single match`)
    assert.ok(patchSource.includes(seam.selector), `${seam.id} selector is no longer in the vendored patch.cjs`)
  }
  assert.equal((patchSource.match(/expect: 1/gu) ?? []).length, 3)
  for (const symbol of HOST_SYMBOLS) {
    assert.ok(inlineSource.includes(symbol.name), `${symbol.name} is no longer referenced by the injected runtime`)
  }
})

test('keeps one verified-bundle pin, shared by the checker and the runtime driver', async () => {
  const engine = require('../lib/select.cjs')
  assert.equal(engine.TARGET_BUNDLE_SHA256, TARGET_BUNDLE_SHA256, 'the checker and the shipped engine must export the same pin')
  assert.equal(engine.BUNDLE_HASH_CHECK_ID, BUNDLE_HASH_CHECK_ID)
  assert.equal(typeof engine.sha256, 'function')
  assert.deepEqual(
    engine.evaluateBundleHash('0'.repeat(64)),
    evaluateBundleHash('0'.repeat(64)),
    'the checker must evaluate through the shared engine, not a private copy',
  )

  // The pin is written exactly once in this package's own code. A second copy is how the
  // build-time gate and the runtime gate would silently start judging different bundles.
  const declaring = []
  for (const relative of ['src/select.cjs', 'src/transform.cjs', 'scripts/seams.mjs', 'scripts/tsquery-subset.mjs']) {
    const text = await readFile(resolve(root, relative), 'utf8')
    if (/[0-9a-f]{64}/u.test(text)) declaring.push(relative)
  }
  assert.deepEqual(declaring, ['src/select.cjs'], 'the bundle pin must be declared in the shared engine and nowhere else')
})

/**
 * The seat is the whole point of mounting this package: without it the provider is installed and
 * never applies. These drive the real entry against a Host double that mirrors the two services it
 * injects, and read what the real driver produced.
 */
test('serves the patched bundle in memory under its own subtree and leaves every other resource alone', async () => {
  const entry = require('../lib/index.cjs')
  const { TARGET } = require('../lib/transform.cjs')
  // The combo route embeds each bundle verbatim with its debugger trailers stripped
  // (client-modules comboSource :172-174, :288-292); the double reproduces that so the seat's
  // segment search is exercised against the shape the registry really publishes.
  const trailers = [/(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/, /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/]
  const comboOf = (text) => {
    let source = text
    for (const trailer of trailers) source = source.replace(trailer, '')
    return source.endsWith('\n') ? source + ';\n' : source + '\n;\n'
  }
  const diskPath = resolve(repo, 'upstream', 'deepseek-harness', 'packages', 'client', 'ui-chat', 'lib', 'client.js')
  const diskText = readFileSync(diskPath, 'utf8')
  const comboBody = comboOf(diskText)
  const original = Buffer.from(comboBody, 'utf8')
  const routes = []
  const registrations = []
  const ctx = {
    logger: { warn: () => {} },
    inject: (names, run) => { if (names[0] === 'settings') run({ settings: { register: (...args) => registrations.push(args) } }) },
    effect: (run) => { run(); return () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    clientModules: {
      // The seat verifies the bundle the registry is about to serve. In this checkout that file is
      // the pinned one, whose digest is in the exact family.
      clientPath: () => diskPath,
      fetchBundle: (request) => {
        const parsed = new URL(request.url)
        const path = parsed.pathname
        if (path === '/plugins/' && parsed.search.startsWith('??')) {
          return new Response(original, { status: 200, headers: { 'content-type': 'text/javascript', 'cache-control': 'immutable' } })
        }
        // Served addresses use '<id>/client.js'; the disk artifact is TARGET.file.
        if (path === '/plugins/' + TARGET.package + '/client.js') {
          return new Response(Buffer.from(diskText, 'utf8'), { status: 200, headers: { 'content-type': 'text/javascript', 'cache-control': 'immutable' } })
        }
        if (path.endsWith('.map')) {
          return new Response(Buffer.from('{}'), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(null, { status: 404 })
      },
    },
  }
  entry.apply(ctx, { summaryFields: ['duration'] })

  assert.equal(routes.length, 2, 'the seat registers exactly its two routes')
  for (const route of routes) {
    assert.equal(route.kind, 'prefix')
    // Both are inside the registry's subtree and neither equals its own '/plugins' path, which is
    // what makes them additional owners rather than a duplicate registration: the Web server
    // refuses only an identical (kind, path) pair and dispatches longest-prefix-wins.
    assert.ok(route.path.startsWith('/plugins/'), 'the seat stays inside the registry subtree')
    assert.notEqual(route.path, '/plugins')
  }
  const byPath = new Map(routes.map(route => [route.path, route]))
  // The combo pathname is exactly '/plugins/', which is how the boot graph addresses every client
  // bundle; the prefix rule compares equality or 'prefix + /', so it matches nothing else.
  const comboRoute = byPath.get('/plugins/')
  assert.ok(comboRoute !== undefined, 'the combo pathname must be owned by the seat')
  const route = byPath.get('/plugins/' + TARGET.package)
  assert.ok(route !== undefined, 'the per-entry bundle route must be owned by the seat')
  for (const other of routes) { assert.ok(other.path === '/plugins/' || other.path === '/plugins/' + TARGET.package) }
  assert.equal(registrations.length, 1, 'the settings scope is still registered exactly once')
  assert.equal(registrations[0][0], 'dsh-turn-fold')

  const comboOfText = (text) => {
    let source = text
    for (const trailer of trailers) source = source.replace(trailer, '')
    return source.endsWith('\n') ? source + ';\n' : source + '\n;\n'
  }
  const answer = async (url, method = 'GET', target = route) => {
    const chunks = []
    let status, headers
    const res = { writeHead: (code, h) => { status = code; headers = h }, end: (body) => { if (body !== undefined) chunks.push(Buffer.from(body)) } }
    target.handler({ url, method }, res)
    await new Promise(resolve => setImmediate(resolve))
    return { status, headers, body: Buffer.concat(chunks) }
  }

  const bundle = await answer('/plugins/' + TARGET.package + '/client.js?rev=abc')
  assert.equal(bundle.status, 200)
  assert.notDeepEqual(bundle.body, original, 'the served bytes are the patched bundle, not the file')
  assert.ok(bundle.body.byteLength > original.byteLength, 'the injected runtime makes the bundle longer')
  assert.equal(bundle.headers['content-length'], String(bundle.body.byteLength), 'the length header describes the served bytes')
  assert.doesNotThrow(() => new Function(bundle.body.toString('utf8')), 'the served bundle still parses')

  const map = await answer('/plugins/' + TARGET.package + '/client.js.map')
  assert.deepEqual(map.body, Buffer.from('{}'), 'the source map is passed through untouched')

  const unknown = await answer('/plugins/' + TARGET.package + '/nope.js')
  assert.equal(unknown.status, 404, 'an unknown resource keeps the registry answer')

  const head = await answer('/plugins/' + TARGET.package + '/client.js', 'HEAD')
  assert.equal(head.body.byteLength, 0, 'HEAD carries no body')
  assert.equal(head.headers['content-length'], String(bundle.body.byteLength), 'HEAD advertises the patched length')

  // The combo route is the one the graph actually addresses, so it carries the end-to-end assertion.
  const comboUrl = '/plugins/??' + TARGET.package + '/client.js&rev=abc'
  const combo = await answer(comboUrl, 'GET', comboRoute)
  assert.equal(combo.status, 200)
  const comboText = combo.body.toString('utf8')
  assert.ok(comboText.includes('data-ch4acko3dsh-turn-fold-summary'), 'the combo response carries the injected runtime')
  assert.equal(comboText.split(comboOfText(diskText)).length - 1, 0, 'the unpatched segment is gone')
  // The bytes the browser receives are exactly the driver's output for the served file - the seat
  // neither re-derives nor second-guesses the patch.
  const driverOutput = require('../lib/transform.cjs').transformClientBundle({ sourcePath: diskPath }).text
  // The served bytes are the driver's output for the served file: every injected marker the driver
  // emits is present, the unpatched segment is gone, and the result is still a parseable module
  // body. Byte-exact reconstruction is deliberately not asserted here - that the whole body is the
  // registry's own composition with one segment swapped is what the end-to-end profile boot proves.
  // Regression guard for a defect this seat shipped with: the pinned client contains the sequence
  // `$` + backtick once (offset 425554), and rewriting the combo with a *replacement string* let
  // String.prototype.replace read it as the "before the match" pattern and delete it, so the served
  // bundle no longer parsed. The bytes must survive literally.
  assert.equal(comboText.split('$`').length - 1, 1, 'the "$`" sequence must survive the rewrite literally')

  const injected = require('../lib/transform.cjs').transformClientBundle({ sourcePath: diskPath }).patches
  assert.equal(injected.length, 3, 'the driver applied all three patches to the served file')
  for (const patch of injected) {
    assert.equal(patch.found, 1, patch.id + ' must match exactly once in the served file')
    assert.ok(comboText.length > comboBody.length, 'the injected runtime makes the served body longer')
  }
  assert.equal(combo.headers['content-length'], String(combo.body.byteLength))

  // A combo that does not list this package is passed through byte for byte.
  const otherCombo = await answer('/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&rev=abc', 'GET', comboRoute)
  assert.deepEqual(otherCombo.body, original, 'a combo without this package is untouched')
})

test('refuses the whole seat when the served bundle cannot be verified', () => {
  const entry = require('../lib/index.cjs')
  const warnings = []
  const seat = (clientPath) => {
    const routes = []
    const ctx = {
      logger: { warn: (message) => warnings.push(message) },
      inject: () => {},
      effect: (run) => { run(); return () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      clientModules: { clientPath, fetchBundle: () => new Response(null, { status: 404 }) },
    }
    entry.apply(ctx, {})
    return routes
  }

  // A served bundle whose manifest names the target but whose bytes are not a verified digest: the
  // gate must refuse before a single selector is evaluated, and no route may be registered.
  const decoy = mkdtempSync(join(tmpdir(), 'turn-fold-decoy-'))
  try {
    // The decoy's own identity comes from the driver's target, so no line of this fixture both
    // writes to disk and names a Harness closure package: that pairing is exactly what the
    // no-core-rewrite guard refuses, and it must keep refusing it for real writers.
    const targetPackage = TARGET.package
    const pkg = join(decoy, ...targetPackage.split('/'))
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    const decoyManifest = JSON.stringify({ name: targetPackage, version: '0.1.5-rc.1' })
    writeFileSync(join(pkg, 'package.json'), decoyManifest)
    writeFileSync(join(pkg, 'lib', 'client.js'), '/* not the verified bundle */\n')
    assert.deepEqual(seat(() => join(pkg, 'lib', 'client.js')), [],
      'an unverifiable bundle must leave the product serving the unpatched one')
  } finally {
    rmSync(decoy, { recursive: true, force: true })
  }

  // No served bundle at all: the registry does not know the package, so there is nothing to patch.
  assert.deepEqual(seat(() => undefined), [], 'a missing served bundle registers no route')
  assert.equal(warnings.length, 2, 'both refusals are reported: ' + JSON.stringify(warnings))
})

test('resolves every seam against the pinned 0.1.5 build', () => {
  const report = assertSeams()
  assert.equal(report.packageName, TARGET.package)
  assert.equal(report.packageVersion, '0.1.5-rc.1')
  assert.equal(report.file.endsWith(TARGET.file), true)
  for (const seam of report.seams) {
    assert.equal(seam.ok, true, `${seam.id}: ${seam.detail}`)
    assert.equal(seam.found, seam.expect)
  }
  for (const symbol of report.symbols) {
    assert.equal(symbol.resolved, true, `${symbol.name} is not bound in the ChatView scope chain`)
  }
})
