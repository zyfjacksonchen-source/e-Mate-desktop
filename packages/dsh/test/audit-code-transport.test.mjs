import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Loader from '../../../upstream/deepseek-harness/vendor/loader/lib/index.js'
import Timer from '../../../upstream/deepseek-harness/vendor/timer/lib/index.js'
import SystemPrompt from '../../../upstream/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime, { defineTool } from '../../../upstream/deepseek-harness/packages/core/tools/lib/index.js'
import { SessionStore, SessionId } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import { createScope } from '../../../upstream/deepseek-harness/packages/core/scope/lib/index.js'
import { CallId, createAssistantMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import WorkerThreadCodeRuntime from '../../../upstream/deepseek-harness/packages/code-runtime/code-runtime-worker-thread/lib/index.js'
import * as Audit from '../profile/plugins/audit.js'

const NATIVE = new URL('../../../upstream/deepseek-harness/', import.meta.url)
const EVIDENCE = fileURLToPath(new URL('../../../work/audit-code-transport-0910/', import.meta.url))
const OFFICE_MODULE = '@e-mate/dsh-plugin-univer-office'
const OFFICE_TOOLS = [
  'univer_new', 'univer_status', 'univer_import', 'univer_api', 'univer_execute',
  'univer_unit', 'univer_worktree', 'univer_inspect', 'univer_export', 'univer_lint',
  'univer_compile_svg', 'univer_screenshot', 'univer_print_pdf', 'univer_resources',
]
const PRIVATE = 'private-customer-content'
const SUBJECT = 'audit-code-fixture-subject'
const digest = value => createHash('sha256').update(value).digest('hex')
const taskId = id => `task_${digest(`e-Mate task v1\0${digest(id)}:1`)}`

function fixtureTool(name) {
  return defineTool({
    name, description: 'Local audit classification fixture',
    parameters: { private_text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => PRIVATE,
  })
}

async function fixture(t, mode) {
  await mkdir(EVIDENCE, { recursive: true })
  const root = await mkdtemp(join(EVIDENCE, `fixture-${mode}-`))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime, { mode })
  await ctx.plugin(WorkerThreadCodeRuntime, { computeMs: 5_000, maxWallMs: 10_000 })

  // Real Loader entries own provenance. Only module import resolution and the
  // audited Tool body are local fixtures; no provenance/result events are mocked.
  const body = names => `import { defineTool } from ${JSON.stringify(new URL('packages/core/tools/lib/index.js', NATIVE).href)};\n`
    + `export const name = 'univer-tools'; export const inject = ['tools'];\n`
    + `export function apply(ctx) { for (const name of ${JSON.stringify(names)}) ctx.tools.register(defineTool({ name, description: 'Local audit fixture', parameters: { private_text: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => ${JSON.stringify(PRIVATE)} })); }\n`
  const packageRoot = join(root, 'node_modules', '@e-mate', 'dsh-plugin-univer-office')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: OFFICE_MODULE, type: 'module', exports: './index.mjs' }))
  await writeFile(join(packageRoot, 'index.mjs'), body(OFFICE_TOOLS))
  await writeFile(join(root, 'private-office.mjs'), body(['univer_new']))
  ctx.baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
  await ctx.plugin(Loader)
  const requireFixture = createRequire(ctx.baseUrl)
  ctx.loader.internal = { version: 'v2', import: async name => import(pathToFileURL(requireFixture.resolve(name)).href) }
  let officeEntry = await ctx.loader.create({ name: OFFICE_MODULE })
  await ctx.loader.await()
  ctx.tools.register(fixtureTool('unknown_fixture'))

  const usage = { bindings: new Map(), outbox: new Map() }
  const tasks = { bindings: new Map(), outbox: new Map() }
  let opened = 0
  let replaySession
  ctx.provide('connection', { rpc: { handle: () => () => {} } })
  ctx.provide('sessionPersistence', { list: async () => replaySession === undefined ? [] : [{ id: replaySession.id }], readFrom: async () => ({ events: replaySession?.events ?? [] }) })
  ctx.provide('storageDomain', { open: async () => {
    const tables = opened++ === 0 ? usage : tasks
    return { table: name => ({ entries: () => tables[name].entries(), put: async (key, value) => { tables[name].set(key, structuredClone(value)) } }), close: async () => {} }
  } })
  ctx.provide('emateIdentity', { localAccountSubject: () => SUBJECT })
  ctx.provide('emateModelPolicy', { markAuditDelivered: async () => {} })
  const binding = { schema_version: 1, product: 'e-Mate', version: '2.0.18', harness_commit: '78a2b98562185d6fe46f4071653cae61132bf1ea', dsh_home: root }
  for (const [key, path] of [
    ['tools_module', 'packages/core/tools/lib/index.js'],
    ['storage_domain_module', 'packages/storage/storage-domain/lib/index.js'],
    ['zod_module', 'packages/storage/storage-domain/node_modules/zod/index.js'],
  ]) {
    binding[key] = await realpath(fileURLToPath(new URL(path, NATIVE)))
    binding[`${key}_sha256`] = digest(await readFile(binding[key]))
  }
  const bindingPath = join(root, 'runtime-binding.json')
  await writeFile(bindingPath, JSON.stringify(binding))
  const auditConfig = { bindingPath, auditProvider: {}, taskAuditProvider: {}, flushIntervalMs: 30_000 }
  let auditFiber = await ctx.plugin(Audit, auditConfig)
  const results = []
  ctx.on('tools/result', exec => { results.push({ name: exec.name, callId: exec.callId, rootCallId: exec.rootCallId, nested: exec.parent !== undefined, provenance: ctx.tools.provenance(exec.name, exec.agent) }) })
  async function mintScope(key) {
    let scope
    await ctx.plugin({ name: 'audit-fixture-scope', inject: ['tools', 'sessions'], apply(inner) { scope = createScope(inner, key) } })
    return scope
  }
  let serial = 0
  async function run(names, transport, code) {
    const id = `${mode}-audit-${++serial}`
    const agent = { id: SessionId(id) }
    const scope = await mintScope(agent)
    agent.ctx = scope.ctx
    agent.session = scope.ctx.sessions.create(agent.id, { meta: { cwd: root } })
    const session = agent.session
    const firstResult = results.length
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const calls = transport === 'code' ? [{ name: 'run_code', arguments: {
      description: 'Local audit fixture',
      code: code ?? names.map(name => `await tools.${name}({ private_text: ${JSON.stringify(PRIVATE)} });`).join('\n'),
    } }] : names.map(name => ({ name, arguments: { private_text: PRIVATE } }))
    for (const [index, call] of calls.entries()) {
      const callId = CallId(`${id}-call-${index}`)
      session.append('tool/call', { turn: 1, step: 1, callId, name: call.name, arguments: JSON.stringify(call.arguments) })
      const result = await ctx.tools.execute({ ...call, callId, rootCallId: callId, agent, signal: new AbortController().signal })
      assert.equal(result.isError, false, JSON.stringify(result))
    }
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: PRIVATE }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.emateAudit.drain()
    const rows = [...tasks.outbox.values()].filter(row => row.payload.taskId === taskId(id))
    assert.deepEqual(rows.map(row => row.payload.type), ['RECEIVED', ...calls.map(() => 'TOOL_EXECUTION'), 'FIRST_RESPONSE', 'COMPLETED'])
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['account_subject_sha256', 'attempt_count', 'event_id', 'next_attempt_at', 'payload', 'payload_sha256', 'schema_version', 'source_seq', 'status'])
      assert.deepEqual(Object.keys(row.payload).sort(), ['eventId', 'occurredAt', 'scenario', 'schemaVersion', 'taskId', 'type'])
      assert.equal(row.account_subject_sha256, digest(SUBJECT))
      assert.equal(row.payload_sha256, digest(JSON.stringify(Object.fromEntries(Object.entries(row.payload).sort()))))
      assert.equal(row.schema_version, 1)
      assert.equal(row.status, 'pending')
      assert.equal(row.attempt_count, 0)
      assert.equal(row.event_id, row.payload.eventId)
      assert.match(row.event_id, /^taskevent_[0-9a-f]{64}$/u)
    }
    const serialized = JSON.stringify(rows)
    for (const secret of [PRIVATE, SUBJECT, id, ...names]) assert.equal(serialized.includes(secret), false, secret)
    return { agent, scope, rows, events: results.slice(firstResult) }
  }
  async function usePrivateOffice() {
    await ctx.loader.remove(officeEntry)
    officeEntry = await ctx.loader.create({ name: './private-office.mjs' })
    await ctx.loader.await()
  }
  async function restoreOffice() {
    await ctx.loader.remove(officeEntry)
    officeEntry = await ctx.loader.create({ name: OFFICE_MODULE })
    await ctx.loader.await()
  }
  async function replayLockedSession(session) {
    await auditFiber.dispose()
    opened = 0
    replaySession = session
    auditFiber = await ctx.plugin(Audit, auditConfig)
    await new Promise(resolve => setImmediate(resolve))
    await ctx.emateAudit.drain()
  }
  return { ctx, tasks, run, mintScope, usePrivateOffice, restoreOffice, replayLockedSession }
}

