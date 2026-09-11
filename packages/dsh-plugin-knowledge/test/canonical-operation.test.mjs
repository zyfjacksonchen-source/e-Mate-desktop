import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A Host operation spans many live UI reads, and each read arrives with a fresh execution
// wrapper. The reads must share one canonical Xin operation keyed by the operation root,
// otherwise every read captures its own and the live view loses its subject binding.
const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

test('live reads share one canonical Xin operation per root call', () => {
  assert.match(source, /const xinOperations = new WeakMap</u, 'the canonical operation cache disappeared')
  const capture = /const captureXin = \(exec[^)]*\) => \{[\s\S]*?\n  \}/u.exec(source)
  assert.notEqual(capture, null, 'captureXin disappeared')
  assert.match(capture[0], /exec\?\.rootCallId \? exec : exec\?\.agent/u,
    'the operation is no longer keyed by the root call with the agent as fallback')
  assert.match(capture[0], /xinOperations\.get\(key\)/u, 'the cache is no longer consulted')
  const uses = source.match(/captureXin\(/gu) ?? []
  assert.ok(uses.length >= 3, 'fewer read paths go through the canonical capture than before')
})
