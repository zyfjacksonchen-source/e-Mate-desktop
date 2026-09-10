import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ToolSearch from '../lib/index.mjs'
import * as Schedule from '../../../upstream/deepseek-harness/packages/schedule/schedule/lib/index.js'
import SubagentRuntime from '../../../upstream/deepseek-harness/packages/subagent/subagent/lib/index.js'
import * as SpawnInProcess from '../../../upstream/deepseek-harness/packages/subagent/subagent-spawn-in-process/lib/index.js'

const { TOOL_SEARCH_NAME } = ToolSearch

const signal = new AbortController().signal
let ordinal = 0

function fixture(name, description) {
  return defineContentToolFixture({
    name,
    description,
    parameters: {},
    async execute() { return [{ type: 'text', text: `ran:${name}` }] },
  })
}

function toolCallResponse(id, name, args) {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super()
    this.script = script
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    const next = this.script.shift()
    if (next === undefined) throw new Error('script exhausted')
    for (const chunk of next(options)) yield chunk
  }
}

async function harness(config = {}, install = true) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const plugin = install ? await ctx.plugin(ToolSearch, config) : undefined
  return { ctx, plugin }
}

function createAgent(ctx, id) {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
}

async function execute(ctx, agent, name, args, parent) {
  ordinal += 1
  return await ctx.tools.execute({
    callId: CallId(`tool-search-${ordinal}`),
    name,
    arguments: args,
    agent,
    signal,
    ...(parent === undefined ? {} : { parent }),
  })
}

function names(ctx, agent) {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

test('keeps the upstream generation and edit tools visible with the accepted native search route', () => {
  const componentPatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const profilePatch = readFileSync(new URL('../../dsh/profile/cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(componentPatch, /^\s+- generate_image$/mu)
  assert.match(componentPatch, /^\s+- edit_image$/mu)
  assert.match(componentPatch, /generate_image:[\s\S]*批量生图[\s\S]*生成多张图片/u)
  assert.match(componentPatch, /^\s+- web_search$/mu)
  assert.doesNotMatch(componentPatch, /^\s+- imagen$/mu)
  assert.doesNotMatch(componentPatch, /gpt-responses|allowInsecureHttp|43\.135\.183\.53|emate-web-search-gpt/u)
  assert.match(profilePatch, /searchProvider: deepseek-official/u)
  assert.match(profilePatch, /id: web-search-deepseek[\s\S]*disabled: false/u)
  assert.match(profilePatch, /apiKeyEnv: E_MATE_SEARCH_KEY_DEEPSEEK/u)
  assert.match(profilePatch, /baseURL: https:\/\/api\.deepseek\.com\/anthropic\/v1/u)
  assert.match(profilePatch, /model: deepseek-v4-flash/u)
})

class PersistenceProbe extends Service {
  constructor(ctx) { super(ctx, 'sessionPersistence') }
}

test('keeps pinned Schedule tools Agent-local and executes them through the native definitions', async (t) => {
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Schedule)
  await ctx.plugin(ToolSearch, { maxResults: 5 })
  const agent = createAgent(ctx, 'schedule-disclosure')

  assert.deepEqual(names(ctx, agent), ['schedule_create', 'schedule_delete', 'schedule_list'])
  const created = await execute(ctx, agent, 'schedule_create', { prompt: '生成日报', after_seconds: 3600 })
  assert.equal(created.isError, false)
  assert.equal(created.value.prompt, '生成日报')
  const listed = await execute(ctx, agent, 'schedule_list', {})
  assert.deepEqual(listed.value, [created.value])
  const deleted = await execute(ctx, agent, 'schedule_delete', { id: created.value.id })
  assert.deepEqual(deleted.value, { id: created.value.id, deleted: true })
  assert.deepEqual((await execute(ctx, agent, 'schedule_list', {})).value, [])
  assert.deepEqual(names(ctx, agent), ['schedule_create', 'schedule_delete', 'schedule_list'])
})

test('restores a Schedule request header without restricting Agent-local tool names', async (t) => {
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Schedule)
  const agent = createAgent(ctx, 'schedule-restore')
  agent.session.append('request/header', {
    header: {
      config: { provider: 'mock', model: 'mock' },
      tools: [
        ...ctx.tools.schemas(agent),
        { name: TOOL_SEARCH_NAME, description: 'Search tools', parameters: { type: 'object', properties: {} } },
      ],
    },
    reason: 'initial',
  })

  await ctx.plugin(ToolSearch, { maxResults: 5 })

  assert.deepEqual(names(ctx, agent), ['schedule_create', 'schedule_delete', 'schedule_list'])
  assert.deepEqual((await execute(ctx, agent, 'schedule_list', {})).value, [])
})

test('keeps Schedule tools visible when Tool Search registers first', async (t) => {
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolSearch, { maxResults: 5 })
  await ctx.plugin(Schedule)
  const agent = createAgent(ctx, 'schedule-late-registration')

  assert.deepEqual(names(ctx, agent), ['schedule_create', 'schedule_delete', 'schedule_list'])
  assert.deepEqual((await execute(ctx, agent, 'schedule_list', {})).value, [])
})

