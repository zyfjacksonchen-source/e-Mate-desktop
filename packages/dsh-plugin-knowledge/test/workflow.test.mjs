import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Timer from '../../../upstream/deepseek-harness/vendor/timer/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../upstream/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../../../upstream/deepseek-harness/packages/core/agent-loop/lib/index.js'
import { installModelSelection } from '../../../upstream/deepseek-harness/packages/core/agent/lib/index.js'
import { LlmAdapter, createUserMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import SubagentRuntime from '../../../upstream/deepseek-harness/packages/subagent/subagent/lib/index.js'
import * as Spawn from '../../../upstream/deepseek-harness/packages/subagent/subagent-spawn-in-process/lib/index.js'
import LocalJobs from '../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'
import GoalService from '../../../upstream/deepseek-harness/packages/goal/goal/lib/index.js'
import Persistence from '../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import LocalFs from '../../../upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'
import { createKnowledgeWorkflow, recoverNativeClaims, normalizeCheckpoint } from '../src/workflow.ts'
import { collectOriginals, digest, events } from '../src/imports.ts'

// Captured from B 92b50d9 KnowledgeCheckpointData.model_validate({}).model_dump(mode='json').
const bCheckpointDefaults = { child_session_id: null, completed_units: [], message_id: null, session_id: null, unknown_submission: false }
const source = { source_id: '11111111-1111-4111-8111-111111111111', source_version: 'a'.repeat(64), parse_revision: 'b'.repeat(64) }
const claim = { kind: 'original_fact', text: '公开原文', citations: [{ ...source, chunk_id: 0, quote: '公开原文', quote_sha256: createHash('sha256').update('公开原文').digest('hex') }], benchmark_query_ids: [] }
const output = { claims: [{ ...claim, citations: claim.citations.map(({ quote_sha256, ...citation }) => citation) }] }
function toolChunks(id, name, args) {
  const json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class Adapter extends LlmAdapter {
  requests = []; script = []
  async resolveModel(provider, model) { return { provider, id: model, name: model, ...(this.reasoning ? { reasoning: this.reasoning } : {}) } }
  async *stream(request) {
    this.requests.push(request)
    const step = this.script.shift()
    if (!step) throw Error('No fixture model response')
    if (step === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise((resolve, reject) => { if (request.signal.aborted) reject(Error('aborted')); else request.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }) })
    } else for (const chunk of typeof step === 'function' ? step(request) : step) yield chunk
  }
}
function server() {
  let compilation; const revisions = new Map(); const calls = []; let lostCreate = false, lostCommit = false, lostClaim = false, lostCheckpoint = false, conflict = false, rejectedCitations = 0, unreachableCreates = 0
  const response = value => Response.json({ schema_version: 1, scope: { kind: 'enterprise-subject' }, ...structuredClone(value) })
  return { calls, revisions, get compilation() { return compilation }, loseCreate() { lostCreate = true }, loseCommit() { lostCommit = true }, loseLeaseReplies() { lostClaim = true; lostCheckpoint = true }, conflict() { conflict = true }, clearConflict() { conflict = false }, rejectCitationOnce() { rejectedCitations = 1 }, failCreates(count) { unreachableCreates = count },
    async request(url, init) {
      const path = url.pathname.split('/knowledge/v1')[1]; const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method: init.method, path, query: url.search, body })
      if (init.method === 'POST' && path === '/compilations') {
        if (unreachableCreates > 0) { unreachableCreates--; throw Error('POST never reached the service') }
        compilation = { id: randomUUID(), operation_id: body.operation_id, request: body, state: 'pending', version: 1, checkpoint: {}, revision_ids: Object.fromEntries(body.topics.map(topic => [topic.key, randomUUID()])), benchmark_evidence: [] }
        if (lostCreate) { lostCreate = false; throw Error('lost create response') }
        return response(compilation)
      }
      if (init.method === 'GET' && path.startsWith('/compilations')) return compilation ? response(compilation) : Response.json({ error: 'NOT_FOUND' }, { status: 404 })
      if (path.endsWith('/claim')) { assert.equal(body.expected_version, compilation.version); compilation.version++; compilation.state = 'running'; compilation.lease_token = 'c'.repeat(64); compilation.runner_id = body.runner_id; if (lostClaim) { lostClaim = false; throw Error('claim response lost') }; return response(compilation) }
      if (init.method === 'PATCH') {
        if (body.expected_version !== compilation.version) return Response.json({ error: 'LEASE_CONFLICT' }, { status: 409 })
        compilation.version++; compilation.state = body.state; compilation.checkpoint = { ...bCheckpointDefaults, ...body.checkpoint }; if (lostCheckpoint) { lostCheckpoint = false; throw Error('checkpoint response lost') }; return response(compilation)
      }
      if (path.endsWith('/chunks')) return response({ version: source, chunks: [{ chunk_id: 0, content: '公开原文', quote_sha256: claim.citations[0].quote_sha256 }], next_offset: null })
      if (path.startsWith('/revisions/')) {
        const id = path.split('/').at(-1)
        if (init.method === 'PUT') {
          if (rejectedCitations > 0) { rejectedCitations--; return Response.json({ error: 'INVALID_CITATION' }, { status: 400 }) }
          if (conflict) return Response.json({ error: 'REVISION_CONFLICT' }, { status: 409 })
          assert.equal(body.expected_version, compilation.version)
          assert.equal(body.markdown, body.claims.map(item => item.text).join('\n\n'))
          revisions.set(id, { revision_id: id, request_hash: digest({ topic_key: body.topic_key, markdown: body.markdown, claims: body.claims }), status: 'prepared' })
        }
        return revisions.has(id) ? response(revisions.get(id)) : Response.json({ error: 'NOT_FOUND' }, { status: 404 })
      }
      if (path.endsWith('/commit')) { assert.equal(body.expected_version, compilation.version); assert.equal(compilation.checkpoint.unknown_submission, false); compilation.state = 'committed'; compilation.version++; if (lostCommit) { lostCommit = false; throw Error('lost commit response') }; return response(compilation) }
      throw Error('unexpected route ' + init.method + ' ' + path)
    },
  }
}
async function runtime(t, backend = server(), root, dependencies = {}) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'emate-knowledge-runtime-'))
  if (!root) t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: directory, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime); await ctx.plugin(Spawn)
  await ctx.plugin(LocalJobs); ctx.jobs.attachController('knowledge-test')
  await ctx.plugin(GoalService); await ctx.plugin(LocalFs, { cwd: directory })
  const adapter = new Adapter(); ctx.llm.registerAdapter(['mock'], adapter)
  let principal = { tenantId: 'enterprise', userId: 'u1' }
  const identity = { localAccountPrincipal: () => principal, request: backend.request }
  ctx.reflect.provide('emateIdentity', identity)
  const workflow = createKnowledgeWorkflow(ctx, { installModelSelection, ...dependencies })
  const caller = await workflow.openOperation({ provider: 'mock', model: 'model' })
  let disposed = false
  const dispose = async () => { if (disposed) return; disposed = true; await workflow.dispose(); await ctx.fiber.dispose() }
  t.after(dispose)
  return { ctx, workflow, caller, adapter, backend, root: directory, dispose, changeAccount() { principal = { ...principal, userId: 'u2' }; workflow.changed() } }
}
const request = () => ({ operationId: randomUUID(), sourceVersions: [source], topics: [{ key: 'general', expected_revision_id: null }], model: { id: 'model', reasoning_effort: 'none' }, scope: { kind: 'public' } })
async function done(run, result) {
  const agent = run.ctx.agents.get(result.session_id)
  return run.ctx.jobs.wait(result.job_id, 5000, agent)
}

