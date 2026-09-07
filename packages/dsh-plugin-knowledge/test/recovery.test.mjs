import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Timer from '../../../upstream/deepseek-harness/vendor/timer/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../upstream/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../../../upstream/deepseek-harness/packages/core/agent-loop/lib/index.js'
import LocalJobs from '../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'
import GoalService from '../../../upstream/deepseek-harness/packages/goal/goal/lib/index.js'
import Persistence from '../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { LlmAdapter } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import { createKnowledgeWorkflow } from '../src/workflow.ts'
import { createKnowledgeRecovery } from '../src/recovery.ts'
import { digest } from '../src/imports.ts'

const owner = digest(['enterprise', 'employee'])
const selection = { provider: 'mock', model: 'fixture-model' }
const source = { source_id: randomUUID(), source_version: 'a'.repeat(64), parse_revision: 'b'.repeat(64) }
class NoModel extends LlmAdapter {
  requests = 0
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() { this.requests++; throw Error('Recovery discovery must never start a model') }
}
function backend() {
  const rows = new Map(), calls = []
  let gate
  return { rows, calls, setGate(value) { gate = value }, async request(url, init) {
    const path = url.pathname.split('/knowledge/v1')[1]
    const id = path.split('/')[2], row = rows.get(id)
    calls.push({ path, method: init.method })
    if (gate) await gate(path, init)
    if (path.startsWith('/revisions/') && [...rows.values()].some(value => Object.values(value.revision_ids).includes(id))) return Response.json({ schema_version: 1, scope: { kind: 'enterprise-subject' }, revision_id: id, status: 'prepared' })
    if (!row) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    if (path.endsWith('/claim')) { assert.equal(body.expected_version, row.version); row.version++; row.state = 'running'; row.lease_token = 'c'.repeat(64) }
    else if (path.endsWith('/commit')) { assert.equal(body.expected_version, row.version); row.version++; row.state = 'committed' }
    else if (init.method === 'PATCH') { assert.equal(body.expected_version, row.version); row.version++; row.state = body.state; row.checkpoint = body.checkpoint }
    return Response.json({ schema_version: 1, scope: { kind: 'enterprise-subject' }, ...structuredClone(row) })
  } }
}
async function runtime(t, directory, remote) {
  const ctx = new Context()
  await ctx.plugin(Timer); await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: directory, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(LocalJobs); ctx.jobs.attachController('knowledge-recovery-test')
  await ctx.plugin(GoalService)
  let principal = { tenantId: 'enterprise', userId: 'employee' }
  ctx.reflect.provide('emateIdentity', { localAccountPrincipal: () => principal, request: remote.request })
  const adapter = new NoModel(); ctx.llm.registerAdapter(['mock'], adapter)
  const workflow = createKnowledgeWorkflow(ctx)
  const recovery = createKnowledgeRecovery(ctx, { workflow })
  let disposed = false
  const close = async () => { if (disposed) return; disposed = true; await recovery.dispose(); await workflow.dispose(); await ctx.fiber.dispose() }
  t.after(close)
  return { ctx, workflow, recovery, adapter, close, signout() { principal = undefined; recovery.changed(); workflow.changed() } }
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'emate-knowledge-recovery-'))
  t.after(() => rm(path, { recursive: true, force: true })); return path
}
async function seed(run, remote, { identity = owner, controls = [], scope = { kind: 'public' }, withScope = true, caller = false, controlVersion = 1 } = {}) {
  const compilationId = randomUUID(), operationId = randomUUID(), revisionId = randomUUID()
  const handle = await run.ctx.agents.create({ sessionId: randomUUID(), agentOptions: selection })
  const session = handle.agent.session
  const append = data => session.append('knowledge/workflow', { schema_version: 1, owner: identity, compilationId, ...data }, { ignorable: true })
  if (caller) {
    append({ kind: 'compilation-request', operationId, selection, request: { scope } })
    append({ kind: 'compilation-receipt', operationId })
  } else append({ kind: 'compilation-session', selection, ...(controlVersion ? { controlVersion } : {}), ...(withScope ? { scope } : {}) })
  for (const data of controls) append(data)
  await run.ctx.sessions.flush(session)
  const sessionId = handle.agent.id
  await handle.dispose()
  remote.rows.set(compilationId, { id: compilationId, operation_id: operationId, version: 1, state: 'paused',
    request: { scope, model: { id: selection.model, reasoning_effort: 'none' }, source_versions: [source], topics: [{ key: 'topic' }] },
    checkpoint: { session_id: sessionId, child_session_id: null, message_id: null, completed_units: ['topic'], unknown_submission: false }, revision_ids: { topic: revisionId } })
  return { sessionId, compilationId, operationId }
}
async function waitJobs(run) {
  for (const agent of run.ctx.agents.list()) for (const job of run.ctx.jobs.list(agent)) if (job.kind === 'knowledge') await run.ctx.jobs.wait(job.id, 3000, agent)
}