test('discloses deferred native tools without replacing their execution path', async (t) => {
  const { ctx } = await harness({ alwaysVisible: ['read_*'], maxResults: 2 })
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('read_file', 'Read a local file'))
  ctx.tools.register(fixture('browser_navigate', 'Navigate the current webpage'))
  ctx.tools.register(fixture('office_write', 'Create an office document'))
  const agent = createAgent(ctx, 'native-disclosure')

  assert.deepEqual(names(ctx, agent), ['read_file', TOOL_SEARCH_NAME])
  assert.equal((await execute(ctx, agent, 'office_write', {})).isError, true)
  const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { query: 'office document', limit: 1 })
  assert.deepEqual(found.value.tools, [{ name: 'office_write', status: 'loaded' }])
  assert.deepEqual(names(ctx, agent), ['office_write', 'read_file', TOOL_SEARCH_NAME])
  assert.equal((await execute(ctx, agent, 'office_write', {})).isError, false)
  assert.equal(agent.session.events.some(event => event.type === 'tool-search/selection'), false)
})

test('keeps the rc.7 native web_search definition directly visible', async (t) => {
  const { ctx } = await harness({ alwaysVisible: ['web_search'] })
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('web_search', 'Search the public web'))
  ctx.tools.register(fixture('long_tail_probe', 'Deferred external capability'))
  const agent = createAgent(ctx, 'native-search')

  assert.deepEqual(names(ctx, agent), [TOOL_SEARCH_NAME, 'web_search'])
  assert.equal((await execute(ctx, agent, 'web_search', { query: 'e-Mate' })).isError, false)
})

test('uses bounded CJK aliases without changing the initial header or adding a plugin-owned query event', async (t) => {
  const config = {
    maxResults: 1,
    searchAliases: {
      image_batch: ['批量生图', '多图生成', '生成多张图片', '一组配图'],
      imagegen: ['生图', '生成封面', '内页图片', '把图片中', '图片编辑'],
    },
  }
  const { ctx } = await harness(config)
  t.after(async () => ctx.fiber.dispose())
  const { ctx: baselineCtx } = await harness({ maxResults: 1 })
  t.after(async () => baselineCtx.fiber.dispose())
  ctx.tools.register(fixture('image_batch', 'Generate several independent new images'))
  ctx.tools.register(fixture('imagegen', 'Generate or edit one image'))
  ctx.tools.register(fixture('image_metadata', 'Inspect image metadata and error logs'))
  baselineCtx.tools.register(fixture('imagegen', 'Generate or edit one image'))
  baselineCtx.tools.register(fixture('image_metadata', 'Inspect image metadata and error logs'))
  const agent = createAgent(ctx, 'cjk-image-disclosure')
  const baselineAgent = createAgent(baselineCtx, 'baseline-image-disclosure')
  const initialHeader = JSON.stringify(ctx.tools.schemas(agent))

  assert.deepEqual(names(ctx, agent), [TOOL_SEARCH_NAME])
  assert.equal(initialHeader, JSON.stringify(baselineCtx.tools.schemas(baselineAgent)))
  assert.equal(initialHeader.includes('image_batch'), false)
  assert.equal(initialHeader.includes('批量生图'), false)
  const generation = await execute(ctx, agent, TOOL_SEARCH_NAME, { query: '批量生图六张' })
  assert.deepEqual(generation.value.tools, [{ name: 'image_batch', status: 'loaded' }])
  assert.equal(agent.session.events.some(event => JSON.stringify(event).includes('批量生图六张')), false)
})

