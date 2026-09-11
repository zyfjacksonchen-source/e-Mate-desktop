/**
 * The repository rules "no plugin modifies the core" and "no plugin owns the native
 * transcript", proved against this checkout and against mutations of it. The mutations
 * are fed to the shipping rule objects, so a rule replaced by a constant would turn
 * these cases red instead of silently passing.
 *
 * The one exemption - the AGENTS.md turn-folding ruling - is proved in both directions
 * here: the exempt provider roots are not reported for the families the ruling grants,
 * and the same source text one package over is still reported for every one of them.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  EXEMPT_PROVIDER_ROOTS,
  NATIVE_TRANSCRIPT_HOOKS,
  RETIRED_OWNER_ENTRIES,
  RETIRED_OWNER_MARKERS,
  SELF_EXEMPT_PATHS,
  findViolations,
  isExemptProviderPath,
  isShippedSurface,
  observedTestBundleReads,
  readPluginSurfaces,
  reviewedTestBundleReads,
} from './no-core-rewrite-guard.mjs'

// The checker lives in scripts/, so the repository root is one level up.
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const files = readPluginSurfaces(ROOT)

/** One synthetic file at a repository-relative path. */
const file = (path, text) => ({ path, text })

const SHIPPED = 'packages/dsh-plugin-example/src/client/index.ts'
const TEST_FILE = 'packages/dsh-plugin-example/test/example.test.mjs'

test('the scan covers the e-Mate plugin surfaces instead of an empty set', () => {
  assert.ok(files.length > 400, 'scanned ' + String(files.length) + ' files')
  const paths = new Set(files.map(entry => entry.path))
  assert.ok(paths.has('packages/dsh-plugin-file-import/src/client/index.tsx'), 'a plugin source is scanned')
  assert.ok(paths.has('packages/dsh-plugin-univer-office/src/client/index.tsx'), 'a second plugin source is scanned')
  assert.ok([...paths].some(path => path.startsWith('packages/dsh/profile/plugins/emate-shell/src/')), 'a profile plugin source is scanned')
  assert.ok([...paths].some(path => path.startsWith('packages/dsh-plugin-canvas/test/')), 'plugin tests are scanned')
})

test('the retired tidychat owner is gone from the plugin surfaces', () => {
  assert.ok(!files.some(entry => entry.path.startsWith('packages/dsh-plugin-tidychat/')), 'no tidychat surface is scanned')
  assert.ok(!existsSync(ROOT + '/packages/dsh-plugin-tidychat'), 'the retired plugin package is deleted')
})

test('the self-exemption names exactly the checker pair and both files exist', () => {
  assert.deepEqual(SELF_EXEMPT_PATHS, [
    'scripts/no-core-rewrite-guard.mjs',
    'scripts/no-core-rewrite-guard.test.mjs',
  ])
  for (const path of SELF_EXEMPT_PATHS) assert.ok(existsSync(ROOT + '/' + path), path)
  assert.ok(!files.some(entry => SELF_EXEMPT_PATHS.includes(entry.path)), 'the checker never scans itself')
})

test('no e-Mate plugin rewrites the core or owns the native transcript', () => {
  const violations = findViolations(files)
  assert.deepEqual(violations, [], violations.map(entry => entry.rule + ' ' + entry.path + ':' + String(entry.line)).join('; '))
})

test('the reviewed reads are exactly the Harness bundle reads the tree contains', () => {
  assert.deepEqual(observedTestBundleReads(files), reviewedTestBundleReads())
})

const EXEMPT_SCRIPT = 'packages/dsh-plugin-turn-fold/scripts/seams.mjs'
const EXEMPT_SCRIPT_2 = 'packages/dsh-plugin-harmony/scripts/seams.mjs'
const EXEMPT_TEST = 'packages/dsh-plugin-turn-fold/test/seams.test.mjs'
const OUTSIDE_SCRIPT = 'packages/dsh-plugin-canvas/scripts/build.mjs'
const OUTSIDE_TEST = 'packages/dsh-plugin-example/test/example.test.mjs'

test('the turn-folding exemption names exactly the provider roots, and they stay scanned', () => {
  assert.deepEqual(EXEMPT_PROVIDER_ROOTS, [
    'packages/dsh-plugin-turn-fold',
    'packages/dsh-plugin-harmony',
    'upstream/plugins/dsh-turn-fold',
    'upstream/plugins/dsh-harmony',
  ])
  for (const root of EXEMPT_PROVIDER_ROOTS) {
    assert.equal(isExemptProviderPath(root), true, root)
    assert.equal(isExemptProviderPath(root + '/scripts/seams.mjs'), true, root)
  }
  // Roots match exactly: a neighbouring package inherits nothing from the grant.
  assert.equal(isExemptProviderPath('packages/dsh-plugin-turn-fold-extra/scripts/build.mjs'), false)
  assert.equal(isExemptProviderPath('packages/dsh-plugin-turn-foldish/scripts/build.mjs'), false)
  assert.equal(isExemptProviderPath('upstream/plugins/dsh-harmony-fork/index.js'), false)
  assert.equal(isExemptProviderPath('packages/dsh/profile/plugins/emate-shell/src/client/index.ts'), false)
  // The exempt files are read, not skipped out of the scan: the write rule below
  // stays live inside them because these paths are in the scanned set.
  const scanned = new Set(files.map(entry => entry.path))
  assert.ok(scanned.has('packages/dsh-plugin-turn-fold/scripts/seams.mjs'), 'the provider seam checker is scanned')
  assert.ok(scanned.has('packages/dsh-plugin-harmony/scripts/seams.mjs'), 'the patcher seam checker is scanned')
  assert.ok(files.some(entry => isExemptProviderPath(entry.path)), 'exempt paths reach the rules')
})