function classified(result, scenario) {
  assert.ok(result.rows.length >= 4)
  assert.ok(result.rows.every(row => row.payload.scenario === scenario), JSON.stringify(result.rows))
}

for (const mode of ['native', 'both', 'code']) {
  test(`native audit preserves trusted classifications through ${mode} presentation`, async t => {
    const f = await fixture(t, mode)
    const transports = mode === 'native' ? ['native'] : mode === 'both' ? ['native', 'code'] : ['code']
    assert.equal(f.ctx.tools.schemas().some(tool => tool.name === 'run_code'), mode !== 'native')
    assert.throws(() => f.ctx.tools.register(fixtureTool('run_code')), /reserved.*cannot be registered or shadowed/u)
    const reservedScope = await f.mintScope({})
    assert.throws(() => reservedScope.ctx.tools.register(fixtureTool('run_code')), /reserved.*cannot be registered or shadowed/u)
    await reservedScope.dispose()
    for (const transport of transports) {
      for (const name of OFFICE_TOOLS) {
        const result = await f.run([name], transport)
        classified(result, 'DOCUMENT_EDITING')
        const inner = result.events.find(event => event.name === name)
        assert.deepEqual(inner.provenance, { moduleSpecifier: OFFICE_MODULE, pluginName: 'univer-tools' })
        assert.equal(inner.nested, transport === 'code')
        if (transport === 'code') {
          assert.deepEqual(result.events.map(event => event.name), [name, 'run_code'])
          const root = result.events.at(-1)
          assert.equal(root.nested, false)
          assert.equal(root.provenance, undefined)
          assert.equal(inner.rootCallId, root.callId)
          assert.equal(result.agent.session.events.filter(event => event.type === 'tool/code-dispatch').length, 1)
        }
      }
      const unknown = await f.run(['unknown_fixture'], transport)
      classified(unknown, 'GENERAL')
      assert.equal(unknown.events.find(event => event.name === 'unknown_fixture').provenance, undefined)
      classified(await f.run(['univer_new', 'unknown_fixture'], transport), 'GENERAL')
    }
    if (mode !== 'native') {
      for (const code of ['', 'return 17 + 23;']) {
        const result = await f.run([], 'code', code)
        classified(result, 'GENERAL')
        assert.deepEqual(result.events.map(event => event.name), ['run_code'])
        assert.equal(result.events[0].provenance, undefined)
      }
    }
    await f.usePrivateOffice()
    const transport = transports.at(-1)
    const privateResult = await f.run(['univer_new'], transport)
    classified(privateResult, 'GENERAL')
    assert.deepEqual(privateResult.events.find(event => event.name === 'univer_new').provenance, { moduleSpecifier: './private-office.mjs', pluginName: 'univer-tools' })
    const historicalRows = structuredClone(privateResult.rows)
    await f.restoreOffice()
    await f.replayLockedSession(privateResult.agent.session)
    classified(await f.run(['univer_new'], transport), 'DOCUMENT_EDITING')
    assert.deepEqual([...f.tasks.outbox.values()].filter(row => row.payload.taskId === historicalRows[0].payload.taskId), historicalRows)
  })
}