test('CJK image aliases find an edit but do not recall imagegen for diagnostics', async (t) => {
  const { ctx } = await harness({
    maxResults: 2,
    searchAliases: { imagegen: ['改图', '把图中', '把图上', '把图片中', '图片编辑'] },
  })
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('imagegen', 'Generate or edit one image'))
  ctx.tools.register(fixture('image_metadata', 'Inspect image metadata and error logs'))
  const editAgent = createAgent(ctx, 'cjk-image-edit')
  const edit = await execute(ctx, editAgent, TOOL_SEARCH_NAME, { query: '把图中3处武汉全部改成成都' })
  assert.deepEqual(edit.value.tools, [{ name: 'imagegen', status: 'loaded' }])

  const diagnosticAgent = createAgent(ctx, 'cjk-image-negative')
  const diagnostic = await execute(ctx, diagnosticAgent, TOOL_SEARCH_NAME, { query: '检查图片元数据和错误日志' })
  assert.equal(diagnostic.value.tools.some(tool => tool.name === 'imagegen'), false)
  assert.deepEqual(names(ctx, diagnosticAgent), [TOOL_SEARCH_NAME])
})

test('a real pinned spawn child receives the first-party image tool without discovery', async (t) => {
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  const executed = []
  ctx.tools.register(defineContentToolFixture({
    name: 'imagegen',
    description: 'Generate or edit one image',
    parameters: { prompt: { type: 'string', required: true } },
    async execute(args) {
      executed.push(args)
      return [{ type: 'text', text: 'image receipt committed' }]
    },
  }))
  ctx.tools.register(fixture('unrelated_write', 'Write unrelated data'))
  await ctx.plugin(ToolSearch, { alwaysVisible: ['imagegen'], maxResults: 1 })
  const leafArgs = { prompt: 'Generate exactly one leaf image.' }
  const leafPrompt = 'Call imagegen exactly once and do not call tool_search or any other tool.'
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
    (request) => {
      assert.match(JSON.stringify(request.messages), /imagegen.*tool_search/u)
      assert.deepEqual(request.tools.map(tool => tool.name), ['imagegen'])
      return toolCallResponse('leaf-image', 'imagegen', leafArgs)
    },
    request => {
      assert.deepEqual(request.tools.map(tool => tool.name), ['imagegen'])
      return textResponse('leaf complete')
    },
  ]))
  const parent = createAgent(ctx, 'image-leaf-parent')
  const run = await ctx.subagents.start('spawn', {
    label: 'e-mate:image-leaf:test',
    prompt: [{ type: 'text', text: leafPrompt }],
    parent,
    agentOptions: { provider: 'mock', model: 'mock' },
    toolFilter: { allow: ['imagegen'] },
    persona: 'Execute exactly one image leaf.',
    signal,
  })

  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(executed, [leafArgs])
  assert.deepEqual(names(ctx, run.localAgent), ['imagegen'])
  const searchCall = run.localAgent.session.events.find(event => event.type === 'tool/call'
    && event.data.name === TOOL_SEARCH_NAME)
  assert.equal(searchCall, undefined)
  assert.equal(run.localAgent.session.events.some(event => event.type === 'tool-search/selection'), false)
  assert.equal((await execute(ctx, run.localAgent, 'unrelated_write', {})).isError, true)
  await run.dispose()
})

test('restores only a post-plugin request/header and never mistakes a legacy full catalog for a selection', async (t) => {
  const { ctx } = await harness({}, false)
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('read_file', 'Read a local file'))
  ctx.tools.register(fixture('office_write', 'Create an office document'))
  const restored = createAgent(ctx, 'restored')
  restored.session.append('request/header', {
    header: {
      config: { provider: 'mock', model: 'mock' },
      tools: [
        { name: TOOL_SEARCH_NAME, description: 'Search tools', parameters: { type: 'object', properties: {} } },
        { name: 'office_write', description: 'Create an office document', parameters: { type: 'object', properties: {} } },
      ],
    },
    reason: 'initial',
  })
  const legacy = createAgent(ctx, 'legacy')
  legacy.session.append('request/header', {
    header: {
      config: { provider: 'mock', model: 'mock' },
      tools: [
        { name: 'read_file', description: 'Read a local file', parameters: { type: 'object', properties: {} } },
        { name: 'office_write', description: 'Create an office document', parameters: { type: 'object', properties: {} } },
      ],
    },
    reason: 'initial',
  })
  await ctx.plugin(ToolSearch, { alwaysVisible: ['read_*'] })

  assert.deepEqual(names(ctx, restored), ['office_write', 'read_file', TOOL_SEARCH_NAME])
  assert.deepEqual(names(ctx, legacy), ['read_file', TOOL_SEARCH_NAME])
  ctx.tools.register(fixture('late_probe', 'Late external capability'))
  assert.deepEqual(names(ctx, restored), ['office_write', 'read_file', TOOL_SEARCH_NAME])
  assert.deepEqual(names(ctx, legacy), ['read_file', TOOL_SEARCH_NAME])
})

