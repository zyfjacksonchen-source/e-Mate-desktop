import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createKnowledgeHost, knowledgeTarget } from '../src/index.ts'
import { API_ROOT, parseGraph } from '../src/contract.ts'
const result = { schema_version: 1, scope: { kind: 'public' }, corpus_revision: 'a'.repeat(64), source_count: 0 }
const principal = { tenantId: 'enterprise', userId: 'user-1' }
const reply = value => Response.json(value)

test('only fixed readonly operations and bounded targets are accepted, never renderer credentials', () => {
  const target = knowledgeTarget('graph', { limit: 500, depth: 2 })
  assert.equal(target.url.href, API_ROOT + '/graph?limit=500&depth=2')
  for (const [action, params] of [['graph', { limit: 501 }], ['catalog', { token: 'fake' }], ['search', { question: 'q', project_id: 1 }], ['imports', {}], ['original', { source_id: 'a'.repeat(36) }]]) assert.throws(() => knowledgeTarget(action, params))
})

test('Host bootstraps the native identity once before capturing the owner and reads no renderer token', async () => {
  let active
  let requests = 0
  const host = createKnowledgeHost({ localAccountPrincipal: () => active, state: async () => { active = principal; return { authenticated: true, workspace_unlocked: true } }, request: async (url, init) => {
    requests++; assert.equal(url.href, API_ROOT + '/catalog'); assert.equal(init.headers?.authorization, undefined); return reply(result)
  } })
  const value = await host.call('catalog', {})
  assert.equal(requests, 1); assert.match(value.scope_key, /^[a-f0-9]{64}$/); assert.equal(value.result.source_count, 0)
  host.dispose()
})

test('account change during response body consumption cancels or rejects the old result', async () => {
  let active = principal, stream
  const host = createKnowledgeHost({ localAccountPrincipal: () => active, request: async () => new Response(new ReadableStream({ start(controller) { stream = controller } }), { headers: { 'content-type': 'application/json' } }) })
  const pending = host.call('catalog', {})
  await Promise.resolve(); await Promise.resolve()
  active = { ...principal, userId: 'user-2' }; host.changed()
  stream.enqueue(new TextEncoder().encode(JSON.stringify(result))); stream.close()
  await assert.rejects(pending)
  host.dispose()
})

test('same-account credential refresh preserves in-flight reads', async () => {
  let stream
  const host = createKnowledgeHost({ localAccountPrincipal: () => principal, request: async () => new Response(new ReadableStream({ start(controller) { stream = controller } }), { headers: { 'content-type': 'application/json' } }) })
  const pending = host.call('catalog', {})
  await Promise.resolve(); host.changed()
  stream.enqueue(new TextEncoder().encode(JSON.stringify(result))); stream.close()
  assert.equal((await pending).result.source_count, 0)
  host.dispose()
})

test('original bytes are hash-verified, one-time and bound to the same active owner', async () => {
  let active = principal, corrupt = false
  const content = Buffer.from('verified source'), version = createHash('sha256').update(content).digest('hex')
  const host = createKnowledgeHost({ localAccountPrincipal: () => active, request: async () => new Response(corrupt ? 'wrong' : content, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''source.md" } }) })
  const read = () => host.call('original', { source_id: 'a'.repeat(36), version })
  const first = (await read()).result.url.split('/').at(-1)
  assert.deepEqual(host.takeDownload(first).bytes, content); assert.equal(host.takeDownload(first), undefined)
  const second = (await read()).result.url.split('/').at(-1)
  active = { ...principal, userId: 'user-2' }
  assert.equal(host.takeDownload(second), undefined)
  corrupt = true
  await assert.rejects(read(), /版本核验失败/)
  host.dispose()
})

test('graph rejects invented identities, duplicate nodes, dangling edges and more than 500 points', () => {
  const node = { id: '1'.repeat(64), title: 'Fixture source', source_id: 'a'.repeat(36), source_version: 'b'.repeat(64), layer: 'expert' }
  const graph = { ...result, nodes: [node], edges: [], truncated: false }
  assert.equal(parseGraph(graph).nodes.length, 1)
  for (const value of [{ ...graph, nodes: [node, node] }, { ...graph, nodes: Array(501).fill(node) }, { ...graph, edges: [{ from: node.id, to: '2'.repeat(64), source_id: node.source_id, kind: 'reference' }] }]) assert.throws(() => parseGraph(value))
})

test('knowledge domain failures survive the real pinned native RPC envelope codec', async () => {
  const { serverResponseSchema } = await import('../../../upstream/deepseek-harness/packages/host/apiproxy/src/api/rpc.schema.ts')
  const { knowledgeRpc } = await import('../src/index.ts')
  const { parseKnowledgeRpc } = await import('../src/contract.ts')
  const host = createKnowledgeHost({ localAccountPrincipal: () => principal, request: async () => reply(result) })
  const success = serverResponseSchema.parse({ type: 'server-response', rpcId: 'test-rpc', result: await knowledgeRpc(host, 'catalog', {}) })
  assert.equal(parseKnowledgeRpc(success.result).result.source_count, 0)
  const failure = serverResponseSchema.parse({ type: 'server-response', rpcId: 'test-rpc', result: await knowledgeRpc(host, 'catalog', { token: 'never-accepted' }) })
  assert.throws(() => parseKnowledgeRpc(failure.result), error => error.code === 'invalid-request')
  const controller = new AbortController(); controller.abort()
  const cancelled = serverResponseSchema.parse({ type: 'server-response', rpcId: 'test-rpc', result: await knowledgeRpc(host, 'catalog', {}, controller.signal) })
  assert.throws(() => parseKnowledgeRpc(cancelled.result), error => error.code === 'cancelled')
  host.dispose()
})

test('a revoked identity is recognized even when the native request rejects before returning a body', async () => {
  let active = principal
  const host = createKnowledgeHost({ localAccountPrincipal: () => active, request: async () => { active = undefined; throw Error('native signed out') } })
  await assert.rejects(host.call('catalog', {}), error => error.code === 'scope-changed')
  host.dispose()
})
