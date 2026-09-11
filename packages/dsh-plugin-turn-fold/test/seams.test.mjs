/**
 * Negative controls for the fail-closed seam checker.
 *
 * `scripts/seams.mjs` refuses to build when a vendored patch anchor stops resolving
 * exactly once. A guard like that is only trustworthy once it has been shown to
 * *reject*: a rule that quietly accepted everything would look identical on the happy
 * path. These tests therefore drive the pure `evaluateSeams` / `evaluateHostSymbols`
 * layer with deliberately mutated copies of the real pinned bundle and require the
 * checker to report the broken seam.
 *
 * The mutations are derived from the real pinned build at test time; the bundle is
 * never copied into this repository. Each mutation asserts that it actually changed
 * the text before checking the negative expectation, so a mutation that silently did
 * nothing cannot make these controls vacuous.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  HOST_SYMBOLS,
  SEAMS,
  TARGET,
  evaluateHostSymbols,
  evaluateSeams,
  findHarnessRoot,
  loadCompiler,
  locateTarget,
} from '../scripts/seams.mjs'
import { createSelectorEngine } from '../scripts/tsquery-subset.mjs'

/** Read the real pinned bundle once, through the same lookup the build uses. */
let pinned
function loadPinned() {
  if (pinned === undefined) {
    const harnessRoot = findHarnessRoot()
    const ts = loadCompiler(harnessRoot)
    const target = locateTarget(harnessRoot, TARGET)
    pinned = { ts, target, text: readFileSync(target.file, 'utf8') }
  }
  return pinned
}

function seamById(id) {
  const seam = SEAMS.find(candidate => candidate.id === id)
  assert.ok(seam !== undefined, `unknown seam: ${id}`)
  return seam
}

/** The exact source text of the single node a seam selects in the pinned bundle. */
function anchorText({ ts, target, text }, seam) {
  const sourceFile = ts.createSourceFile(target.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const matched = createSelectorEngine(ts).query(sourceFile, seam.selector)
  assert.equal(matched.length, seam.expect, `${seam.id} does not resolve once in the pinned bundle, so this control cannot be built`)
  return matched[0].getText(sourceFile)
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

test('POSITIVE: the unmutated pinned bundle resolves every seam and every host symbol', () => {
  const source = loadPinned()
  const { results, failures } = evaluateSeams(source.ts, source.text, source.target.file)

  assert.deepEqual(results.map(result => result.id), SEAMS.map(seam => seam.id))
  for (const result of results) {
    assert.equal(result.expect, 1, `${result.id} must stay fail-closed on exactly one match`)
    assert.equal(result.ok, true, `${result.id}: ${result.detail}`)
    assert.equal(result.found, 1)
  }
  assert.deepEqual(failures, [])

  const hosts = evaluateHostSymbols(source.ts, source.text, source.target.file, results)
  assert.equal(HOST_SYMBOLS.length, 6, 'the checker must guard six host symbols')
  assert.deepEqual(hosts.symbols.map(symbol => symbol.name), HOST_SYMBOLS.map(symbol => symbol.name))
  for (const symbol of hosts.symbols) {
    assert.equal(symbol.resolved, true, `${symbol.name} is not bound in the ChatView scope chain`)
  }
  assert.deepEqual(hosts.failures, [])
})

test('MISS: renaming the ChatView anchor reports seam 1 as not ok with found 0', () => {
  const source = loadPinned()
  const seam = seamById('inject-turn-fold-runtime')
  const mutated = source.text.split('ChatView').join('ChatViewRenamed')

  // The mutation must be real and targeted: every occurrence was renamed, and no
  // standalone `ChatView` identifier survives to keep the anchor matching.
  assert.notEqual(mutated, source.text, 'the rename must change the source text')
  assert.equal(occurrences(mutated, 'ChatViewRenamed'), occurrences(source.text, 'ChatView'))
  assert.equal((mutated.match(/ChatView(?![A-Za-z0-9_$])/gu) ?? []).length, 0, 'a standalone ChatView identifier survived the rename')

  const { results, failures } = evaluateSeams(source.ts, mutated, source.target.file)
  const result = results.find(candidate => candidate.id === seam.id)
  assert.ok(result !== undefined, `${seam.id} is missing from the report`)
  assert.equal(result.ok, false, 'a missing anchor must fail closed')
  assert.equal(result.found, 0)
  assert.equal(result.expect, 1)
  assert.match(result.detail, /no match/u)
  assert.ok(
    failures.includes(`${seam.id}: selector matched 0, expected 1`),
    `no failure recorded for ${seam.id}: ${JSON.stringify(failures)}`,
  )
  // The rename is targeted: the other two anchors are untouched and still resolve.
  for (const other of results.filter(candidate => candidate.id !== seam.id)) {
    assert.equal(other.ok, true, `${other.id} must be unaffected: ${other.detail}`)
  }
})

test('DOUBLE: duplicating the node-list call reports seam 2 as not ok with found 2', () => {
  const source = loadPinned()
  const seam = seamById('rewrite-node-render-loop')
  const anchor = anchorText(source, seam)
  // A leading `;` keeps the appended call a fresh statement instead of letting it
  // continue the previous expression through automatic semicolon insertion.
  const mutated = `${source.text}\n;\n${anchor};\n`

  assert.equal(occurrences(mutated, anchor), occurrences(source.text, anchor) + 1, 'the append must duplicate the matched call exactly once')

  const { results, failures } = evaluateSeams(source.ts, mutated, source.target.file)
  const result = results.find(candidate => candidate.id === seam.id)
  assert.ok(result !== undefined, `${seam.id} is missing from the report`)
  assert.equal(result.ok, false, 'a duplicated anchor must fail closed')
  assert.equal(result.found, 2)
  assert.equal(result.expect, 1)
  assert.match(result.detail, /^line \d+, \d+$/u, 'the report must name both match sites')
  assert.ok(
    failures.includes(`${seam.id}: selector matched 2, expected 1`),
    `no failure recorded for ${seam.id}: ${JSON.stringify(failures)}`,
  )
  for (const other of results.filter(candidate => candidate.id !== seam.id)) {
    assert.equal(other.ok, true, `${other.id} must be unaffected: ${other.detail}`)
  }
})

test('MISS cascade: an unresolved seam-1 anchor leaves every host symbol unresolved', () => {
  const source = loadPinned()
  const mutated = source.text.split('ChatView').join('ChatViewRenamed')
  assert.notEqual(mutated, source.text, 'the rename must change the source text')

  const { results } = evaluateSeams(source.ts, mutated, source.target.file)
  assert.equal(results[0].ok, false, 'seam 1 must be unresolved for this control to mean anything')
  const hosts = evaluateHostSymbols(source.ts, mutated, source.target.file, results)

  assert.equal(hosts.symbols.length, 6)
  for (const symbol of hosts.symbols) {
    assert.equal(symbol.resolved, false, `${symbol.name} must not be reported as bound without its anchor`)
  }
  assert.equal(hosts.failures.length, 6, `every unbound symbol must be reported: ${JSON.stringify(hosts.failures)}`)
})
