/**
 * Behaviour of the e-Mate patch driver: it applies the vendored Source Patches to
 * the pinned compiled bundle **in memory**, and it refuses instead of applying a
 * partial rewrite when the compiled shape moved.
 *
 * The refusal paths are the point of this file. A driver that quietly skipped a
 * patch whose anchor disappeared would look identical to a working one on the happy
 * path, so every negative control below builds a real, deliberately mutated copy of
 * the pinned bundle in a temporary Harness root and requires the driver to reject
 * it with the reason a maintainer needs.
 *
 * The first refusal is the bundle identity. The driver only rewrites the bundle whose
 * sha256 is the pin the build-time checker also uses, so the shape controls below measure
 * the moved anchor through the pure `evaluateSeams` layer and then require the driver to
 * refuse the same bytes without rewriting them - a bundle the checker never verified must
 * never reach the selector loop.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  TARGET,
  TARGET_BUNDLE_SHA256,
  VERIFIED_BUNDLE_SHA256,
  assertSeams,
  evaluateSeams,
  findHarnessRoot,
  loadCompiler,
  locateTarget,
} from '../scripts/seams.mjs'

const require = createRequire(import.meta.url)
const { transformClientBundle } = require('../lib/transform.cjs')

const pinnedRoot = findHarnessRoot()
const pinned = locateTarget(pinnedRoot, TARGET)
const pinnedText = readFileSync(pinned.file, 'utf8')

const temporaryRoots = []
test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

/**
 * Build a throwaway Harness checkout that carries the pinned compiler and a mutated
 * copy of the pinned bundle, so a refusal can be driven through the real lookup.
 * @param {(text: string) => string} mutate - the mutation applied to the bundle.
 * @returns {{ root: string, file: string, text: string }} the mutated checkout.
 */
