import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createKnowledgeHost, knowledgeTarget } from '../src/index.ts'
import { API_ROOT, parseGraph } from '../src/contract.ts'
const result = { schema_version: 1, scope: { kind: 'public' }, corpus_revision: 'a'.repeat(64), source_count: 0 }
const principal = { tenantId: 'enterprise', userId: 'user-1' }
const reply = value => Response.json(value)

test('import lookup validates the exact operation receipt without inventing a corpus revision', async () => {
  const operation_id = 'a'.repeat(64)
  const receipt = { schema_version: 1, scope: { kind: 'uploader-private' }, operation_id,
    import_id: '11111111-1111-4111-8111-111111111111', request_hash: 'b'.repeat(64), status: 'awaiting_content', source: null }
  const host = createKnowledgeHost({ localAccountPrincipal: () => principal, async request(url) {
    assert.equal(url.href, API_ROOT + '/imports?operation_id=' + operation_id); return reply(receipt)
  } })
  assert.equal((await host.call('import', { operation_id })).result.status, 'awaiting_content')
  receipt.operation_id = 'c'.repeat(64)
  await assert.rejects(host.call('import', { operation_id }), { code: 'invalid-response' })
  for (const payload of [{}, { operation_id, scope: 'public' }, { operation_id: '../another' }]) assert.throws(() => knowledgeTarget('import', payload))
  host.dispose()
})

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

test('private and Wiki reads keep the current enterprise owner and exact service scope', async () => {
  let wrongScope = false
  const id = '11111111-1111-4111-8111-111111111111'
  const host = createKnowledgeHost({ localAccountPrincipal: () => principal, async request(url) {
    if (url.pathname.endsWith('/revisions/' + id)) return reply({ schema_version: 1, scope: { kind: 'enterprise-subject' }, revision_id: id, markdown: 'Exact verified revision', source_versions: [] })
    assert.equal(url.searchParams.get('scope'), 'uploader-private')
    return reply({ ...result, scope: { kind: wrongScope ? 'public' : 'uploader-private' }, items: [] })
  } })
  assert.equal((await host.call('revisions', { scope: 'uploader-private' })).result.scope.kind, 'uploader-private')
  wrongScope = true
  await assert.rejects(host.call('catalog', { scope: 'uploader-private' }), { code: 'invalid-response' })
  assert.equal((await host.call('revision', { revision_id: id })).result.revision_id, id)
  for (const scope of ['project', { kind: 'uploader-private', subject_id: 'another' }]) assert.throws(() => knowledgeTarget('catalog', { scope }))
  assert.throws(() => knowledgeTarget('revision', { revision_id: id, tenant_id: 'another' }))
  assert.throws(() => knowledgeTarget('compilations', {}))
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

test('disposing during cold identity bootstrap cannot revive a request or mint a download', async () => {
  let active, finish, requests = 0
  const bootstrap = new Promise(resolve => { finish = resolve })
  const host = createKnowledgeHost({ localAccountPrincipal: () => active, state: () => bootstrap, request: async () => { requests++; return reply(result) } })
  const pending = host.call('catalog', {})
  host.dispose()
  active = principal; host.changed(); finish({ authenticated: true, workspace_unlocked: true })
  await assert.rejects(pending, error => error.code === 'cancelled')
  await assert.rejects(host.call('catalog', {}), error => error.code === 'cancelled')
  assert.equal(requests, 0)
})

async function nativeApplyReview(t, root, xin) {
  const [{ Context }, { default: Timer }, { mountAgentLoopTestDependencies }, { default: AgentLoop }, { default: Persistence }, { default: Jobs }, { default: Fs }, { apply }] = await Promise.all([
    import('../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'),
    import('../../../upstream/deepseek-harness/vendor/timer/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/core/agent-loop/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'),
    import('../src/index.ts'),
  ])
  const ctx = new Context(); await ctx.plugin(Timer); await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root, compression: 'none' }); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Jobs)
  ctx.jobs.attachController('knowledge-apply-review'); await ctx.plugin(Fs, { cwd: root })
  const { LlmAdapter } = await import('../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js')
  class NoModelCalls extends LlmAdapter { async resolveModel(provider, model) { return { provider, id: model, name: model } } async *stream() { throw Error('unexpected model call') } }
  ctx.llm.registerAdapter(['mock'], new NoModelCalls())
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) })
  ctx.reflect.provide('emateModelPolicy', { assertModel: async () => {} })
  ctx.reflect.provide('emateIdentity', { localAccountPrincipal: () => principal, state: async () => ({ authenticated: true }), request: async () => { throw Error('unexpected HTTP') } })
  ctx.reflect.provide('emateXinKnowledge', { capture(exec = {}) {
    const bound = xin.subject, epoch = xin.epoch; xin.captures.push({ bound, exec })
    return { async bind(expected, signal) {
      signal?.throwIfAborted(); exec.signal?.throwIfAborted()
      if (xin.revoked) throw Object.assign(Error('grant revoked'), { code: 'project-unavailable' })
      const fingerprint = createHash('sha256').update(bound).digest('hex')
      if (bound !== xin.subject || epoch !== xin.epoch || expected !== undefined && expected !== fingerprint) throw Object.assign(Error('Xin subject changed'), { code: 'scope-changed' })
      return fingerprint
    }, async call(name, args, signal) {
      signal?.throwIfAborted(); exec.signal?.throwIfAborted()
      if (bound !== xin.subject || epoch !== xin.epoch) throw Object.assign(Error('Xin subject changed'), { code: 'scope-changed' })
      xin.calls.push({ bound, name, args })
      if (name === 'find_imported_source') return { structuredContent: { schema_version: 1, status: 'failed', error: 'NOT_FOUND' } }
      if (name === 'prepare_source_upload') throw Error('fixture submission not acknowledged')
      return { structuredContent: { schema_version: 1, id: args.compilation_id, operation_id: 'known_operation_id', version: 1, state: 'paused', request: { scope: { kind: 'project', project_id: 17 }, source_versions: [], topics: [] }, checkpoint: {}, revision_ids: {} } }
    } }
  } })
  ctx.reflect.provide('connection', { rpc: { handle: () => () => {} } })
  ctx.reflect.provide('webServer', { register: () => () => {} })
  apply(ctx)
  let disposed = false
  const dispose = async () => { if (disposed) return; disposed = true; await ctx.emateKnowledgeUi.dispose(); await ctx.emateKnowledgeRecovery.dispose(); await ctx.emateKnowledgeWorkflow.dispose(); await ctx.fiber.dispose() }
  t.after(dispose)
  return { ctx, workflow: ctx.emateKnowledgeWorkflow, dispose }
}

