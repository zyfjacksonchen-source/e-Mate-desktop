import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { handleRequest, forwardRequest } from '../src/index.js'

class MemoryR2 {
  objects = new Map()
  listPageSize = Number.POSITIVE_INFINITY
  listCalls = 0

  async put(key, value, options = {}) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer())
    const object = {
      key,
      size: bytes.byteLength,
      customMetadata: { ...options.customMetadata },
      httpMetadata: { ...options.httpMetadata },
      bytes,
    }
    this.objects.set(key, object)
    return this.view(object)
  }

  async head(key) {
    const object = this.objects.get(key)
    return object === undefined ? null : this.view(object)
  }

  async get(key) {
    const object = this.objects.get(key)
    return object === undefined
      ? null
      : { ...this.view(object), body: new Blob([object.bytes]).stream() }
  }

  async delete(key) {
    this.objects.delete(key)
  }

  async list({ prefix = '', limit = 1_000, cursor } = {}) {
    this.listCalls += 1
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort()
    const start = cursor === undefined ? 0 : Number(cursor)
    const size = Math.min(limit, this.listPageSize)
    const end = Math.min(start + size, keys.length)
    const truncated = end < keys.length
    return {
      objects: keys.slice(start, end).map(key => this.view(this.objects.get(key))),
      truncated,
      ...(truncated ? { cursor: String(end) } : {}),
    }
  }

  view(object) {
    return {
      key: object.key,
      size: object.size,
      customMetadata: { ...object.customMetadata },
      httpMetadata: { ...object.httpMetadata },
    }
  }
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function modelToken(userId = 'user-1') {
  return [
    base64url({ alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: 'auth-key-1' }),
    base64url({
      schemaVersion: 1,
      tenantId: 'tenant-1',
      sub: userId,
      sid: '01234567-89ab-4def-8123-456789abcdef',
      exp: Math.floor(Date.now() / 1_000) + 900,
    }),
    'x'.repeat(86),
  ].join('.')
}

function environment(overrides = {}) {
  return {
    PUBLIC_ORIGIN: 'https://emate-share.example.workers.dev',
    MODEL_SESSION_VALIDATION_URL: 'https://model.example/e-mate/model-api/v1/consents/current',
    SHARE_TTL_SECONDS: '604800',
    MAX_UPLOAD_BYTES: '104857600',
    SHARES: new MemoryR2(),
    ...overrides,
  }
}

function authorizedRequest(url, options = {}, userId = 'user-1') {
  return new Request(url, {
    ...options,
    headers: {
      authorization: `Bearer ${modelToken(userId)}`,
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { duplex: 'half' }),
  })
}

const activeSession = async (url, init) => {
  assert.equal(url, 'https://model.example/e-mate/model-api/v1/consents/current')
  assert.match(init.headers.authorization, /^Bearer /u)
  return new Response(null, { status: 200 })
}

test('keeps the public 2.0.13 contract while exposing strict versioned health and revoke', async () => {
  const env = environment()
  assert.deepEqual(await (await handleRequest(
    new Request('https://share.example/healthz'), env, activeSession,
  )).json(), { schema_version: 1, ready: true })
  assert.deepEqual(await (await handleRequest(
    new Request('https://share.example/v2/healthz'), env, activeSession,
  )).json(), {
    schema_version: 1,
    service: 'emate-share',
    version: 1,
    ready: true,
  })

  const session = '9'.repeat(64)
  const created = await (await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-emate-session-sha256': session },
    body: new Uint8Array([1]),
  }), env, activeSession)).json()
  const strictUrl = `https://share.example/v2/shares/${created.share.id}`
  assert.equal((await handleRequest(authorizedRequest(strictUrl, { method: 'DELETE' }), env, activeSession)).status, 400)
  assert.equal((await handleRequest(authorizedRequest(strictUrl, {
    method: 'DELETE',
    headers: { 'x-emate-session-sha256': '8'.repeat(64) },
  }), env, activeSession)).status, 403)
  assert.equal((await handleRequest(authorizedRequest(strictUrl, {
    method: 'DELETE',
    headers: { 'x-emate-session-sha256': session },
  }), env, activeSession)).status, 200)
})