function mutatedCheckout(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'emate-turn-fold-'))
  temporaryRoots.push(root)
  cpSync(join(pinnedRoot, 'package.json'), join(root, 'package.json'))
  // The compiler is resolved from the Harness root, so the throwaway root reuses the
  // pinned checkout's installation instead of installing anything.
  symlinkSync(join(pinnedRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  const target = join(root, 'packages', 'client', 'ui-chat')
  mkdirSync(join(target, 'lib'), { recursive: true })
  cpSync(join(pinned.root, 'package.json'), join(target, 'package.json'))
  const text = mutate(pinnedText)
  writeFileSync(join(target, TARGET.file), text)
  return { root, file: join(target, TARGET.file), text }
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * Everything about a bundle a refusal must leave untouched. The digest, the size and the
 * mtime are separate readings on purpose: bytes alone would not catch a rewrite that
 * restored them, and the listing catches a write beside the bundle.
 */
function snapshot(file) {
  const bytes = readFileSync(file)
  const stats = statSync(file)
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    listing: readdirSync(dirname(file)).sort(),
  }
}

/** The digest of a file, computed here rather than read from the pin. */
function digestOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Run a check that must fail closed, and return the error it raised. */
function captureError(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  assert.fail('expected the check to fail closed')
}

/** A throwaway patch module, so a control can decide what the driver is asked to apply. */
function patchModuleWith(source) {
  const root = mkdtempSync(join(tmpdir(), 'emate-turn-fold-patch-'))
  temporaryRoots.push(root)
  const file = join(root, 'patch.cjs')
  writeFileSync(file, source)
  return file
}

/** The pinned compiler, loaded once: every shape control measures through the pure layer. */
const pinnedCompiler = loadCompiler(pinnedRoot)

/** A mutation that moves only the bundle identity: every byte a selector reads is intact. */
const digestOnlyMutation = text => text + '\n// e-Mate digest control: not a byte of the verified bundle\n'

test('applies all three vendored patches in memory against the pinned build', () => {
  const result = transformClientBundle()
  assert.equal(result.target.name, TARGET.package)
  assert.equal(result.target.version, '0.1.5-rc.1')
  assert.deepEqual(result.patches.map(patch => patch.id), [
    'inject-turn-fold-runtime',
    'rewrite-node-render-loop',
    'install-turn-fold-services',
  ])
  for (const patch of result.patches) {
    assert.equal(patch.found, 1, patch.id + ' must match exactly one anchor')
    assert.ok(patch.line > 0, patch.id + ' must report the line it rewrote')
  }
  // The injected runtime arrives, and both rewrites are present in the output.
  assert.ok(result.text.includes('__ch4acko3DshTurnFoldInstall(ctx);'))
  assert.ok(result.text.includes('__ch4acko3DshTurnFoldRender({ order, nodeStore, timeline, sessionId,'))
  assert.notEqual(result.text, result.sourceText)
  // The happy path is the verified path: the applied source is the pinned bundle, and the
  // driver reports the identity it verified instead of re-deriving one.
  assert.equal(result.bundleVerified, true)
  assert.equal(result.sourceSha256, TARGET_BUNDLE_SHA256, 'only the verified bundle is rewritten')
  assert.equal(result.sourceSha256, digestOf(pinned.file))
  assert.deepEqual(result.pinnedSha256, VERIFIED_BUNDLE_SHA256)
  assert.notEqual(result.sha256, result.sourceSha256, 'the applied bundle must differ from its source')
  // Nothing is written: the shipped bundle on disk still has its pinned digest.
  assert.equal(readFileSync(pinned.file, 'utf8'), pinnedText, 'the transform must not touch the pinned bundle')
})

test('REFUSES a bundle that is not the verified target, before it loads the patch module', () => {
  const checkout = mutatedCheckout(digestOnlyMutation)
  // The control is only meaningful if the shape really is intact: every seam must still
  // resolve exactly once, so the digest is the only thing left to refuse.
  const seams = evaluateSeams(pinnedCompiler, checkout.text, checkout.file)
  assert.deepEqual(seams.failures, [], 'the mutation must not move the compiled shape')
  assert.equal(seams.results.every(result => result.ok), true)

  // If the driver loaded the patch module before verifying the digest, this module would
  // throw its own error and the digest refusal would never be reached.
  const patchModule = patchModuleWith("'use strict'\nthrow new Error('the patch module must not load before the digest gate')\n")
  const refusal = captureError(() => transformClientBundle({ harnessRoot: checkout.root, patchModule }))
  const actual = digestOf(checkout.file)
  assert.notEqual(actual, TARGET_BUNDLE_SHA256, 'the control bundle must really differ from the pin')
  assert.match(refusal.message, /turn-fold transform refused: verify-bundle-hash refused @deepseek-ai\/dsh-client-ui-chat/u)
  assert.ok(refusal.message.includes(actual), `the refusal must name the resolved digest: ${refusal.message}`)
  assert.ok(refusal.message.includes(TARGET_BUNDLE_SHA256), `the refusal must name the pin: ${refusal.message}`)
  assert.doesNotMatch(refusal.message, /must not load before the digest gate/u, 'the digest gate must run before the patch module loads')
  assert.doesNotMatch(refusal.message, /matched \d+, expected 1/u, 'no selector may be evaluated behind a refused digest')

  const report = refusal.report
  assert.equal(report.bundleVerified, false)
  assert.equal(report.evaluated, false)
  assert.deepEqual(report.applied, [], 'a refused bundle has nothing applied')
  assert.equal(report.fileSha256, actual)
  assert.deepEqual(report.pinnedSha256, VERIFIED_BUNDLE_SHA256)
  assert.equal(report.hash.ok, false)
  assert.equal(report.hash.found, 0)
  assert.equal(report.hash.expect, 1)
  assert.deepEqual(report.failures, [`verify-bundle-hash: ${report.hash.detail}`])
})

test('leaves the pinned bundle byte-identical when it refuses', () => {
  const checkout = mutatedCheckout(digestOnlyMutation)
  const before = snapshot(checkout.file)
  assert.throws(() => transformClientBundle({ harnessRoot: checkout.root }), /verify-bundle-hash/u)
  const after = snapshot(checkout.file)
  assert.deepEqual(after.bytes, before.bytes, 'the refused bundle must keep its bytes')
  assert.equal(after.sha256, before.sha256, 'the refused bundle must keep its digest')
  assert.equal(after.sha256, digestOf(checkout.file))
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs, 'the refused bundle must not even be touched')
  assert.deepEqual(after.listing, before.listing, 'nothing may be written beside the bundle')
})