test('real apply keeps one native Xin capture per Host Agent across fresh executions and pause signals', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'knowledge-apply-'))
  const xin = { subject: 'xin-a', epoch: 1, captures: [], calls: [] }, run = await nativeApplyReview(t, root, xin)
  const agent = await run.workflow.openOperation({ provider: 'mock', model: 'mock-model' })
  const id = '11111111-1111-4111-8111-111111111111', scope = { kind: 'project', project_id: 17 }
  const cancelled = new AbortController()
  await run.workflow.status({ agent, signal: cancelled.signal }, id, scope)
  cancelled.abort()
  await run.workflow.status({ agent, signal: new AbortController().signal }, id, scope)
  assert.equal(xin.captures.length, 1)
  assert.equal(xin.captures[0].exec.signal, undefined)
  xin.subject = 'xin-b'; xin.epoch++
  await assert.rejects(run.workflow.status({ agent, signal: new AbortController().signal }, id, scope), { code: 'scope-changed' })
  assert.equal(xin.captures.length, 1)
  assert.equal(xin.calls.length, 2)
  t.after(() => rm(root, { recursive: true, force: true }))
})

test('real apply cold Session restoration must not prepare an old import under a different Xin subject', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'knowledge-apply-cold-'))
  const file = join(root, 'original.txt'); await writeFile(file, 'frozen original')
  const xin = { subject: 'xin-a', epoch: 1, captures: [], calls: [] }
  const first = await nativeApplyReview(t, root, xin)
  const agent = await first.workflow.openOperation({ provider: 'mock', model: 'mock-model' })
  const options = { operationId: 'frozen_import_operation', paths: [file], scope: { kind: 'project', project_id: 17 } }
  await assert.rejects(first.workflow.importFiles({ agent }, options), { code: 'not-found' })
  const sessionId = agent.id
  await first.dispose()
  xin.subject = 'xin-b'; xin.epoch++
  const second = await nativeApplyReview(t, root, xin)
  const restored = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock-model' } })
  t.after(() => restored.dispose())
  const error = await second.workflow.importFiles({ agent: restored.agent }, options).then(() => undefined, error => error)
  assert.equal(xin.calls.filter(call => call.bound === 'xin-b' && call.name === 'prepare_source_upload').length, 0, 'old import must issue zero prepare calls under a new Xin subject')
  assert.equal(error?.code, 'scope-changed')
  t.after(() => rm(root, { recursive: true, force: true }))
})


