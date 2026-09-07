import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { download, officeInstallArguments } from './prepare-python-runtime.mjs'

test('Word dependencies use hashed binary wheels and the target Python site-packages', async () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const args = officeInstallArguments(target, '/staging')
    for (const flag of ['--isolated', '--no-deps', '--no-compile', '--only-binary=:all:', '--require-hashes']) {
      assert.ok(args.includes(flag))
    }
    assert.equal(args[args.indexOf('--platform') + 1], target.startsWith('win32') ? 'win_amd64' : 'macosx_10_13_universal2')
    assert.equal(args[args.indexOf('--target') + 1], join('/staging', 'python', ...(target.startsWith('win32') ? ['Lib', 'site-packages'] : ['lib', 'python3.12', 'site-packages'])))
    const requirements = await readFile(args.at(-1), 'utf8')
    const packages = requirements.split('\n').filter(line => line && !line.startsWith('#'))
    assert.equal(packages.length, 3)
    for (const line of packages) assert.match(line, / @ https:\/\/files\.pythonhosted\.org\/\S+\.whl --hash=sha256:[0-9a-f]{64}$/u)
  }
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
