import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '../../../upstream/deepseek-harness/packages/core/system-prompt/lib/index.js'
import LocalAttachments from '../../../upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'
import LocalJobs from '../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'
import AgentRegistry from '../../../upstream/deepseek-harness/packages/core/agent/lib/index.js'
import { Session, SessionId } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import { createUserMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import * as ImageGen from '../lib/index.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const cleanups = []
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const success = id => json({ id, data: [{ b64_json: PNG.toString('base64') }], usage: { images: 1 } })
const receipts = owner => owner.session.events.filter(event => event.type === 'emate/image-output').map(event => event.data)
const snake = ref => ({ attachment_id: ref.attachmentId, media_type: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) })

async function fixture(request = async (_url, _init, ordinal) => success(`fixture-${ordinal}`)) {
  const ctx = new Context(), home = await mkdtemp(join(tmpdir(), 'emate-dsh-imagegen-'))
  const fibers = []
  const mount = (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); return fiber }
  cleanups.push(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  await mount(SystemPrompt)
  await mount(ToolRuntime)
  await mount(AgentRegistry)
  await mount(LocalJobs, {})
  await mount(LocalAttachments, { dshHome: home })
  const calls = [], capability = []
  ctx.provide('emateIdentity', { async request(url, init) { calls.push({ url: String(url), init }); return request(url, init, calls.length) } })
  ctx.provide('emateModelPolicy', { assertModel: async model => { assert.equal(model, ImageGen.IMAGE_MODEL) } })
  ctx.provide('emateCapabilities', { register(value) { capability.push(value); return () => {} } })
  await mount(ImageGen, { rootUrl: 'https://images.example.test/v1' })
  let serial = 0
  function owner(rawId = `owner-${++serial}`) {
    const fiber = mount(() => {})
    const session = Session.create(SessionId(rawId))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const agent = { id: session.header.id, session, ctx: fiber.ctx, options: {}, status: 'idle', cancel() {},
      whenIdle: async () => {}, runMaintenance: async fn => fn(new AbortController().signal) }
    ctx.agents.register(agent)
    return agent
  }
  const firstOwner = owner()
  async function call(name, args, options = {}) {
    const agent = options.agent ?? firstOwner, callId = options.callId ?? `call-${++serial}`, rootCallId = options.rootCallId ?? callId
    if (!agent.session.events.some(event => event.type === 'tool/call' && event.data.callId === rootCallId)) {
      agent.session.append('tool/call', { turn: 1, step: 1, callId: rootCallId, name: options.parent ? 'run_code' : name, arguments: '{}' })
    }
    return ctx.tools.execute({ name, arguments: args, agent, callId, rootCallId, signal: options.signal ?? new AbortController().signal,
      ...(options.parent ? { parent: options.parent } : {}) })
  }
  return { ctx, home, owner, agent: firstOwner, calls, capability, call }
}

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test('only four upstream tools and a single fixed enterprise channel are registered', async () => {
  const f = await fixture()
  assert.deepEqual(f.ctx.tools.schemas().map(tool => tool.name).sort(), ['cancel_image_generation_task', 'edit_image', 'generate_image', 'get_image_generation_task'])
  assert.equal(ImageGen.name, 'emate-imagegen')
  assert.deepEqual(f.capability[0].actions, [])
  assert.equal((await f.capability[0].status()).state, 'ready')
  assert.equal(ImageGen.managedChannel(new URL('https://images.example.test/v1')).models[0].id, 'gpt-image-2.5-flare')
  for (const root of ['http://localhost/v1', 'https://u:p@images.example.test/v1', 'https://images.example.test/v1?x=1']) assert.throws(() => ImageGen.managedRoot(root))
  const rejected = await f.call('generate_image', { prompt: 'fixture', model: 'gpt-image-2' })
  assert.equal(rejected.isError, true)
  assert.equal(f.calls.length, 0)
})

