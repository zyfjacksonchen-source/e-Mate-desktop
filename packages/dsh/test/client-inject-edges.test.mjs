import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A component that injects a client edge the pinned Harness does not ship fails at load.
// The rule is package existence, not a name prefix: the Harness ships client-facing
// packages outside the @deepseek-ai/dsh-client-* family too (for example
// @deepseek-ai/dsh-api-remotes, which upstream's own client-ui-agent-team injects), while
// the retired @deepseek-ai/dsh-client-runtime exists in no 0.1.5 package at all.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const harnessPackages = join(repoRoot, 'upstream', 'deepseek-harness', 'packages')
const packagesRoot = join(repoRoot, 'packages')

function shippedNames(directory) {
  const names = new Set()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(directory, entry.name)
    const manifest = join(full, 'package.json')
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof parsed.name === 'string') names.add(parsed.name)
    }
    if (entry.name === 'node_modules') continue
    for (const nested of readdirSync(full, { withFileTypes: true })) {
      if (!nested.isDirectory()) continue
      const nestedManifest = join(full, nested.name, 'package.json')
      if (existsSync(nestedManifest)) {
        const parsed = JSON.parse(readFileSync(nestedManifest, 'utf8'))
        if (typeof parsed.name === 'string') names.add(parsed.name)
      }
    }
  }
  return names
}

test('every declared client edge names a package the pinned Harness ships', () => {
  const shipped = shippedNames(harnessPackages)
  assert.ok(shipped.size > 50, 'the pinned Harness package inventory looks empty')
  const missing = []
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(packagesRoot, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    const inject = parsed.dsh?.client?.inject
    if (!Array.isArray(inject)) continue
    for (const edge of inject) {
      if (typeof edge === 'string' && !shipped.has(edge)) {
        missing.push((parsed.name ?? entry.name) + ': ' + edge)
      }
    }
  }
  assert.deepEqual(missing, [])
})

// A client contribution whose `inject` names a service the pinned Harness does not provide
// never activates: Cordis leaves the fiber PENDING and the desktop reports the plugin as one
// that could not load. Package existence is not enough to catch that, because a service is a
// name inside a package, not a package. 0.1.5 renamed the rc.6 conversation-node registry to
// `uiConversation.events` (packages/client/ui-conversation), so the retired spelling is the
// first entry of a list that must stay empty across every shipped client contribution.
const RETIRED_CLIENT_SERVICES = ['conversationEvents']

function clientSources(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) clientSources(full, found)
    else if (/\.tsx?$/u.test(entry.name)) found.push(full)
  }
  return found
}

test('no shipped client contribution injects a retired client service name', () => {
  const roots = [packagesRoot, join(repoRoot, 'upstream', 'plugins')].filter(existsSync)
  assert.ok(roots.length > 0, 'the client contribution inventory looks empty')
  const offenders = []
  for (const root of roots) {
    for (const path of clientSources(root)) {
      const source = readFileSync(path, 'utf8')
      for (const retired of RETIRED_CLIENT_SERVICES) {
        if (source.includes("'" + retired + "'") || source.includes('"' + retired + '"')) {
          offenders.push(relative(repoRoot, path) + ': ' + retired)
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})
