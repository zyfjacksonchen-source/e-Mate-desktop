/** e-Mate host adapter for the pinned dsh-imagegen execution engine. */
import { createHash } from 'node:crypto'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ImageGenerationRuntime, type RuntimeChannel } from './upstream/generation-runtime.ts'
import { type AgentImageRef, type AgentImageToolHost, projectRef, restoreRef, toSaveImage, waitForAgentImageTask } from './upstream/agent-image-tools.ts'
import type { GenerateRequest, GenerationTask } from './upstream/protocol.ts'

export const IMAGE_MODEL = 'gpt-image-2.5-flare'
const CHANNEL = 'emate-managed'
const HASH = /^sha256:[0-9a-f]{64}$/u
const MAX_EDIT_BYTES = 5 * 1024 * 1024
const MAX_EDIT_IMAGES = 16
const MAX_PROMPT_CHARS = 20_000
const MAX_ERROR_BYTES = 16 * 1024
const COMPLETED_TASK_CACHE_LIMIT = 256
const isRecord = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1024)

export interface ImageRequestReceipt {
  client_request_id: string
  task_id: string
  trace_id: string
  provider_request_id?: string
  image_sha256?: string
}
export interface ImageOutputReceipt {
  schema_version: 3
  revision: 1 | 2
  call_id: string
  root_call_id: string
  turn?: number
  tool_name: 'generate_image' | 'edit_image'
  task_id: string
  parent_session_id: string
  operation: 'generate' | 'edit'
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  sources: ImageAttachmentRef[]
  content: Array<{ type: 'image'; attachment: ImageAttachmentRef }>
  model: typeof IMAGE_MODEL
  requested_count: number
  returned_count: number
  failed_count: number
  job_id: string
  client_request_ids: string[]
  provider_request_ids: string[]
  request_receipts: ImageRequestReceipt[]
  error?: string
}
interface Scope {
  exec: ToolRunContext
  owner: any
  sources: ImageAttachmentRef[]
  operation: 'generate' | 'edit'
  requestedCount: number
  taskId: string
  jobId: string
  clientIds: string[]
  providerIds: string[]
  requestReceipts: ImageRequestReceipt[]
  final?: Promise<void>
  refs?: ImageAttachmentRef[]
  receipt?: ImageOutputReceipt
}

export function managedRoot(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('企业管理端尚未下发生图服务地址。')
  const root = new URL(value)
  root.pathname = root.pathname.replace(/\/+$/u, '')
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash || !root.pathname.endsWith('/v1')) {
    throw new Error('图像服务必须使用企业管理的 HTTPS Model Gateway /v1 地址。')
  }
  return root
}

/** One channel resolves only to the existing enterprise identity transport. */
export function managedChannel(root: URL, request?: typeof fetch): RuntimeChannel {
  return { id: CHANNEL, name: 'e-Mate', preset: '', apiUrl: root.href, models: [{ alias: IMAGE_MODEL, id: IMAGE_MODEL }],
    // Upstream checks that a credential exists; this marker is removed before
    // identity.request supplies the real account credential. It is not an API key.
    apiKey: 'managed-by-emate-identity', request }
}

function ownerOf(exec: ToolRunContext): any {
  const owner = exec.agent
  if (!owner?.session?.header?.id || !exec.callId || !exec.rootCallId) throw new Error('图片工具需要原生 Agent、Session 和 Tool 调用身份。')
  return owner
}
function sameRef(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId && left.mediaType === right.mediaType && left.bytes === right.bytes
    && left.width === right.width && left.height === right.height && left.name === right.name
}
function readRef(value: unknown): ImageAttachmentRef | undefined {
  if (!isRecord(value) || typeof value.attachmentId !== 'string' || !HASH.test(value.attachmentId)) return
  try { return restoreRef({ attachment_id: value.attachmentId, media_type: value.mediaType, bytes: value.bytes,
    width: value.width, height: value.height, ...(typeof value.name === 'string' ? { name: value.name } : {}) }) } catch { return }
}