test('UI prepare freezes the original Xin subject before start without exposing its fingerprint', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'knowledge-prepare-binding-'))
  const file = join(root, 'original.txt'); await writeFile(file, 'frozen original')
  const xin = { subject: 'xin-a', epoch: 1, captures: [], calls: [] }, run = await nativeApplyReview(t, root, xin)
  const ui = run.ctx.emateKnowledgeUi
  const prepared = (await ui.call('ui.import.prepare', { paths: [file], scope: { kind: 'project', project_id: 17 } })).result
  const agent = run.ctx.agents.get(prepared.session_id)
  const marker = agent.session.events.find(event => event.type === 'knowledge/workflow' && event.data.kind === 'ui-import').data
  assert.equal(marker.xin_subject, createHash('sha256').update('xin-a').digest('hex'))
  assert.equal(xin.calls.length, 0)
  assert.doesNotMatch(JSON.stringify(prepared), /xin_subject|xinSubject|xin-a/)
  xin.subject = 'xin-b'; xin.epoch++
  const ref = { operation_id: prepared.operation_id, session_id: prepared.session_id }
  await ui.call('ui.import.start', ref)
  for (let i = 0; i < 50; i++) { const status = (await ui.call('ui.import.status', ref)).result; if (status.phase === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal((await ui.call('ui.import.status', ref)).result.phase, 'failed')
  assert.equal(xin.calls.length, 0)
  xin.subject = 'xin-a'; xin.epoch++
  await ui.call('ui.import.resume', ref)
  for (let i = 0; i < 50 && !xin.calls.some(call => call.name === 'prepare_source_upload'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(xin.calls.filter(call => call.name === 'prepare_source_upload' && call.bound === 'xin-a').length, 1)
  t.after(() => rm(root, { recursive: true, force: true }))
})

test('same-subject cold imports retain the original binding, while legacy missing bindings and revoked captures fail closed', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'knowledge-binding-recovery-'))
  const file = join(root, 'original.txt'); await writeFile(file, 'frozen original')
  const xin = { subject: 'xin-a', epoch: 1, captures: [], calls: [] }, first = await nativeApplyReview(t, root, xin)
  const agent = await first.workflow.openOperation({ provider: 'mock', model: 'mock-model' })
  const options = { operationId: 'stable_import_operation', paths: [file], scope: { kind: 'project', project_id: 17 } }
  await assert.rejects(first.workflow.importFiles({ agent }, options), { code: 'not-found' })
  const originalBatch = structuredClone(agent.session.events.find(event => event.type === 'knowledge/workflow' && event.data.kind === 'import-batch').data)
  const sessionId = agent.id; await first.dispose(); xin.epoch++
  const second = await nativeApplyReview(t, root, xin)
  const restored = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock-model' } }); t.after(() => restored.dispose())
  await assert.rejects(second.workflow.importFiles({ agent: restored.agent }, options), { code: 'not-found' })
  assert.equal(xin.calls.filter(call => call.name === 'prepare_source_upload').length, 2)
  xin.epoch++; xin.revoked = true
  await assert.rejects(second.workflow.importFiles({ agent: restored.agent }, options), { code: 'project-unavailable' })
  assert.equal(xin.calls.filter(call => call.name === 'prepare_source_upload').length, 2)
  const legacy = await second.workflow.openOperation({ provider: 'mock', model: 'mock-model' })
  delete originalBatch.xin_subject
  legacy.session.append('knowledge/workflow', originalBatch, { ignorable: true }); await second.ctx.sessions.flush(legacy.session)
  await assert.rejects(second.workflow.importFiles({ agent: legacy }, options), { code: 'xin-binding-missing' })
  assert.equal(xin.calls.filter(call => call.name === 'prepare_source_upload').length, 2)
  t.after(() => rm(root, { recursive: true, force: true }))
})
