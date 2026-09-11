/**
 * First-token cost per round: the request prefix must stay cacheable.
 *
 * A provider's prompt cache only helps while the prefix of a request is
 * byte-identical to the previous one. The pinned kernel derives the request
 * series from three facts, and any of them changing re-projects the system
 * prompt and starts a new series — which re-processes the whole history and
 * makes the first token slower with every round:
 *   1. the rendered system prompt text,
 *   2. the surface's own replace generation,
 *   3. the assembled tool schemas (packages/core/agent-loop/src/agent.ts:363-368).
 *
 * This guard drives two real turns through the real AgentLoop with the product's
 * own dynamically registering Tool Search plugin mounted, and pins all three
 * facts: one system message on the surface, an identical tool schema set, and a
 * turn-two request whose serialized messages extend turn one's as a strict
 * prefix rather than rewriting it.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** One opaque 1x1 PNG; the store normalizes it, which is the point of the image round. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '../../../upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolSearch from '../../dsh-plugin-tool-search/src/index.ts'

interface CapturedRequest {
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly system?: unknown
}

class CapturingAdapter extends LlmAdapter {
  readonly requests: CapturedRequest[] = []

  resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: CapturedRequest) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' } as const
    yield { type: 'text-delta', index: 0, text: '好的' } as const
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '好的' } } as const
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } } as const
    yield { type: 'finish', reason: { kind: 'stop' } } as const
  }
}

test('two rounds of one conversation keep the request prefix byte-identical', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'emate-prefix-stability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  await mkdir(cwd)

  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const searchFiber = await ctx.plugin(ToolSearch, { alwaysVisible: [], maxResults: 5 })
  t.after(() => searchFiber.dispose())
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new CapturingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('prefix-1'), { provider: 'mock', model: 'mock' }, { cwd })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '第一轮' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '第二轮' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  assert.equal(adapter.requests.length, 2, 'each round must submit exactly one request')
  const [first, second] = adapter.requests as [CapturedRequest, CapturedRequest]

  // 3. Tool schemas identical: a changed set starts a new series by itself.
  assert.deepEqual(second.tools, first.tools)

  // 1. One system prompt, unchanged: a rewritten prompt invalidates the prefix.
  const systemMessages = agent.session.snapshotEvents().filter(event => event.type === 'system/message')
  assert.equal(systemMessages.length, 1, 'the system prompt must be projected once, not re-appended per round')
  const firstSystem = first.messages.find(message => (message as { role?: string }).role === 'system')
  const secondSystem = second.messages.find(message => (message as { role?: string }).role === 'system')
  assert.deepEqual(secondSystem, firstSystem)

  // 2. Append-only history: round two keeps round one's messages byte-identical
  //    and only appends after them, which is what lets the provider cache hit.
  assert.ok(second.messages.length > first.messages.length, 'the second request must carry the first round as history')
  assert.equal(
    JSON.stringify(second.messages.slice(0, first.messages.length)),
    JSON.stringify(first.messages),
    'the earlier messages must serialize exactly as they did in the first request',
  )
})

test('an image round keeps the earlier prefix byte-identical for the next round', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'emate-prefix-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  await mkdir(cwd)

  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const attachments = new LocalAttachmentStore(ctx, { dshHome: join(root, 'home') })
  const reference = await attachments.saveImage({
    data: Buffer.from(PNG_1PX, 'base64'),
    mediaType: 'image/png',
    name: 'round-one.png',
  })
  await ctx.plugin(AgentLoop, { agents: [] })

  const adapter = new CapturingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('prefix-image'), { provider: 'mock', model: 'mock' }, { cwd })

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '第一轮带图' }, { type: 'image', attachment: reference }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '第二轮' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  assert.equal(adapter.requests.length, 2)
  const [first, second] = adapter.requests as [CapturedRequest, CapturedRequest]
  assert.deepEqual(second.tools, first.tools)
  assert.equal(
    JSON.stringify(second.messages.slice(0, first.messages.length)),
    JSON.stringify(first.messages),
    'adding an image round must not rewrite the history a later round submits',
  )
  const carried = second.messages.find(message => JSON.stringify(message).includes(reference.attachmentId))
  assert.ok(carried !== undefined, 'the earlier image must stay in later rounds')
})