test('cold native JSONL coordinator resumes the same compilation through real Agents, Goal and Job with no model replay', async t => {
  const path = await directory(t), remote = backend(), first = await runtime(t, path, remote)
  const saved = await seed(first, remote)
  await first.close()
  const run = await runtime(t, path, remote)
  assert.equal(run.ctx.agents.get(saved.sessionId), undefined)
  const result = await run.recovery.scan()
  assert.equal(result.recovered, 1)
  await waitJobs(run)
  assert.equal(remote.rows.get(saved.compilationId).state, 'committed')
  const physical = await run.ctx.sessionPersistence.readFrom(saved.sessionId, 0)
  assert(physical.events.some(event => event.data.kind === 'committed' && event.data.compilationId === saved.compilationId))
  assert.equal(run.adapter.requests, 0)
  assert.equal((await run.recovery.scan()).recovered, 0)
  assert.equal(run.recovery.recent()[0].state, 'committed')
  assert(!remote.calls.some(call => call.path === '/compilations' && call.method === 'POST'))
})

test('foreign owner, user stop, unknown physical submission and ordinary chat initiator never auto-resume', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  const foreign = await seed(run, remote, { identity: digest(['enterprise', 'other']) })
  const stopped = await seed(run, remote, { controls: [{ kind: 'user-stop' }, { kind: 'paused', unknownSubmission: false }] })
  const unknown = await seed(run, remote, { controls: [{ kind: 'model-submission', topicKey: 'topic', childSessionId: randomUUID() }] })
  const caller = await seed(run, remote, { caller: true })
  assert.equal((await run.recovery.scan()).recovered, 0)
  const recent = run.recovery.recent()
  assert.equal(recent.find(item => item.compilation_id === stopped.compilationId).state, 'stopped')
  assert.equal(recent.find(item => item.compilation_id === unknown.compilationId).state, 'unknown')
  assert(!recent.some(item => [foreign.compilationId, caller.compilationId].includes(item.compilation_id)))
  assert.equal(remote.calls.length, 0); assert.equal(run.ctx.agents.list().length, 0)
})

test('a canonical explicit resume overrides user stop; server unknown still blocks model/job launch', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  const saved = await seed(run, remote, { controls: [{ kind: 'user-stop' }, { kind: 'paused', unknownSubmission: false }, { kind: 'user-resume' }] })
  remote.rows.get(saved.compilationId).checkpoint.unknown_submission = true
  assert.equal((await run.recovery.scan()).recovered, 0)
  assert.equal(run.recovery.recent()[0].state, 'unknown')
  assert(!remote.calls.some(call => call.path.endsWith('/claim'))); assert.equal(run.adapter.requests, 0)
})

test('identity changes during status discard results and dispose the cold resumed owner', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  await seed(run, remote)
  remote.setGate(async () => run.signout())
  assert.equal((await run.recovery.scan()).recovered, 0)
  assert.deepEqual(run.recovery.recent(), [])
  assert.equal(run.ctx.agents.list().length, 0)
  assert(!remote.calls.some(call => call.path.endsWith('/claim')))
})

