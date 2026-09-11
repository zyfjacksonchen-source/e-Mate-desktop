import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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
  assert.equal(manifest.eMate.harnessCommit, 'f9e0f1190e4021e63db579ef36b67484028e8c53')
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
  assert.deepEqual(entry.inject, ['harmony'])
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
