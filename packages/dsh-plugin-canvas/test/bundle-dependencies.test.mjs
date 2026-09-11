import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The native Desktop boot resolves the client bundle without the package manager, so a
// dependency that stays external is a runtime failure there. fflate is reachable through
// the Excalidraw archive path and must therefore be emitted inside the bundle.
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

test('the canvas client bundle emits fflate instead of importing it', () => {
  const config = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(
    config,
    /alwaysBundle:\s*\[\s*'fflate'\s*\]/u,
    'tsdown.config.ts no longer forces fflate into the client bundle',
  )
  assert.doesNotMatch(
    bundle,
    /(?:from\s*|require\(\s*)["']fflate["']/u,
    'lib/client.js imports fflate at runtime; the Desktop boot cannot resolve it',
  )
  assert.ok(packageRoot.length > 0)
})
