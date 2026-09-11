import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import {
  MemoryMediaPool,
  MemoryStorageBackend,
} from '../../../upstream/deepseek-harness/packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import * as ToolSearch from '../../dsh-plugin-tool-search/src/index.ts'
import * as MemoryEvolve from '../src/index.ts'

const signal = new AbortController().signal
let callOrdinal = 0

function alwaysVisibleTools(): string[] {
  const lines = readFileSync(new URL('../../dsh-plugin-tool-search/cordis.patch.yml', import.meta.url), 'utf8').split('\n')
  const start = lines.findIndex(line => line.trim() === 'alwaysVisible:')
  assert.notEqual(start, -1)
  const entries = lines.slice(start + 1)
  const end = entries.findIndex(line => !/^\s+-\s+\S/u.test(line))
  return entries.slice(0, end === -1 ? entries.length : end).map(line => line.replace(/^\s+-\s+/u, ''))
}

class CaptureAdapter extends LlmAdapter {
  readonly requests: unknown[] = []

  resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: unknown) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' } as const
    yield { type: 'text-delta', index: 0, text: '榛果-A' } as const
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '榛果-A' } } as const
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } } as const
    yield { type: 'finish', reason: { kind: 'stop' } } as const
  }
}

async function execute(ctx: Context, agent: ReturnType<AgentLoop['create']>, name: string, args: unknown) {
  callOrdinal += 1
  const result = await ctx.tools.execute({
    callId: ToolCallId(`memory-real-${callOrdinal}`),
    name,
    arguments: args,
    agent,
    signal,
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value
}

test('installed Tool Search keeps real project memory durable, isolated, and present in the model request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'emate-installed-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  const general = join(root, 'general')
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(general)])

  const headers = [
    { version: 0, id: SessionId('a-1'), createdAt: 1, cwd: projectA },
    { version: 0, id: SessionId('a-2'), createdAt: 2, cwd: projectA },
    { version: 0, id: SessionId('b-1'), createdAt: 3, cwd: projectB },
    { version: 0, id: SessionId('g-1'), createdAt: 4, cwd: general },
  ]
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  const pool = new MemoryMediaPool()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  const domains = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domains)
  ctx.provide('storageDomain', domains)
  ctx.provide('sessionPersistence', {
    // 0.1.5 lists snapshots ({ header, revision }), not bare headers, and
    // AgentLoop.create takes write ownership through a per-session handle.
    list: async () => headers.map(header => ({ header, revision: 'rev-1' })),
    create: async (header: { id: unknown }) => ({
      id: header.id,
      header,
      inheritedEventCount: 0,
      access: 'write' as const,
      read: () => { throw new Error('event bodies must not be read') },
      append: async () => {},
      flush: async () => {},
      close: async () => {},
    }),
    open: () => { throw new Error('event bodies must not be read') },
    stat: async () => undefined,
    flush: async () => {},
  } as never)
  ctx.provide('userQuestions', {
    ask: async (request: { questions: Array<{ id: string; options: Array<{ label: string }> }> }) => ({
      answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options[0]!.label] }],
    }),
  } as never)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  let memoryFiber = await ctx.plugin(MemoryEvolve, { sessionOnlyWorkspacePath: general })
  await ctx.plugin(ToolSearch, { alwaysVisible: alwaysVisibleTools(), maxResults: 5 })

  // 0.1.5 AgentLoop.create is async and resolves the published Agent.
  const a1 = await ctx.agentLoop.create(SessionId('a-1'), { provider: 'mock', model: 'mock' }, { cwd: projectA })
  const a2 = await ctx.agentLoop.create(SessionId('a-2'), { provider: 'mock', model: 'mock' }, { cwd: projectA })
  const b1 = await ctx.agentLoop.create(SessionId('b-1'), { provider: 'mock', model: 'mock' }, { cwd: projectB })
  const g1 = await ctx.agentLoop.create(SessionId('g-1'), { provider: 'mock', model: 'mock' }, { cwd: general })
  for (const agent of [a1, a2, b1, g1]) {
    assert.deepEqual(
      ctx.tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith('e_mate_memory_')).sort(),
      ['e_mate_memory_delete', 'e_mate_memory_remember', 'e_mate_memory_search'],
    )
  }

  const remembered = await execute(ctx, a1, 'e_mate_memory_remember', { content: '项目验收代号是榛果-A。' }) as { memory_id: string }
  await execute(ctx, b1, 'e_mate_memory_remember', { content: 't18' })
  await execute(ctx, g1, 'e_mate_memory_remember', { content: 'general-only' })
  const workspaceA = await ctx.workspaceRegistry.resolveByPath(projectA)
  assert.deepEqual(workspaceA?.sessionIds.map(String), ['a-2', 'a-1'])
  const stored = pool.media.get('emate_memory_evolve')?.tables.get('records')?.get(remembered.memory_id) as {
    scopeKind?: string
    projectId?: string
    writtenBySessionId?: string
  }
  assert.deepEqual(
    { scopeKind: stored.scopeKind, projectId: stored.projectId, writtenBySessionId: stored.writtenBySessionId },
    { scopeKind: 'project', projectId: String(workspaceA?.id), writtenBySessionId: 'a-1' },
  )

  const first = await ctx.systemPrompt.assemble(assembleContextFor(a2, signal))
  const retry = await ctx.systemPrompt.assemble(assembleContextFor(a2, signal))
  for (const assembly of [first, retry]) {
    const prompt = JSON.stringify(assembly)
    assert.match(prompt, /榛果-A/u)
    assert.match(prompt, new RegExp(remembered.memory_id, 'u'))
    assert.doesNotMatch(prompt, /t18|general-only/u)
  }
  assert.doesNotMatch(JSON.stringify(await ctx.systemPrompt.assemble(assembleContextFor(b1, signal))), /榛果-A/u)
  assert.doesNotMatch(JSON.stringify(await ctx.systemPrompt.assemble(assembleContextFor(g1, signal))), /榛果-A/u)

  await memoryFiber.dispose()
  memoryFiber = await ctx.plugin(MemoryEvolve, { sessionOnlyWorkspacePath: general })
  const afterRestart = await execute(ctx, a2, 'e_mate_memory_search', {}) as { items: Array<{ memory_id: string }> }
  assert.equal(afterRestart.items[0]?.memory_id, remembered.memory_id)

  const adapter = new CaptureAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  a2.followup(createUserMessage({
    content: [{ type: 'text', text: '本项目验收代号是什么？只回复代号。' }],
    source: { kind: 'user' },
  }))
  await a2.whenIdle()
  assert.equal(adapter.requests.length, 1)
  const request = JSON.stringify(adapter.requests[0])
  assert.match(request, /榛果-A/u)
  assert.doesNotMatch(request, /t18|general-only/u)
  assert.match(request, /scoped facts\/data only/u)
})