/** Only native image blocks and successful durable receipts confer edit access. */
export function sessionImageRefs(session: any): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  const collect = (content: unknown) => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (isRecord(block) && block.type === 'image') {
        const ref = readRef(block.attachment)
        if (ref) refs.push(ref)
      } else if (isRecord(block) && block.type === 'tool-result' && block.isError !== true) collect(block.content)
    }
  }
  for (const event of session.snapshotEvents()) {
    if (['user/message', 'assistant/message', 'emate/image-draft-staged'].includes(event.type)) {
      collect(event.data?.content); collect(event.data?.message?.content)
    }
    if (event.type === 'tool/result' && event.data?.message?.isError !== true) collect(event.data?.message?.content)
    if (event.type === 'emate/image-output' && event.data?.parent_session_id === session.header.id
      && (event.data.schema_version === 2 && event.data.status === 'completed'
        || event.data.schema_version === 3 && ['completed', 'cancelled', 'failed'].includes(event.data.status))) collect(event.data.content)
  }
  return refs
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  // Fetch exposes decoded bytes; compressed Content-Length is a wire length.
  if (!response.headers.get('content-encoding') && contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
    await response.body?.cancel(); throw new Error('图像服务响应超过字节上限。')
  }
  if (!response.body) throw new Error('图像服务响应缺少内容。')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximum) throw new Error('图像服务响应超过字节上限。')
      chunks.push(chunk.value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  return Buffer.concat(chunks, bytes)
}

/** Authenticated calls cannot follow provider-returned URLs or change models. */
function scopedTransport(ctx: any, root: URL, scope: Scope, correlation: string): typeof fetch {
  return async (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    if (target.origin !== root.origin || ![`${root.pathname}/images/generations`, `${root.pathname}/images/edits`].includes(target.pathname)
      || target.username || target.password || target.search || target.hash || init.method !== 'POST') {
      throw new Error('图像请求超出企业图像服务边界。')
    }
    const bodyModel = init.body instanceof FormData ? init.body.get('model')
      : typeof init.body === 'string' ? JSON.parse(init.body).model : undefined
    if (bodyModel !== IMAGE_MODEL) throw new Error('图像请求必须使用企业固定模型。')
    await ctx.emateModelPolicy.assertModel(IMAGE_MODEL)
    init.signal?.throwIfAborted()
    const clientId = `${correlation}-${scope.clientIds.length + 1}`
    scope.clientIds.push(clientId)
    const requestReceipt: ImageRequestReceipt = { client_request_id: clientId, task_id: clientId, trace_id: clientId }
    scope.requestReceipts.push(requestReceipt)
    const headers = new Headers(init.headers)
    headers.delete('authorization')
    headers.set('accept', 'application/json')
    headers.set('x-e-mate-task-id', clientId)
    headers.set('x-e-mate-trace-id', clientId)
    headers.set('session_id', clientId)
    headers.set('x-client-request-id', clientId)
    const response = await ctx.emateIdentity.request(target, { ...init, headers, redirect: 'error' })
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel(); throw new Error(`图像服务返回非 JSON 响应（HTTP ${response.status}）。`)
    }
    const maximum = response.ok ? Math.ceil(ctx.attachments.imageLimits.maxImageBytes * 4 / 3) + 256 * 1024 : MAX_ERROR_BYTES
    const data = await boundedBody(response, maximum)
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
    if (response.ok) {
      if (typeof payload.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(payload.id)) throw new Error('图像服务缺少可核验的请求回执。')
      scope.providerIds.push(payload.id)
      requestReceipt.provider_request_id = payload.id
      // A returned-byte digest correlates out-of-order provider replies to
      // native CAS refs; it does not itself assert attachment/usage persistence.
      const encoded = payload.data?.length === 1 ? payload.data[0]?.b64_json : undefined
      if (typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
        requestReceipt.image_sha256 = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex')
      }
    }
    // The original upstream engine still owns response interpretation and image normalization.
    return new Response(data as BodyInit, { status: response.status, statusText: response.statusText,
      headers: { 'content-type': 'application/json' } })
  }
}