test('real native Session, spawn, Goal and Job compile only frozen public chunks and preserve lost create/commit receipts', async t => {
  const backend = server(); backend.loseCreate(); backend.loseCommit()
  const run = await runtime(t, backend)
  run.ctx.systemPrompt.context({ name: 'private-memory', order: 1, text: 'PRIVATE_MEMORY_MARKER' })
  run.ctx.systemPrompt.section({ name: 'private-persona', order: 1, text: 'PRIVATE_PERSONA_MARKER' })
  run.ctx.tools.register({ name: 'xin_private_read', description: 'PRIVATE_XIN_TOOL', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', properties: {} }, render: () => [] }, async execute() { throw Error('must never execute') } })
  run.caller.session.append('knowledge/workflow', { kind: 'private-history', text: 'PRIVATE_CHAT_MARKER' }, { ignorable: true })
  run.adapter.script.push(toolChunks('read', 'knowledge_frozen_source', { source_index: 0, offset: 0 }), toolChunks('result', 'structured_output', output))
  const result = await run.workflow.start({ agent: run.caller }, request())
  assert.equal((await done(run, result)).status, 'completed')
  assert.equal(backend.compilation.state, 'committed')
  assert.equal(backend.calls.filter(call => call.method === 'POST' && call.path === '/compilations').length, 1)
  assert(backend.calls.some(call => call.query.startsWith('?operation_id=')))
  assert.equal(run.adapter.requests.length, 2)
  for (const request of run.adapter.requests) {
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_(MEMORY|PERSONA|XIN|CHAT)_MARKER|lease_token|cccccccc/)
    assert.deepEqual(request.tools.map(tool => tool.name).sort(), ['knowledge_frozen_source', 'structured_output'])
  }
  assert.equal(run.ctx.goals.get(run.ctx.agents.get(result.session_id)).phase, 'complete')
  assert.deepEqual(await recoverNativeClaims(run.ctx, run.ctx.agents.get(result.session_id), result.compilation_id, 'general', digest({unused: true})), undefined)
  const owner = events(run.ctx.agents.get(result.session_id)).find(event => event.kind === 'compilation-session').owner
  assert.deepEqual(await recoverNativeClaims(run.ctx, run.ctx.agents.get(result.session_id), result.compilation_id, 'general', owner), { markdown: '公开原文', claims: [claim] })
  assert.doesNotMatch(JSON.stringify(result), /lease_token|cccccccc/)
})

test('model policy mismatch fails before a real native adapter stream and preserves a resumable compilation', async t => {
  const run = await runtime(t, server(), undefined, { installModelSelection(agentCtx, selection) { return installModelSelection(agentCtx, { ...selection, current: { ...selection.current, model: 'unexpected-model' } }) } })
  const input = request(); input.model.reasoning_effort = 'medium'
  const result = await run.workflow.start({ agent: run.caller }, input)
  assert.equal((await done(run, result)).status, 'failed')
  assert.equal(run.adapter.requests.length, 0)
  assert.equal(run.backend.compilation.state, 'paused')
  assert.equal(run.backend.compilation.checkpoint.unknown_submission, false)
})

test('native Job stop cancels the actual model stream; resume does not replay an unknown model request', async t => {
  const run = await runtime(t); run.adapter.script.push('hang')
  const result = await run.workflow.start({ agent: run.caller }, request())
  for (let i = 0; i < 100 && !run.adapter.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(run.adapter.requests.length, 1)
  await run.workflow.stop({ agent: run.caller }, result.compilation_id)
  assert.equal((await done(run, result)).status, 'killed')
  assert.equal(run.backend.compilation.checkpoint.unknown_submission, true)
  const resumed = await run.workflow.resume({ agent: run.caller }, result.compilation_id)
  assert.equal((await done(run, resumed)).status, 'failed')
  assert.equal(run.adapter.requests.length, 1)
})

test('a server CAS conflict retains durable structured output; new native runtime resumes the same compilation without generating again', async t => {
  const backend = server(); backend.conflict()
  const first = await runtime(t, backend); first.adapter.script.push(toolChunks('result', 'structured_output', output))
  const result = await first.workflow.start({ agent: first.caller }, request())
  assert.equal((await done(first, result)).status, 'failed')
  assert.equal(first.adapter.requests.length, 1)
  const id = result.compilation_id
  await first.dispose()
  backend.clearConflict()
  const second = await runtime(t, backend, first.root)
  const resumed = await second.workflow.resume({ agent: second.caller }, id)
  assert.equal((await done(second, resumed)).status, 'completed')
  assert.equal(second.adapter.requests.length, 0)
  assert.equal(backend.compilation.id, id)
})


test('project compilation uses only fixed Xin knowledge tools and supports native MCP text JSON results', async t => {
  const backend = server(); const names = []
  const route = {
    create_knowledge_compilation: args => ['POST', '/compilations', args.request],
    find_knowledge_compilation: args => ['GET', '/compilations?operation_id=' + args.operation_id],
    get_knowledge_compilation: args => ['GET', '/compilations/' + args.compilation_id],
    claim_knowledge_compilation: args => ['POST', '/compilations/' + args.compilation_id + '/claim', args.request],
    checkpoint_knowledge_compilation: args => ['PATCH', '/compilations/' + args.compilation_id, args.request],
    prepare_knowledge_revision: args => ['PUT', '/revisions/' + args.revision_id, args.request],
    get_knowledge_revision: args => ['GET', '/revisions/' + args.revision_id],
    commit_knowledge_compilation: args => ['POST', '/compilations/' + args.compilation_id + '/commit', args.request],
    read_knowledge_chunks: args => { assert.equal(args.project_id, 42); return ['GET', '/sources/' + args.version.source_id + '/chunks'] },
  }
  const run = await runtime(t, { request() { throw Error('project must not use enterprise public transport') } }, undefined, {
    async xinKnowledgeCall(name, args, exec, signal) {
      names.push(name); assert(exec.agent); signal?.throwIfAborted()
      const [method, path, body] = route[name](args)
      const response = await backend.request(new URL('https://local/knowledge/v1' + path), { method, body: body === undefined ? undefined : JSON.stringify(body) })
      let value = await response.json()
      if (!response.ok) value = { schema_version: 1, status: 'failed', error: value.error }
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    },
  })
  run.adapter.script.push(toolChunks('read', 'knowledge_frozen_source', { source_index: 0, offset: 0 }), toolChunks('result', 'structured_output', output))
  const result = await run.workflow.start({ agent: run.caller }, { ...request(), scope: { kind: 'project', project_id: 42 } })
  assert.equal((await done(run, result)).status, 'completed')
  assert.equal(backend.compilation.request.scope.project_id, 42)
  assert(names.includes('read_knowledge_chunks')); assert(names.includes('commit_knowledge_compilation'))
  assert.doesNotMatch(JSON.stringify(result), /lease_token/)
})

test('native filesystem import streams only original bytes to Host and requires matching explicit public action', async t => {
  const root = await mkdtemp(join(tmpdir(), 'emate-knowledge-files-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'folder'))
  const original = Buffer.from([0, 1, 255, 9]); await writeFile(join(root, 'folder', 'binary.pdf'), original)
  const requests = []; const imports = new Map()
  const backend = { async request(url, init) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    requests.push({ url: url.href, body, method: init.method })
    if (init.method === 'POST') {
      const value = { import_id: randomUUID(), operation_id: body.operation_id, status: 'awaiting_content', scope: body.scope, request_hash: digest({ ...body, provenance: body.provenance ?? null, supersedes: body.supersedes ?? null }), source: null }
      imports.set(value.import_id, value)
      return Response.json({ schema_version: 1, ...value })
    }
    const id = url.pathname.split('/').at(-2); const value = imports.get(id)
    assert.deepEqual(Buffer.from(body), original)
    value.status = 'parsing'; value.source = { id: source.source_id, file_hash: source.source_version }
    return Response.json({ schema_version: 1, ...value })
  } }
  const run = await runtime(t, backend, root)
  const paths = [join(root, 'folder')]
  const result = await run.workflow.importFiles({ agent: run.caller }, { paths, operationId: randomUUID() })
  assert.equal(result.scope.kind, 'uploader-private')
  assert.equal(requests[0].body.byte_length, 4)
  assert.equal(requests[1].method, 'PUT')
  assert.equal(run.adapter.requests.length, 0)
  const before = requests.length
  await assert.rejects(run.workflow.importFiles({ agent: run.caller }, { paths, operationId: randomUUID(), scope: { kind: 'public' }, publicIntentId: randomUUID() }), { code: 'public-intent-required' })
  assert.equal(requests.length, before)
  const intent = await run.workflow.recordPublicIntent(run.caller, paths)
  const publicResult = await run.workflow.importFiles({ agent: run.caller }, { paths, operationId: randomUUID(), scope: { kind: 'public' }, publicIntentId: intent })
  assert.equal(publicResult.scope.kind, 'public')
  assert.equal(requests[2].body.provenance.intent_receipt.kind, 'public_library_action')
  assert.doesNotMatch(JSON.stringify(run.caller.session.events), /\"(?:bytes|base64)\":/)
})

test('folder collection rejects escapes and oversized files before reading any original', async t => {
  const run = await runtime(t)
  await mkdir(join(run.root, 'selected')); await writeFile(join(run.root, 'outside.txt'), 'private')
  await symlink(join(run.root, 'outside.txt'), join(run.root, 'selected', 'escape.txt'))
  await assert.rejects(collectOriginals(run.ctx.fs, [join(run.root, 'selected')], undefined), { code: 'outside-source-folder' })
  const fs = { resolve: async () => ({ targetKey: 'huge' }), stat: async () => ({ type: 'file', size: 20 * 1024 * 1024 + 1 }) }
  await assert.rejects(collectOriginals(fs, ['large.pdf'], undefined), { code: 'file-too-large' })
})


test('project original upload uses the exact native ticket and queries the durable original after a lost response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'emate-project-files-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('project original'); const sha256 = createHash('sha256').update(bytes).digest('hex')
  const path = join(root, 'source.pdf'); await writeFile(path, bytes)
  const uploaded = { id: randomUUID(), file_hash: sha256, project_id: 42, status: 'parsing' }
  const calls = []; let complete = false
  const ticket = 'https://mvdcm.ecoremedia.net/business-assistant/api/uploads/' + 't'.repeat(43)
  const run = await runtime(t, { async request(url, init) { assert.equal(url.href, ticket); assert.equal(init.method, 'PUT'); assert.equal(init.headers.authorization, undefined); assert.deepEqual(Buffer.from(init.body), bytes); complete = true; throw Error('upload response lost') } }, root, {
    async xinKnowledgeCall(name, args) {
      calls.push({ name, args })
      if (name === 'find_imported_source') return complete ? { schema_version: 1, source: uploaded } : { schema_version: 1, status: 'failed', error: 'NOT_FOUND' }
      assert.equal(name, 'prepare_source_upload'); assert.equal(args.intent.project_id, 42)
      return { content: [{ type: 'text', text: JSON.stringify({ upload_url: ticket, method: 'PUT', sha256, size: bytes.length }) }] }
    },
  })
  const operationId = randomUUID()
  const result = await run.workflow.importFiles({ agent: run.caller }, { operationId, paths: [path], scope: { kind: 'project', project_id: 42 } })
  assert.deepEqual(result.sources, [uploaded])
  assert.equal(calls.filter(call => call.name === 'find_imported_source').length, 2)
  assert.equal(calls.filter(call => call.name === 'prepare_source_upload').length, 1)
  assert.deepEqual((await run.workflow.importsStatus({ agent: run.caller }, operationId, { kind: 'project', project_id: 42 })).sources, [uploaded])
  assert.doesNotMatch(JSON.stringify(run.caller.session.events), /api\/uploads|tttttttttt/)
  assert.equal(run.adapter.requests.length, 0)
})

test('account replacement cancels a running native compilation and does not send old lease checkpoints with new credentials', async t => {
  const run = await runtime(t); run.adapter.script.push('hang')
  const result = await run.workflow.start({ agent: run.caller }, request())
  for (let i = 0; i < 100 && !run.adapter.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(run.adapter.requests.length, 1)
  const before = run.backend.calls.length
  run.changeAccount()
  assert.equal((await done(run, result)).status, 'killed')
  assert.equal(run.backend.calls.length, before)
})


test('native model selection freezes medium thinking while preserving the enterprise request-policy waterfall', async t => {
  const run = await runtime(t)
  run.adapter.reasoning = { efforts: [{ id: 'medium', name: 'Medium' }] }
  const checked = []
  run.ctx.on('agent/request', async (_payload, next) => { const config = await next(); checked.push(config); return config })
  run.adapter.script.push(toolChunks('result', 'structured_output', output))
  const input = request(); input.model.reasoning_effort = 'medium'
  const result = await run.workflow.start({ agent: run.caller }, input)
  assert.equal((await done(run, result)).status, 'completed')
  assert.equal(run.adapter.requests[0].reasoningEffort, 'medium')
  assert(checked.some(config => config.model === 'model' && config.reasoningEffort === 'medium'))
})

test('simultaneous starts share one create request and one native Job; a different payload cannot reuse the operation ID', async t => {
  const run = await runtime(t); run.adapter.script.push(toolChunks('result', 'structured_output', output))
  const input = request()
  const [a, b] = await Promise.all([run.workflow.start({ agent: run.caller }, input), run.workflow.start({ agent: run.caller }, input)])
  assert.equal(a.job_id, b.job_id)
  assert.equal((await done(run, a)).status, 'completed')
  assert.equal(run.backend.calls.filter(call => call.method === 'POST' && call.path === '/compilations').length, 1)
  await assert.rejects(run.workflow.start({ agent: run.caller }, { ...input, topics: [{ key: 'other' }] }), { code: 'idempotency-conflict' })
  assert.equal(run.adapter.requests.length, 1)
})

test('natural-language public purpose is backed by the real current user message, not a model-supplied receipt', async t => {
  const run = await runtime(t)
  const parent = run.ctx.agentLoop.create(randomUUID(), { provider: 'mock', model: 'model' })
  let intent
  run.ctx.tools.register({ name: 'record_public_import', description: 'Record this requested public import.', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', properties: { id: { type: 'string' } } }, render: () => [] },
    async execute(_args, exec) { intent = await run.workflow.recordUserPublicIntent(exec, ['/files/source.pdf']); exec.concludeTurn(); return { id: intent } },
  })
  run.adapter.script.push(toolChunks('record', 'record_public_import', {}))
  const message = createUserMessage({ content: [{ type: 'text', text: '请把 /files/source.pdf 导入公共知识库' }], source: { kind: 'user' } })
  parent.followup(message); await parent.whenIdle()
  assert.equal(intent, message.id)
  assert.equal(events(parent).find(event => event.kind === 'public-intent').origin, 'user_message')
  const before = events(parent).length
  await assert.rejects(run.workflow.recordUserPublicIntent({ agent: parent, rootCallId: 'made-up-call' }, ['/files/private.pdf']), { code: 'scope-changed' })
  assert.equal(events(parent).length, before)
})

test('native timer renews the same compilation lease during a long model call and stops on cancellation', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const run = await runtime(t); run.adapter.script.push('hang')
  const result = await run.workflow.start({ agent: run.caller }, request())
  for (let i = 0; i < 100 && !run.adapter.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(run.adapter.requests.length, 1)
  const version = run.backend.compilation.version
  t.mock.timers.tick(45000)
  for (let i = 0; i < 100 && run.backend.compilation.version === version; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(run.backend.compilation.version, version + 1)
  assert.equal(run.backend.compilation.checkpoint.unknown_submission, true)
  assert.equal(run.adapter.requests.length, 1)
  await run.workflow.stop({ agent: run.caller }, result.compilation_id)
  const after = run.backend.calls.length
  t.mock.timers.tick(90000)
  await Promise.resolve()
  assert.equal(run.backend.calls.length, after)
})


test('unknown claim and checkpoint responses are read back without issuing a new claim or changing compilation', async t => {
  const backend = server(); backend.loseLeaseReplies()
  const run = await runtime(t, backend); run.adapter.script.push(toolChunks('result', 'structured_output', output))
  const result = await run.workflow.start({ agent: run.caller }, request())
  assert.equal((await done(run, result)).status, 'completed')
  assert.equal(backend.calls.filter(call => call.path.endsWith('/claim')).length, 1)
  assert(backend.calls.filter(call => call.method === 'GET' && call.path.startsWith('/compilations/')).length >= 2)
  assert.equal(run.adapter.requests.length, 1)
})


test('Host computes quote digests and corrects only a known rejected candidate once with the same frozen compilation/revision', async t => {
  const backend = server(); backend.rejectCitationOnce()
  const run = await runtime(t, backend)
  run.adapter.script.push(toolChunks('first', 'structured_output', output), request => {
    assert.match(JSON.stringify(request.messages), /上次引用被服务器明确拒绝/)
    return toolChunks('corrected', 'structured_output', output)
  })
  const result = await run.workflow.start({ agent: run.caller }, request())
  assert.equal((await done(run, result)).status, 'completed')
  const puts = backend.calls.filter(call => call.method === 'PUT' && call.path.startsWith('/revisions/'))
  assert.equal(puts.length, 2); assert.equal(puts[0].path, puts[1].path)
  assert.equal(puts[0].body.claims[0].citations[0].quote_sha256, claim.citations[0].quote_sha256)
  assert.equal(backend.calls.filter(call => call.path === '/compilations' && call.method === 'POST').length, 1)
  assert.equal(run.adapter.requests.length, 2)
})


test('checkpoint normalization matches the actual B Pydantic defaults and preserves populated native fields', () => {
  assert.deepEqual(normalizeCheckpoint({}), bCheckpointDefaults)
  assert.deepEqual(normalizeCheckpoint({ session_id: 'session', completed_units: [] }), { ...bCheckpointDefaults, session_id: 'session' })
  assert.deepEqual(normalizeCheckpoint({ session_id: 'session', child_session_id: 'child', completed_units: ['topic'], unknown_submission: true }), { ...bCheckpointDefaults, session_id: 'session', child_session_id: 'child', completed_units: ['topic'], unknown_submission: true })
})

test('negative/excluded files and ambiguous basenames never obtain public intent or trigger upload', async t => {
  const run = await runtime(t)
  const parent = run.ctx.agentLoop.create(randomUUID(), { provider: 'mock', model: 'model' })
  const rejected = []
  run.ctx.tools.register({ name: 'attempt_public_import', description: 'Attempt this file import.', parameters: { type: 'object', properties: { path: { type: 'string' } } }, output: { schema: { type: 'object', properties: { blocked: { type: 'boolean' } } }, render: () => [] },
    async execute(args, exec) {
      try { await run.workflow.importFiles(exec, { operationId: randomUUID(), paths: [args.path], scope: { kind: 'public' } }) }
      catch (error) { rejected.push(error); exec.concludeTurn(); return { blocked: true } }
      throw Error('must not authorize excluded file')
    },
  })
  for (const [text, path] of [
    ['请把public.pdf导入公共知识库，不要上传private.pdf', '/files/private.pdf'],
    ['请把public.pdf导入公共知识库，除了private.pdf', '/files/private.pdf'],
    ['请把/public/report.pdf导入公共知识库', '/private/report.pdf'],
    ['请把report.pdf导入公共知识库', '/ambiguous/report.pdf'],
  ]) {
    run.adapter.script.push(toolChunks(randomUUID(), 'attempt_public_import', { path }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); await parent.whenIdle()
  }
  assert.equal(rejected.length, 4)
  assert(rejected.every(error => error.code === 'public-intent-required' && error.message.includes('未执行导入')))
  assert.equal(events(parent).filter(event => event.kind === 'public-intent').length, 0)
  assert.equal(run.backend.calls.length, 0)
})

test('a persisted compilation intent recovers after POST never arrives and lookup returns a real 404', async t => {
  const backend = server(); backend.failCreates(2)
  const run = await runtime(t, backend); const input = request()
  await assert.rejects(run.workflow.start({ agent: run.caller }, input))
  assert.equal(run.adapter.requests.length, 0)
  assert.equal(backend.compilation, undefined)
  run.adapter.script.push(toolChunks('result', 'structured_output', output))
  const recovered = await run.workflow.start({ agent: run.caller }, input)
  assert.equal((await done(run, recovered)).status, 'completed')
  const creates = backend.calls.filter(call => call.method === 'POST' && call.path === '/compilations')
  assert.equal(creates.length, 3)
  assert(creates.every(call => digest(call.body) === digest(creates[0].body)))
  assert.equal(backend.calls[4].method, 'GET')
  assert.equal(run.adapter.requests.length, 1)
})

test('a persisted import intent retries only the same body after a real lookup miss and never treats 403/409/network lookup failures as missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'emate-import-recover-')); t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'original.pdf'); await writeFile(path, 'raw original')
  const calls = []; let remaining = 2, imported, denyLookup
  const backend = { async request(url, init) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    calls.push({ method: init.method, path: url.pathname, body })
    if (init.method === 'GET') {
      if (denyLookup === 'network') throw Error('lookup connection unavailable')
      if (denyLookup) return Response.json({ error: 'FORBIDDEN' }, { status: denyLookup })
      return imported ? Response.json({ schema_version: 1, ...imported }) : Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    }
    if (init.method === 'POST') {
      if (remaining-- > 0) throw Error('POST never reached server')
      imported = { import_id: randomUUID(), operation_id: body.operation_id, scope: body.scope, status: 'awaiting_content', request_hash: digest({ ...body, provenance: null, supersedes: null }), source: null }
    } else { imported.status = 'parsing'; imported.source = { id: source.source_id } }
    return Response.json({ schema_version: 1, ...imported })
  } }
  const run = await runtime(t, backend, root)
  const options = { paths: [path], operationId: randomUUID() }
  await assert.rejects(run.workflow.importFiles({ agent: run.caller }, options))
  for (const denied of [403, 409, 'network']) {
    denyLookup = denied; const before = calls.filter(call => call.method === 'POST').length
    await assert.rejects(run.workflow.importFiles({ agent: run.caller }, options))
    assert.equal(calls.filter(call => call.method === 'POST').length, before)
  }
  denyLookup = undefined
  assert.equal((await run.workflow.importFiles({ agent: run.caller }, options)).imports[0].status, 'parsing')
  const creates = calls.filter(call => call.method === 'POST')
  assert.equal(creates.length, 3)
  assert(creates.every(call => digest(call.body) === digest(creates[0].body)))
})
