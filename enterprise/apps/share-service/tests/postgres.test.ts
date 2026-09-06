import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initialize } from '../src/store.ts'
import { createService, PUBLIC_BASE } from '../src/server.ts'

const database = process.env.SHARE_TEST_DATABASE_URL
test('PostgreSQL: concurrent same-session creates, response loss recovery, owner isolation and revoke',
  { skip: database ? false : 'requires an explicitly isolated SHARE_TEST_DATABASE_URL' }, async t => {
    const pool = new Pool({ connectionString: database, max: 6, connectionTimeoutMillis: 3000 })
    const volume = await mkdtemp(join(tmpdir(), 'emate-share-pg-'))
    const user = `share-test-${randomUUID()}`
    const owner = createHash('sha256').update(`share-test-tenant\0${user}`).digest('hex')
    t.after(async () => {
      await pool.query("DELETE FROM emate_share.objects WHERE custom_metadata->>'owner_sha256'=$1 OR starts_with(key,$2)", [owner, `owners/${owner}/`])
      await pool.end()
      await rm(volume, { recursive: true, force: true })
    })
    await initialize(pool)
    await pool.query("INSERT INTO emate_share.service_state(singleton,manifest_sha256,imported_object_count) VALUES(true,$1,0) ON CONFLICT(singleton) DO NOTHING", ['0'.repeat(64)])
    const service = createService({ pool, volume, validationUrl: 'http://model-gateway/v1/consents/current',
      fetchImplementation: async (url, init) => {
        assert.equal(url, 'http://model-gateway/v1/consents/current')
        assert.equal(init?.redirect, 'manual')
        return new Response(null, { status: 200 })
      } })
    await service.files.ready()
    const token = (sub = user) => [
      { alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: 'test-key' },
      { schemaVersion: 1, tenantId: 'share-test-tenant', sub, sid: randomUUID(), exp: Math.floor(Date.now() / 1000) + 300 },
    ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('x'.repeat(86)).join('.')
    const session = createHash('sha256').update(randomUUID()).digest('hex')
    const request = (path: string, method = 'GET', sub = user) => new Request(`${PUBLIC_BASE}${path}`, {
      method, headers: { authorization: `Bearer ${token(sub)}`, 'x-emate-session-sha256': session, 'content-type': 'application/zip' },
      ...(method === 'POST' ? { body: new Uint8Array([80, 75, 3, 4]), duplex: 'half' } : {}),
    } as RequestInit)
    const results = await Promise.all(Array.from({ length: 4 }, () => service.fetch(request('/v1/shares', 'POST'))))
    assert.deepEqual(results.map(value => value.status).sort(), [200, 200, 200, 201])
    const links = await Promise.all(results.map(value => value.json()))
    assert.equal(new Set(links.map(value => value.share.id)).size, 1)
    const id = links[0].share.id
    assert.equal((await pool.query("SELECT key FROM emate_share.objects WHERE custom_metadata->>'owner_sha256'=$1", [owner])).rowCount, 1)
    assert.deepEqual((await (await service.fetch(request(`/v1/shares?session_sha256=${session}`, 'GET', 'other-user'))).json()).shares, [])
    assert.equal((await service.fetch(request(`/v2/shares/${id}`, 'DELETE', 'other-user'))).status, 403)
    assert.deepEqual(new Uint8Array(await (await service.fetch(new Request(`${PUBLIC_BASE}/s/${id}/archive.zip`))).arrayBuffer()), new Uint8Array([80, 75, 3, 4]))
    assert.equal((await service.fetch(request(`/v2/shares/${id}`, 'DELETE'))).status, 200)

    const connect = pool.connect.bind(pool)
    let loseCommit = true
    // Actual COMMIT reaches PostgreSQL; only its response is lost to the caller.
    const wrappedPool = new Proxy(pool, { get(target, property) {
      if (property !== 'connect') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value }
      return async () => {
      const client = await connect()
      const query = client.query.bind(client)
      const release = client.release.bind(client)
      client.query = (async (...args: any[]) => {
        const value = await (query as any)(...args)
        if (args[0] === 'COMMIT' && loseCommit) { loseCommit = false; throw new Error('injected response loss') }
        return value
      }) as typeof client.query
      client.release = (...args) => { client.query = query; client.release = release; release(...args) }
      return client
      }
    } })
    const lossyService = createService({ pool: wrappedPool, volume, validationUrl: 'http://model-gateway/v1/consents/current', fetchImplementation: async () => new Response(null, { status: 200 }) })
    assert.equal((await lossyService.fetch(request('/v1/shares', 'POST'))).status, 503)
    const recovered = await (await service.fetch(request(`/v1/shares?session_sha256=${session}`))).json()
    assert.equal(recovered.shares.length, 1)
    const resumed = await (await service.fetch(request('/v1/shares', 'POST'))).json()
    assert.equal(resumed.share.id, recovered.shares[0].id)
    assert.equal((await service.fetch(new Request(`${resumed.share.public_url}/archive.zip`))).status, 200)
    await service.maintenance()
    assert.equal((await service.fetch(new Request(`${resumed.share.public_url}/archive.zip`))).status, 200)
    service.close()
    assert.equal((await service.fetch(request('/v2/healthz'))).status, 503)
  })