test('the grant holds inside the exempt roots and the same text is refused outside them', () => {
  const cases = [
    ['parsing-toolchain', "import { createSourceFile } from 'typescript'"],
    ['source-rewrite', "const engine = tsquery(sourceFile, 'ClassDeclaration')"],
    ['source-rewrite', 'const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)'],
    ['shipped-harness-bundle', "const bundle = readFileSync('upstream/deepseek-harness/packages/client/ui-chat/lib/client.js', 'utf8')"],
    ['native-transcript-hook', "const column = document.querySelector('[data-chat-flow]')"],
    ['retired-owner-marker', "row.setAttribute('data-tidychat-folded', '1')"],
    ['retired-owner-identity', "ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'tidychat-nav' }, Rail)"],
  ]
  for (const [rule, line] of cases) {
    assert.deepEqual(findViolations([file(EXEMPT_SCRIPT, line)]), [], rule + ' inside the provider: ' + line)
    assert.deepEqual(findViolations([file(EXEMPT_SCRIPT_2, line)]), [], rule + ' inside the patcher: ' + line)
    assert.deepEqual(findViolations([file(OUTSIDE_SCRIPT, line)]).map(entry => entry.rule), [rule],
      rule + ' outside the provider: ' + line)
  }
  // A provider test may read the pinned bundle the same way a shipped script does.
  const bundle = cases[3][1]
  assert.deepEqual(findViolations([file(EXEMPT_TEST, bundle)]), [], 'the provider test may read the pinned bundle')
  assert.deepEqual(findViolations([file(OUTSIDE_TEST, bundle)]).map(entry => entry.rule), ['unreviewed-harness-bundle'])
})

test('the exemption never covers a write into the Harness closure', () => {
  const source = "writeFileSync(join(targetLib, 'client.js'), patched)"
  for (const path of [EXEMPT_SCRIPT, EXEMPT_SCRIPT_2, EXEMPT_TEST]) {
    assert.deepEqual(findViolations([file(path, source)]).map(entry => entry.rule), ['harness-artifact-write'],
      'a persisted patch stays refused in ' + path)
  }
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

test('every native transcript hook a retired owner needed is in the rule table', () => {
  assert.deepEqual(NATIVE_TRANSCRIPT_HOOKS, [
    'data-chat-anchor-key',
    'data-chat-flow-kind',
    'data-chat-turn',
    'data-chat-flow',
    'data-conversation-scroll',
  ])
})

test('shipped code may not address a native transcript hook', () => {
  const lines = [
    "const all = scopedRows('[data-chat-anchor-key]')",
    "const kind = row.getAttribute('data-chat-flow-kind') || ''",
    "const t = row.getAttribute('data-chat-turn')",
    "const column = document.querySelector('[data-chat-flow]')",
    "const host = document.querySelector('[data-conversation-scroll]')",
  ]
  for (const line of lines) {
    assert.deepEqual(findViolations([file(SHIPPED, line)]).map(entry => entry.rule), ['native-transcript-hook'], line)
  }
  // Reading the transcript is what folding and the retired rail were built on.
  assert.deepEqual(findViolations([file(TEST_FILE, lines[0])]), [], 'a test fixture may replay the native DOM')
  assert.deepEqual(findViolations([file(SHIPPED, "const el = document.querySelector('[data-composer-card]')")]), [],
    'the composer seam is not the transcript')
})

test('the retired owner cannot come back under its markers or its slot entry', () => {
  assert.deepEqual(RETIRED_OWNER_MARKERS, ['data-tidychat-'])
  assert.deepEqual(RETIRED_OWNER_ENTRIES, ['tidychat-nav'])
  const marker = "row.setAttribute('data-tidychat-folded', '1')"
  assert.deepEqual(findViolations([file(SHIPPED, marker)]).map(entry => entry.rule), ['retired-owner-marker'], marker)
  const entry = "ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'tidychat-nav' }, Rail)"
  assert.deepEqual(findViolations([file(SHIPPED, entry)]).map(entry => entry.rule), ['retired-owner-identity'], entry)
  assert.deepEqual(findViolations([file(TEST_FILE, entry)]), [], 'a test may still name the retired identity')
  assert.deepEqual(findViolations([file(SHIPPED, "ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'e-mate-canvas-navigation' }, Button)")]), [],
    'an unrelated header utility keeps its own navigation-free identity')
})
