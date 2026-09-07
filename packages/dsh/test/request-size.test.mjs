import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import LlmRuntime, { LlmAdapter, createUserMessage, createMessage, createToolResultMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import SessionStore, { Session, SESSION_FORMAT_VERSION } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import TokenMeter from '../../../upstream/deepseek-harness/packages/llm/token-meter/lib/index.js'
import BasicCompaction from '../../../upstream/deepseek-harness/packages/compaction/compaction-basic/lib/index.js'
import Pruner from '../../../upstream/deepseek-harness/packages/compaction/compaction-tool-result-pruner/lib/index.js'
import * as pairing from '../../../upstream/deepseek-harness/packages/compaction/compaction/lib/index.js'
import { LocalAttachmentStore } from '../../../upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'
import Persistence from '../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { toPiContext } from '../../../upstream/deepseek-harness/packages/llm/llm-pi-ai/src/context.ts'
import { compactRequestHistory, estimateRequestBytes, requestSizeFailure, MAX_RESPONSES_BYTES } from '../src/profile/request-size.ts'

const require = createRequire(new URL('../../../upstream/deepseek-harness/packages/attachment/attachment-local/package.json', import.meta.url))
const sharp = require('sharp')
const target = { provider: 'e-mate-enterprise', model: 'gpt-6-astra' }
const header = { config: { ...target, reasoningEffort: 'medium', temperature: 0.3 }, system: 'Keep original sources and exact parameters.', tools: [{ name: 'inspect', description: 'Inspect original image', parameters: { type: 'object', properties: {} } }] }
const digest = data => createHash('sha256').update(data).digest('hex')
let fixtureImage
async function image() {
  fixtureImage ??= sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
  return fixtureImage
}
class SummaryAdapter extends LlmAdapter {
  calls = []
  action
  async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 1_000_000 } } }
  async *stream(options) {
    this.calls.push(options)
    assert.equal(options.purpose, 'compaction')
    assert.ok(estimateRequestBytes(options) < 33 * 1024 * 1024)
    if (this.action) await this.action(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Older screenshots documented completed checks; preserve the original attachment references in history.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), 'emate-request-bytes-'))
  const ctx = new Context()
  const fibers = [await ctx.plugin(SessionStore), await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })]
  new LlmRuntime(ctx)
  new TokenMeter(ctx)
  new Pruner(ctx)
  new BasicCompaction(ctx, { auto: false })
  const attachments = new LocalAttachmentStore(ctx, { dshHome: home })
  const adapter = new SummaryAdapter()
  ctx.llm.registerAdapter(['e-mate-enterprise'], adapter)
  let owner = { tenantId: 'isolated-tenant', userId: 'isolated-user' }
  ctx.provide('emateIdentity', { localAccountPrincipal: () => owner })
  const ref = await attachments.saveImage({ data: await image(), mediaType: 'image/png', name: 'synthetic-original.png' })
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  return { ctx, attachments, adapter, ref, home, switchOwner() { owner = undefined; ctx.emit('credentials/updated') } }
}
function conversation(ref, count = 20) {
  const session = Session.create('request-byte-fixture')
  for (let turn = 1; turn <= count; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Inspect step ${turn}` }, ...(turn === 1 ? [{ type: 'image', attachment: ref }] : [])] }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header, reason: 'initial' })
    const callId = `screenshot-${turn}`
    session.append('assistant/message', { turn, step: 1, message: createMessage({ role: 'assistant', source: { kind: 'model', ...target }, content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }] }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'inspect', arguments: '{}' })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `Screenshot ${turn}` }, { type: 'image', attachment: ref }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: count + 1 })
  return session
}
function payload(session, messages = []) { return { agent: { session, options: target }, signal: new AbortController().signal, messages } }
function options(session, messages = []) { return { ...header.config, system: header.system, tools: header.tools, messages: [...session.deriveMessages(), ...messages] } }

test('over 72 MiB native tool-image history compacts bounded regions; raw JSONL, CAS, user images and current input survive', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  const incoming = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compare this exact original without reducing quality.' }, { type: 'image', attachment: h.ref }] })
  const original = structuredClone(session.events)
  const beforeOptions = options(session, [incoming])
  const beforeBytes = Buffer.byteLength(JSON.stringify(await toPiContext(beforeOptions, h.attachments)))
  assert.ok(beforeBytes >= 72 * 1024 * 1024)
  assert.ok(estimateRequestBytes(beforeOptions) >= beforeBytes)
  await compactRequestHistory(h.ctx, payload(session, [incoming]), pairing)
  const afterOptions = options(session, [incoming])
  const afterBytes = Buffer.byteLength(JSON.stringify(await toPiContext(afterOptions, h.attachments)))
  assert.ok(afterBytes < MAX_RESPONSES_BYTES)
  assert.equal(requestSizeFailure(afterOptions), undefined)
  assert.ok(h.adapter.calls.length > 0 && h.adapter.calls.length <= 3)
  for (const call of h.adapter.calls) { assert.equal(call.model, target.model); assert.equal(call.provider, target.provider); assert.equal(call.system, header.system); assert.deepEqual(call.tools, header.tools) }
  assert.deepEqual(session.events.slice(0, original.length), original)
  assert.deepEqual(session.requestHeader(), header)
  assert.deepEqual(afterOptions.messages.at(-1), incoming)
  assert.ok(session.surface.nodes.includes(original.find(e => e.type === 'user/message').seq))
  assert.ok(session.surface.nodes.includes(original.findLast(e => e.type === 'tool/result').seq))
  await h.ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: session.id, createdAt: Date.now(), cwd: h.home, delegationDepth: 0 })
  await h.ctx.sessionPersistence.append(session.id, session.events)
  const restored = await h.ctx.sessionPersistence.inspect(session.id)
  assert.deepEqual(restored.events.slice(0, original.length), original)
  assert.deepEqual(Session.create(session.id, restored.events).deriveMessages(), session.deriveMessages())
  const stored = await h.attachments.readImage(h.ref)
  assert.equal(digest(stored.data), digest(await image()))
  assert.deepEqual(stored.ref, h.ref)
  t.diagnostic(JSON.stringify({ originalNativeContextBytes: beforeBytes, compactedNativeContextBytes: afterBytes, compactionCalls: h.adapter.calls.length, originalEventsRetained: original.length }))
})

test('oversized current user images are retained and rejected with actionable batching, with no summarizer call', async t => {
  const h = await harness(t)
  const session = Session.create('current-images')
  const incoming = createUserMessage({ source: { kind: 'user' }, content: Array.from({ length: 18 }, () => ({ type: 'image', attachment: h.ref })) })
  await compactRequestHistory(h.ctx, payload(session, [incoming]), pairing)
  assert.equal(h.adapter.calls.length, 0)
  assert.equal(incoming.content.length, 18)
  assert.equal(session.events.length, 0)
  assert.match(requestSizeFailure(options(session, [incoming])).message, /分批发送/u)
  assert.equal(digest((await h.attachments.readImage(h.ref)).data), digest(await image()))
})

test('unknown summarizer submission is not repeated and oversized original still fails preflight', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  const original = structuredClone(session.events)
  h.adapter.action = async () => { throw new Error('synthetic response lost after submission') }
  await compactRequestHistory(h.ctx, payload(session), pairing)
  assert.equal(h.adapter.calls.length, 1)
  assert.equal(session.surface.replaceGeneration, 0)
  assert.deepEqual(session.events.slice(0, original.length), original)
  assert.equal(requestSizeFailure(options(session)).status, 413)
})

test('identity switch aborts the original native compaction and never commits into the changed owner', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  h.adapter.action = async request => { h.switchOwner(); request.signal.throwIfAborted() }
  await assert.rejects(compactRequestHistory(h.ctx, payload(session), pairing), /account changed/u)
  assert.equal(h.adapter.calls.length, 1)
  assert.equal(session.surface.replaceGeneration, 0)
})

test('one pre-step performs at most three native compactions then rejects remaining oversized history', async t => {
  const h = await harness(t)
  const session = conversation(h.ref, 50)
  await compactRequestHistory(h.ctx, payload(session), pairing)
  assert.equal(h.adapter.calls.length, 3)
  assert.equal(requestSizeFailure(options(session)).status, 413)
})

test('actual native text pruner handles large tool text without summarization or deleting original events', async t => {
  const h = await harness(t)
  const session = conversation(h.ref, 1)
  const callId = 'long-text'
  session.append('step/start', { turn: 2, step: 1 })
  session.append('assistant/message', { turn: 2, step: 1, message: createMessage({ role: 'assistant', source: { kind: 'model', ...target }, content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }] }) }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'x'.repeat(25 * 1024 * 1024) }], isError: false }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  const original = structuredClone(session.events)
  await compactRequestHistory(h.ctx, payload(session), pairing)
  assert.equal(h.adapter.calls.length, 0)
  assert.equal(requestSizeFailure(options(session)), undefined)
  assert.deepEqual(session.events.slice(0, original.length), original)
  assert.ok(session.events.some(e => e.type === 'compaction/prune'))
})

test('413 HTML maps to fixed native failure; other providers and unrelated failures retain their contract', () => {
  const large = requestSizeFailure(target, { code: 'PI_AI_ERROR', message: 'OpenAI API error (413): 413 <html><head><title>413 Request Entity Too Large</title> secret </html>' })
  assert.equal(large.status, 413)
  assert.doesNotMatch(large.message, /html|secret|nginx/u)
  assert.equal(requestSizeFailure(target, { code: 'PI_AI_ERROR', message: 'connection reset' }), undefined)
  assert.equal(requestSizeFailure({ provider: 'other' }, { status: 413 }), undefined)
  assert.equal(requestSizeFailure(target, { status: 413 }).code, 'REQUEST_TOO_LARGE')
})

test('cancelled pre-step never prunes or submits a summarizer', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  const original = structuredClone(session.events)
  const controller = new AbortController()
  controller.abort(new Error('explicit cancel'))
  await assert.rejects(compactRequestHistory(h.ctx, { ...payload(session), signal: controller.signal }, pairing), /explicit cancel/u)
  assert.equal(h.adapter.calls.length, 0)
  assert.deepEqual(session.events, original)
})

test('a non-shrinking compaction result cannot spend a second attempt', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  let calls = 0
  const boundary = {
    emateIdentity: h.ctx.emateIdentity,
    on: (...args) => h.ctx.on(...args),
    get(name) { return name === 'compaction' ? { async compactRegion() { calls++ } } : h.ctx.get(name) },
  }
  await compactRequestHistory(boundary, payload(session), pairing)
  assert.equal(calls, 1)
  assert.equal(requestSizeFailure(options(session)).status, 413)
})
