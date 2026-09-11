import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../profile/plugins/share.js'

const id = 'A'.repeat(32)
const root = 'https://enterprise.example/e-mate/share'
const expires = () => new Date(Date.now() + 60_000).toISOString()
const result = () => ({ schema_version: 1, share: { id, public_url: `${root}/s/${id}`, expires_at: expires() } })
function fixture(request, overrides = {}) {
  let handler
  let exports = 0
  const exported = []
  apply({
    credentials: { resolve: async () => ({ value: 'fixture-model-session-token-1234567890' }) },
    connection: {
      rpc: { handle: (_channel, value) => { handler = value; return () => {} } },
      // The native owner of the Session ZIP is the session-log-download row, which
      // publishes GET /api/session.export with sessionId/includeDescendants
      // (upstream/deepseek-harness/packages/session-query/session-log-export/src/index.ts:42,85-99).
      createSharedFetchHandler: channel => {
        assert.equal(channel, '/api')
        return { fetch: async request => {
          const url = new URL(request.url)
          assert.equal(url.pathname, '/api/session.export')
          assert.equal(url.searchParams.get('includeDescendants'), 'true')
          exported.push(url.searchParams.get('sessionId'))
          exports += 1
          return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-type': 'application/zip' } })
        } }
      },
    },
    effect: value => value(),
    ...overrides,
  }, { rootUrl: root, fetchImplementation: request })
  return { call: (...args) => handler(...args), exports: () => exports, exported: () => exported }
}

test('share accepts decoded compressed JSON and preserves fixed enterprise base path', async () => {
  const f = fixture(async (url, init) => {
    assert.equal(url, `${root}/v1/shares`)
    assert.equal(init.duplex, 'half')
    await new Response(init.body).arrayBuffer()
    // Native fetch decodes response bytes without removing wire encoding/length.
    return new Response(JSON.stringify(result()), { headers: { 'content-encoding': 'gzip', 'content-length': '97' } })
  })
  const value = await f.call('create', { session_id: 'one' })
  assert.equal(value.ok, true)
  assert.equal(value.value.public_url, `${root}/s/${id}`)
  assert.deepEqual(f.exported(), ['one'])
})

test('share rejects a response outside its exact configured base path', async () => {
  const value = result()
  value.share.public_url = `https://enterprise.example/other/s/${id}`
  const f = fixture(async () => Response.json(value))
  assert.equal((await f.call('create', { session_id: 'one' })).error.code, 'invalid-response')
})

test('share still rejects truncated identity JSON and oversized decoded JSON', async () => {
  for (const response of [
    new Response(JSON.stringify(result()), { headers: { 'content-length': '1' } }),
    new Response(' '.repeat(16 * 1024 + 1), { headers: { 'content-encoding': 'gzip', 'content-length': '100' } }),
  ]) {
    const f = fixture(async () => response)
    assert.equal((await f.call('create', { session_id: 'one' })).error.code, 'invalid-response')
  }
})

test('share filters links expiring during list transit without failing remaining links', async () => {
  const f = fixture(async () => Response.json({ schema_version: 1, shares: [
    result().share,
    { id: 'B'.repeat(32), public_url: `${root}/s/${'B'.repeat(32)}`, expires_at: new Date(Date.now() - 1).toISOString() },
  ] }))
  const value = await f.call('list', { session_id: 'one' })
  assert.equal(value.ok, true)
  assert.deepEqual(value.value.shares.map(value => value.share_id), [id])
})

test('overlapping share calls reuse one native archive/upload and clear a failed attempt', async () => {
  let release
  let uploads = 0
  const f = fixture(async (_url, init) => {
    uploads += 1
    await new Response(init.body).arrayBuffer()
    if (uploads === 1) await new Promise(resolve => { release = resolve })
    return uploads === 1 ? new Response(null, { status: 503 }) : Response.json(result())
  })
  const first = f.call('create', { session_id: 'one' })
  const second = f.call('create', { session_id: 'one' })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.exports(), 1)
  assert.equal(uploads, 1)
  release()
  assert.deepEqual(await first, await second)
  assert.equal((await f.call('create', { session_id: 'one' })).ok, true)
  assert.equal(f.exports(), 2)
  assert.equal(uploads, 2)
})
