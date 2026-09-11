import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The enterprise plane owns authentication, model provisioning, the model gateway and
// audit. It must not gate a local run: the fixed enterprise service roots belong to the
// enterprise provider alone, are used to contain requests (origin comparison) rather than
// to reach the network at load time, and no enterprise artifact ships inside the app.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const profileRoot = join(repoRoot, 'packages', 'dsh', 'src', 'profile')
const enterpriseRoots = /https:\/\/[a-z0-9.-]*(?:ecoremedia\.net|workers\.dev)/u

function sourceFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.tsx?$/u.test(entry.name)) found.push(full)
  }
  return found
}

test('only the enterprise provider names a fixed enterprise service root', () => {
  const offenders = sourceFiles(profileRoot).filter((file) => {
    return enterpriseRoots.test(readFileSync(file, 'utf8'))
      && !file.endsWith(join('identity', 'enterprise-provider.ts'))
  })
  assert.deepEqual(offenders.map(file => file.slice(repoRoot.length)), [])
})

test('the enterprise provider contains requests instead of reaching out at load time', () => {
  const provider = readFileSync(join(profileRoot, 'identity', 'enterprise-provider.ts'), 'utf8')
  const reaching = provider.split('\n').filter((line) => {
    return enterpriseRoots.test(line) && /fetch\(|request\(|http\.get|https\.get/u.test(line)
  })
  assert.deepEqual(reaching, [])
})

test('the desktop build ships no enterprise artifact', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'desktop', 'e-mate-desktop', 'package.json'), 'utf8'))
  const files = manifest.build?.files ?? []
  assert.ok(Array.isArray(files) && files.length > 0, 'the desktop build files list disappeared')
  assert.deepEqual(files.filter(entry => String(entry).startsWith('enterprise')), [])
})
