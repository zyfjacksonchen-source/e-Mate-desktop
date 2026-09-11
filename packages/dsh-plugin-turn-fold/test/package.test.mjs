import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { HOST_SYMBOLS, SEAMS, TARGET, assertSeams } from '../scripts/seams.mjs'
import { SHIPPED } from '../scripts/shipped.mjs'

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
  assert.equal(manifest.eMate.harnessCommit, 'd1d095bee770c3e9d302f844083e02f0b74576ee')
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
  assert.match(patch, /inject: \[harmony\]/u)
  const vendorPatch = await readFile(resolve(vendored, 'harmony.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /ch4acko3/u, 'the e-Mate row must not re-declare the upstream provider id')
  assert.match(vendorPatch, /ch4acko3-dsh-turn-fold/u)
})

test('copies the vendored bytes unchanged', async () => {
  for (const relative of SHIPPED) {
    const shipped = await readFile(resolve(root, 'lib', relative))
    const source = await readFile(resolve(vendored, relative))
    assert.deepEqual(shipped, source, `lib/${relative} differs from the vendored upstream file`)
  }
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