test('intersects with an existing per-agent restriction and does not disclose its denied schema', async (t) => {
  const { ctx } = await harness()
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('public_lookup', 'Find public records'))
  ctx.tools.register(fixture('secret_lookup', 'Find private records'))
  const handle = await ctx.agents.create({
    sessionId: SessionId('restricted'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup(agentCtx) { agentCtx.tools.restrict({ deny: ['secret_lookup'] }) },
  })

  const result = await execute(ctx, handle.agent, TOOL_SEARCH_NAME, { query: 'private secret' })
  assert.deepEqual(result.value.tools, [])
  assert.deepEqual(names(ctx, handle.agent), [TOOL_SEARCH_NAME])
  await handle.dispose()
})

test('same-named Agent-local tools stay outside the global catalog and restriction', async (t) => {
  const { ctx } = await harness()
  t.after(async () => ctx.fiber.dispose())
  const createLocal = id => ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup(agentCtx) { agentCtx.tools.register(fixture('agent_status', `Status for ${id}`)) },
  })
  const left = await createLocal('local-left')
  const right = await createLocal('local-right')

  for (const handle of [left, right]) {
    assert.deepEqual(names(ctx, handle.agent), ['agent_status'])
    assert.equal((await execute(ctx, handle.agent, TOOL_SEARCH_NAME, { query: 'agent status' })).isError, true)
    assert.equal((await execute(ctx, handle.agent, 'agent_status', {})).isError, false)
  }
  await left.dispose()
  await right.dispose()
})

test('keeps native tools usable when progressive restriction cannot be installed', async (t) => {
  const { ctx } = await harness({}, false)
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('native_probe', 'Native capability'))
  await ctx.plugin(ToolSearch)

  const handle = await ctx.agents.create({
    sessionId: SessionId('restriction-failure'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup(agentCtx) {
      agentCtx.tools.restrict = () => { throw new Error('simulated stale allow list') }
    },
  })

  assert.deepEqual(names(ctx, handle.agent), ['native_probe'])
  assert.equal((await execute(ctx, handle.agent, 'native_probe', {})).isError, false)
  await handle.dispose()
})

test('an unknown-global tools/change race restores the native surface without blocking registration', async (t) => {
  const { ctx } = await harness({}, false)
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('native_probe', 'Native capability'))
  const agent = createAgent(ctx, 'tools-change-failure')
  await ctx.plugin(ToolSearch)
  assert.deepEqual(names(ctx, agent), [TOOL_SEARCH_NAME])

  agent.ctx.tools.restrict = () => { throw new Error('tools.restrict() names unknown global tool "late_probe"') }
  assert.doesNotThrow(() => ctx.tools.register(fixture('late_probe', 'Late native capability')))
  assert.deepEqual(names(ctx, agent), ['late_probe', 'native_probe'])
  assert.equal((await execute(ctx, agent, 'late_probe', {})).isError, false)
})

test('rebuilds from the real inherited view and preserves selected eligible globals', async (t) => {
  const { ctx } = await harness()
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('first_probe', 'First capability'))
  const agent = createAgent(ctx, 'late-tool')
  assert.deepEqual((await execute(ctx, agent, TOOL_SEARCH_NAME, { query: 'first capability' })).value.tools, [
    { name: 'first_probe', status: 'loaded' },
  ])
  ctx.tools.register(fixture('late_probe', 'Late external capability'))

  assert.deepEqual(names(ctx, agent), ['first_probe', TOOL_SEARCH_NAME])
  const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { query: 'late external' })
  assert.deepEqual(found.value.tools, [{ name: 'late_probe', status: 'loaded' }])
  assert.deepEqual(names(ctx, agent), ['first_probe', 'late_probe', TOOL_SEARCH_NAME])
})

