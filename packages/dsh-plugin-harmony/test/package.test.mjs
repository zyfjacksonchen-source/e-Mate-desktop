import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { BUILTIN_SEAMS, LOAD_DEPENDENCIES, assertSeams, satisfiesRange } from '../scripts/seams.mjs'
import { BUILTINS, SHIPPED_FILES, SHIPPED_TREES } from '../scripts/shipped.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..', '..')
const vendored = resolve(repo, 'upstream', 'plugins', 'dsh-harmony')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

function walk(directory, collected = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, collected)
    else collected.push(path)
  }
  return collected
}

test('owns the pinned identity without adding a runtime dependency', () => {
  assert.equal(manifest.name, '@e-mate/dsh-plugin-harmony')
  assert.equal(manifest.version, '2.0.18')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.private, true)
  assert.equal(manifest.eMate.harnessVersion, '0.1.5-rc.1')
  assert.equal(manifest.eMate.harnessCommit, 'd1d095bee770c3e9d302f844083e02f0b74576ee')
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.dsh.upstream.version, '0.8.10')
  assert.equal(manifest.dsh.upstream.tarballSha256, 'a45b92a4acb9e71f97c1ab62bdb2ac79974c5429e4bd2631e8afab01af42f4c4')
  assert.equal(manifest.main, 'lib/index.js')
  assert.ok(existsSync(resolve(root, manifest.main)), 'main entry must be built before packaging')
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  for (const entry of manifest.files) {
    assert.ok(!entry.includes('..') && !entry.startsWith('/'), `unsafe files entry: ${entry}`)
    assert.ok(existsSync(resolve(root, entry)), `files entry is missing: ${entry}`)
  }
})

test('defers the client bundle and the harmony-settings row instead of mounting unverified seams', async () => {
  assert.equal(manifest.dsh.client, undefined, 'the client bundle registers module id dsh-harmony and must stay unmounted until that id is verified')
  assert.ok(existsSync(resolve(root, 'browser-dist/client.js')), 'the vendored client bundle stays available for the later slice')
  const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: emate-harmony\n/u)
  assert.match(patch, /name: '@e-mate\/dsh-plugin-harmony'/u)
  assert.equal(patch.includes("name: '@e-mate/dsh-plugin-harmony/settings'"), false, 'lib/settings.js imports the deleted settingsNamespace() and must not be mounted yet')
  const settingsEntry = await readFile(resolve(root, 'lib/settings.js'), 'utf8')
  assert.match(settingsEntry, /import \{ settingsNamespace \} from '@deepseek-ai\/dsh-settings'/u)
})