test('REFUSES a bundle whose compiled shape moved instead of applying the other two patches', () => {
  const checkout = mutatedCheckout(text => text.split('ChatView').join('ChatViewRenamed'))
  // The mutation must be real: the rename is total, so no standalone `ChatView`
  // identifier survives to keep the anchor matching by accident.
  assert.equal((checkout.text.match(/ChatView(?![A-Za-z0-9_$])/gu) ?? []).length, 0)
  assert.ok(checkout.text.includes('ChatViewRenamed'))
  // The shape claim is measured at the pure layer, where a mutated copy can be evaluated...
  const anchor = evaluateSeams(pinnedCompiler, checkout.text, checkout.file).results.find(result => result.id === 'inject-turn-fold-runtime')
  assert.equal(anchor.ok, false, 'a moved anchor must be reported as unresolved')
  assert.equal(anchor.found, 0)
  // ...and the driver refuses those bytes without rewriting them. The reason it reports is the
  // identity gate, which is the point: a bundle the checker never verified cannot reach the
  // selector loop at all.
  assert.throws(() => transformClientBundle({ harnessRoot: checkout.root }), /verify-bundle-hash/u)
  assert.equal(readFileSync(checkout.file, 'utf8'), checkout.text)
  assert.equal(occurrences(checkout.text, '__ch4acko3DshTurnFoldInstall'), 0, 'no partial rewrite may reach a refused bundle')
})

test('REFUSES a duplicated node-list anchor', () => {
  const call = pinnedText.match(/\(0, react_jsx_runtime\.jsx\)\(ChatNodeList, \{[\s\S]*?\}\),/u)
  assert.ok(call !== null, 'the pinned bundle must still contain the ChatNodeList call')
  const checkout = mutatedCheckout(text => text + ';\n' + call[0] + '\n')
  assert.equal(occurrences(checkout.text, call[0]), occurrences(pinnedText, call[0]) + 1)
  const doubled = evaluateSeams(pinnedCompiler, checkout.text, checkout.file).results.find(result => result.id === 'rewrite-node-render-loop')
  assert.equal(doubled.ok, false, 'a duplicated anchor must be reported as not ok')
  assert.equal(doubled.found, 2)
  assert.throws(() => transformClientBundle({ harnessRoot: checkout.root }), /verify-bundle-hash/u)
  assert.equal(readFileSync(checkout.file, 'utf8'), checkout.text)
})

test('REFUSES a patch whose anchor matches zero or more than one node, on the verified bundle', () => {
  // The selector loop must still fail closed on the bundle that IS verified: these are the
  // controls for a vendored patch module whose anchors moved while the bundle did not.
  const missing = patchModuleWith([
    "'use strict'",
    'module.exports = {',
    '  createPatches: () => [{',
    "    id: 'moved-anchor',",
    "    select: 'FunctionDeclaration[name.name=\"ChatViewRenamed\"]',",
    '    expect: 1,',
    "    target: { package: '@deepseek-ai/dsh-client-ui-chat', file: 'lib/client.js' },",
    '    apply() {},',
    '  }],',
    '}',
    '',
  ].join('\n'))
  assert.throws(
    () => transformClientBundle({ patchModule: missing }),
    /turn-fold transform refused: moved-anchor matched 0, expected 1 \(the compiled shape of @deepseek-ai\/dsh-client-ui-chat changed\)/u,
  )

  const ambiguous = patchModuleWith([
    "'use strict'",
    'module.exports = {',
    '  createPatches: () => [{',
    "    id: 'ambiguous-anchor',",
    "    select: 'VariableStatement',",
    '    expect: 1,',
    "    target: { package: '@deepseek-ai/dsh-client-ui-chat', file: 'lib/client.js' },",
    '    apply() {},',
    '  }],',
    '}',
    '',
  ].join('\n'))
  const refusal = captureError(() => transformClientBundle({ patchModule: ambiguous }))
  const matched = /turn-fold transform refused: ambiguous-anchor matched (\d+), expected 1/u.exec(refusal.message)
  assert.ok(matched !== null, `the refusal must report the match count: ${refusal.message}`)
  assert.ok(Number(matched[1]) > 1, `this control needs an anchor that matches more than once, matched ${matched[1]}`)
  assert.equal(readFileSync(pinned.file, 'utf8'), pinnedText, 'a refused patch must not touch the pinned bundle')
})

