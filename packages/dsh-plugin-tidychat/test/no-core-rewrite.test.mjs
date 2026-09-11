/**
 * The rule "no plugin modifies the core", proved against this checkout and against
 * mutations of it. The mutations are fed to the shipping rule objects, so a rule
 * replaced by a constant would turn these cases red instead of silently passing.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  SELF_EXEMPT_PATHS,
  findViolations,
  isShippedSurface,
  observedTestBundleReads,
  readPluginSurfaces,
  reviewedTestBundleReads,
} from './no-core-rewrite.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const files = readPluginSurfaces(ROOT)

/** One synthetic file at a repository-relative path. */
const file = (path, text) => ({ path, text })

const SHIPPED = 'packages/dsh-plugin-example/src/client/index.ts'
const TEST_FILE = 'packages/dsh-plugin-example/test/example.test.mjs'

test('the scan covers the e-Mate plugin surfaces instead of an empty set', () => {
  assert.ok(files.length > 400, 'scanned ' + String(files.length) + ' files')
  const paths = new Set(files.map(entry => entry.path))
  assert.ok(paths.has('packages/dsh-plugin-tidychat/src/client/index.ts'), 'tidychat client source is scanned')
  assert.ok(paths.has('packages/dsh-plugin-univer-office/src/client/index.tsx'), 'a second plugin source is scanned')
  assert.ok([...paths].some(path => path.startsWith('packages/dsh/profile/plugins/emate-shell/src/')), 'a profile plugin source is scanned')
  assert.ok([...paths].some(path => path.startsWith('packages/dsh-plugin-canvas/test/')), 'plugin tests are scanned')
})

test('the self-exemption names exactly the checker pair and both files exist', () => {
  assert.deepEqual(SELF_EXEMPT_PATHS, [
    'packages/dsh-plugin-tidychat/test/no-core-rewrite.mjs',
    'packages/dsh-plugin-tidychat/test/no-core-rewrite.test.mjs',
  ])
  for (const path of SELF_EXEMPT_PATHS) assert.ok(existsSync(ROOT + '/' + path), path)
  assert.ok(!files.some(entry => SELF_EXEMPT_PATHS.includes(entry.path)), 'the checker never scans itself')
})

test('no e-Mate plugin parses, patches or writes a compiled Harness artifact', () => {
  const violations = findViolations(files)
  assert.deepEqual(violations, [], violations.map(entry => entry.rule + ' ' + entry.path + ':' + String(entry.line)).join('; '))
})

test('the reviewed reads are exactly the Harness bundle reads the tree contains', () => {
  assert.deepEqual(observedTestBundleReads(files), reviewedTestBundleReads())
})

test('shipped surfaces are separated from test-only surfaces', () => {
  assert.equal(isShippedSurface(SHIPPED), true)
  assert.equal(isShippedSurface('packages/dsh-plugin-example/scripts/build.mjs'), true)
  assert.equal(isShippedSurface('packages/dsh/profile/plugins/emate-shell/src/client/index.ts'), true)
  assert.equal(isShippedSurface(TEST_FILE), false)
  assert.equal(isShippedSurface('packages/dsh/profile/plugins/emate-shell/tests/a.spec.tsx'), false)
})

test('a source-parsing toolchain is rejected, and the clean file is not', () => {
  assert.deepEqual(findViolations([file(SHIPPED, "import { createSourceFile } from 'typescript'")]), [
    { path: SHIPPED, line: 1, text: "import { createSourceFile } from 'typescript'", rule: 'parsing-toolchain', detail: 'imports typescript' },
  ])
  assert.deepEqual(findViolations([file(SHIPPED, "import { createSourceFile } from '@phenomnomnominal/tsquery'")])
    .filter(entry => entry.rule === 'parsing-toolchain').length, 1)
  assert.deepEqual(findViolations([file(SHIPPED, "import * as React from 'react'")]), [])
})

test('a source rewrite is rejected on both the selector and the editor side', () => {
  assert.deepEqual(findViolations([file(SHIPPED, "const found = tsquery(sourceFile, 'FunctionDeclaration')")])
    .map(entry => entry.rule), ['source-rewrite'])
  assert.deepEqual(findViolations([file(SHIPPED, 'edit.prependLeft(node.getStart(sourceFile), INLINE)')])
    .map(entry => entry.rule), ['source-rewrite'])
  assert.deepEqual(findViolations([file(SHIPPED, 'const sourceFile = createSourceFile(name, text)')])
    .map(entry => entry.rule), ['source-rewrite'])
  assert.deepEqual(findViolations([file(SHIPPED, 'const edit = new MagicString(text)')])
    .map(entry => entry.rule), ['source-rewrite'])
  assert.deepEqual(findViolations([file(SHIPPED, 'ctx.slots.register({ name: "conversation.view" }, View)')]), [])
  // A protocol constant that spells a rewriting method is not a rewrite.
  assert.deepEqual(findViolations([file(SHIPPED, "await connection.send('Input.insertText', { text }, signal)")]), [])
})

test('shipped code may not read a compiled Harness client bundle', () => {
  const source = "const bundle = readFileSync('upstream/deepseek-harness/packages/client/ui-chat/lib/client.js', 'utf8')"
  assert.deepEqual(findViolations([file(SHIPPED, source)]).map(entry => entry.rule), ['shipped-harness-bundle'])
  const own = "const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')"
  assert.deepEqual(findViolations([file(SHIPPED, own)]), [])
})

test('a test may only read the bundles the review list admits', () => {
  const unreviewed = "const bundle = readFileSync('upstream/deepseek-harness/packages/client/ui-chat/lib/client.js', 'utf8')"
  assert.deepEqual(findViolations([file(TEST_FILE, unreviewed)]).map(entry => entry.rule), ['unreviewed-harness-bundle'])
  const reviewed = "const bundle = readFileSync(resolve('../../upstream/deepseek-harness/packages/client/ui-chat/lib/client.js'), 'utf8')"
  const at = file('packages/dsh/profile/plugins/emate-shell/tests/image-gallery.client.spec.tsx', reviewed)
  assert.deepEqual(findViolations([at]), [])
})

test('a write into the Harness closure is rejected even from a test', () => {
  const source = "writeFileSync(join(targetLib, 'client.js'), adaptHarnessChatSource(readFileSync(client, 'utf8')))"
  assert.deepEqual(findViolations([file(TEST_FILE, source)]).map(entry => entry.rule), ['harness-artifact-write'])
  assert.deepEqual(findViolations([file(TEST_FILE, "writeFileSync(join(root, 'lib/client.js'), client)")]), [])
})

test('a plugin cannot publish a bundle read under a different bundle name', () => {
  const source = "readFileSync('upstream/deepseek-harness/packages/client/ui-conversation/lib/client.js', 'utf8')"
  assert.deepEqual(findViolations([file('packages/dsh/profile/plugins/emate-shell/tests/image-gallery.client.spec.tsx', source)])
    .map(entry => entry.rule), ['unreviewed-harness-bundle'])
})

test('every reviewed read still names a bundle the pinned Harness actually emits', () => {
  const reviewed = reviewedTestBundleReads()
  assert.equal(reviewed.length, 2)
  for (const key of reviewed) {
    const index = key.indexOf('#client/')
    const path = key.slice(0, index)
    const target = key.slice(index + 1)
    assert.ok(existsSync(ROOT + '/' + path), path)
    assert.ok(existsSync(ROOT + '/upstream/deepseek-harness/packages/' + target), target)
  }
})