test('re-declares exactly the four vendored builtins', async () => {
  assert.deepEqual(manifest.dsh.harmony.patches.map(entry => entry.replace(/^\.\//u, '')), [...BUILTINS])
  assert.equal(BUILTIN_SEAMS.length, 4)
  assert.deepEqual(BUILTIN_SEAMS.map(seam => seam.id), ['client-load-plan', 'cordis-service-index', 'settings', 'session-profile'])
  for (const relative of BUILTINS) {
    assert.ok(existsSync(resolve(root, relative)), `builtin is missing: ${relative}`)
    const source = await readFile(resolve(root, relative), 'utf8')
    const seam = BUILTIN_SEAMS.find(candidate => candidate.builtin === relative)
    for (const part of seam.parts) {
      if (part.select !== 'SourceFile') {
        assert.ok(source.includes(part.select), `${part.id} selector is no longer in ${relative}`)
      }
      assert.ok(source.includes(part.id), `${part.id} is no longer declared in ${relative}`)
    }
    assert.ok(source.includes('throw new Error'), `${relative} no longer fails closed on its inner lookups`)
  }
  const compat = await readFile(resolve(root, 'lib/builtins/dsh-compat.cjs'), 'utf8')
  for (const constant of ["LEGACY_CLIENT_RANGE = '>=0.1.1-rc.2 <0.1.2-0'", "LEGACY_SHARED_RANGE = '>=0.1.0-rc.8 <0.1.2-0'", "DSH_012_RANGE = '>=0.1.2-alpha.4 <0.1.3-0'"]) {
    assert.ok(compat.includes(constant), `dsh-compat.cjs no longer declares ${constant}`)
  }
})

test('copies the vendored published tree unchanged', () => {
  const copied = []
  const expected = []
  for (const tree of SHIPPED_TREES) {
    for (const file of walk(resolve(root, tree))) copied.push(relative(root, file))
    for (const file of walk(resolve(vendored, tree))) expected.push(relative(vendored, file))
  }
  for (const file of SHIPPED_FILES) {
    copied.push(file)
    expected.push(file)
  }
  assert.deepEqual(copied.sort(), expected.sort(), 'the package copy must mirror the vendored published trees')
  for (const file of copied) {
    assert.deepEqual(readFileSync(resolve(root, file)), readFileSync(resolve(vendored, file)), `${file} differs from the vendored upstream file`)
  }
  assert.equal(existsSync(resolve(root, 'harmony.patch.yml')), false, 'upstream harmony.patch.yml must not ship: this package owns its own mount row')
  assert.ok(statSync(resolve(root, 'scripts/build.mjs')).isFile())
})

test('keeps the vendored host entry importable-shape and dependency-gap list current', () => {
  assert.ok(LOAD_DEPENDENCIES.length >= 8)
  const atomicWrite = LOAD_DEPENDENCIES.find(entry => entry.specifier === '@deepseek-ai/dsh-atomic-write')
  assert.match(atomicWrite.available, /base-contract/iu)
  const entry = readFileSync(resolve(root, 'lib/index.js'), 'utf8')
  assert.match(entry, /from '\.\/plugin\.js'/u)
  const plugin = readFileSync(resolve(root, 'lib/plugin.js'), 'utf8')
  for (const specifier of ['\./profile\.js', '\./session-profile\.js', '\./runtime\.js']) {
    assert.match(plugin, new RegExp(`from '${specifier}'`, 'u'))
  }
  assert.match(readFileSync(resolve(root, 'lib/transform.js'), 'utf8'), /from '@phenomnomnominal\/tsquery'/u)
})

test('resolves every builtin seam against the pinned 0.1.5 build', () => {
  const report = assertSeams()
  assert.equal(report.builtins.length, 4)
  for (const builtin of report.builtins) {
    for (const part of builtin.parts) {
      assert.equal(part.ok, true, `${builtin.id}/${part.id}: ${part.detail}`)
      assert.equal(part.found, part.expect)
    }
  }
  assert.deepEqual(report.ranges.map(range => range.id), ['client-load-plan', 'cordis-service-index', 'settings', 'session-profile'])
  assert.deepEqual(report.ranges.map(range => range.satisfied), [false, true, false, false], 'only the cordis range covers the pinned 4.0.2')
})

test('evaluates declared ranges exactly as semver does with includePrerelease', () => {
  // Ground truth produced by semver@7.8.5 (facts §76); the last row is the pair
  // that caught the tuple-restricted pre-release rule being wrongly applied.
  const cases = [
    ['0.1.5-rc.1', '>=0.1.1-rc.2 <0.1.2-0 || >=0.1.2-alpha.4 <0.1.3-0', false],
    ['4.0.2', '>=4.0.1', true],
    ['4.0.0', '>=4.0.1', false],
    ['0.1.5-rc.1', '>=0.1.0-rc.8 <0.1.2-0 || >=0.1.2-alpha.4 <0.1.3-0', false],
    ['0.1.5-rc.1', '>=0.1.2-alpha.4 <0.1.3-0', false],
    ['0.1.2-alpha.5', '>=0.1.1-rc.2 <0.1.2-0 || >=0.1.2-alpha.4 <0.1.3-0', true],
    ['0.1.1-rc.2', '>=0.1.0-rc.8 <0.1.2-0 || >=0.1.2-alpha.4 <0.1.3-0', true],
    ['0.1.3-0', '>=0.1.2-alpha.4 <0.1.3-0', false],
    ['0.1.0-rc.7', '>=0.1.0-rc.8 <=0.1.1-rc.2', false],
  ]
  for (const [version, range, expected] of cases) {
    assert.equal(satisfiesRange(version, range), expected, `${version} in ${range}`)
  }
  assert.equal(satisfiesRange('0.1.5-rc.1', '>=nonsense'), 'unknown')
})
