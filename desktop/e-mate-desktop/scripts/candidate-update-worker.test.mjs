import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import worker from './candidate-update-worker.mjs'

const TOKEN = 'reusable-short-lived-token'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const ROOT = 'desktop/candidates/' + COMMIT + '/'
const MAC = new TextEncoder().encode('mac-installer-bytes')
const WINDOWS = new TextEncoder().encode('windows-installer-bytes')
const subtle = globalThis.crypto.subtle
const nativeTimingSafeEqual = typeof subtle.timingSafeEqual === 'function'
  ? subtle.timingSafeEqual.bind(subtle)
  : null
let timingSafeEqualCalls = 0
Object.defineProperty(subtle, 'timingSafeEqual', {
  configurable: true,
  value(left, right) {
    timingSafeEqualCalls += 1
    if (nativeTimingSafeEqual !== null) return nativeTimingSafeEqual(left, right)
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
    if (a.byteLength !== b.byteLength) return false
    let difference = 0
    for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index]
    return difference === 0
  },
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    source_commit: COMMIT,
    version: '2.0.17',
    artifacts: {
      darwin: { key: ROOT + 'darwin/e-Mate-2.0.17-mac-universal.dmg', bytes: MAC.byteLength, sha256: sha256(MAC) },
      win32: { key: ROOT + 'win32/e-Mate-2.0.17-win-x64-Setup.exe', bytes: WINDOWS.byteLength, sha256: sha256(WINDOWS) },
    },
    ...overrides,
  }
}

function r2Object(key, bytes, customMetadata = {}, size = bytes.byteLength, onArrayBuffer) {
  const copy = bytes.slice()
  return {
    key,
    size,
    customMetadata,
    body: new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close() } }),
    arrayBuffer: async () => {
      onArrayBuffer?.()
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    },
  }
}

function fixture(options = {}) {
  const value = options.manifest ?? manifest()
  const manifestBytes = new TextEncoder().encode(options.rawManifest ?? JSON.stringify(value))
  let manifestArrayBufferCalls = 0
  const objects = new Map([
    [ROOT + 'manifest.json', () => r2Object(
      options.manifestObjectKey ?? ROOT + 'manifest.json',
      manifestBytes,
      {},
      options.manifestSize ?? manifestBytes.byteLength,
      () => { manifestArrayBufferCalls += 1 },
    )],
    [value.artifacts?.darwin?.key, () => r2Object(
      value.artifacts.darwin.key,
      options.macBytes ?? MAC,
      options.macMetadata ?? {
        sha256: value.artifacts.darwin.sha256,
        sourceCommit: value.source_commit,
        version: value.version,
      },
    )],
    [value.artifacts?.win32?.key, () => r2Object(
      value.artifacts.win32.key,
      WINDOWS,
      {
        sha256: value.artifacts.win32.sha256,
        sourceCommit: value.source_commit,
        version: value.version,
      },
    )],
  ])
  const gets = []
  return {
    gets,
    get manifestArrayBufferCalls() { return manifestArrayBufferCalls },
    env: {
      MANIFEST_KEY: options.manifestKey ?? ROOT + 'manifest.json',
      TOKEN_SHA256: sha256(TOKEN),
      EXPIRES_AT: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
      CANDIDATES: {
        async get(key) {
          gets.push(key)
          return objects.get(key)?.() ?? null
        },
      },
    },
  }
}

function request(path, init = {}) {
  return new Request('https://candidate.invalid' + path, {
    headers: { Authorization: 'Bearer ' + TOKEN },
    ...init,
  })
}

