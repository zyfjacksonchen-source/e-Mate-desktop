import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

export const NATIVE_EXECUTION = 'dsh-imagegen-1.5.11-native-tools-jobs-session-v3'
export const IMAGE_MODEL = 'gpt-image-2.5-flare'
export const snakeRef = ref => ({ attachment_id: ref.attachmentId, media_type: ref.mediaType, bytes: ref.bytes,
  width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) })

let modulesPromise
export function nativeModules() {
  modulesPromise ??= Promise.all([
    import('../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/core/tools/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/core/system-prompt/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/core/agent/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/core/session/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'),
    import('../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'),
    import('../../../packages/dsh-plugin-imagegen/lib/index.js'),
  ]).then(([cordis, tools, systemPrompt, agents, sessions, jobs, attachments, llm, imagegen]) => ({
    Context: cordis.Context, Tools: tools.default, SystemPrompt: systemPrompt.default, Agents: agents.default,
    Sessions: sessions.default, Session: sessions.Session, SessionId: sessions.SessionId,
    Jobs: jobs.default, Attachments: attachments.default, ...llm, ImageGen: imagegen,
  }))
  return modulesPromise
}

// Only the existing enterprise request dependency is injected. Tools, queue, Jobs,
// CAS and Session are the real compiled owners; no fixture batch API or scheduler.
export async function createNativeImageFixture({ request, home, hooks = {} } = {}) {
  assert.equal(typeof request, 'function', 'offline fixture requires an explicit local provider')
  const m = await nativeModules(), ctx = new m.Context()
  const ownHome = home === undefined
  home ??= await mkdtemp(join(tmpdir(), 'emate-native-image-performance-'))
  const fibers = [], calls = [], receipts = [], jobTerminals = []
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber; return fiber }
  await mount(m.SystemPrompt)
  await mount(m.Tools)
  await mount(m.Agents)
  await mount(m.Sessions)
  await mount(m.Jobs, {})
  await mount(m.Attachments, { dshHome: home })
  const save = ctx.attachments.saveImage.bind(ctx.attachments)
  ctx.attachments.saveImage = async (...args) => {
    hooks.casBegin?.(performance.now(), 1)
    const ref = await save(...args)
    hooks.casEnd?.(performance.now(), [ref])
    return ref
  }
  const startJob = ctx.jobs.start.bind(ctx.jobs)
  ctx.jobs.start = spec => { hooks.jobStart?.(); return startJob(spec) }
  ctx.jobs.onJobDone((snapshot, owner) => {
    if (snapshot.kind !== 'emate-image') return
    const entry = { at: performance.now(), snapshot, owner }
    jobTerminals.push(entry); hooks.jobTerminal?.(entry)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'emate/image-output' && event.data.revision === 2) {
      const entry = { at: performance.now(), session, receipt: event.data }
      receipts.push(entry); hooks.receiptHandoff?.(entry)
    }
  })
  ctx.provide('emateIdentity', { async request(url, init) {
    const call = { url: String(url), init, at: performance.now() }; calls.push(call)
    return request(url, init, calls.length)
  } })
  ctx.provide('emateModelPolicy', { assertModel: async model => assert.equal(model, IMAGE_MODEL) })
  ctx.provide('emateCapabilities', { register: () => () => {} })
  await mount(m.ImageGen, { rootUrl: 'https://model.example/e-mate/model-api/v1' })
  let serial = 0
  async function owner(id = `native-image-owner-${randomUUID()}`) {
    const fiber = await mount(() => {})
    const session = ctx.sessions.create(m.SessionId(id))
    const append = session.append.bind(session)
    session.append = (type, data, ...options) => {
      const terminal = type === 'emate/image-output' && data.revision === 2
      if (terminal) hooks.receiptBegin?.(performance.now())
      const event = append(type, data, ...options)
      if (terminal) hooks.receiptReturn?.(performance.now())
      return event
    }
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const agent = { id: session.header.id, session, ctx: fiber.ctx, options: {}, status: 'idle', cancel() {},
      whenIdle: async () => {}, runMaintenance: async fn => fn(new AbortController().signal) }
    ctx.agents.register(agent)
    return agent
  }
  const agent = await owner()
  async function call(name, args, options = {}) {
    const target = options.agent ?? agent, callId = options.callId ?? `native-image-call-${++serial}`
    const turn = options.turn ?? 1, step = options.step ?? 1
    const block = { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }
    // 0.1.5 requires the streamed records beside the settled message; this
    // fixture builds the message directly, so no record was streamed.
    target.session.append('assistant/message', { turn, step, stream: [], message: m.createAssistantMessage({ content: [block],
      source: { provider: 'offline-fixture', model: 'no-model-call' } }) }, { surfaceOp: 'append' })
    const event = target.session.append('tool/call', { turn, step, callId, name, arguments: block.arguments })
    const result = await ctx.tools.execute({ name, arguments: args, agent: target, callId, rootCallId: callId,
      signal: options.signal ?? new AbortController().signal })
    target.session.append('tool/result', { turn, step,
      message: m.createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    return result
  }
  return { ...m, ctx, agent, owner, home, calls, receipts, jobTerminals, call,
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      if (ownHome) await rm(home, { recursive: true, force: true })
    },
  }
}
