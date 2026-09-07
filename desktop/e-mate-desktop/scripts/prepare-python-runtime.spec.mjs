import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { download, officeInstallArguments } from './prepare-python-runtime.mjs'

test('all supported targets have a complete hashed wheel lock matching their manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('./office-python/manifest.json', import.meta.url), 'utf8'))
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const content = await readFile(new URL(`./office-python/${target}.txt`, import.meta.url), 'utf8')
    const entries = content.split(/\r?\n/u).filter(line => line && !line.startsWith('#'))
    assert.equal(entries.length, manifest.targets[target].length)
    for (const entry of manifest.targets[target]) {
      assert.ok(entries.includes(`${entry.url} --hash=sha256:${entry.sha256}`))
      assert.equal(new URL(entry.url).hostname, 'files.pythonhosted.org')
      assert.match(entry.sha256, /^[a-f0-9]{64}$/u)
    }
    const args = officeInstallArguments(target, '/staging')
    for (const flag of ['--no-deps', '--no-index', '--only-binary=:all:', '--require-hashes']) assert.ok(args.includes(flag))
    assert.ok(args.at(-1).endsWith(`${target}.txt`))
  }
  assert.throws(() => officeInstallArguments('unsupported', '/staging'), /Unsupported/u)
})

test('retries a transient Python runtime connection failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e-mate-python-runtime-'))
  const destination = join(directory, 'runtime.tar.gz')
  let attempts = 0
  try {
    await download('https://github.com/fixed-runtime', destination, async () => {
      attempts += 1
      if (attempts === 1) {
        const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
        throw new TypeError('fetch failed', { cause })
      }
      return new Response('fixed runtime bytes')
    })
    assert.equal(attempts, 2)
    assert.equal(await readFile(destination, 'utf8'), 'fixed runtime bytes')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bounds transient retries and does not retry HTTP failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e-mate-python-runtime-'))
  let transientAttempts = 0
  let httpAttempts = 0
  try {
    await assert.rejects(download('https://github.com/fixed-runtime', join(directory, 'timeout.tar.gz'), async () => {
      transientAttempts += 1
      const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
      throw new TypeError('fetch failed', { cause })
    }), /fetch failed/u)
    assert.equal(transientAttempts, 3)

    await assert.rejects(download('https://github.com/fixed-runtime', join(directory, 'http.tar.gz'), async () => {
      httpAttempts += 1
      return new Response(null, { status: 503 })
    }), /HTTP 503/u)
    assert.equal(httpAttempts, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