test('native Tool returns JSON references, native CAS stores actual bytes, and presentation/Session expose images', async () => {
  const f = await fixture()
  const result = await f.call('generate_image', { prompt: 'fixture', count: 2 })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.requested_count, 2)
  assert.equal(result.value.returned_count, 2)
  assert.equal(result.value.failed_count, 0)
  assert.deepEqual(result.content.map(block => block.type), ['text'])
  assert.equal(JSON.stringify(result.content).includes(PNG.toString('base64')), false)
  assert.equal(JSON.stringify(result.content).includes('data:image'), false)
  assert.equal(result.meta.images.length, 2)
  const receipt = receipts(f.agent).at(-1)
  assert.equal(receipt.schema_version, 3)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.revision, 2)
  assert.equal(receipt.content.length, 2)
  assert.equal(receipt.turn, 1)
  assert.deepEqual([...receipt.provider_request_ids].sort(), ['fixture-1', 'fixture-2'])
  assert.equal(new Set(receipt.client_request_ids).size, 2)
  for (const block of receipt.content) {
    const stored = await f.ctx.attachments.readImage(block.attachment)
    assert.deepEqual(Buffer.from(stored.data), PNG)
    assert.equal(block.attachment.attachmentId, `sha256:${createHash('sha256').update(PNG).digest('hex')}`)
  }
  const view = f.ctx.tools.get('generate_image').presentResult({ prompt: 'fixture', count: 2 }, result)
  assert.equal(view.content.length, 2)
  assert.equal(view.content[0].type, 'image')
  for (const { url, init } of f.calls) {
    assert.equal(url, 'https://images.example.test/v1/images/generations')
    assert.equal(new Headers(init.headers).has('authorization'), false)
    assert.equal(init.redirect, 'error')
    assert.equal(JSON.parse(init.body).model, ImageGen.IMAGE_MODEL)
    assert.equal('n' in JSON.parse(init.body), false)
    assert.ok(receipt.client_request_ids.includes(new Headers(init.headers).get('x-client-request-id')))
  }
  const job = f.ctx.jobs.get(receipt.job_id, f.agent)
  await f.ctx.jobs.wait(job.id, 1000, f.agent)
  assert.equal(f.ctx.jobs.get(job.id, f.agent).status, 'completed')
})

test('PTC nested tool keeps JSON-only model output and durable images when native metadata is suppressed', async () => {
  const f = await fixture()
  const result = await f.call('generate_image', { prompt: 'nested fixture' }, { callId: 'code-root:code:1', rootCallId: 'code-root', parent: Symbol('PTC') })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.meta, undefined)
  assert.deepEqual(result.content.map(block => block.type), ['text'])
  const receipt = receipts(f.agent).at(-1)
  assert.equal(receipt.call_id, 'code-root:code:1')
  assert.equal(receipt.root_call_id, 'code-root')
  assert.equal(receipt.turn, 1)
  assert.equal(receipt.tool_name, 'generate_image')
  assert.equal(receipt.content[0].type, 'image')
  assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(receipt.content[0].attachment)).data), PNG)
})

test('explicit uploaded and generated image references remain editable; foreign and tampered refs are refused', async () => {
  const f = await fixture()
  const uploaded = await f.ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'uploaded.png' })
  f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'image', attachment: uploaded }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const edit = await f.call('edit_image', { prompt: 'edit the uploaded image', source_image: snake(uploaded) }, { parent: Symbol('PTC'), rootCallId: 'edit-code', callId: 'edit-code:code:1' })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.equal(f.calls[0].url.endsWith('/images/edits'), true)
  assert.deepEqual(Buffer.from(await f.calls[0].init.body.get('image').arrayBuffer()), PNG)
  assert.deepEqual(receipts(f.agent).at(-1).sources, [uploaded])
  const second = await f.call('edit_image', { prompt: 'edit the actual output', source_image: edit.value.images[0] })
  assert.equal(second.isError, false, JSON.stringify(second))
  const count = f.calls.length
  const foreign = await f.call('edit_image', { prompt: 'foreign', source_image: edit.value.images[0] }, { agent: f.owner('other') })
  assert.equal(foreign.isError, true)
  const tampered = await f.call('edit_image', { prompt: 'tampered', source_image: { ...snake(uploaded), width: 2 } })
  assert.equal(tampered.isError, true)
  assert.equal(f.calls.length, count)
  assert.equal(ImageGen.sessionImageRefs(f.agent.session).some(ref => ref.name === 'uploaded.png'), true)
})

