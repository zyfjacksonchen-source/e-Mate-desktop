import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import LlmRuntime, { LlmAdapter, createUserMessage, createMessage, createSystemMessage, createToolResultMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import SessionStore, { Session, SESSION_FORMAT_VERSION } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import { createScope, scopeTarget } from '../../../upstream/deepseek-harness/packages/core/scope/lib/index.js'
import SessionProjectionRegistry from '../../../upstream/deepseek-harness/packages/session/session-projection/lib/index.js'
import TokenMeter from '../../../upstream/deepseek-harness/packages/llm/token-meter/lib/index.js'
import BasicCompaction from '../../../upstream/deepseek-harness/packages/compaction/compaction-basic/lib/index.js'
import Pruner from '../../../upstream/deepseek-harness/packages/compaction/compaction-tool-result-pruner/lib/index.js'
import * as pairing from '../../../upstream/deepseek-harness/packages/compaction/compaction/lib/index.js'
import { LocalAttachmentStore } from '../../../upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'
import Persistence from '../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { toPiContext } from '../../../upstream/deepseek-harness/packages/llm/llm-pi-ai/src/context.ts'
import { installRequestHistoryCompaction, compactRequestHistory, estimateRequestBytes, requestSizeFailure, MAX_RESPONSES_BYTES } from '../src/profile/request-size.ts'

const require = createRequire(new URL('../../../upstream/deepseek-harness/packages/attachment/attachment-local/package.json', import.meta.url))
const sharp = require('sharp')
const target = { provider: 'e-mate-enterprise', model: 'gpt-6-astra' }
const system = 'Keep original sources and exact parameters.'
// 0.1.5 derives the system prompt from the surface's leading `system/message`; `request/header` carries only config and tools.
const header = { config: { ...target, reasoningEffort: 'medium', temperature: 0.3 }, tools: [{ name: 'inspect', description: 'Inspect original image', parameters: { type: 'object', properties: {} } }] }
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
async function harness(t, isolated = false) {
  const home = await mkdtemp(join(tmpdir(), 'emate-request-bytes-'))
  const ctx = new Context()
  // 0.1.5 TokenMeter injects sessionProjections, so the registry must be mounted before it is constructed.
  const fibers = [await ctx.plugin(SessionStore), await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' }), await ctx.plugin(SessionProjectionRegistry)]
  new LlmRuntime(ctx)
  new TokenMeter(ctx)
  const scopeKey = {}
  const scoped = isolated ? createScope(ctx, scopeKey) : undefined
  if (scoped) {
    const realm = scoped.ctx.isolate('compaction').isolate('toolResultPruner')
    fibers.push(await realm.plugin(Pruner), await realm.plugin(BasicCompaction, { auto: false }))
    t.after(() => scoped.dispose())
  } else {
    new Pruner(ctx)
    new BasicCompaction(ctx, { auto: false })
  }
  const attachments = new LocalAttachmentStore(ctx, { dshHome: home })
  const adapter = new SummaryAdapter()
  ctx.llm.registerAdapter(['e-mate-enterprise'], adapter)
  let owner = { tenantId: 'isolated-tenant', userId: 'isolated-user' }
  ctx.provide('emateIdentity', { localAccountPrincipal: () => owner })
  const ref = await attachments.saveImage({ data: await image(), mediaType: 'image/png', name: 'synthetic-original.png' })
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  return { ctx, scopeKey, attachments, adapter, ref, home, switchOwner() { owner = undefined; ctx.emit('credentials/updated') } }
}
function conversation(ref, count = 20) {
  const session = Session.create('request-byte-fixture')
  for (let turn = 1; turn <= count; turn++) {
    session.append('turn/start', { turn })
    if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage(system, '@e-mate/dsh-request-size-fixture') }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Inspect step ${turn}` }, ...(turn === 1 ? [{ type: 'image', attachment: ref }] : [])] }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header, reason: 'initial' })
    const callId = `screenshot-${turn}`
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant', source: { kind: 'model', ...target }, content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }] }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'inspect', arguments: '{}' })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `Screenshot ${turn}` }, { type: 'image', attachment: ref }], isError: false }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: count + 1 })
  return session
}
// 0.1.5 binds request images through PiImageRequestContext instead of a bare AttachmentStore, and applies a
// request-image policy (kernel default: 1 MiB per image) that re-encodes stored images before they reach the wire.
// This fixture measures the product's own raw-byte model, so it pins a policy that passes its 1024x1024 / ~3 MiB
// PNGs through unchanged; without it the same history measures ~21 MiB instead of 92 MiB.
function imagesContext(h) { return { attachments: h.attachments, resolveImageAccess: () => undefined, requestImagePolicy: { maxPixels: 4096 * 4096, maxBytes: 64 * 1024 * 1024 } } }
function payload(session, messages = []) { return { agent: { session, options: target }, signal: new AbortController().signal, messages } }
function options(session, messages = []) { return { ...header.config, tools: header.tools, messages: [...session.deriveMessages(), ...messages] } }

test('over 72 MiB native tool-image history compacts bounded regions; raw JSONL, CAS, user images and current input survive', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  const incoming = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compare this exact original without reducing quality.' }, { type: 'image', attachment: h.ref }] })
  const original = structuredClone(session.snapshotEvents())
  const beforeOptions = options(session, [incoming])
  const beforeBytes = Buffer.byteLength(JSON.stringify(await toPiContext(beforeOptions, imagesContext(h))))
  assert.ok(beforeBytes >= 72 * 1024 * 1024)
  assert.ok(estimateRequestBytes(beforeOptions) >= beforeBytes)
  await compactRequestHistory(h.ctx, payload(session, [incoming]), pairing)
  const afterOptions = options(session, [incoming])
  const afterBytes = Buffer.byteLength(JSON.stringify(await toPiContext(afterOptions, imagesContext(h))))
  assert.ok(afterBytes < MAX_RESPONSES_BYTES)
  assert.equal(requestSizeFailure(afterOptions), undefined)
  assert.ok(h.adapter.calls.length > 0 && h.adapter.calls.length <= 3)
  for (const call of h.adapter.calls) { assert.equal(call.model, target.model); assert.equal(call.provider, target.provider)
    // 0.1.5 replays the conversation's own system prompt as the leading system message; options.system no longer carries it.
    assert.equal(call.messages[0].role, 'system'); assert.equal(call.messages[0].content[0].text, system); assert.deepEqual(call.tools, header.tools) }
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  assert.deepEqual(session.requestHeader(), header)
  assert.deepEqual(afterOptions.messages.at(-1), incoming)
  assert.ok(session.surface.nodes.includes(original.find(e => e.type === 'user/message').seq))
  assert.ok(session.surface.nodes.includes(original.findLast(e => e.type === 'tool/result').seq))
  const handle = await h.ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: session.id, createdAt: Date.now(), cwd: h.home, isSeeded: false, delegationDepth: 0 })
  await handle.append(session.snapshotEvents())
  // 0.1.5 addresses stored sessions through per-session handles: the removed service-level append(id, events)/inspect(id) are handle.append(events) and open(id, 'read').read().
  const restored = await (await h.ctx.sessionPersistence.open(session.id, 'read')).read()
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
  assert.equal(session.snapshotEvents().length, 0)
  assert.match(requestSizeFailure(options(session, [incoming])).message, /分批发送/u)
  assert.equal(digest((await h.attachments.readImage(h.ref)).data), digest(await image()))
})

test('unknown summarizer submission is not repeated and oversized original still fails preflight', async t => {
  const h = await harness(t)
  const session = conversation(h.ref)
  const original = structuredClone(session.snapshotEvents())
  h.adapter.action = async () => { throw new Error('synthetic response lost after submission') }
  await compactRequestHistory(h.ctx, payload(session), pairing)
  assert.equal(h.adapter.calls.length, 1)
  assert.equal(session.surface.replaceGeneration, 0)
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
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
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant', source: { kind: 'model', ...target }, content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }] }) }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'x'.repeat(25 * 1024 * 1024) }], isError: false }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  const original = structuredClone(session.snapshotEvents())
  await compactRequestHistory(h.ctx, payload(session), pairing)
  assert.equal(h.adapter.calls.length, 0)
  assert.equal(requestSizeFailure(options(session)), undefined)
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  assert.ok(session.snapshotEvents().some(e => e.type === 'compaction/prune'))
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
  const original = structuredClone(session.snapshotEvents())
  const controller = new AbortController()
  controller.abort(new Error('explicit cancel'))
  await assert.rejects(compactRequestHistory(h.ctx, { ...payload(session), signal: controller.signal }, pairing), /explicit cancel/u)
  assert.equal(h.adapter.calls.length, 0)
  assert.deepEqual(session.snapshotEvents(), original)
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


test('byte pressure follows actual isolated preset scopes, existing providers, reload and teardown', async t => {
  const h = await harness(t)
  // Root services in the older unit fixture are deliberately removed from this
  // proof: only providers behind native Context.isolate may process the events.
  const root = new Context()
  root.provide('emateIdentity', h.ctx.emateIdentity)
  let installs = 0
  const ownerKeys = [{}, {}]
  const scopes = ownerKeys.map(key => createScope(root, key))
  const counts = [0, 0]
  const provide = async index => {
    const realm = scopes[index].ctx.isolate('compaction').isolate('toolResultPruner')
    const fiber = await realm.plugin({ name: `isolated-compaction-${index}-${++installs}`, apply(ctx) {
      ctx.provide('toolResultPruner', { pruneSession() {} })
      ctx.provide('compaction', { async compactRegion() { counts[index]++ } })
    } })
    return { realm, fiber }
  }
  const first = await provide(0) // Already mounted when policy starts.
  assert.equal(root.get('compaction'), undefined)
  assert.equal(root.get('toolResultPruner'), undefined)
  const startPolicy = () => root.plugin({ name: 'test-root-policy', apply(ctx) {
    ctx.effect(() => installRequestHistoryCompaction(ctx, pairing))
  } })
  let policy = await startPolicy()
  const second = await provide(1) // Later preset mounts notify the policy.
  const run = async index => {
    const session = conversation(h.ref)
    const input = payload(session)
    return root.waterfall(scopeTarget(root, ownerKeys[index]), 'agent/pre-step', input,
      async () => ({ kind: 'enter', messages: [] }))
  }
  await run(0)
  assert.deepEqual(counts, [1, 0])
  await run(1)
  assert.deepEqual(counts, [1, 1])
  // Repeated native notifications must not multiply hooks.
  first.fiber.ctx.reflect.notify(['compaction'])
  first.fiber.ctx.reflect.notify(['compaction'])
  await run(0)
  assert.deepEqual(counts, [2, 1])
  await policy.dispose()
  await run(0)
  assert.deepEqual(counts, [2, 1])
  policy = await startPolicy()
  await run(0)
  assert.deepEqual(counts, [3, 1])
  await first.fiber.dispose()
  await run(0)
  assert.deepEqual(counts, [3, 1])
  const replacement = await provide(0)
  await run(0)
  assert.deepEqual(counts, [4, 1])
  await policy.dispose()
  await run(1)
  assert.deepEqual(counts, [4, 1])
  await replacement.fiber.dispose()
  await second.fiber.dispose()
  for (const scope of scopes) await scope.dispose()
})


test('real native compaction processes image history through its isolated pre-step hook', async t => {
  const h = await harness(t, true)
  assert.equal(h.ctx.get('compaction'), undefined)
  assert.equal(h.ctx.get('toolResultPruner'), undefined)
  const stop = installRequestHistoryCompaction(h.ctx, pairing)
  t.after(stop)
  const session = conversation(h.ref)
  const original = structuredClone(session.snapshotEvents())
  const incoming = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: h.ref }] })
  const run = (input, decision) => h.ctx.waterfall(scopeTarget(h.ctx, h.scopeKey), 'agent/pre-step', input, async () => decision)
  await run(payload(session), { kind: 'enter', messages: [incoming] })
  assert.ok(h.adapter.calls.length > 0)
  assert.equal(requestSizeFailure(options(session, [incoming])), undefined)
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  assert.equal(digest((await h.attachments.readImage(h.ref)).data), digest(await image()))
  const calls = h.adapter.calls.length
  const cancelled = new AbortController()
  cancelled.abort(new Error('explicit cancel'))
  await run({ ...payload(conversation(h.ref)), signal: cancelled.signal }, { kind: 'enter', messages: [] })
  await run(payload(conversation(h.ref)), { kind: 'reject', reason: 'test rejection' })
  assert.equal(h.adapter.calls.length, calls)
  h.adapter.action = async request => { h.switchOwner(); request.signal.throwIfAborted() }
  const changed = conversation(h.ref)
  await assert.rejects(run(payload(changed), { kind: 'enter', messages: [] }), /account changed/u)
  assert.equal(changed.surface.replaceGeneration, 0)
})