export function createImageHost(ctx: any, root: URL): { runtime: ImageGenerationRuntime; host: AgentImageToolHost } {
  const scopes = new Map<string, Scope>()
  const transports = new Map<string, Scope>()
  const completed = new Map<string, { refs: ImageAttachmentRef[]; receipt: ImageOutputReceipt }>()
  const remember = (receipt: ImageOutputReceipt, refs: ImageAttachmentRef[]) => {
    completed.delete(receipt.task_id)
    completed.set(receipt.task_id, { refs, receipt })
    while (completed.size > COMPLETED_TASK_CACHE_LIMIT) {
      const oldest = completed.keys().next().value!
      completed.delete(oldest)
      runtime.queue.forget(oldest)
    }
  }
  const runtime = new ImageGenerationRuntime(request => {
    const scope = transports.get(request.clientRequestId ?? '')
    if (!scope) throw new Error('图像任务缺少企业调用归属。')
    return { channels: [managedChannel(root, scopedTransport(ctx, root, scope, request.clientRequestId!))], defaultChannelId: CHANNEL }
  }, { append: async () => [] })
  const append = (scope: Scope, status: ImageOutputReceipt['status'], error?: string) => {
    const rootCall = scope.owner.session.snapshotEvents().find((event: any) => event.type === 'tool/call' && event.data?.callId === String(scope.exec.rootCallId))
    const receipt: ImageOutputReceipt = { schema_version: 3, revision: status === 'running' ? 1 : 2,
      call_id: String(scope.exec.callId), root_call_id: String(scope.exec.rootCallId),
      ...(Number.isSafeInteger(rootCall?.data?.turn) ? { turn: rootCall.data.turn } : {}),
      tool_name: scope.operation === 'generate' ? 'generate_image' : 'edit_image', task_id: scope.taskId,
      parent_session_id: String(scope.owner.session.header.id), operation: scope.operation, status,
      sources: scope.sources, content: (scope.refs ?? []).map(attachment => ({ type: 'image', attachment })),
      model: IMAGE_MODEL, requested_count: scope.requestedCount, returned_count: scope.refs?.length ?? 0,
      failed_count: status === 'running' ? 0 : Math.max(0, scope.requestedCount - (scope.refs?.length ?? 0)), job_id: scope.jobId, client_request_ids: [...scope.clientIds], provider_request_ids: [...scope.providerIds], request_receipts: scope.requestReceipts.map(receipt => ({ ...receipt })),
      ...(error ? { error } : {}) }
    scope.owner.session.append('emate/image-output', receipt, { ignorable: true })
    scope.receipt = receipt
  }
  const finish = async (scope: Scope, task: GenerationTask, correlation: string): Promise<void> => {
    try {
      try { task = await waitForAgentImageTask(runtime, task.id, undefined) }
      catch (error) {
        task = runtime.queue.list().find(item => item.id === task.id) ?? task
        if (task.status !== 'cancelled') throw error
      }
      await runtime.queue.settled(task.id)
      // A cancellation notification can precede successful sibling response cleanup.
      task = runtime.queue.list().find(item => item.id === task.id) ?? task
      const images = task.result?.images ?? []
      if (task.status === 'completed' && images.length === 0) throw new Error('图像服务没有返回实际图片。')
      if (images.length > 0) {
        // Keep native aggregate admission even though valid independent outputs
        // must survive another output's decode or storage failure.
        if (images.length > ctx.attachments.imageLimits.maxImagesPerMessage
          || images.reduce((bytes, image) => bytes + Buffer.byteLength(image.b64, 'base64'), 0) > ctx.attachments.imageLimits.maxMessageImageBytes) {
          throw new Error('图像输出超过当前原生附件数量或总字节上限。')
        }
        const saved = await Promise.allSettled(images.map(async (image, index) => {
          const bytes = Buffer.from(image.b64, 'base64')
          if (bytes.length > ctx.attachments.imageLimits.maxImageBytes || bytes.toString('base64').replace(/=+$/u, '') !== image.b64.replace(/=+$/u, '')) {
            throw new Error('图像服务返回的图片编码或大小无效。')
          }
          return await ctx.attachments.saveImage(toSaveImage(image, task.id, index)) as ImageAttachmentRef
        }))
        scope.refs = saved.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
        const errors = saved.flatMap(result => result.status === 'rejected' ? [errorText(result.reason)] : [])
        if (errors.length > 0) task.error = [task.error, ...errors].filter(Boolean).join('; ')
        if (scope.refs.length === 0 && task.status !== 'cancelled') task.status = 'failed'
      }
      append(scope, task.status === 'completed' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'failed', task.error)
    } catch (error) {
      scope.refs = []
      append(scope, 'failed', errorText(error))
      throw error
    } finally {
      runtime.queue.releaseImages(task.id)
      transports.delete(correlation)
      if (scope.receipt?.revision === 2) {
        remember(scope.receipt, scope.refs ?? [])
        scopes.delete(scope.taskId)
      }
    }
  }
  const find = async (id: string, exec: ToolRunContext): Promise<GenerationTask> => {
    const owner = ownerOf(exec)
    const scope = scopes.get(id)
    if (scope && scope.owner.session.header.id !== owner.session.header.id) throw new Error('图像任务不属于当前会话。')
    const receipt = [...owner.session.snapshotEvents()].reverse().find((event: any) => event.type === 'emate/image-output'
      && event.data?.schema_version === 3 && event.data.task_id === id && event.data.parent_session_id === owner.session.header.id)?.data as ImageOutputReceipt | undefined
    if (receipt?.revision === 2) {
      remember(receipt, receipt.content.map(block => readRef(block.attachment)).filter((ref): ref is ImageAttachmentRef => ref !== undefined))
      return { id, status: receipt.status === 'running' ? 'running' : receipt.status, createdAt: 0,
        request: { mode: receipt.operation === 'generate' ? 'text' : 'edit', model: IMAGE_MODEL, prompt: '', size: 'auto', quality: 'auto', n: receipt.requested_count, detail: '' },
        ...(receipt.error ? { error: receipt.error } : {}) }
    }
    if (!scope) throw new Error(receipt ? '图片任务在主机重启前未完成；没有可确认的终态，请勿自动重复提交。' : '当前会话中没有这个图片任务。')
    ctx.jobs.get(scope.jobId, owner)
    const task = runtime.queue.list().find(item => item.id === id)
    if (!task) throw new Error('图片任务不存在。')
    return task
  }
  const host: AgentImageToolHost = {
    async submit(request, exec, sources = []) {
      const owner = ownerOf(exec)
      exec.signal.throwIfAborted()
      if (!request.prompt.trim() || request.prompt.length > MAX_PROMPT_CHARS || request.prompt.includes('\0')) throw new Error('图片提示词必须为 1 至 20000 个字符。')
      if (request.model !== IMAGE_MODEL || request.upstream !== IMAGE_MODEL) throw new Error('图片模型不在企业授权范围内。')
      if (!['', 'auto'].includes(request.quality) || request.detail !== '') throw new Error('企业图像路由不支持显式 quality/detail 参数。')
      const pixelRatios: Record<string, string> = { '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' }
      const size = pixelRatios[request.size] ?? request.size
      if (request.mode === 'edit' ? !['', 'auto'].includes(size) : !['', 'auto', '1:1', '2:3', '3:4', '3:2', '4:3'].includes(size)) {
        throw new Error(request.mode === 'edit' ? '企业改图路由仅支持自动尺寸。' : '企业生图路由仅支持自动、1024x1024、1024x1536 或 1536x1024 尺寸。')
      }
      request = { ...request, size }
      await ctx.emateModelPolicy.assertModel(IMAGE_MODEL)
      exec.signal.throwIfAborted()
      if (owner.session.snapshotEvents().some((event: any) => event.type === 'emate/image-output' && event.data?.call_id === String(exec.callId))) {
        throw new Error('此图片调用已经有持久回执，不会重复提交。')
      }
      const correlation = `image-${createHash('sha256').update(String(owner.session.header.id)).update('\0').update(String(exec.callId)).digest('hex').slice(0, 32)}`
      if (transports.has(correlation)) throw new Error('此图片调用正在执行。')
      const scope: Scope = { exec, owner, sources, operation: request.mode === 'text' ? 'generate' : 'edit', requestedCount: request.n, taskId: '', jobId: '', clientIds: [], providerIds: [], requestReceipts: [] }
      let task: GenerationTask | undefined
      transports.set(correlation, scope)
      try {
        scope.jobId = ctx.jobs.start({ kind: 'emate-image', label: scope.operation === 'generate' ? 'Generate image' : 'Edit image', owner,
          outputLimitBytes: 16 * 1024,
          run() {
            task = runtime.queue.submit({ ...request, clientRequestId: correlation })
            scope.taskId = task.id
            scopes.set(task.id, scope)
            // A microtask lets native Job identity and the running Session receipt commit first.
            scope.final = Promise.resolve().then(() => finish(scope, task!, correlation))
            return { cancel: () => { runtime.queue.cancel(task!.id) }, done: scope.final.then(() => ({
              status: scope.receipt?.status === 'completed' ? 'completed' : scope.receipt?.status === 'cancelled' ? 'killed' : 'failed',
              output: JSON.stringify({ task_id: scope.taskId, status: scope.receipt?.status, images: (scope.refs ?? []).map(projectRef),
                requested_count: scope.requestedCount, returned_count: scope.refs?.length ?? 0,
                failed_count: scope.receipt?.failed_count, ...(scope.receipt?.error ? { error: scope.receipt.error } : {}),
                client_request_ids: scope.clientIds, provider_request_ids: scope.providerIds, request_receipts: scope.requestReceipts }),
            }), error => ({ status: 'failed', detail: errorText(error) })) }
          },
        })
        append(scope, 'running')
        return task!
      } catch (error) { transports.delete(correlation); throw error }
    },
    find,
    async cancel(id, exec) {
      const task = await find(id, exec)
      const scope = scopes.get(id)
      if (scope && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
        ctx.jobs.kill(scope.jobId, ownerOf(exec), 'Image tool cancellation')
        await scope.final
        return find(id, exec)
      }
      return task
    },
    async images(task) {
      const scope = scopes.get(task.id)
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') await scope?.final
      const terminal = completed.get(task.id)
      return (terminal?.refs ?? scope?.refs ?? []).map(projectRef)
    },
    async readSources(refs, exec) {
      const owner = ownerOf(exec)
      const known = sessionImageRefs(owner.session)
      if (refs.length < 1 || refs.length > MAX_EDIT_IMAGES
        || refs.reduce((bytes, ref) => bytes + ref.bytes, 0) > ctx.attachments.imageLimits.maxMessageImageBytes) {
        throw new Error('改图来源必须为 1 至 16 张图片，且总大小不超过当前原生附件上限。')
      }
      for (const ref of refs) {
        if (!HASH.test(ref.attachmentId) || !known.some(candidate => sameRef(candidate, ref))) {
          throw new Error('参考图片没有当前会话的原生附件记录。')
        }
        if (ref.bytes > MAX_EDIT_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mediaType)) throw new Error('改图来源必须为不超过 5 MiB 的 PNG、JPEG 或 WebP。')
      }
      return Promise.all(refs.map(ref => ctx.attachments.readImage(ref, exec.signal)))
    },
  }
  return { runtime, host }
}