test('background task commits images to its original call and supports owner-scoped query and cancellation', async () => {
  const finish = deferred()
  const f = await fixture(async (_url, _init, ordinal) => { await finish.promise; return success(`background-${ordinal}`) })
  const start = await f.call('generate_image', { prompt: 'background', wait_for_completion: false }, { callId: 'bg' })
  assert.equal(start.isError, false, JSON.stringify(start))
  assert.ok(['queued', 'running'].includes(start.value.status))
  assert.equal(start.value.images.length, 0)
  const other = f.owner('foreign')
  assert.equal((await f.call('get_image_generation_task', { task_id: start.value.task_id }, { agent: other })).isError, true)
  assert.equal((await f.call('cancel_image_generation_task', { task_id: start.value.task_id }, { agent: other })).isError, true)
  finish.resolve()
  const job = receipts(f.agent)[0].job_id
  await f.ctx.jobs.wait(job, 1000, f.agent)
  const receipt = receipts(f.agent).at(-1)
  assert.equal(receipt.call_id, 'bg')
  assert.equal(receipt.content.length, 1)
  const queried = await f.call('get_image_generation_task', { task_id: start.value.task_id })
  assert.equal(queried.isError, false, JSON.stringify(queried))
  assert.equal(queried.value.images.length, 1)
  assert.equal(f.calls.length, 1)
})

test('cancellation waits for provider cleanup through the native Job', async () => {
  const begun = deferred(), released = deferred()
  let cleaned = false
  const f = await fixture(async (_url, init) => {
    begun.resolve()
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
    await released.promise
    cleaned = true
    throw new Error('fixture aborted')
  })
  const start = await f.call('generate_image', { prompt: 'cancel', wait_for_completion: false })
  await begun.promise
  const cancel = f.call('cancel_image_generation_task', { task_id: start.value.task_id })
  await new Promise(resolve => setTimeout(resolve, 10))
  const jobId = receipts(f.agent)[0].job_id
  assert.equal(f.ctx.jobs.get(jobId, f.agent).status, 'stopping')
  assert.equal(cleaned, false)
  released.resolve()
  const result = await cancel
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(cleaned, true)
  assert.equal(result.value.status, 'cancelled')
  await f.ctx.jobs.wait(jobId, 1000, f.agent)
  assert.equal(f.ctx.jobs.get(jobId, f.agent).status, 'killed')
})

