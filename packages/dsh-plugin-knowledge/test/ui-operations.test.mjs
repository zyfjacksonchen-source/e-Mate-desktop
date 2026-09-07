import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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
  let parseState = 'ready', failNextUpload = false, library = [], truncated = false; const failedNames = new Set()
  const reply = value => Response.json({ schema_version: 1, scope: { kind: 'enterprise-subject' }, ...structuredClone(value) })
  const missing = () => Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  return { imports, sources, compilations, revisions, calls, setParsing(value) { parseState = value; for (const source of sources.values()) source.status = value }, failUpload() { failNextUpload = true }, failParsing(name) { failedNames.add(name) }, setLibrary(items, partial = false) { library = items; truncated = partial },
    async request(url, init) {
      const path = url.pathname.split('/knowledge/v1')[1], body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
      calls.push({ path, method: init.method, body })
      if (path === '/imports' && init.method === 'POST') {
        let entry = [...imports.values()].find(value => value.request.operation_id === body.operation_id)
        if (!entry) { entry = { import_id: randomUUID(), request: body, operation_id: body.operation_id, request_hash: digest({ ...body, provenance: body.provenance ?? null, supersedes: body.supersedes ?? null }), scope: body.scope, status: 'awaiting_content', source: null }; imports.set(entry.import_id, entry) }
        return reply(entry)
      }
      if (path.startsWith('/imports')) {
        const entry = path === '/imports' ? [...imports.values()].find(value => value.operation_id === url.searchParams.get('operation_id')) : imports.get(path.split('/')[2])
        if (!entry) return missing()
        if (init.method === 'PUT') {
          if (failNextUpload) { failNextUpload = false; throw Error('upload unknown') }
          if (!entry.source) { const source = { id: randomUUID(), file_hash: hash(body), parse_revision: hash('parse:' + hash(body)), title: entry.request.title, filename: entry.request.filename, status: failedNames.has(entry.request.filename) ? 'failed' : parseState, text: Buffer.from(body).toString('utf8') }; sources.set(source.id, source); entry.source = source }
        }
        if (entry.source) entry.status = entry.source.status
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
      if (endpoint === 'import') { const value = [...imports.values()].find(value => value.operation_id === payload.operation_id); if (!value) throw Object.assign(Error('missing'), { code: 'not-found' }); return { source: value.source, status: value.source?.status ?? value.status } }
      if (endpoint === 'revisions') return { items: typeof library === 'function' ? library() : library, truncated }
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
  await assert.rejects(run.ui.call('ui.import.status', ref(prepared)), { code: 'invalid-recovery-session' })
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
