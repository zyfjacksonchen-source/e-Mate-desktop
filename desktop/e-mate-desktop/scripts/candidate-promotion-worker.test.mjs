import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import worker from './candidate-promotion-worker.mjs'

const subtle = globalThis.crypto.subtle
if (typeof subtle.timingSafeEqual !== 'function') Object.defineProperty(subtle, 'timingSafeEqual', { configurable: true, value(left, right) { const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength), b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength); if (a.byteLength !== b.byteLength) return false; let difference = 0; for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index]; return difference === 0 } })

const TOKEN = 'promotion-only-secret'
const CANDIDATE_TOKEN = 'candidate-read-secret'
const SOURCE = '0123456789abcdef0123456789abcdef01234567'
const HISTORY_SOURCE = 'f'.repeat(40)
const HISTORY_KEY = 'desktop/releases/release-record.json'
const encoder = new TextEncoder()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const hashBuffer = value => Uint8Array.from(sha256(value).match(/../gu), pair => Number.parseInt(pair, 16)).buffer
function stream(bytes, consumed) { const copy = Uint8Array.from(bytes); return new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close(); consumed?.() } }) }
async function bytesOf(value) { if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer()); if (typeof value === 'string') return encoder.encode(value); if (value instanceof ArrayBuffer) return new Uint8Array(value); return new Uint8Array(value.buffer, value.byteOffset, value.byteLength) }
function object(key, stored, withBody = true) { return { key, size: stored.bytes.byteLength, etag: stored.etag, customMetadata: { ...stored.customMetadata }, httpMetadata: { ...stored.httpMetadata }, checksums: { sha256: hashBuffer(stored.bytes) }, ...(withBody ? { body: stream(stored.bytes, stored.consumed) } : {}), async arrayBuffer() { return stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.byteLength) } } }
function identity(version, source, artifacts) { return { version, source_commit: source, artifacts: { darwin: { bytes: artifacts.darwin.bytes, sha256: artifacts.darwin.sha256 }, win32: { bytes: artifacts.win32.bytes, sha256: artifacts.win32.sha256 } } } }
function evidence(version = '2.0.18', withUniverPlugin = false) {
  const root = 'desktop/candidates/' + SOURCE + '/', installers = { darwin: encoder.encode('exact mac installer'), win32: encoder.encode('exact windows installer') }
  const artifacts = { darwin: { key: root + 'darwin/e-Mate-' + version + '-mac-universal.dmg', bytes: installers.darwin.byteLength, sha256: sha256(installers.darwin) }, win32: { key: root + 'win32/e-Mate-' + version + '-win-x64-Setup.exe', bytes: installers.win32.byteLength, sha256: sha256(installers.win32) } }
  const sourceBytes = encoder.encode('corresponding sources')
  const sourceCompanion = { key: root + 'sources/e-Mate-' + version + '-runtime-sources.tar', bytes: sourceBytes.byteLength, sha256: sha256(sourceBytes) }
  const univerBytes = encoder.encode('exact optional Univer plugin')
  const univerPlugin = { key: root + 'plugins/e-mate-dsh-plugin-univer-office-' + version + '.tgz', bytes: univerBytes.byteLength, sha256: sha256(univerBytes) }
  const state = platform => ({ app_path: platform === 'darwin' ? '/Applications/e-Mate.app' : 'C:/Program Files/e-Mate/e-Mate.exe', dsh_home: platform === 'darwin' ? '/Users/test/.dsh' : 'C:/Users/test/.dsh', user_data: platform === 'darwin' ? '/Users/test/Library/Application Support/e-Mate' : 'C:/Users/test/AppData/Roaming/e-Mate', installation_id_sha256: 'd'.repeat(64), test_session_id: 'session-' + platform })
  const receipt = platform => ({ schema_version: 2, source_companion: sourceCompanion, ...(withUniverPlugin ? { univer_plugin: { ...univerPlugin } } : {}), platform, source_commit: SOURCE, version, installer: { bytes: artifacts[platform].bytes, sha256: artifacts[platform].sha256 }, native_download: { succeeded: true, bytes: artifacts[platform].bytes, sha256: artifacts[platform].sha256 }, native_install: { succeeded: true }, normal_launch: { succeeded: true, launched_version: version }, continuity: { from_version: '2.0.16', before: state(platform), after: { ...state(platform) } }, debug: { port_closed: true } })
  return { root, installers, artifacts, sourceBytes, sourceCompanion, ...(withUniverPlugin ? { univerBytes, univerPlugin } : {}), manifest: { schema_version: 2, source_companion: sourceCompanion, ...(withUniverPlugin ? { univer_plugin: { ...univerPlugin } } : {}), source_commit: SOURCE, version, artifacts }, mac: receipt('darwin'), windows: receipt('win32') }
}
function fixture(options = {}) {
  const value = evidence(options.version, options.withUniverPlugin); options.mutate?.(value)
  let serial = 0, candidateArrayBuffers = 0, concurrent = options.concurrentClaim === true, failPublicKey = options.failPublicKey
  const privateStore = new Map(), publicStore = new Map(), publicOps = [], publicWrites = [], privatePuts = []
  const store = (map, key, bytes, customMetadata = {}, httpMetadata = {}) => map.set(key, { bytes: Uint8Array.from(bytes), customMetadata, httpMetadata, etag: 'etag-' + ++serial })
  const jsonStore = (map, key, value, metadata = {}) => store(map, key, encoder.encode(JSON.stringify(value) + '\n'), metadata, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' })
  jsonStore(privateStore, value.root + 'manifest.json', value.manifest)
  jsonStore(privateStore, value.root + 'acceptance/darwin.json', value.mac)
  jsonStore(privateStore, value.root + 'acceptance/win32.json', value.windows)
  for (const platform of ['darwin', 'win32']) store(privateStore, value.artifacts[platform].key, value.installers[platform], { sha256: value.artifacts[platform].sha256, sourceCommit: SOURCE, version: value.manifest.version })
  store(privateStore, value.sourceCompanion.key, value.sourceBytes, { sha256: value.sourceCompanion.sha256, sourceCommit: SOURCE, version: value.manifest.version })
  if (value.univerPlugin) store(privateStore, value.univerPlugin.key, value.univerBytes, { sha256: value.univerPlugin.sha256, sourceCommit: SOURCE, version: value.manifest.version })
  const historyArtifacts = { darwin: { bytes: 170, sha256: 'a'.repeat(64) }, win32: { bytes: 171, sha256: 'b'.repeat(64) } }
  if (!options.missingHistory) jsonStore(privateStore, HISTORY_KEY, { schema_version: 1, highest: identity(options.highestVersion ?? '2.0.17', HISTORY_SOURCE, historyArtifacts), claim: null })
  const privateBucket = {
    async get(key) { const stored = privateStore.get(key); if (!stored) return null; const result = object(key, stored); if ([value.artifacts.darwin.key, value.artifacts.win32.key, value.sourceCompanion.key, value.univerPlugin?.key].includes(key)) result.arrayBuffer = async () => { candidateArrayBuffers += 1; throw new Error('candidate artifact arrayBuffer forbidden') }; return result },
    async put(key, input, putOptions = {}) {
      privatePuts.push({ key, options: putOptions })
      const existing = privateStore.get(key)
      if (key === HISTORY_KEY && putOptions.onlyIf?.etagMatches && concurrent) {
        concurrent = false
        const competitor = identity('2.0.19', 'e'.repeat(40), { darwin: { bytes: 1, sha256: 'c'.repeat(64) }, win32: { bytes: 1, sha256: 'd'.repeat(64) } })
        jsonStore(privateStore, HISTORY_KEY, { schema_version: 1, highest: JSON.parse(new TextDecoder().decode(existing.bytes)).highest, claim: { candidate: competitor, state: 'running' } })
        return null
      }
      if (putOptions.onlyIf?.etagMatches && existing?.etag !== putOptions.onlyIf.etagMatches) return null
      if (putOptions.onlyIf?.etagDoesNotMatch === '*' && existing) return null
      const bytes = await bytesOf(input); assert.equal(sha256(bytes), putOptions.sha256); store(privateStore, key, bytes, putOptions.customMetadata, putOptions.httpMetadata); return object(key, privateStore.get(key), false)
    },
  }
  const publicBucket = {
    async head(key) { publicOps.push('head:' + key); const stored = publicStore.get(key); return stored ? object(key, stored, false) : null },
    async get(key) { publicOps.push('get:' + key); const stored = publicStore.get(key); return stored ? object(key, stored) : null },
    async put(key, input, putOptions = {}) {
      publicOps.push('put:' + key); publicWrites.push(key)
      if (failPublicKey === key) { failPublicKey = undefined; throw new Error('simulated secret backend detail') }
      const existing = publicStore.get(key)
      if (putOptions.onlyIf?.etagDoesNotMatch === '*' && existing) return null
      const bytes = await bytesOf(input); assert.equal(sha256(bytes), putOptions.sha256); store(publicStore, key, bytes, putOptions.customMetadata, putOptions.httpMetadata); return object(key, publicStore.get(key), false)
    },
  }
  return { value, privateStore, publicStore, publicOps, publicWrites, privatePuts, get candidateArrayBuffers() { return candidateArrayBuffers }, env: { SOURCE_COMMIT: SOURCE, PROMOTION_TOKEN_SHA256: sha256(TOKEN), PROMOTION_EXPIRES_AT: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(), TOKEN_SHA256: sha256(CANDIDATE_TOKEN), CANDIDATES: privateBucket, BUCKET: publicBucket } }
}
function request(token = TOKEN, path = '/promote', method = 'POST') { return new Request('https://promotion.invalid' + path, { method, headers: { Authorization: 'Bearer ' + token } }) }
async function body(response) { return JSON.parse(await response.text()) }
function pluginReleaseKey(value) { return 'desktop/plugins/univer-office/' + value.manifest.version + '/' + value.univerPlugin.sha256 + '.tgz' }
function substitutePlugin(value, remove = false) {
  const stored = value.privateStore.get(value.value.univerPlugin.key)
  stored.bytes[0] ^= 1
  const hash = sha256(stored.bytes); stored.customMetadata.sha256 = hash
  for (const path of ['manifest.json', 'acceptance/darwin.json', 'acceptance/win32.json']) {
    const row = value.privateStore.get(value.value.root + path)
    const parsed = JSON.parse(new TextDecoder().decode(row.bytes))
    if (remove) delete parsed.univer_plugin
    else parsed.univer_plugin.sha256 = hash
    row.bytes = encoder.encode(JSON.stringify(parsed))
  }
}

test('single route, distinct token, short expiry, and missing history reject with zero public writes', async () => {
  for (const value of [fixture({ expiresAt: new Date(Date.now() - 1).toISOString() }), fixture({ expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }), fixture({ missingHistory: true })]) { const result = await worker.fetch(request(), value.env); assert.notEqual(result.status, 200); assert.deepEqual(value.publicWrites, []) }
  const auth = fixture(); assert.equal((await worker.fetch(request(CANDIDATE_TOKEN), auth.env)).status, 401); assert.deepEqual(auth.publicWrites, [])
  for (const route of [['/copy', 'POST'], ['/promote?source=' + SOURCE, 'POST'], ['/promote', 'GET']]) assert.equal((await worker.fetch(request(TOKEN, route[0], route[1]), auth.env)).status, 404)
})

test('downgrade, same-version identity collision, and concurrent CAS reject before public writes', async () => {
  for (const value of [fixture({ version: '2.0.16' }), fixture({ version: '2.0.17' }), fixture({ concurrentClaim: true })]) { const result = await worker.fetch(request(), value.env); assert.equal(result.status, 409); assert.deepEqual(value.publicWrites, []); const error = await body(result); assert.equal(error.partial_public, false); assert.deepEqual(error.operations, []) }
})

test('same candidate cannot share a running claim while its first public write is paused', { timeout: 5000 }, async () => {
  const value = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const put = value.env.BUCKET.put
  let paused = false, expired = false
  value.env.BUCKET.put = async (...args) => {
    if (!paused) { paused = true; entered.resolve(); await release.promise }
    return put(...args)
  }
  const timer = setTimeout(() => { expired = true; entered.resolve(); release.resolve() }, 2000)
  const first = worker.fetch(request(), value.env)
  try {
    await entered.promise
    assert.equal(expired, false)
    assert.deepEqual(value.publicWrites, [])
    const before = value.privateStore.get(HISTORY_KEY)
    assert.equal(JSON.parse(new TextDecoder().decode(before.bytes)).claim.state, 'running')
    const second = await worker.fetch(request(), value.env), failure = await body(second)
    assert.equal(second.status, 409); assert.equal(failure.error, 'promotion_in_progress')
    assert.equal(failure.partial_public, false); assert.deepEqual(failure.operations, [])
    assert.deepEqual(value.publicWrites, [])
    assert.equal(value.privateStore.get(HISTORY_KEY), before)
    assert.equal(expired, false)
  } finally {
    clearTimeout(timer); release.resolve()
    assert.equal((await first).status, 200)
  }
  assert.equal(JSON.parse(new TextDecoder().decode(value.privateStore.get(HISTORY_KEY).bytes)).claim, null)
})

test('acceptance failures still produce zero public writes', async () => {
  for (const mutate of [value => { delete value.windows.native_install.succeeded }, value => { value.mac.native_download.succeeded = false }, value => { value.windows.installer.sha256 = 'f'.repeat(64) }, value => { value.windows.continuity.after.test_session_id = 'other' }]) { const value = fixture({ mutate }); assert.equal((await worker.fetch(request(), value.env)).status, 409); assert.deepEqual(value.publicWrites, []) }
})

test('interrupted promotion reports sanitized partial phase and same candidate resumes without version bump', async () => {
  const value = fixture({ failPublicKey: 'desktop/downloads/mac' })
  const first = await worker.fetch(request(), value.env), failure = await body(first)
  assert.equal(first.status, 409); assert.equal(failure.phase, 'aliases'); assert.equal(failure.partial_public, true); assert.equal(failure.error, 'operation_failed'); assert.ok(failure.operations.some(entry => entry.startsWith('alias-put-attempt:'))); assert.doesNotMatch(JSON.stringify(failure), /simulated secret/u)
  const claimed = JSON.parse(new TextDecoder().decode(value.privateStore.get(HISTORY_KEY).bytes)); assert.equal(claimed.claim.candidate.version, '2.0.18'); assert.equal(claimed.claim.state, 'retryable'); assert.ok(value.privatePuts.at(-1).options.onlyIf.etagMatches)
  const second = await worker.fetch(request(), value.env), completed = await body(second)
  assert.equal(second.status, 200); assert.equal(completed.status, 'promotion-complete'); assert.equal(completed.version, '2.0.18'); assert.equal(completed.atomic, false)
  assert.equal(value.candidateArrayBuffers, 0)
  const releaseRecord = JSON.parse(new TextDecoder().decode(value.privateStore.get(HISTORY_KEY).bytes)); assert.equal(releaseRecord.highest.version, '2.0.18'); assert.equal(releaseRecord.claim, null)
})

test('stores exact same-source completion receipt only after version-last public readback', async () => {
  const value = fixture(), response = await worker.fetch(request(), value.env), result = await body(response)
  assert.equal(response.status, 200)
  const completionKey = 'desktop/candidates/' + SOURCE + '/promotion-complete.json'
  const stored = JSON.parse(new TextDecoder().decode(value.privateStore.get(completionKey).bytes))
  assert.deepEqual(result, stored)
  assert.deepEqual(Object.keys(stored).sort(), ['artifacts', 'atomic', 'completed_operations', 'schema_version', 'source_commit', 'source_companion', 'status', 'version'])
  assert.equal(stored.source_commit, SOURCE); assert.equal(stored.completed_operations.at(-1).key, 'desktop/version.json')
  assert.deepEqual(value.publicWrites.slice(-1), ['desktop/version.json'])
  const completionPut = value.privatePuts.find(entry => entry.key === completionKey), historyFinalize = value.privatePuts.at(-1)
  assert.deepEqual(completionPut.options.onlyIf, { etagDoesNotMatch: '*' }); assert.equal(historyFinalize.key, HISTORY_KEY); assert.ok(historyFinalize.options.onlyIf.etagMatches)
})

test('source missing, changed bytes behind matching metadata, and foreign metadata produce zero public writes', async () => {
  for (const mutate of [
    v => v.privateStore.delete(v.value.sourceCompanion.key),
    v => { v.privateStore.get(v.value.sourceCompanion.key).bytes[0] ^= 1 },
    v => { v.privateStore.get(v.value.sourceCompanion.key).customMetadata.sourceCommit = HISTORY_SOURCE },
  ]) {
    const value = fixture(); mutate(value)
    assert.equal((await worker.fetch(request(), value.env)).status, 409)
    assert.deepEqual(value.publicWrites, [])
    assert.deepEqual(value.privatePuts, [])
  }
})

test('source publication failure leaves aliases untouched; identical retry publishes source before installers', async () => {
  const key = 'desktop/releases/v2.0.18/' + SOURCE + '/e-Mate-2.0.18-runtime-sources.tar'
  const value = fixture({ failPublicKey: key })
  assert.equal((await worker.fetch(request(), value.env)).status, 409)
  assert.deepEqual(value.publicWrites, [key])
  assert.equal((await worker.fetch(request(), value.env)).status, 200)
  assert.deepEqual(value.publicWrites.slice(0, 2), [key, key])
  const record = JSON.parse(new TextDecoder().decode(value.privateStore.get(HISTORY_KEY).bytes))
  assert.deepEqual(record.highest.source_companion, { bytes: value.value.sourceCompanion.bytes, sha256: value.value.sourceCompanion.sha256 })
})

test('same installers with a substituted source archive cannot reuse a retryable claim', async () => {
  const value = fixture({ failPublicKey: 'desktop/downloads/mac' })
  assert.equal((await worker.fetch(request(), value.env)).status, 409)
  const before = value.publicWrites.length
  const storedSource = value.privateStore.get(value.value.sourceCompanion.key)
  storedSource.bytes[0] ^= 1
  const hash = sha256(storedSource.bytes); storedSource.customMetadata.sha256 = hash
  for (const path of ['manifest.json', 'acceptance/darwin.json', 'acceptance/win32.json']) {
    const stored = value.privateStore.get(value.value.root + path)
    const parsed = JSON.parse(new TextDecoder().decode(stored.bytes))
    parsed.source_companion.sha256 = hash
    stored.bytes = encoder.encode(JSON.stringify(parsed))
  }
  const result = await worker.fetch(request(), value.env)
  assert.equal(result.status, 409)
  assert.equal((await body(result)).error, 'concurrent_candidate_claim')
  assert.equal(value.publicWrites.length, before)
})

test('existing source immutable collision is detected before any public write', async () => {
  const value = fixture()
  const key = 'desktop/releases/v2.0.18/' + SOURCE + '/e-Mate-2.0.18-runtime-sources.tar'
  value.publicStore.set(key, { bytes: encoder.encode('wrong source'), customMetadata: {}, httpMetadata: {}, etag: 'collision' })
  const result = await worker.fetch(request(), value.env)
  assert.equal(result.status, 409)
  assert.equal((await body(result)).error, 'immutable_preflight_conflict')
  assert.deepEqual(value.publicWrites, [])
})

test('optional Univer TGZ is promoted unchanged, read back before aliases, recorded and reused on an identical retry', async () => {
  const value = fixture({ withUniverPlugin: true }), key = pluginReleaseKey(value.value)
  const first = await worker.fetch(request(), value.env), completed = await body(first)
  assert.equal(first.status, 200)
  assert.deepEqual(completed.univer_plugin, { ...value.value.univerPlugin, key })
  assert.deepEqual(value.publicStore.get(key).bytes, value.value.univerBytes)
  assert.deepEqual(value.publicStore.get(key).httpMetadata, { contentType: 'application/gzip', cacheControl: 'public, max-age=31536000, immutable' })
  assert.deepEqual(completed.completed_operations[1], { phase: 'immutable', platform: 'univer_plugin', key, read_back: true })
  assert.ok(value.publicOps.indexOf('put:' + key) < value.publicOps.indexOf('put:desktop/downloads/mac'))
  assert.ok(value.publicOps.lastIndexOf('head:' + key) < value.publicOps.indexOf('put:desktop/downloads/mac'))
  assert.equal(value.publicWrites.at(-1), 'desktop/version.json')
  const history = JSON.parse(new TextDecoder().decode(value.privateStore.get(HISTORY_KEY).bytes))
  assert.deepEqual(history.highest.univer_plugin, { bytes: value.value.univerPlugin.bytes, sha256: value.value.univerPlugin.sha256 })
  const receipt = JSON.parse(new TextDecoder().decode(value.privateStore.get(value.value.root + 'promotion-complete.json').bytes))
  assert.deepEqual(receipt, completed)
  const before = value.publicWrites.length
  const retry = await worker.fetch(request(), value.env)
  assert.equal(retry.status, 200)
  assert.deepEqual(await body(retry), completed)
  assert.deepEqual(value.publicWrites.slice(before), ['desktop/downloads/mac', 'desktop/downloads/windows', 'desktop/version.json'])
  assert.equal(value.publicWrites.filter(item => item === key).length, 1)
  assert.equal(value.candidateArrayBuffers, 0)
})

test('missing or mismatched Univer platform receipts reject before the claim and every public write', async () => {
  for (const platform of ['mac', 'windows']) {
    for (const mutate of [
      v => { delete v[platform].univer_plugin },
      v => { v[platform].univer_plugin.bytes += 1 },
      v => { v[platform].univer_plugin.sha256 = '0'.repeat(64) },
    ]) {
      const value = fixture({ withUniverPlugin: true, mutate })
      const result = await worker.fetch(request(), value.env)
      assert.equal(result.status, 409)
      assert.equal((await body(result)).phase, 'acceptance')
      assert.deepEqual(value.publicWrites, [])
      assert.deepEqual(value.privatePuts, [])
    }
  }
})

test('missing, tampered or foreign Univer candidate identity rejects before claiming or publishing', async () => {
  for (const mutate of [
    v => v.privateStore.delete(v.value.univerPlugin.key),
    v => { v.privateStore.get(v.value.univerPlugin.key).bytes[0] ^= 1 },
    v => { v.privateStore.get(v.value.univerPlugin.key).customMetadata.sha256 = '0'.repeat(64) },
    v => { v.privateStore.get(v.value.univerPlugin.key).customMetadata.sourceCommit = HISTORY_SOURCE },
    v => { v.privateStore.get(v.value.univerPlugin.key).customMetadata.version = '2.0.17' },
  ]) {
    const value = fixture({ withUniverPlugin: true }); mutate(value)
    const result = await worker.fetch(request(), value.env)
    assert.equal(result.status, 409)
    assert.equal((await body(result)).error, 'candidate_installer_identity')
    assert.deepEqual(value.publicWrites, [])
    assert.deepEqual(value.privatePuts, [])
  }
})

test('Univer immutable collision is found during complete preflight before any public write', async () => {
  const value = fixture({ withUniverPlugin: true }), key = pluginReleaseKey(value.value)
  value.publicStore.set(key, { bytes: encoder.encode('wrong plugin'), customMetadata: {}, httpMetadata: {}, etag: 'collision' })
  const result = await worker.fetch(request(), value.env)
  assert.equal(result.status, 409)
  assert.equal((await body(result)).error, 'immutable_preflight_conflict')
  assert.deepEqual(value.publicWrites, [])
})

test('Univer write failure leaves aliases and version untouched; same-byte retry reuses completed source', async () => {
  const key = pluginReleaseKey(evidence('2.0.18', true))
  const value = fixture({ withUniverPlugin: true, failPublicKey: key })
  const first = await worker.fetch(request(), value.env), failed = await body(first)
  assert.equal(first.status, 409)
  assert.equal(failed.phase, 'immutable')
  assert.equal(failed.partial_public, true)
  assert.equal(value.publicWrites.at(-1), key)
  assert.equal(value.publicWrites.some(item => item.startsWith('desktop/downloads/') || item === 'desktop/version.json'), false)
  assert.equal(value.privateStore.has(value.value.root + 'promotion-complete.json'), false)
  const claimed = JSON.parse(new TextDecoder().decode(value.privateStore.get(HISTORY_KEY).bytes))
  assert.equal(claimed.claim.state, 'retryable')
  assert.deepEqual(claimed.claim.candidate.univer_plugin, { bytes: value.value.univerPlugin.bytes, sha256: value.value.univerPlugin.sha256 })
  assert.equal((await worker.fetch(request(), value.env)).status, 200)
  assert.equal(value.publicWrites.filter(item => item.endsWith('-runtime-sources.tar')).length, 1)
  assert.equal(value.publicWrites.filter(item => item === key).length, 2)
  assert.equal(value.publicWrites.at(-1), 'desktop/version.json')
})

test('Univer checksum-protected streamed write and immutable readback failures cannot reach aliases or version', async () => {
  for (const failure of ['stream', 'readback']) {
    const value = fixture({ withUniverPlugin: true }), key = pluginReleaseKey(value.value)
    if (failure === 'stream') {
      const get = value.env.CANDIDATES.get
      value.env.CANDIDATES.get = async candidateKey => {
        const found = await get(candidateKey)
        if (candidateKey === value.value.univerPlugin.key) {
          const changed = Uint8Array.from(value.value.univerBytes); changed[0] ^= 1
          found.body = stream(changed)
        }
        return found
      }
    } else {
      const head = value.env.BUCKET.head
      value.env.BUCKET.head = async publicKey => {
        const found = await head(publicKey)
        return publicKey === key && found !== null ? { ...found, size: found.size + 1 } : found
      }
    }
    const result = await worker.fetch(request(), value.env), failed = await body(result)
    assert.equal(result.status, 409)
    assert.equal(failed.phase, 'immutable')
    assert.equal(value.publicWrites.some(item => item.startsWith('desktop/downloads/') || item === 'desktop/version.json'), false)
    assert.equal(value.privateStore.has(value.value.root + 'promotion-complete.json'), false)
  }
})

test('substituted or removed Univer TGZ cannot reuse a retryable claim or an already released version', async () => {
  for (const retryable of [true, false]) {
    for (const remove of [true, false]) {
      const value = fixture({ withUniverPlugin: true, ...(retryable ? { failPublicKey: 'desktop/downloads/mac' } : {}) })
      assert.equal((await worker.fetch(request(), value.env)).status, retryable ? 409 : 200)
      const before = value.publicWrites.length
      substitutePlugin(value, remove)
      const result = await worker.fetch(request(), value.env)
      assert.equal(result.status, 409)
      assert.equal((await body(result)).error, retryable ? 'concurrent_candidate_claim' : 'same_version_identity_collision')
      assert.equal(value.publicWrites.length, before)
    }
  }
})

test('schema-1 promotion keeps its original receipt without optional artifact fields', async () => {
  const value = fixture({ version: '2.0.17', highestVersion: '2.0.16', mutate(v) {
    for (const row of [v.manifest, v.mac, v.windows]) { row.schema_version = 1; delete row.source_companion }
  } })
  const result = await worker.fetch(request(), value.env), completed = await body(result)
  assert.equal(result.status, 200)
  assert.equal(completed.schema_version, 1)
  assert.equal(Object.hasOwn(completed, 'source_companion'), false)
  assert.equal(Object.hasOwn(completed, 'univer_plugin'), false)
  assert.equal(value.publicWrites.some(item => item.includes('/plugins/') || item.endsWith('-runtime-sources.tar')), false)
})

test('release-record Univer identity stays strict and requires the schema-2 source companion identity', async () => {
  for (const mutate of [
    row => { row.univer_plugin.bytes = 0 },
    row => { row.univer_plugin.sha256 = 'invalid' },
    row => { row.univer_plugin.key = 'unexpected-field' },
    row => { delete row.source_companion },
  ]) {
    const value = fixture({ withUniverPlugin: true })
    const stored = value.privateStore.get(HISTORY_KEY), record = JSON.parse(new TextDecoder().decode(stored.bytes))
    record.highest.source_companion = { bytes: 10, sha256: 'c'.repeat(64) }
    record.highest.univer_plugin = { bytes: 20, sha256: 'd'.repeat(64) }
    mutate(record.highest)
    stored.bytes = encoder.encode(JSON.stringify(record))
    const result = await worker.fetch(request(), value.env)
    assert.equal(result.status, 409)
    assert.equal((await body(result)).error, 'release_record_invalid')
    assert.deepEqual(value.publicWrites, [])
    assert.deepEqual(value.privatePuts, [])
  }
})
