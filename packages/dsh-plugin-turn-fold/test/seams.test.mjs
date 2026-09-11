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
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'

import {
  BUNDLE_HASH_CHECK_ID,
  HOST_SYMBOLS,
  SEAMS,
  TARGET,
  TARGET_BUNDLE_SHA256,
  assertSeams,
  evaluateBundleHash,
  evaluateHostSymbols,
  evaluateSeams,
  findHarnessRoot,
  formatReport,
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

/** A digest that is not the pinned one; deliberately not a real sha256 of anything. */
const WRONG_SHA256 = 'f'.repeat(64)

/** The digest of the real pinned bundle, computed here instead of read from the pin. */
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

/** Everything about the bundle the checker must leave untouched. */
function snapshot(file, directory) {
  const bytes = readFileSync(file)
  const stats = statSync(file)
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    listing: readdirSync(directory).sort(),
  }
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

test('PIN: the exported pin is the digest of the pinned bundle, and the runner verifies it', () => {
  const source = loadPinned()
  assert.match(TARGET_BUNDLE_SHA256, /^[0-9a-f]{64}$/u, 'the pin must be a lowercase sha256 digest')
  assert.equal(digestOf(source.target.file), TARGET_BUNDLE_SHA256, 'the pin must name the very bundle this checker reads')

  const report = assertSeams()
  assert.equal(report.pinnedSha256, TARGET_BUNDLE_SHA256)
  assert.equal(report.fileSha256, TARGET_BUNDLE_SHA256)
  assert.equal(report.fileBytes, statSync(source.target.file).size)
  assert.equal(report.hash.id, BUNDLE_HASH_CHECK_ID)
  assert.deepEqual(Object.keys(report.hash).sort(), ['detail', 'expect', 'found', 'id', 'ok'], 'the hash gate must report in the same shape the selector checks use')
  assert.equal(report.hash.ok, true, report.hash.detail)
  assert.equal(report.hash.found, 1)
  assert.equal(report.hash.expect, 1)
  assert.equal(report.bundleVerified, true)
  assert.equal(report.evaluated, true, 'a verified bundle is evaluated')
  assert.equal(report.seams.length, SEAMS.length)
  assert.equal(report.symbols.length, HOST_SYMBOLS.length)

  const text = formatReport(report)
  assert.ok(text.includes(`sha256: ${TARGET_BUNDLE_SHA256}`), `the report must name the resolved digest: ${text}`)
  assert.ok(text.includes(`pinned: ${TARGET_BUNDLE_SHA256}`), `the report must name the pin: ${text}`)
  assert.match(text, /OK\s+verify-bundle-hash\s+1\/1/u)
})

test('RED: a wrong pin refuses the bundle before any selector is evaluated, naming both hashes', () => {
  const source = loadPinned()
  const actual = digestOf(source.target.file)
  assert.notEqual(actual, WRONG_SHA256, 'the wrong pin must really be wrong')

  const error = captureError(() => assertSeams({ pinnedSha256: WRONG_SHA256 }))
  assert.match(error.message, /^turn-fold seams failed against @deepseek-ai\/dsh-client-ui-chat@0\.1\.5-rc\.1:/u)
  assert.ok(error.message.includes(WRONG_SHA256), `the failure must name the pin: ${error.message}`)
  assert.ok(error.message.includes(actual), `the failure must name the resolved digest: ${error.message}`)
  assert.match(error.message, /verify-bundle-hash: resolved sha256 [0-9a-f]{64} is not the verified target \(pinned [0-9a-f]{64}\)/u)
  assert.match(error.message, /no patch is authorized for this bundle/u)

  const report = error.report
  assert.equal(report.bundleVerified, false)
  assert.equal(report.evaluated, false, 'a refused bundle must not be evaluated')
  assert.deepEqual(report.seams, [], 'no selector result may exist behind a refused pin')
  assert.deepEqual(report.symbols, [], 'no host symbol may be read behind a refused pin')
  assert.equal(report.hash.ok, false)
  assert.equal(report.hash.found, 0)
  assert.equal(report.hash.expect, 1)
  assert.ok(report.hash.detail.includes(WRONG_SHA256) && report.hash.detail.includes(actual), report.hash.detail)
  assert.equal(report.fileSha256, actual, 'the report must carry the digest it actually resolved')

  const text = formatReport(report)
  assert.ok(text.includes(WRONG_SHA256) && text.includes(actual), `the printed refusal must name both hashes: ${text}`)
  assert.match(text, /FAIL verify-bundle-hash +0\/1/u)
  assert.match(text, /REFUSED: no patch is applied/u)
  assert.doesNotMatch(text, /host symbols in ChatView scope/u, 'a refused bundle has no seam results to print')
})

test('CONTROL: evaluateBundleHash is pure, and its mismatch is reported like a failed selector', () => {
  const match = evaluateBundleHash(TARGET_BUNDLE_SHA256)
  assert.deepEqual(Object.keys(match.result).sort(), ['detail', 'expect', 'found', 'id', 'ok'])
  assert.equal(match.result.id, BUNDLE_HASH_CHECK_ID)
  assert.equal(match.result.ok, true)
  assert.equal(match.result.found, 1)
  assert.equal(match.result.expect, 1)
  assert.match(match.result.detail, /is the verified target/u)
  assert.deepEqual(match.failures, [])

  const mismatch = evaluateBundleHash(WRONG_SHA256)
  assert.equal(mismatch.result.ok, false)
  assert.equal(mismatch.result.found, 0)
  assert.equal(mismatch.result.expect, 1)
  assert.deepEqual(mismatch.failures, [`${BUNDLE_HASH_CHECK_ID}: ${mismatch.result.detail}`])
  assert.ok(mismatch.result.detail.includes(TARGET_BUNDLE_SHA256), 'the mismatch must name the pin')
  assert.ok(mismatch.result.detail.includes(WRONG_SHA256), 'the mismatch must name the resolved digest')

  // An omitted pin means the shipped one, so the default cannot drift away from the constant.
  assert.deepEqual(evaluateBundleHash(TARGET_BUNDLE_SHA256).result, evaluateBundleHash(TARGET_BUNDLE_SHA256, TARGET_BUNDLE_SHA256).result)
})

test('NEVER WRITES: the checker leaves the pinned bundle byte-identical on the pass and the refused path', () => {
  const source = loadPinned()
  const directory = dirname(source.target.file)
  const before = snapshot(source.target.file, directory)

  assertSeams()
  const error = captureError(() => assertSeams({ pinnedSha256: WRONG_SHA256 }))
  assert.equal(error.report.evaluated, false)

  const after = snapshot(source.target.file, directory)
  assert.deepEqual(after.bytes, before.bytes, 'the checker must not rewrite the bundle')
  assert.equal(after.sha256, before.sha256)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs, 'the bundle must not even be touched')
  assert.deepEqual(after.listing, before.listing, 'the checker must not write beside the bundle')
})
