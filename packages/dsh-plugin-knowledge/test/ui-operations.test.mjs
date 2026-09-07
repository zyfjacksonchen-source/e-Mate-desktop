import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Timer from '../../../upstream/deepseek-harness/vendor/timer/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../upstream/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../../../upstream/deepseek-harness/packages/core/agent-loop/lib/index.js'
import { installModelSelection } from '../../../upstream/deepseek-harness/packages/core/agent/lib/index.js'
import { LlmAdapter } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import Subagents from '../../../upstream/deepseek-harness/packages/subagent/subagent/lib/index.js'
import * as Spawn from '../../../upstream/deepseek-harness/packages/subagent/subagent-spawn-in-process/lib/index.js'
import Jobs from '../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'
import Goals from '../../../upstream/deepseek-harness/packages/goal/goal/lib/index.js'
import Persistence from '../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import Fs from '../../../upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'
import { createKnowledgeWorkflow } from '../src/workflow.ts'
import { createKnowledgeUiOperations } from '../src/ui-operations.ts'
import { digest, events, ownerOf } from '../src/imports.ts'
const hash = value => createHash('sha256').update(value).digest('hex')
function tool(id, name, args) { const text = JSON.stringify(args); return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }, { type: 'finish', reason: { kind: 'tool-calls' } }] }
class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    const result = request.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result')
    if (!result) { yield* tool('read', 'knowledge_frozen_source', { source_index: 0, offset: 0 }); return }
    const value = JSON.parse(result.content.find(block => block.type === 'text').text)
    assert(value.chunks[0].content)
    yield* tool('claims', 'structured_output', { claims: [{ kind: 'original_fact', text: value.chunks[0].content, citations: [{ ...value.version, chunk_id: 0, quote: value.chunks[0].content }], benchmark_query_ids: [] }] })
  }
}
function service() {
  const imports = new Map(), sources = new Map(), compilations = new Map(), revisions = new Map(), calls = []
  let bindingActive = true, parseState = 'ready', failNextUpload = false, library = [], truncated = false; const failedNames = new Set()
  const reply = value => Response.json({ schema_version: 1, scope: { kind: 'enterprise-subject' }, ...structuredClone(value) })
  const missing = () => Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  return { imports, sources, compilations, revisions, calls, setBindingActive(value) { bindingActive = value }, setParsing(value) { parseState = value; for (const source of sources.values()) source.status = value }, failUpload() { failNextUpload = true }, failParsing(name) { failedNames.add(name) }, setLibrary(items, partial = false) { library = items; truncated = partial },
    async request(url, init) {
      const path = url.pathname.split('/knowledge/v1')[1], body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
      calls.push({ path, method: init.method, body })
      if (path === '/catalog') return reply({ capabilities: ['graph-path-v1', 'import-source-ref-v1'] })
      if (path === '/imports' && init.method === 'POST') {
        let entry = [...imports.values()].find(value => value.request.operation_id === body.operation_id)
        if (!entry) { entry = { import_id: randomUUID(), request: body, operation_id: body.operation_id, request_hash: digest({ ...body, provenance: body.provenance ?? null, supersedes: body.supersedes ?? null }), scope: body.scope, status: 'awaiting_content', source: null, ...(body.graph_path ? { graph_binding_status: 'pending', graph_binding: null } : {}) }; imports.set(entry.import_id, entry) }
        return reply(entry)
      }
      if (path.startsWith('/imports')) {
        const entry = path === '/imports' ? [...imports.values()].find(value => value.operation_id === url.searchParams.get('operation_id')) : imports.get(path.split('/')[2])
        if (!entry) return missing()
        if (init.method === 'PUT') {
          if (failNextUpload) { failNextUpload = false; throw Error('upload unknown') }
          if (!entry.source) { const source = { id: randomUUID(), file_hash: hash(body), parse_revision: hash('parse:' + hash(body)), title: entry.request.title, filename: entry.request.filename, status: failedNames.has(entry.request.filename) ? 'error' : parseState, text: Buffer.from(body).toString('utf8') }; sources.set(source.id, source); entry.source = source }
        }
        if (entry.source) entry.status = entry.source.status
        if (entry.request.graph_path && entry.source?.status === 'ready' && bindingActive) {
          const { expected_binding, ...path } = entry.request.graph_path
          entry.graph_binding_status = 'active'; entry.graph_binding = { ...path, source_id: entry.source.id, source_version: entry.source.file_hash, parse_revision: entry.source.parse_revision, binding_revision: digest(path) }
        }
        return reply(entry)
      }
      if (path === '/compilations' && init.method === 'POST') {
        let value = [...compilations.values()].find(value => value.operation_id === body.operation_id)
        if (!value) { value = { id: randomUUID(), operation_id: body.operation_id, request: body, version: 1, state: 'pending', checkpoint: {}, revision_ids: Object.fromEntries(body.topics.map(topic => [topic.key, randomUUID()])), benchmark_evidence: [] }; compilations.set(value.id, value) }
        return reply(value)
      }
      if (path.startsWith('/compilations')) {
        const value = path === '/compilations' ? [...compilations.values()].find(value => value.operation_id === url.searchParams.get('operation_id')) : compilations.get(path.split('/')[2])
        if (!value) return missing()
        if (path.endsWith('/claim')) { assert.equal(body.expected_version, value.version); value.version++; value.state = 'running'; value.lease_token = 'a'.repeat(64); value.runner_id = body.runner_id }
        if (init.method === 'PATCH') { assert.equal(body.expected_version, value.version); value.version++; value.state = body.state; value.checkpoint = body.checkpoint }
        if (path.endsWith('/commit')) { assert.equal(body.expected_version, value.version); value.version++; value.state = 'committed' }
        return reply(value)
      }
      if (path.startsWith('/revisions/')) {
        const id = path.split('/')[2]
        if (init.method === 'PUT') { assert.equal(body.markdown, body.claims.map(claim => claim.text).join('\n\n')); revisions.set(id, { revision_id: id, request_hash: digest({ topic_key: body.topic_key, markdown: body.markdown, claims: body.claims }), status: 'prepared' }) }
        return revisions.has(id) ? reply(revisions.get(id)) : missing()
      }
      if (path.endsWith('/chunks')) { const source = sources.get(path.split('/')[2]); return reply({ version: { source_id: source.id, source_version: source.file_hash, parse_revision: source.parse_revision }, chunks: [{ chunk_id: 0, content: source.text }], next_offset: null }) }
      throw Error('unexpected ' + path)
    },
    async read({ endpoint, payload }) {
      if (endpoint === 'import') { const value = [...imports.values()].find(value => value.operation_id === payload.operation_id); if (!value) throw Object.assign(Error('missing'), { code: 'not-found' }); if (value.request.graph_path && value.source?.status === 'ready' && bindingActive) { const { expected_binding, ...path } = value.request.graph_path; value.graph_binding_status = 'active'; value.graph_binding = { ...path, source_id: value.source.id, source_version: value.source.file_hash, parse_revision: value.source.parse_revision, binding_revision: digest(path) } }; return { source: value.source, status: value.source?.status ?? value.status, ...(value.request.graph_path ? { graph_binding_status: value.graph_binding_status, graph_binding: value.graph_binding } : {}) } }
      if (endpoint === 'revisions') {
        const items = typeof library === 'function' ? library() : library, offset = payload.offset ?? 0
        return { schema_version: 1, scope: payload.scope, corpus_revision: digest(items), items: items.slice(offset, offset + payload.limit), truncated: truncated || items.length > offset + payload.limit, next_offset: items.length > offset + payload.limit ? offset + payload.limit : null }
      }
      if (endpoint === 'source') return { source: sources.get(payload.source_id) }
      if (endpoint === 'projects') return { items: [{ id: 42, title: '真实合同形状的项目', can_import: true }], complete: true }
      throw Error('unexpected read ' + endpoint)
    },
  }
}
async function harness(t, backend = service(), directory) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'emate-ui-import-'))
  const ctx = new Context(); await ctx.plugin(Timer); await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root, compression: 'none' }); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn); await ctx.plugin(Jobs); ctx.jobs.attachController('ui-import-tests'); await ctx.plugin(Goals); await ctx.plugin(Fs, { cwd: root })
  const adapter = new Adapter(); ctx.llm.registerAdapter(['mock'], adapter)
  let principal = { tenantId: 'fixture', userId: 'u1' }, ui
  const identity = { localAccountPrincipal: () => principal, request: backend.request }; ctx.reflect.provide('emateIdentity', identity)
  const selected = { provider: 'mock', model: 'model' }
  const workflow = createKnowledgeWorkflow(ctx, { installModelSelection, resolveSelection: async exec => ui?.selectionFor(exec.agent) ?? selected })
  ui = createKnowledgeUiOperations(ctx, { workflow, resolveSelection: async () => selected, read: async request => ({ scope_key: ownerOf(identity), result: await backend.read(request) }) })
  let disposed = false
  const dispose = async () => { if (disposed) return; disposed = true; await ui.dispose(); await workflow.dispose(); await ctx.fiber.dispose() }
  t.after(async () => { await dispose(); if (!directory) await rm(root, { recursive: true, force: true }) })
  return { root, ctx, ui, workflow, adapter, backend, dispose, changeOwner() { principal = { ...principal, userId: 'u2' }; ui.changed(); workflow.changed() } }
}
const ref = value => ({ operation_id: value.operation_id, session_id: value.session_id })
async function waitPhase(run, value, expected) {
  for (let i = 0; i < 200; i++) { const status = (await run.ui.call('ui.import.status', ref(value))).result; if (expected.includes(status.phase)) return status; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw Error('phase did not settle')
}

test('one UI operation performs real native import, parsing, model source reads and automatic compilation', async t => {
  const run = await harness(t); const path = join(run.root, 'method.txt'); await writeFile(path, '这是一条真实原文。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path], title: '整理方法' })).result
  assert.equal(prepared.phase, 'prepared'); assert.equal(run.backend.calls.length, 0)
  assert.equal(prepared.scope.kind, 'uploader-private')
  const responseController = new AbortController()
  const started = (await run.ui.call('ui.import.start', ref(prepared), responseController.signal)).result
  responseController.abort()
  const complete = await waitPhase(run, started, ['complete', 'partial'])
  assert.equal(complete.phase, 'complete'); assert.equal(complete.compiled_count, 1); assert.equal(complete.sources[0].status, 'ready')
  assert.equal(run.adapter.requests.length, 2)
  const compilation = [...run.backend.compilations.values()][0]
  assert.match(compilation.request.topics[0].key, /^source\/[a-f0-9-]{36}$/)
  assert.equal(compilation.request.topics[0].title, '整理方法')
  assert.equal(compilation.state, 'committed')
  assert.doesNotMatch(JSON.stringify(complete), /lease_token|provider|upload_url/)
})

test('public intent is created once and preserved across UI resume; stop differs from application pause', async t => {
  const backend = service(); backend.setParsing('parsing')
  const run = await harness(t, backend); const path = join(run.root, 'source.txt'); await writeFile(path, '公开原件。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path], scope: { kind: 'public' } })).result
  await run.ui.call('ui.import.start', ref(prepared)); await waitPhase(run, prepared, ['parsing'])
  const agent = run.ctx.agents.get(prepared.session_id)
  assert.equal(events(agent).filter(event => event.kind === 'public-intent').length, 1)
  await run.ui.call('ui.import.stop', ref(prepared))
  assert.equal((await run.ui.call('ui.import.status', ref(prepared))).result.phase, 'stopped')
  assert.equal(events(agent).filter(event => event.kind === 'ui-import-control' && event.action === 'stop').length, 1)
  backend.setParsing('ready')
  await run.ui.call('ui.import.resume', ref(prepared)); assert.equal((await waitPhase(run, prepared, ['complete', 'partial'])).phase, 'complete')
  assert.equal(events(agent).filter(event => event.kind === 'public-intent').length, 1)
})

test('restart restores original receipts and parsing work without another public intent or upload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'emate-ui-restart-')); const backend = service(); backend.setParsing('parsing')
  const first = await harness(t, backend, directory); const path = join(directory, 'source.txt'); await writeFile(path, '重启恢复原文。')
  const prepared = (await first.ui.call('ui.import.prepare', { paths: [path], scope: { kind: 'public' } })).result
  await first.ui.call('ui.import.start', ref(prepared)); await waitPhase(first, prepared, ['parsing']); await first.dispose()
  backend.setParsing('ready'); await rm(path)
  const second = await harness(t, backend, directory); t.after(() => rm(directory, { recursive: true, force: true }))
  await second.ui.recover()
  const complete = await waitPhase(second, prepared, ['complete', 'partial'])
  assert.equal(complete.phase, 'complete')
  assert.equal(backend.calls.filter(call => call.method === 'POST' && call.path === '/imports').length, 1)
  assert.equal(events(second.ctx.agents.get(prepared.session_id)).filter(event => event.kind === 'public-intent').length, 1)
})

test('unknown upload and partial parse failures do not become fake completed compilation', async t => {
  const backend = service(); backend.failUpload()
  const run = await harness(t, backend); const path = join(run.root, 'unknown.txt'); await writeFile(path, '保留原件。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
  await run.ui.call('ui.import.start', ref(prepared))
  assert.equal((await waitPhase(run, prepared, ['unknown', 'partial'])).phase, 'unknown')
  assert.equal(run.adapter.requests.length, 0)
  await run.ui.call('ui.import.resume', ref(prepared)); assert.equal((await waitPhase(run, prepared, ['complete', 'partial'])).phase, 'complete')
})

test('UI request boundary rejects caller identity/provider and cannot read an old account operation', async t => {
  const run = await harness(t); const path = join(run.root, 'source.txt'); await writeFile(path, '本机原件')
  for (const extra of [{ token: 'fake' }, { provider: 'fake' }, { tenant: 'fake' }, { user: 'fake' }]) await assert.rejects(run.ui.call('ui.import.prepare', { paths: [path], ...extra }), { code: 'invalid-request' })
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
  run.changeOwner()
  await assert.rejects(run.ui.call('ui.import.status', ref(prepared)), { code: 'scope-changed' })
  assert.deepEqual((await run.ui.call('ui.import.recent', {})).result.items, [])
})


test('partial parsing publishes only ready sources and preserves the failed original receipt', async t => {
  const backend = service(); backend.failParsing('failed.txt')
  const run = await harness(t, backend); const good = join(run.root, 'good.txt'), bad = join(run.root, 'failed.txt')
  await writeFile(good, '可用原文。'); await writeFile(bad, '暂时解析失败的原件。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [good, bad] })).result
  await run.ui.call('ui.import.start', ref(prepared))
  const result = await waitPhase(run, prepared, ['partial', 'complete'])
  assert.equal(result.phase, 'partial'); assert.equal(result.compiled_count, 1)
  assert.equal(result.sources.filter(source => source.status === 'failed').length, 1)
  assert.equal(backend.sources.size, 2)
  assert.equal([...backend.compilations.values()][0].request.source_versions.length, 1)
})

test('existing topics are reused by real source identity and revision, never by matching display title', async t => {
  const backend = service(); const revision = randomUUID()
  backend.setLibrary(() => {
    const source = [...backend.sources.values()][0]
    const version = { source_id: source.id, source_version: source.file_hash, parse_revision: source.parse_revision }
    return [{ topic_key: 'wiki/existing-method', title: '真实已有标题', revision_id: revision, source_versions: [version] },
      { topic_key: 'wiki/unrelated', title: source.title, revision_id: randomUUID(), source_versions: [{ ...version, source_id: randomUUID() }] }]
  })
  const run = await harness(t, backend); const path = join(run.root, 'same-name.txt'); await writeFile(path, '真实来源关系。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
  await run.ui.call('ui.import.start', ref(prepared)); assert.equal((await waitPhase(run, prepared, ['complete', 'partial'])).phase, 'complete')
  const topics = [...backend.compilations.values()][0].request.topics
  assert.deepEqual(topics, [{ key: 'wiki/existing-method', title: '真实已有标题', expected_revision_id: revision }])
})

test('over-limit folders fail before remote writes and report the batch limit rather than a large file', async t => {
  const run = await harness(t); const folder = join(run.root, 'many')
  const { mkdir } = await import('node:fs/promises'); await mkdir(folder)
  for (let i = 0; i < 101; i++) await writeFile(join(folder, i + '.txt'), 'small')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [folder] })).result
  await run.ui.call('ui.import.start', ref(prepared))
  const result = await waitPhase(run, prepared, ['failed', 'partial'])
  assert.equal(result.phase, 'failed'); assert.match(result.reason, /100份原件/)
  assert.equal(run.backend.calls.length, 0); assert.equal(run.adapter.requests.length, 0)
})

test('retrying a resolved parse failure must compile the newly ready source before complete', async t => {
  const backend = service(); backend.failParsing('bad.txt')
  const run = await harness(t, backend); const good = join(run.root, 'good.txt'), bad = join(run.root, 'bad.txt')
  await writeFile(good, '已成功解析的来源。'); await writeFile(bad, '随后恢复的来源。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [good, bad] })).result
  await run.ui.call('ui.import.start', ref(prepared))
  const partial = await waitPhase(run, prepared, ['partial'])
  assert.equal(partial.compiled_count, 1)
  backend.setParsing('ready')
  const second = (await run.ui.call('ui.import.resume', ref(prepared))).result
  if (second.job_id) await run.ctx.jobs.wait(second.job_id, 5000, run.ctx.agents.get(prepared.session_id))
  const resumed = (await run.ui.call('ui.import.status', ref(prepared))).result
  assert.equal(resumed.sources.filter(source => source.status === 'ready').length, 2)
  assert.equal(resumed.compiled_count, 2, 'must not report complete while the frozen old plan omits the recovered source')
  const plans = events(run.ctx.agents.get(prepared.session_id)).filter(event => event.kind === 'ui-import-plan').flatMap(event => event.plans)
  assert.equal(plans.length, 2); assert.equal(backend.compilations.size, 2)
  const operationIds = plans.map(plan => plan.operationId), requests = run.adapter.requests.length
  const third = (await run.ui.call('ui.import.resume', ref(prepared))).result
  if (third.job_id) await run.ctx.jobs.wait(third.job_id, 5000, run.ctx.agents.get(prepared.session_id))
  assert.equal((await run.ui.call('ui.import.status', ref(prepared))).result.phase, 'complete')
  assert.equal(run.adapter.requests.length, requests)
  assert.deepEqual(events(run.ctx.agents.get(prepared.session_id)).filter(event => event.kind === 'ui-import-plan').flatMap(event => event.plans.map(plan => plan.operationId)), operationIds)
  assert.equal(backend.calls.filter(call => call.path === '/compilations' && call.method === 'POST').length, 2)
})


test('resume keeps a frozen parse version conflict and never replaces its plan or model request', async t => {
  const run = await harness(t); const path = join(run.root, 'source.txt'); await writeFile(path, '原始冻结输入。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
  await run.ui.call('ui.import.start', ref(prepared)); await waitPhase(run, prepared, ['complete'])
  const before = events(run.ctx.agents.get(prepared.session_id)).filter(event => event.kind === 'ui-import-plan'), requests = run.adapter.requests.length
  ;[...run.backend.sources.values()][0].parse_revision = hash('different parser revision')
  await run.ui.call('ui.import.resume', ref(prepared))
  const result = await waitPhase(run, prepared, ['partial', 'unknown'])
  assert.equal(result.phase, 'partial'); assert.match(result.reason, /解析版本已变化/)
  assert.equal(run.adapter.requests.length, requests)
  assert.deepEqual(events(run.ctx.agents.get(prepared.session_id)).filter(event => event.kind === 'ui-import-plan'), before)
  assert.equal(run.backend.compilations.size, 1)
})

test('bounded recovery finds an older paused import behind more than twenty newer stopped UI rows', async t => {
  const backend = service(); backend.setParsing('parsing')
  const first = await harness(t, backend)
  const file = join(first.root, 'older-original.txt'); await writeFile(file, '应恢复的旧资料。')
  const older = (await first.ui.call('ui.import.prepare', { paths: [file] })).result
  await first.ui.call('ui.import.start', ref(older)); await waitPhase(first, older, ['parsing'])
  await first.dispose()
  const later = await harness(t, backend, first.root)
  for (let i = 0; i < 26; i++) {
    const newer = (await later.ui.call('ui.import.prepare', { paths: [file], title: '已停止 ' + i })).result
    await later.ui.call('ui.import.stop', ref(newer))
  }
  await later.dispose(); backend.setParsing('ready')
  const restored = await harness(t, backend, first.root)
  await restored.ui.call('ui.import.recent', {})
  const visible = (await restored.ui.call('ui.import.recent', {})).result
  assert.equal(visible.items.length, 20)
  assert.equal(visible.items.some(item => item.operation_id === older.operation_id), false)
  // A UI scan may already have cached the unchanged physical records. The
  // execution scan still needs to consider them, across its 24-record boundary.
  for (let i = 0; i < 4; i++) {
    const result = await restored.ui.recover()
    const active = restored.ctx.agents.list().flatMap(agent => restored.ctx.jobs.list(agent)).filter(job => job.kind === 'knowledge-import' && ['running', 'stopping'].includes(job.status))
    assert(active.length <= 1)
    if (!result.has_more) break
  }
  const completed = await waitPhase(restored, older, ['complete', 'partial'])
  assert.equal(completed.phase, 'complete')
  assert.equal(completed.compiled_count, 1)
  assert.equal(backend.calls.filter(call => call.path === '/imports' && call.method === 'POST').length, 1)
  await restored.dispose()
})


test('101 revision heads use frozen pages and recovered plan does not compile twice', async t => {
  const backend = service(), targetRevision = randomUUID()
  const heads = Array.from({ length: 100 }, (_, i) => ({ topic_key: 'other/' + i, revision_id: randomUUID(), source_versions: [] }))
  backend.setLibrary(() => {
    const source = [...backend.sources.values()][0]
    return [...heads, { topic_key: 'existing/page-101', revision_id: targetRevision, source_versions: [{ source_id: source.id, source_version: source.file_hash, parse_revision: source.parse_revision }] }]
  })
  const pages = [], read = backend.read
  backend.read = async request => { if (request.endpoint === 'revisions') pages.push(request.payload); return read(request) }
  const run = await harness(t, backend), path = join(run.root, 'paged.txt'); await writeFile(path, '分页后的原件。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
  await run.ui.call('ui.import.start', ref(prepared)); assert.equal((await waitPhase(run, prepared, ['complete', 'partial'])).phase, 'complete')
  assert.deepEqual(pages.map(page => page.offset), [0, 100]); assert.match(pages[1].corpus_revision, /^[a-f0-9]{64}$/)
  assert.deepEqual([...backend.compilations.values()][0].request.topics, [{ key: 'existing/page-101', expected_revision_id: targetRevision }])
  const requests = run.adapter.requests.length
  const resumed = (await run.ui.call('ui.import.resume', ref(prepared))).result
  if (resumed.job_id) await run.ctx.jobs.wait(resumed.job_id, 5000, run.ctx.agents.get(prepared.session_id))
  assert.equal(backend.compilations.size, 1); assert.equal(run.adapter.requests.length, requests); assert.equal(pages.length, 2)
})

test('changed snapshots, duplicate heads and nonadvancing pages stop before compilation', async t => {
  for (const failure of ['snapshot', 'topic', 'revision', 'offset', 'scope']) {
    const backend = service(), items = Array.from({ length: 101 }, (_, i) => ({ topic_key: 'topic/' + i, revision_id: randomUUID(), source_versions: [] }))
    backend.setLibrary(items)
    const read = backend.read, pages = []
    let run
    backend.read = async request => {
      const result = await read(request)
      if (request.endpoint !== 'revisions') return result
      pages.push(request.payload.offset)
      if (failure === 'offset') return { ...result, next_offset: 0 }
      if (!request.payload.offset) return result
      if (failure === 'snapshot') result.corpus_revision = hash('changed')
      if (failure === 'topic') result.items[0].topic_key = items[0].topic_key
      if (failure === 'revision') result.items[0].revision_id = items[0].revision_id
      if (failure === 'scope') result.scope = { kind: 'public' }
      return result
    }
    run = await harness(t, backend); const path = join(run.root, failure + '.txt'); await writeFile(path, '保留原件。')
    const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
    await run.ui.call('ui.import.start', ref(prepared)); await waitPhase(run, prepared, ['failed', 'partial', 'paused'])
    assert.equal(backend.compilations.size, 0); assert.equal(run.adapter.requests.length, 0)
    assert.deepEqual(pages, failure === 'offset' ? [0] : [0, 100])
  }
})


test('a failed continuation retains its snapshot across resume instead of silently switching libraries', async t => {
  const backend = service(), items = Array.from({ length: 101 }, (_, i) => ({ topic_key: 'topic/' + i, revision_id: randomUUID(), source_versions: [] }))
  backend.setLibrary(items)
  const read = backend.read, requests = []; let failPage = true
  backend.read = async request => {
    if (request.endpoint === 'revisions') {
      requests.push(structuredClone(request.payload))
      if (request.payload.offset && failPage) throw Error('temporary read failure')
    }
    return read(request)
  }
  const run = await harness(t, backend), path = join(run.root, 'snapshot.txt'); await writeFile(path, '保持原快照。')
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
  await run.ui.call('ui.import.start', ref(prepared)); await waitPhase(run, prepared, ['failed', 'partial'])
  const snapshot = requests[1].corpus_revision; assert.match(snapshot, /^[a-f0-9]{64}$/)
  failPage = false; backend.setLibrary([...items, { topic_key: 'changed', revision_id: randomUUID(), source_versions: [] }])
  const resumed = (await run.ui.call('ui.import.resume', ref(prepared))).result
  if (resumed.job_id) await run.ctx.jobs.wait(resumed.job_id, 5000, run.ctx.agents.get(prepared.session_id))
  assert.deepEqual(requests.map(request => request.offset), [0, 100, 0]); assert.equal(requests[2].corpus_revision, snapshot)
  assert.equal(backend.compilations.size, 0); assert.equal(run.adapter.requests.length, 0)
  assert.equal(events(run.ctx.agents.get(prepared.session_id)).filter(event => event.kind === 'ui-import-library-snapshot').length, 1)
})


test('stop and account switch during a continuation cannot start compilation', async t => {
  for (const action of ['stop', 'account']) {
    const backend = service(); backend.setLibrary(Array.from({ length: 101 }, (_, i) => ({ topic_key: 'topic/' + i, revision_id: randomUUID(), source_versions: [] })))
    let reached, release
    const arrived = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve }), read = backend.read
    backend.read = async request => { if (request.endpoint === 'revisions' && request.payload.offset) { reached(); await gate }; return read(request) }
    const run = await harness(t, backend), path = join(run.root, action + '.txt'); await writeFile(path, '停止分页。')
    const prepared = (await run.ui.call('ui.import.prepare', { paths: [path] })).result
    const started = (await run.ui.call('ui.import.start', ref(prepared))).result
    await arrived
    let stopping
    if (action === 'stop') stopping = run.ui.call('ui.import.stop', ref(prepared))
    else run.changeOwner()
    release()
    if (stopping) await stopping
    await run.ctx.jobs.wait(started.job_id, 5000, run.ctx.agents.get(prepared.session_id))
    assert.equal(backend.compilations.size, 0); assert.equal(run.adapter.requests.length, 0)
  }
})

test('UI recent scans cannot put background import and compilation recovery out of phase', async () => {
  const { createKnowledgeRecovery } = await import('../src/recovery.ts')
  const identity = { localAccountPrincipal: () => ({ tenantId: 'test', userId: 'test' }) }
  const snapshots = Array.from({ length: 50 }, (_, index) => ({ header: { id: String(index).padStart(8, '0') + '-0000-4000-a000-000000000000', createdAt: 50 - index }, revision: 'revision-1' }))
  let lists = 0, reads = 0
  const ctx = { get: () => identity, agents: { list: () => [], get: () => undefined }, jobs: { list: () => [] }, sessionPersistence: {
    async listSnapshots() { lists++; return structuredClone(snapshots) },
    async readFrom(id) { reads++; return { meta: { id }, events: [] } },
  } }
  const workflow = {}
  const ui = createKnowledgeUiOperations(ctx, { workflow, read: async () => { throw Error('Unexpected network') }, resolveSelection: async () => { throw Error('Unexpected model') } })
  const recovery = createKnowledgeRecovery(ctx, { workflow })
  try {
    await ui.call('ui.import.recent', {})
    const rounds = []
    for (let index = 0; index < 3; index++) {
      const imports = await ui.recover(), compilations = await recovery.scan()
      rounds.push([imports.has_more, compilations.has_more])
      // Exercise the user opening/refreshing the panel between every batch.
      if (index < 2) await ui.call('ui.import.recent', {})
    }
    assert.deepEqual(rounds, [[true, true], [true, true], [false, false]])
    assert.equal(lists, 5, 'one directory snapshot per recovery reader; UI recent lists independently')
    assert.equal(reads, 150)
  } finally { await ui.dispose(); await recovery.dispose() }
})


test('folder UI preserves namespace across repeated selection and restart, isolates account, and resumes frozen graph files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'emate-ui-graph-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const backend = service(); backend.setParsing('parsing')
  const folder = join(directory, '知识'); await mkdir(folder); await writeFile(join(folder, '原文.md'), '# 真实原件。')
  const first = await harness(t, backend, directory)
  const prepared = (await first.ui.call('ui.import.prepare', { paths: [folder] })).result
  const marker = events(first.ctx.agents.get(prepared.session_id)).find(event => event.kind === 'ui-import')
  const again = (await first.ui.call('ui.import.prepare', { paths: [folder] })).result
  assert.deepEqual(events(first.ctx.agents.get(again.session_id)).find(event => event.kind === 'ui-import').graph_root, marker.graph_root)
  await first.ui.call('ui.import.start', ref(prepared)); await waitPhase(first, prepared, ['parsing'])
  await first.dispose(); backend.setParsing('ready')
  const second = await harness(t, backend, directory)
  await second.ui.recover()
  const complete = await waitPhase(second, prepared, ['complete', 'partial'])
  assert.equal(complete.phase, 'complete'); assert.equal(complete.sources[0].graph_binding_status, 'active')
  const restored = events(second.ctx.agents.get(prepared.session_id)).find(event => event.kind === 'ui-import')
  assert.deepEqual(restored.graph_root, marker.graph_root)
  assert.equal(backend.calls.filter(call => call.path === '/imports' && call.method === 'POST').length, 1)
  const reselection = (await second.ui.call('ui.import.prepare', { paths: [folder] })).result
  assert.deepEqual(events(second.ctx.agents.get(reselection.session_id)).find(event => event.kind === 'ui-import').graph_root, marker.graph_root)
  const publicSelection = (await second.ui.call('ui.import.prepare', { paths: [folder], scope: { kind: 'public' } })).result
  assert.notEqual(events(second.ctx.agents.get(publicSelection.session_id)).find(event => event.kind === 'ui-import').graph_root.namespace_id, marker.graph_root.namespace_id)
  second.changeOwner()
  const other = (await second.ui.call('ui.import.prepare', { paths: [folder] })).result
  assert.notEqual(events(second.ctx.agents.get(other.session_id)).find(event => event.kind === 'ui-import').graph_root.namespace_id, marker.graph_root.namespace_id)
  const request = backend.calls.find(call => call.path === '/imports' && call.method === 'POST').body
  assert.equal(request.graph_path.relative_path, '原文.md'); assert(!JSON.stringify(request).includes(directory))
})

test('ready sources and committed Wiki remain partial while their graph binding is pending', async t => {
  const backend = service(); backend.setBindingActive(false)
  const run = await harness(t, backend), path = join(run.root, 'source.md'); await writeFile(path, '# 真实原文。')
  const graph_path = { namespace_id: randomUUID(), relative_path: '资料/source.md', layer: 'source', expected_binding: null }
  const prepared = (await run.ui.call('ui.import.prepare', { paths: [path], graph_files: [{ path, graph_path }] })).result
  await run.ui.call('ui.import.start', ref(prepared))
  const partial = await waitPhase(run, prepared, ['partial', 'complete'])
  assert.equal(partial.phase, 'partial'); assert.equal(partial.sources[0].status, 'ready'); assert.equal(partial.sources[0].graph_binding_status, 'pending'); assert.equal(partial.compiled_count, 1)
  backend.setBindingActive(true)
  await run.ui.call('ui.import.resume', ref(prepared))
  assert.equal((await waitPhase(run, prepared, ['complete'])).phase, 'complete')
  assert.equal(backend.calls.filter(call => call.path === '/imports' && call.method === 'POST').length, 1)
})