test('partial provider failure retains successful bytes and accurately reports requested versus returned counts', async () => {
  const slow = deferred(), started = deferred()
  const f = await fixture(async (_url, _init, ordinal) => {
    if (ordinal === 1) return new Response(JSON.stringify({ error: { message: 'fixture provider rejected' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    started.resolve(); await slow.promise; return success('partial-success')
  })
  const pending = f.call('generate_image', { prompt: 'partial', count: 2 })
  await started.promise
  assert.equal(receipts(f.agent).at(-1).status, 'running')
  slow.resolve()
  const result = await pending
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.requested_count, 2)
  assert.equal(result.value.returned_count, 1)
  assert.equal(result.value.failed_count, 1)
  assert.match(result.value.message, /requested 2, returned 1/u)
  assert.match(result.value.error, /fixture provider rejected/u)
  assert.equal(receipts(f.agent).at(-1).content.length, 1)
  assert.equal(f.calls.length, 2)
})

test('persisted task query survives host recreation without re-generating or reading another Session', async () => {
  const f = await fixture()
  const generated = await f.call('generate_image', { prompt: 'persisted' })
  assert.equal(generated.isError, false, JSON.stringify(generated))
  const restored = Session.create(f.agent.id, f.agent.session.events, f.agent.session.header)
  const { host } = ImageGen.createImageHost(f.ctx, ImageGen.managedRoot('https://images.example.test/v1'))
  const task = await host.find(generated.value.task_id, { agent: { ...f.agent, session: restored }, callId: 'recover', rootCallId: 'recover' })
  const refs = await host.images(task)
  assert.equal(refs.length, 1)
  assert.equal(task.status, 'completed')
  assert.equal(f.calls.length, 1)
  await assert.rejects(host.find(task.id, { agent: f.owner('new-owner'), callId: 'reject', rootCallId: 'reject' }))
})

test('untrusted image URLs, missing request receipts and oversized responses cannot escape managed transport', async () => {
  for (const response of [
    () => json({ id: 'url-response', data: [{ url: 'https://attacker.example/image.png' }] }),
    () => json({ data: [{ b64_json: PNG.toString('base64') }] }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(100 * 1024 * 1024) } }),
  ]) {
    const f = await fixture(async () => response())
    const result = await f.call('generate_image', { prompt: 'reject untrusted result' })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.status, 'failed')
    assert.equal(result.value.returned_count, 0)
    assert.equal(f.calls.length, 1)
    assert.equal(receipts(f.agent).at(-1).status, 'failed')
  }
})

test('image count outside the upstream 1–4 tool boundary is rejected without silently changing quantity', async () => {
  const f = await fixture()
  for (const count of [0, 5, 1.5]) {
    const result = await f.call('generate_image', { prompt: 'invalid quantity', count })
    assert.equal(result.isError, true)
  }
  assert.equal(f.calls.length, 0)
})

test('native typed tool-result image blocks confer edit scope without parsing arbitrary JSON', async () => {
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
  const session = { header: { id: 's' }, events: [
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', isError: false, content: [{ type: 'image', attachment: ref }] }] } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: JSON.stringify({ type: 'image', attachment: { ...ref, name: 'untrusted' } }) }] } } },
  ] }
  assert.deepEqual(ImageGen.sessionImageRefs(session), [ref])
})

test('settled queue retains neither base64 outputs nor edit bytes, and native receipts remain the durable source', async () => {
  const f = await fixture()
  const { runtime, host } = ImageGen.createImageHost(f.ctx, ImageGen.managedRoot('https://images.example.test/v1'))
  const task = await host.submit({ mode: 'edit', model: ImageGen.IMAGE_MODEL, upstream: ImageGen.IMAGE_MODEL,
    prompt: 'memory fixture', size: 'auto', quality: 'auto', n: 1, detail: '', image: `data:image/png;base64,${PNG.toString('base64')}`, images: [`data:image/png;base64,${PNG.toString('base64')}`] },
  { agent: f.agent, callId: 'memory', rootCallId: 'memory', signal: new AbortController().signal })
  const job = receipts(f.agent).at(-1).job_id
  await f.ctx.jobs.wait(job, 1000, f.agent)
  const retained = runtime.queue.list().find(item => item.id === task.id)
  assert.equal(retained.request.image, undefined)
  assert.equal(retained.request.images, undefined)
  assert.deepEqual(retained.result.images, [])
  assert.equal(JSON.stringify(retained).includes(PNG.toString('base64')), false)
  const recovered = await host.find(task.id, { agent: f.agent, callId: 'memory-query', rootCallId: 'memory-query' })
  assert.equal((await host.images(recovered)).length, 1)
})

test('upstream source manifest pins exact Apache source and explicitly records every local adaptation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../upstream-manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.commit, '1f0ec46bdc477835202d9d497744eaa18692b4e0')
  assert.equal(manifest.version, '1.5.11')
  assert.equal(manifest.license, 'Apache-2.0')
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(`../${file.path}`, import.meta.url))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
    assert.equal(file.modified, file.upstreamSha256 !== file.sha256)
  }
  assert.match(await readFile(new URL('../LICENSE', import.meta.url), 'utf8'), /Apache License/u)
})