test('native completion plus a deferred next scan drains multiple compilations one Job at a time', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  await seed(run, remote); await seed(run, remote); await seed(run, remote)
  let finish, resolveEntered
  const entered = new Promise(resolve => { resolveEntered = resolve })
  remote.setGate(async path => { if (path.endsWith('/claim')) { resolveEntered(); await new Promise(resolve => { finish = resolve }) } })
  const scanned = run.recovery.scan(); await entered; await scanned
  assert.equal((await run.recovery.scan()).recovered, 0)
  assert.equal(remote.calls.filter(call => call.path.endsWith('/claim')).length, 1)
  const completed = new Promise(resolve => {
    let count = 0
    const stop = run.ctx.jobs.onJobDone(snapshot => {
      if (snapshot.kind !== 'knowledge') return
      if (++count === 3) { stop(); resolve() }
      else setImmediate(() => { void run.recovery.scan() })
    })
  })
  remote.setGate(undefined); finish()
  await completed
  assert.equal([...remote.rows.values()].filter(row => row.state === 'committed').length, 3)
  assert.equal(run.adapter.requests, 0)
})

test('read-only discovery is bounded, cancellation-aware and uses physical revisions without synthetic crash repair', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  for (let i = 0; i < 27; i++) await seed(run, remote, { controls: [{ kind: 'user-stop' }] })
  const before = await run.ctx.sessionPersistence.listSnapshots()
  const first = await run.recovery.scan()
  assert.equal(first.has_more, true); assert.equal(first.items.length, 24)
  assert.equal((await run.recovery.scan()).has_more, false)
  assert.equal(run.recovery.recent().length, 27)
  assert.deepEqual(await run.ctx.sessionPersistence.listSnapshots(), before)
  const abort = new AbortController(); abort.abort()
  assert.equal((await run.recovery.scan(abort.signal)).recovered, 0)
  assert.equal(remote.calls.length, 0)
})

test('a durable user stop arriving during server status wins over automatic recovery', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  const saved = await seed(run, remote)
  remote.setGate(async (_path, init) => {
    if (init.method !== 'GET') return
    remote.setGate(undefined)
    const agent = run.ctx.agents.get(saved.sessionId)
    agent.session.append('knowledge/workflow', { schema_version: 1, owner, kind: 'user-stop', compilationId: saved.compilationId }, { ignorable: true })
    await run.ctx.sessions.flush(agent.session)
  })
  assert.equal((await run.recovery.scan()).recovered, 0)
  assert.equal(run.recovery.recent()[0].state, 'stopped')
  assert(!remote.calls.some(call => call.path.endsWith('/claim')))
  assert.equal(run.ctx.agents.list().length, 0)
})

test('dispose cancels the native resumed Job and releases its owned Agent without recording a user stop', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  const saved = await seed(run, remote)
  let entered
  const started = new Promise(resolve => { entered = resolve })
  remote.setGate(async (path, init) => {
    if (!path.endsWith('/claim')) return
    entered()
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  })
  const pending = run.recovery.scan(); await started; await pending
  await run.recovery.dispose()
  assert.deepEqual(run.recovery.recent(), []); assert.equal(run.ctx.agents.list().length, 0)
  const stored = await run.ctx.sessionPersistence.readFrom(saved.sessionId, 0)
  assert(!stored.events.some(event => event.data.kind === 'user-stop'))
  assert.equal(run.adapter.requests, 0)
})


test('legacy paused coordinators without durable stop semantics stay unknown until explicit user resume', async t => {
  const path = await directory(t), remote = backend(), run = await runtime(t, path, remote)
  // Omit the new control marker rather than inventing why an old paused task stopped.
  const legacy = await seed(run, remote, { controlVersion: null, controls: [{ kind: 'paused', unknownSubmission: false }] })
  // A lost old pause response may leave the server running; local ambiguous stop still wins.
  remote.rows.get(legacy.compilationId).state = 'running'
  assert.equal((await run.recovery.scan()).recovered, 0)
  assert.equal(run.recovery.recent().find(item => item.compilation_id === legacy.compilationId).reason, 'legacy-pause-unknown')
  assert(!remote.calls.some(call => call.path.endsWith('/claim')))
})