test('requires the reusable Bearer token through timingSafeEqual before reading the private bucket', async () => {
  const { env, gets } = fixture()
  const callsBefore = timingSafeEqualCalls
  for (const authorization of [undefined, 'Bearer wrong', 'Basic ' + TOKEN]) {
    const headers = authorization === undefined ? {} : { Authorization: authorization }
    const response = await worker.fetch(new Request('https://candidate.invalid/desktop/version.json', { headers }), env)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.deepEqual(gets, [])

  const first = await worker.fetch(request('/desktop/version.json'), env)
  const second = await worker.fetch(request('/desktop/version.json'), env)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(timingSafeEqualCalls - callsBefore, 3)
})

test('rejects expiry, wrong methods, and every route outside the three exact GET paths', async () => {
  const expired = fixture({ expiresAt: String(Date.now() - 1) })
  assert.equal((await worker.fetch(request('/desktop/version.json'), expired.env)).status, 401)
  assert.deepEqual(expired.gets, [])

  const { env, gets } = fixture()
  const post = await worker.fetch(request('/desktop/version.json', { method: 'POST' }), env)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET')
  for (const path of [
    '/desktop/version.json/',
    '/desktop/version.json?token=' + TOKEN,
    '/desktop/downloads/mac/',
    '/desktop/downloads/windows?download=1',
    '/desktop/downloads/linux',
    '/anything',
  ]) {
    assert.equal((await worker.fetch(request(path), env)).status, 404)
  }
  assert.deepEqual(gets, [])
})

test('returns only the production-shaped version as direct no-store JSON', async () => {
  const expected = manifest()
  const { env, gets } = fixture({ manifest: expected })
  const response = await worker.fetch(request('/desktop/version.json'), env)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/u)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-e-mate-candidate-source'), COMMIT)
  assert.equal(response.headers.has('location'), false)
  assert.deepEqual(await response.json(), { version: expected.version })
  assert.deepEqual(gets, [ROOT + 'manifest.json'])
})

test('streams only the selected exact R2 object after identity validation', async () => {
  const { env, gets } = fixture()
  const response = await worker.fetch(request('/desktop/downloads/mac'), env)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-length'), String(MAC.byteLength))
  assert.equal(response.headers.get('x-e-mate-candidate-source'), COMMIT)
  assert.equal(response.headers.has('location'), false)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MAC)
  assert.deepEqual(gets, [ROOT + 'manifest.json', ROOT + 'darwin/e-Mate-2.0.17-mac-universal.dmg'])
})

test('fails closed for malformed manifests and immutable-path or R2 identity mismatches', async () => {
  const malformed = fixture({ rawManifest: '{' })
  assert.equal((await worker.fetch(request('/desktop/version.json'), malformed.env)).status, 502)

  const oversized = fixture({ manifestSize: 16 * 1024 + 1 })
  assert.equal((await worker.fetch(request('/desktop/version.json'), oversized.env)).status, 502)
  assert.equal(oversized.manifestArrayBufferCalls, 0)

  const mutable = manifest()
  mutable.artifacts.darwin.key = ROOT + 'darwin/arbitrary.dmg'
  assert.equal((await worker.fetch(request('/desktop/version.json'), fixture({ manifest: mutable }).env)).status, 502)

  const wrongManifestObject = fixture({ manifestObjectKey: ROOT + 'other.json' })
  assert.equal((await worker.fetch(request('/desktop/version.json'), wrongManifestObject.env)).status, 502)

  const wrongSize = fixture({ macBytes: new TextEncoder().encode('wrong-size') })
  assert.equal((await worker.fetch(request('/desktop/downloads/mac'), wrongSize.env)).status, 502)

  for (const macMetadata of [
    { sha256: 'f'.repeat(64), sourceCommit: COMMIT, version: '2.0.17' },
    { sha256: sha256(MAC), sourceCommit: 'f'.repeat(40), version: '2.0.17' },
    { sha256: sha256(MAC), sourceCommit: COMMIT, version: '2.0.18' },
  ]) {
    const wrongMetadata = fixture({ macMetadata })
    assert.equal((await worker.fetch(request('/desktop/downloads/mac'), wrongMetadata.env)).status, 502)
  }
})

test('new source-bound manifest uses existing native routes and rejects a schema downgrade', async () => {
  const value = manifest({ schema_version: 2, version: '2.0.18', source_companion: { key: ROOT + 'sources/e-Mate-2.0.18-calc-sources.tar', bytes: 30, sha256: 'a'.repeat(64) } })
  for (const row of Object.values(value.artifacts)) row.key = row.key.replace('2.0.17', '2.0.18')
  const current = fixture({ manifest: value })
  assert.equal((await worker.fetch(request('/desktop/downloads/mac'), current.env)).status, 200)
  assert.equal((await worker.fetch(request('/desktop/downloads/sources'), current.env)).status, 404)
  delete value.source_companion; value.schema_version = 1
  assert.equal((await worker.fetch(request('/desktop/version.json'), fixture({ manifest: value }).env)).status, 502)
})