test('REFUSES a patch descriptor that is not fail-closed on a single match', () => {
  const root = mkdtempSync(join(tmpdir(), 'emate-turn-fold-patch-'))
  temporaryRoots.push(root)
  const patchModule = join(root, 'patch.cjs')
  writeFileSync(patchModule, [
    "'use strict'",
    'module.exports = {',
    '  createPatches: () => [{',
    "    id: 'not-fail-closed',",
    "    select: 'FunctionDeclaration[name.name=\"ChatView\"]',",
    '    expect: 2,',
    '    target: { package: ' + JSON.stringify(TARGET.package) + ', file: ' + JSON.stringify(TARGET.file) + ' },',
    '    apply() {},',
    '  }],',
    '}',
    '',
  ].join('\n'))
  assert.throws(
    () => transformClientBundle({ patchModule }),
    /not-fail-closed declares expect 2, not the fail-closed 1/u,
  )
})

test('REFUSES a patch descriptor aimed at a different target', () => {
  const root = mkdtempSync(join(tmpdir(), 'emate-turn-fold-target-'))
  temporaryRoots.push(root)
  const patchModule = join(root, 'patch.cjs')
  writeFileSync(patchModule, [
    "'use strict'",
    'module.exports = {',
    '  createPatches: () => [{',
    "    id: 'wrong-target',",
    "    select: 'FunctionDeclaration[name.name=\"ChatView\"]',",
    '    expect: 1,',
    "    target: { package: '@deepseek-ai/dsh-client-ui-conversation', file: 'lib/client.js' },",
    '    apply() {},',
    '  }],',
    '}',
    '',
  ].join('\n'))
  assert.throws(
    () => transformClientBundle({ patchModule }),
    /wrong-target targets @deepseek-ai\/dsh-client-ui-conversation\/lib\/client\.js, not @deepseek-ai\/dsh-client-ui-chat\/lib\/client\.js/u,
  )
})

test('resolves the active DSH version from the target, not from an ambient installation', () => {
  // The vendored patch module used to probe for an installed @deepseek-ai/dsh at
  // import time and throw when it was absent. It now reads the version the driver
  // resolved from the patch target's own manifest.
  const restore = process.env.DSH_TURN_FOLD_ACTIVE_VERSION
  delete process.env.DSH_TURN_FOLD_ACTIVE_VERSION
  try {
    const patchModule = require('../lib/patch.cjs')
    assert.equal(typeof patchModule.createPatches, 'function')
    assert.equal(patchModule.length, 3)
    assert.equal(patchModule[0].target.package, TARGET.package)
  } finally {
    if (restore !== undefined) process.env.DSH_TURN_FOLD_ACTIVE_VERSION = restore
  }
})

test('the checker and the driver refuse the same bundle through one shared pin', () => {
  const checkout = mutatedCheckout(digestOnlyMutation)
  const previous = process.env.EMATE_HARNESS_ROOT
  process.env.EMATE_HARNESS_ROOT = checkout.root
  let checkerRefusal
  try {
    assertSeams()
  } catch (error) {
    checkerRefusal = error
  } finally {
    if (previous === undefined) delete process.env.EMATE_HARNESS_ROOT
    else process.env.EMATE_HARNESS_ROOT = previous
  }
  assert.ok(checkerRefusal !== undefined, 'the build-time checker must refuse a bundle it did not verify')
  assert.equal(checkerRefusal.report.bundleVerified, false)
  assert.equal(checkerRefusal.report.evaluated, false)
  // Both gates judge against every digest the seams were verified for, one per platform,
  // so the assertion is the whole set rather than the single macOS digest it grew from.
  assert.deepEqual(checkerRefusal.report.pinnedSha256, VERIFIED_BUNDLE_SHA256)
  assert.equal(checkerRefusal.report.fileSha256, digestOf(checkout.file))

  const driverRefusal = captureError(() => transformClientBundle({ harnessRoot: checkout.root }))
  assert.deepEqual(driverRefusal.report.pinnedSha256, VERIFIED_BUNDLE_SHA256)
  assert.equal(driverRefusal.report.fileSha256, checkerRefusal.report.fileSha256, 'both gates must judge the same bytes')
})