test('rebuild drops removed selections instead of reviving them after re-registration', async (t) => {
  const { ctx } = await harness()
  t.after(async () => ctx.fiber.dispose())
  const remove = ctx.tools.register(fixture('ephemeral_probe', 'Ephemeral capability'))
  const agent = createAgent(ctx, 'removed-tool')
  await execute(ctx, agent, TOOL_SEARCH_NAME, { query: 'ephemeral capability' })
  assert.deepEqual(names(ctx, agent), ['ephemeral_probe', TOOL_SEARCH_NAME])

  remove()
  assert.deepEqual(names(ctx, agent), [])
  ctx.tools.register(fixture('ephemeral_probe', 'Ephemeral capability restored'))
  assert.deepEqual(names(ctx, agent), [TOOL_SEARCH_NAME])
})

test('rejects nested Code Mode dispatch and invalid requests without changing visibility', async (t) => {
  const { ctx } = await harness({ maxResults: 1, maxQueryChars: 8 })
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('probe', 'Probe a target'))
  const agent = createAgent(ctx, 'invalid')
  const before = names(ctx, agent)

  for (const [args, parent] of [
    [{ query: '   ' }, undefined],
    [{ query: '123456789' }, undefined],
    [{ query: 'probe', limit: 2 }, undefined],
    [{ query: 'probe' }, Symbol('code-parent')],
  ]) assert.equal((await execute(ctx, agent, TOOL_SEARCH_NAME, args, parent)).isError, true)
  assert.deepEqual(names(ctx, agent), before)
})

test('keeps selections isolated across Agents and disposal restores the native surface', async (t) => {
  const { ctx, plugin } = await harness({ maxResults: 1 })
  t.after(async () => ctx.fiber.dispose())
  ctx.tools.register(fixture('agent_alpha', 'Alpha capability'))
  ctx.tools.register(fixture('agent_beta', 'Beta capability'))
  const left = await ctx.agents.create({
    sessionId: SessionId('isolation-left'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  const right = await ctx.agents.create({
    sessionId: SessionId('isolation-right'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  await execute(ctx, left.agent, TOOL_SEARCH_NAME, { query: 'alpha capability' })
  await execute(ctx, right.agent, TOOL_SEARCH_NAME, { query: 'beta capability' })
  assert.deepEqual(names(ctx, left.agent), ['agent_alpha', TOOL_SEARCH_NAME])
  assert.deepEqual(names(ctx, right.agent), ['agent_beta', TOOL_SEARCH_NAME])

  await left.dispose()
  ctx.tools.register(fixture('after_left_dispose', 'Registered after one Agent disposed'))
  assert.deepEqual(names(ctx, right.agent), ['agent_beta', TOOL_SEARCH_NAME])
  await plugin.dispose()
  assert.deepEqual(names(ctx, right.agent), ['after_left_dispose', 'agent_alpha', 'agent_beta'])
  await right.dispose()
})

test('keeps a seventy-tool native catalog out of the initial request schema', async (t) => {
  const { ctx } = await harness({ maxResults: 1 })
  t.after(async () => ctx.fiber.dispose())
  for (let index = 0; index < 70; index += 1) {
    ctx.tools.register(fixture(`synthetic_tool_${index}`, `Synthetic capability number ${index}`))
  }
  const fullCatalogBytes = Buffer.byteLength(JSON.stringify(ctx.tools.schemas()))
  const agent = createAgent(ctx, 'seventy-tools')
  const initialSchemas = ctx.tools.schemas(agent)
  const initialBytes = Buffer.byteLength(JSON.stringify(initialSchemas))

  assert.deepEqual(initialSchemas.map(schema => schema.name), [TOOL_SEARCH_NAME])
  assert.ok(initialBytes * 10 < fullCatalogBytes)
  const found = await execute(ctx, agent, TOOL_SEARCH_NAME, { query: 'synthetic_tool_42', limit: 1 })
  assert.deepEqual(found.value.tools, [{ name: 'synthetic_tool_42', status: 'loaded' }])
  assert.deepEqual(names(ctx, agent), ['synthetic_tool_42', TOOL_SEARCH_NAME])
})