test('ordered multi-source edit uses one upstream multipart operation and refuses mixed foreign sources', async () => {
  const f = await fixture()
  const first = await f.ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'first.png' })
  const second = await f.ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'second.png' })
  const foreign = await f.ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'foreign.png' })
  f.agent.session.append('user/message', createUserMessage({ content: [first, second].map(attachment => ({ type: 'image', attachment })), source: { kind: 'user' } }), { surfaceOp: 'append' })
  const result = await f.call('edit_image', { prompt: 'combine first subject with second composition', source_images: [snake(first), snake(second)] })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url.endsWith('/images/edits'), true)
  const images = f.calls[0].init.body.getAll('image[]')
  assert.equal(images.length, 2)
  for (const file of images) assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
  assert.deepEqual(receipts(f.agent).at(-1).sources, [first, second])
  for (const args of [
    { source_images: [snake(first), snake(foreign)] },
    { source_images: [snake(first)], source_image: snake(first) },
    { source_images: [] },
    { source_images: Array.from({ length: 17 }, () => snake(first)) },
    {},
  ]) {
    const failed = await f.call('edit_image', { prompt: 'invalid sources', ...args })
    assert.equal(failed.isError, true, JSON.stringify(failed))
  }
  assert.equal(f.calls.length, 1)
})

test('the existing queue admits 2+1+1 together inside one four-request budget', async () => {
  const release = deferred(), four = deferred()
  let active = 0, peak = 0
  const f = await fixture(async (_url, _init, ordinal) => {
    active += 1; peak = Math.max(peak, active)
    if (ordinal === 4) four.resolve()
    await release.promise
    active -= 1
    return success(`mixed-${ordinal}`)
  })
  const pending = [2, 1, 1].map(count => f.call('generate_image', { prompt: 'mixed budget', count }))
  await four.promise
  assert.equal(f.calls.length, 4)
  assert.equal(active, 4)
  release.resolve()
  const results = await Promise.all(pending)
  assert.equal(peak, 4)
  assert.deepEqual(results.map(result => result.value.returned_count), [2, 1, 1])
})

test('two count-four calls use two waves and never fan out eight provider requests', async () => {
  const wave = deferred(), firstFour = deferred()
  let active = 0, peak = 0
  const f = await fixture(async (_url, _init, ordinal) => {
    active += 1; peak = Math.max(peak, active)
    if (ordinal === 4) firstFour.resolve()
    if (ordinal <= 4) await wave.promise
    active -= 1
    return success(`waves-${ordinal}`)
  })
  const pending = [1, 2].map(() => f.call('generate_image', { prompt: 'four images', count: 4 }))
  await firstFour.promise
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.calls.length, 4)
  wave.resolve()
  const results = await Promise.all(pending)
  assert.equal(peak, 4)
  assert.equal(f.calls.length, 8)
  assert.deepEqual(results.map(result => result.value.returned_count), [4, 4])
})

test('cancelled count-four work retains its queue budget until every provider resource is released', async () => {
  const started = deferred(), cleanup = deferred()
  let active = 0, peak = 0, cleaned = 0
  const f = await fixture(async (_url, init, ordinal) => {
    active += 1; peak = Math.max(peak, active)
    if (ordinal === 4) started.resolve()
    if (ordinal <= 4) {
      await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
      await cleanup.promise
      active -= 1; cleaned += 1
      throw new Error('fixture cancelled and cleaned')
    }
    active -= 1
    return success('after-cancel')
  })
  const first = await f.call('generate_image', { prompt: 'cancel four', count: 4, wait_for_completion: false })
  await started.promise
  const later = f.call('generate_image', { prompt: 'one queued image' })
  const cancelled = f.call('cancel_image_generation_task', { task_id: first.value.task_id })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.calls.length, 4)
  assert.equal(active, 4)
  cleanup.resolve()
  const [cancelResult, laterResult] = await Promise.all([cancelled, later])
  assert.equal(cancelResult.value.status, 'cancelled')
  assert.equal(laterResult.value.returned_count, 1)
  assert.equal(cleaned, 4)
  assert.equal(peak, 4)
  assert.equal(f.calls.length, 5)
})