test('creates, opens, downloads, and revokes one authenticated DSH archive', async () => {
  const env = environment()
  const create = await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-emate-session-sha256': 'a'.repeat(64),
    },
    body: new Uint8Array([80, 75, 3, 4]),
  }), env, activeSession)
  assert.equal(create.status, 201)
  const created = await create.json()
  assert.match(created.share.id, /^[A-Za-z0-9_-]{32}$/u)
  assert.equal(created.share.public_url, `https://emate-share.example.workers.dev/s/${created.share.id}`)

  const recovered = await handleRequest(authorizedRequest(
    `https://share.example/v1/shares?session_sha256=${'a'.repeat(64)}`,
  ), env, activeSession)
  assert.deepEqual(await recovered.json(), { schema_version: 1, shares: [created.share] })

  const retried = await (await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-emate-session-sha256': 'a'.repeat(64),
    },
    body: new Uint8Array([9, 9, 9]),
  }), env, activeSession)).json()
  assert.deepEqual(retried.share, created.share)

  const page = await handleRequest(new Request(created.share.public_url), env, activeSession)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /下载任务归档（ZIP）/u)

  const archive = await handleRequest(new Request(`${created.share.public_url}/archive.zip`), env, activeSession)
  assert.equal(archive.headers.get('content-type'), 'application/zip')
  assert.deepEqual(new Uint8Array(await archive.arrayBuffer()), new Uint8Array([80, 75, 3, 4]))

  const revoked = await handleRequest(authorizedRequest(
    `https://share.example/v2/shares/${created.share.id}`,
    { method: 'DELETE', headers: { 'x-emate-session-sha256': 'a'.repeat(64) } },
  ), env, activeSession)
  assert.deepEqual(await revoked.json(), { schema_version: 1, revoked: true })
  assert.equal((await handleRequest(new Request(created.share.public_url), env, activeSession)).status, 404)
})

test('keeps legacy v1 revoke owner-only and accepts an already-removed share idempotently', async () => {
  const env = environment()
  const session = 'b'.repeat(64)
  const created = await (await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-emate-session-sha256': session,
    },
    body: new Uint8Array([1]),
  }), env, activeSession)).json()
  const url = `https://share.example/v1/shares/${created.share.id}`

  const revoke = { method: 'DELETE' }
  const denied = await handleRequest(authorizedRequest(url, revoke, 'user-2'), env, activeSession)
  assert.equal(denied.status, 403)
  assert.equal(env.SHARES.objects.size, 2)

  assert.equal((await handleRequest(authorizedRequest(url, revoke), env, activeSession)).status, 200)
  assert.equal((await handleRequest(authorizedRequest(url, revoke), env, activeSession)).status, 200)
})

test('versions health and binds revoke to the exact owner/session index', async () => {
  const env = environment()
  const health = await handleRequest(new Request('https://share.example/v2/healthz'), env, activeSession)
  assert.deepEqual(await health.json(), {
    schema_version: 1,
    service: 'emate-share',
    version: 1,
    ready: true,
  })

  const session = '1'.repeat(64)
  const created = await (await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-emate-session-sha256': session },
    body: new Uint8Array([1]),
  }), env, activeSession)).json()
  const url = `https://share.example/v2/shares/${created.share.id}`

  const denied = await handleRequest(authorizedRequest(url, {
    method: 'DELETE',
    headers: { 'x-emate-session-sha256': '2'.repeat(64) },
  }), env, activeSession)
  assert.equal(denied.status, 403)
  assert.equal(env.SHARES.objects.size, 2)

  const revoked = await handleRequest(authorizedRequest(url, {
    method: 'DELETE',
    headers: { 'x-emate-session-sha256': session },
  }), env, activeSession)
  assert.equal(revoked.status, 200)
  assert.equal(env.SHARES.objects.size, 0)
})

test('fails closed for an invalid login and removes an archive beyond the configured limit', async () => {
  const env = environment({ MAX_UPLOAD_BYTES: '3' })
  const request = () => authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-emate-session-sha256': 'c'.repeat(64),
    },
    body: new Uint8Array([1, 2, 3, 4]),
  })

  const unauthorized = await handleRequest(request(), env, async () => new Response(null, { status: 401 }))
  assert.equal(unauthorized.status, 401)
  assert.equal(env.SHARES.objects.size, 0)

  const oversized = await handleRequest(request(), env, activeSession)
  assert.equal(oversized.status, 413)
  assert.equal(env.SHARES.objects.size, 0)
})