test('completed cache stays bounded and an evicted task is recovered only from its owning Session', async () => {
  const f = await fixture(async () => new Response(JSON.stringify({ error: { message: 'cache fixture' } }), { status: 503, headers: { 'content-type': 'application/json' } }))
  const { runtime, host } = ImageGen.createImageHost(f.ctx, ImageGen.managedRoot('https://images.example.test/v1'))
  let first
  for (let index = 0; index < 260; index += 1) {
    const task = await host.submit({ mode: 'text', model: ImageGen.IMAGE_MODEL, upstream: ImageGen.IMAGE_MODEL,
      prompt: 'bounded cache', size: 'auto', quality: 'auto', n: 1, detail: '' },
    { agent: f.agent, callId: `cache-${index}`, rootCallId: `cache-${index}`, signal: new AbortController().signal })
    first ??= task.id
    await f.ctx.jobs.wait(receipts(f.agent).at(-1).job_id, 1000, f.agent)
  }
  assert.equal(runtime.queue.list().length, 256)
  assert.equal(runtime.queue.list().some(task => task.id === first), false)
  const restored = await host.find(first, { agent: f.agent, callId: 'old-query', rootCallId: 'old-query' })
  assert.equal(restored.status, 'failed')
  assert.deepEqual(await host.images(restored), [])
  assert.equal(f.calls.length, 260)
  assert.ok(runtime.queue.list().length <= 256)
})

test('cancelling after one provider success preserves that actual image in CAS, cancelled receipt and explicit edit scope', async () => {
  const secondStarted = deferred()
  const f = await fixture(async (_url, init, ordinal) => {
    if (ordinal === 1) return success('success-before-cancel')
    if (ordinal > 2) return success('edit-retained-output')
    secondStarted.resolve()
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('fixture unfinished image cancelled')
  })
  const first = await f.call('generate_image', { prompt: 'partly finished', count: 2, wait_for_completion: false })
  await secondStarted.promise
  await new Promise(resolve => setImmediate(resolve))
  const cancelled = await f.call('cancel_image_generation_task', { task_id: first.value.task_id })
  assert.equal(cancelled.isError, false, JSON.stringify(cancelled))
  assert.equal(cancelled.value.status, 'cancelled')
  assert.equal(cancelled.value.requested_count, 2)
  assert.equal(cancelled.value.returned_count, 1)
  assert.equal(cancelled.value.failed_count, 1)
  assert.match(cancelled.value.message, /requested 2, returned 1/u)
  const receipt = receipts(f.agent).at(-1)
  assert.equal(receipt.status, 'cancelled')
  assert.equal(receipt.content.length, 1)
  assert.deepEqual(receipt.provider_request_ids, ['success-before-cancel'])
  assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(receipt.content[0].attachment)).data), PNG)
  const edit = await f.call('edit_image', { prompt: 'edit the retained success', source_image: cancelled.value.images[0] })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.equal(f.calls.length, 3)
})

test('actual Model Gateway validates default count-two generation, independent usage scopes, multi-source edit and supported sizes', async () => {
  const { createModelGatewayServer, InMemoryUsageStore } = await import('../../../enterprise/apps/model-gateway/src/server.ts')
  const { createRequire } = await import('node:module')
  const gatewayRequire = createRequire(new URL('../../../enterprise/apps/model-gateway/src/server.ts', import.meta.url))
  const { InMemoryConsentStore } = await import(gatewayRequire.resolve('@e-mate/consent-store'))
  const { generateKeyPairSync } = await import('node:crypto')
  const { once } = await import('node:events')
  const principal = { tenantId: 'imagegen-fixture', userId: 'fixture-user', modelIds: [ImageGen.IMAGE_MODEL] }
  const policy = { schemaVersion: 1, agreementId: 'e-mate-platform-terms', agreementVersion: '1.0.0', disclaimerVersion: '1.0.0', contentHash: 'a'.repeat(64) }
  const consentStore = new InMemoryConsentStore(policy)
  await consentStore.accept(principal, { ...policy, termsAccepted: true, policyRead: true, lawfulUseConfirmed: true, clientVersion: '2.0.18', locale: 'zh-CN' })
  const usageStore = new InMemoryUsageStore({ tenantRequestsPerMinute: 1000, tenantBurst: 1000, tenantMaxConcurrent: 4, invocationLeaseMs: 180_000 })
  const prepare = usageStore.prepare.bind(usageStore), finalize = usageStore.finalize.bind(usageStore)
  const invocationFacts = [], finalized = [], upstreamRequests = []
  usageStore.prepare = async fact => { invocationFacts.push(structuredClone(fact)); return prepare(fact) }
  usageStore.finalize = async (identity, taskId) => { const usage = await finalize(identity, taskId); finalized.push(usage); return usage }
  const route = { id: ImageGen.IMAGE_MODEL, apiMode: 'images-generations', upstreamModelId: ImageGen.IMAGE_MODEL,
    upstreamBaseUrl: 'https://fixture-provider.example/v1', upstreamApiKey: 'fixture-provider-key', providerId: 'fixture-provider',
    label: 'Fixture image', buttonLabel: 'Fixture image', provider: 'Fixture', providerMark: 'F', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 32_000 }
  const server = createModelGatewayServer({ routes: [route], authenticate: async token => token === 's'.repeat(64) ? principal : null,
    tenantModelRoutePolicy: { isEnabled: async () => true }, consentStore, usageStore,
    usageKeyId: 'fixture-usage', usagePrivateKey: generateKeyPairSync('ed25519').privateKey,
    fetchImplementation: async (input, init) => {
      upstreamRequests.push(new Request(input, init))
      return json({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })
    } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  const localRoot = `http://127.0.0.1:${address.port}`
  try {
    const f = await fixture(async (url, init) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${'s'.repeat(64)}`)
      return fetch(`${localRoot}${new URL(url).pathname}`, { ...init, headers })
    })
    const generated = await f.call('generate_image', { prompt: 'actual gateway defaults', count: 2 })
    assert.equal(generated.isError, false, JSON.stringify(generated))
    assert.equal(generated.value.returned_count, 2, JSON.stringify(generated))
    assert.equal(generated.value.failed_count, 0)
    assert.equal(invocationFacts.length, 2)
    assert.equal(new Set(invocationFacts.map(fact => fact.taskId)).size, 2)
    assert.equal(finalized.length, 2)
    assert.equal(new Set(finalized.map(usage => usage.usageId)).size, 2)
    const receipt = receipts(f.agent).at(-1)
    assert.equal(receipt.request_receipts.length, 2)
    for (const request of receipt.request_receipts) {
      assert.equal(request.task_id, request.client_request_id)
      assert.equal(request.trace_id, request.client_request_id)
      assert.notEqual(request.task_id, receipt.task_id)
      const invocation = invocationFacts.find(fact => fact.taskId === request.task_id)
      assert.equal(invocation.traceId, request.trace_id)
      assert.ok(receipt.provider_request_ids.includes(request.provider_request_id))
      assert.equal(request.image_sha256, createHash('sha256').update(PNG).digest('hex'))
      assert.ok(receipt.content.some(block => block.attachment.attachmentId === `sha256:${request.image_sha256}`))
    }
    for (const request of upstreamRequests) assert.deepEqual(await request.clone().json(), {
      model: ImageGen.IMAGE_MODEL, prompt: 'actual gateway defaults', n: 1, response_format: 'b64_json',
    })
    const edited = await f.call('edit_image', { prompt: 'actual gateway multi-source edit', source_images: generated.value.images })
    assert.equal(edited.isError, false, JSON.stringify(edited))
    assert.equal(edited.value.returned_count, 1)
    assert.equal(upstreamRequests.length, 3)
    const editForm = await upstreamRequests[2].clone().formData()
    assert.deepEqual([...new Set(editForm.keys())].sort(), ['image[]', 'model', 'n', 'prompt', 'response_format'])
    assert.equal(editForm.getAll('image[]').length, 2)
    for (const file of editForm.getAll('image[]')) assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
    const sized = await f.call('generate_image', { prompt: 'actual supported size', size: '1024x1536' })
    assert.equal(sized.isError, false, JSON.stringify(sized))
    assert.equal(sized.value.returned_count, 1)
    assert.equal((await upstreamRequests[3].clone().json()).size, '1024x1536')
    const count = f.calls.length
    for (const [name, args] of [
      ['generate_image', { quality: '2k' }], ['generate_image', { detail: 'high' }], ['generate_image', { size: '16:9' }],
      ['edit_image', { source_image: generated.value.images[0], size: '1:1' }],
      ['edit_image', { source_image: generated.value.images[0], quality: '1k' }],
    ]) {
      const result = await f.call(name, { prompt: 'unsupported managed parameter', ...args })
      assert.equal(result.isError, true, JSON.stringify(result))
    }
    assert.equal(f.calls.length, count)
    assert.equal(upstreamRequests.length, 4)
    assert.equal(finalized.length, 4)
    assert.equal((await usageStore.currentAccountUsage(principal)).totalTokens, 12)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('one corrupt provider image cannot discard a valid sibling; query and edit use the saved partial result', async () => {
  const f = await fixture(async (_url, _init, ordinal) => ordinal === 2
    ? json({ id: 'invalid-image', data: [{ b64_json: Buffer.from('not an encoded image').toString('base64') }] })
    : success(`valid-image-${ordinal}`))
  const generated = await f.call('generate_image', { prompt: 'valid plus corrupt', count: 2 })
  assert.equal(generated.isError, false, JSON.stringify(generated))
  assert.equal(generated.value.status, 'completed')
  assert.equal(generated.value.returned_count, 1)
  assert.equal(generated.value.failed_count, 1)
  assert.ok(generated.value.error)
  const receipt = receipts(f.agent).at(-1)
  assert.equal(receipt.content.length, 1)
  assert.equal(receipt.returned_count, 1)
  const queried = await f.call('get_image_generation_task', { task_id: generated.value.task_id })
  assert.deepEqual(queried.value.images, generated.value.images)
  assert.equal(queried.value.error, generated.value.error)
  const edit = await f.call('edit_image', { prompt: 'use the actual valid output', source_image: generated.value.images[0] })
  assert.equal(edit.isError, false, JSON.stringify(edit))
  assert.equal(edit.value.returned_count, 1)
  assert.equal(f.calls.length, 3)
})

test('all structurally invalid outputs become an honest failed task with no image presentation', async () => {
  const f = await fixture(async () => json({ id: 'corrupt-only', data: [{ b64_json: Buffer.from('not an encoded image').toString('base64') }] }))
  const generated = await f.call('generate_image', { prompt: 'corrupt only' })
  assert.equal(generated.isError, false, JSON.stringify(generated))
  assert.equal(generated.value.status, 'failed')
  assert.equal(generated.value.returned_count, 0)
  assert.equal(generated.value.failed_count, 1)
  assert.ok(generated.value.error)
  assert.deepEqual(generated.meta.images, [])
  assert.deepEqual(receipts(f.agent).at(-1).content, [])
  const queried = await f.call('get_image_generation_task', { task_id: generated.value.task_id })
  assert.equal(queried.value.status, 'failed')
  assert.equal(queried.value.error, generated.value.error)
})