test('paginates the exact owner/session index and never returns another principal or session', async () => {
  const env = environment()
  env.SHARES.listPageSize = 1
  const session = 'd'.repeat(64)
  const first = await (await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-emate-session-sha256': session },
    body: new Uint8Array([1]),
  }), env, activeSession)).json()
  const archive = env.SHARES.objects.get(`shares/${first.share.id}.zip`)
  const secondId = first.share.id === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32)
  const createdAt = new Date(Date.now() + 1_000).toISOString()
  await env.SHARES.put(`shares/${secondId}.zip`, new Uint8Array([2]), {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: { ...archive.customMetadata, created_at: createdAt },
  })
  await env.SHARES.put(
    `owners/${archive.customMetadata.owner_sha256}/${session}/${secondId}`,
    new Uint8Array(),
    { customMetadata: { created_at: createdAt, expires_at: archive.customMetadata.expires_at } },
  )

  const listed = await (await handleRequest(authorizedRequest(
    `https://share.example/v1/shares?session_sha256=${session}`,
  ), env, activeSession)).json()
  assert.equal(listed.shares.length, 2)
  assert.ok(env.SHARES.listCalls >= 3)

  const anotherSession = await (await handleRequest(authorizedRequest(
    `https://share.example/v1/shares?session_sha256=${'e'.repeat(64)}`,
  ), env, activeSession)).json()
  assert.deepEqual(anotherSession.shares, [])
  const anotherOwner = await (await handleRequest(authorizedRequest(
    `https://share.example/v1/shares?session_sha256=${session}`, {}, 'user-2',
  ), env, activeSession)).json()
  assert.deepEqual(anotherOwner.shares, [])
})

test('expires public reads with 410 and removes the matching owner/session index', async () => {
  const env = environment()
  const session = 'f'.repeat(64)
  const created = await (await handleRequest(authorizedRequest('https://share.example/v1/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-emate-session-sha256': session },
    body: new Uint8Array([1]),
  }), env, activeSession)).json()
  const archive = env.SHARES.objects.get(`shares/${created.share.id}.zip`)
  archive.customMetadata.expires_at = new Date(Date.now() - 1_000).toISOString()

  const expired = await handleRequest(new Request(created.share.public_url), env, activeSession)
  assert.equal(expired.status, 410)
  assert.deepEqual(await expired.json(), { schema_version: 1, error: { code: 'SHARE_EXPIRED' } })
  assert.equal(env.SHARES.objects.size, 0)
})

test('enterprise base keeps the native API and landing archive links under the same path', async () => {
  const env = environment({ PUBLIC_ORIGIN: 'https://mvdcm.ecoremedia.net/e-mate/share' })
  const created = await (await handleRequest(authorizedRequest('https://share.example/e-mate/share/v1/shares', {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-emate-session-sha256': '3'.repeat(64) }, body: new Uint8Array([1]),
  }), env, activeSession)).json()
  assert.equal(created.share.public_url, `https://mvdcm.ecoremedia.net/e-mate/share/s/${created.share.id}`)
  const page = await handleRequest(new Request(created.share.public_url), env, activeSession)
  assert.match(await page.text(), new RegExp(`/e-mate/share/s/${created.share.id}/archive.zip`))
  assert.equal((await handleRequest(new Request(`${created.share.public_url}/archive.zip`, { method: 'HEAD' }), env, activeSession)).body, null)
})

test('legacy forwarder uses only the fixed enterprise owner and preserves old client URL binding', async () => {
  const env = environment({ SHARE_SERVICE_BASE: 'https://mvdcm.ecoremedia.net/e-mate/share' })
  const id = 'a'.repeat(32)
  const incoming = authorizedRequest('https://emate-share.example.workers.dev/v1/shares', {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Uint8Array([80, 75]),
  })
  const response = await forwardRequest(incoming, env, async (request, init) => {
    assert.equal(request.url, 'https://mvdcm.ecoremedia.net/e-mate/share/v1/shares')
    assert.equal(init.redirect, 'manual')
    assert.equal(request.headers.get('authorization'), incoming.headers.get('authorization'))
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), new Uint8Array([80, 75]))
    return Response.json({ schema_version: 1, share: { id, public_url: `https://mvdcm.ecoremedia.net/e-mate/share/s/${id}`, expires_at: '2026-09-10T00:00:00.000Z' } }, { status: 201 })
  })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).share.public_url, `https://emate-share.example.workers.dev/s/${id}`)
  await assert.rejects(forwardRequest(new Request('https://old.example/healthz'), { ...env, SHARE_SERVICE_BASE: 'https://unrelated.example' }, () => { throw new Error('must not fetch') }), /fixed share service/)
})

test('expired streamed archive closes its body before removing metadata', async () => {
  const env = environment()
  let cancelled = false
  env.SHARES.get = async key => ({ key, size: 1, customMetadata: { expires_at: '2020-01-01T00:00:00.000Z' },
    body: new ReadableStream({ cancel() { cancelled = true } }) })
  const response = await handleRequest(new Request(`https://share.example/s/${'a'.repeat(32)}/archive.zip`), env, activeSession)
  assert.equal(response.status, 410)
  assert.equal(cancelled, true)
})
