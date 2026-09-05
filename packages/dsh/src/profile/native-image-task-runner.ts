import { randomBytes } from 'node:crypto'
import { imageBatchEventId, imageBatchId, imageBatchTaskId, normalizeImageBatchRequest, type NormalizedImageBatchTask } from './image-batch.ts'
import { reduceImageBatchEvent, type ImageBatchReducerState, type ImageBatchTaskSnapshot, type ImageBatchReceiptPointer } from './image-batch-events.ts'

const PROVIDER = 'spawn'
const LABEL_PREFIX = 'emate-image-batch:'
const TERMINAL_STATUSES = new Set(['completed', 'needs-review', 'failed', 'cancelled', 'unknown'])
const PERSONA = 'Execute exactly one e-Mate image task. Make no second Tool call and do not delegate. Use only the exact imagegen arguments in the user message. Internal typed gateway admission may retry according to its own policy.'

export interface ImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

interface SessionEventLike { readonly seq: number; readonly type: string; readonly data?: unknown }
interface SessionLike {
  readonly header: { readonly id: string; readonly origin?: string; readonly parentSession?: string }
  readonly events: readonly SessionEventLike[]
  append(type: string, data: unknown, options: { ignorable: true }): void
}
interface AgentLike { readonly id: string; readonly session: SessionLike }
interface SubagentRunLike {
  readonly id: string
  readonly localAgent: AgentLike | undefined
  readonly result: Promise<unknown>
  dispose(): Promise<void>
}
interface JobLike { readonly kind: string; readonly ownerSession?: string; readonly status: string }
interface RuntimeContext {
  effect(setup: () => () => void | Promise<void>, label: string): unknown
  readonly sessions: { flush(session: SessionLike): Promise<boolean> }
  readonly emateModelPolicy: { assertModel(model: string): Promise<unknown> }
  readonly jobs: { get(id: string, owner: AgentLike): JobLike }
  readonly subagents: {
    getProvider(name: string): { readonly inheritsParentContext: boolean; readonly capabilities?: { readonly toolFilter?: boolean; readonly persona?: boolean } } | undefined
    start(name: string, request: {
      readonly label: string
      readonly prompt: readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly attachment: ImageAttachmentRef })[]
      readonly parent: AgentLike
      readonly signal: AbortSignal
      readonly toolFilter: { readonly allow: readonly string[] }
      readonly persona: string
    }): Promise<SubagentRunLike>
  }
}
interface ToolExecution { readonly agent: AgentLike; readonly callId: string; readonly signal: AbortSignal }
interface TerminalReceipt {
  readonly call_id: string
  readonly revision: number
  readonly status: 'completed' | 'needs-review' | 'failed' | 'cancelled' | 'unknown'
  readonly billing_status: 'not-submitted' | 'recorded' | 'unknown'
  readonly parent_session_id: string
  readonly operation: 'generate' | 'edit' | 'fusion'
  readonly sources: readonly ImageAttachmentRef[]
  readonly job_id?: string
  readonly client_request_id?: string
  readonly output?: ImageAttachmentRef
  readonly failure_code?: string
}
interface ProvenImage { readonly pointer: ImageBatchReceiptPointer; readonly jobId: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function nativeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(label + ' is invalid')
  return value
}
function imageRef(value: unknown): ImageAttachmentRef {
  if (!isRecord(value)) throw new Error('native image attachment reference is invalid')
  const allowed = new Set(['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name'])
  if (Object.keys(value).some(key => !allowed.has(key))
    || typeof value.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.attachmentId)
    || typeof value.mediaType !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mediaType)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > 5 * 1024 * 1024
    || !Number.isSafeInteger(value.width) || Number(value.width) < 1 || Number(value.width) > 65_535
    || !Number.isSafeInteger(value.height) || Number(value.height) < 1 || Number(value.height) > 65_535
    || value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255 || /[\u0000/\\]/u.test(value.name))) {
    throw new Error('native image attachment reference is invalid')
  }
  return { attachmentId: value.attachmentId, mediaType: value.mediaType as ImageAttachmentRef['mediaType'],
    bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height),
    ...(value.name === undefined ? {} : { name: value.name as string }) }
}
function sameImage(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId && left.mediaType === right.mediaType && left.bytes === right.bytes
    && left.width === right.width && left.height === right.height && left.name === right.name
}
function receipt(value: unknown, owner: string, eventSeq: number, task: NormalizedImageBatchTask,
  sources: readonly ImageAttachmentRef[]): { receipt: TerminalReceipt; pointer: ImageBatchReceiptPointer } {
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) throw new Error('native image receipt event sequence is invalid')
  if (!isRecord(value) || value.schema_version !== 2 || typeof value.call_id !== 'string' || value.call_id.length === 0
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 3
    || typeof value.status !== 'string' || !TERMINAL_STATUSES.has(value.status)
    || typeof value.billing_status !== 'string' || !['not-submitted', 'recorded', 'unknown'].includes(value.billing_status)
    || value.parent_session_id !== owner || value.operation !== task.operation
    || !Array.isArray(value.sources) || value.sources.length !== sources.length || !Array.isArray(value.content)
    || value.job_id !== undefined && typeof value.job_id !== 'string'
    || value.client_request_id !== undefined && typeof value.client_request_id !== 'string'
    || value.failure_code !== undefined && typeof value.failure_code !== 'string') throw new Error('native image child receipt is invalid')
  const receiptSources = value.sources.map(imageRef)
  if (receiptSources.some((source, index) => !sameImage(source, sources[index]))) {
    throw new Error('native image child receipt sources are invalid')
  }
  const output = value.output === undefined ? undefined : imageRef(value.output)
  const block = value.content[0]
  const imageBearing = value.status === 'completed' || value.status === 'needs-review'
  if (imageBearing
    ? output === undefined || value.content.length !== 1 || !isRecord(block) || block.type !== 'image'
      || !sameImage(imageRef(block.attachment), output)
    : value.content.length !== 0) throw new Error('native image child receipt content is invalid')
  if (task.operation === 'generate' && value.status !== 'completed' && output !== undefined) {
    throw new Error('native image child receipt output status is invalid')
  }
  const parsed: TerminalReceipt = { call_id: value.call_id, revision: Number(value.revision),
    status: value.status as TerminalReceipt['status'], billing_status: value.billing_status as TerminalReceipt['billing_status'],
    parent_session_id: owner, operation: task.operation, sources: receiptSources,
    ...(value.job_id === undefined ? {} : { job_id: nativeId(value.job_id, 'native image Job ID') }),
    ...(value.client_request_id === undefined ? {} : { client_request_id: nativeId(value.client_request_id, 'native image client request ID') }),
    ...(output === undefined ? {} : { output }),
    ...(value.failure_code === undefined ? {} : { failure_code: value.failure_code }) }
  return { receipt: parsed, pointer: { owner_session_id: owner, call_id: parsed.call_id,
    revision: parsed.revision, event_seq: eventSeq, status: parsed.status } }
}
function exactTaskArgs(args: unknown, expected: NormalizedImageBatchTask): boolean {
  try {
    const actual = normalizeImageBatchRequest({ tasks: [args, args], concurrency: 1 }).tasks[0]
    return actual.prompt === expected.prompt && actual.attachmentIds.length === expected.attachmentIds.length
      && actual.attachmentIds.every((id, index) => id === expected.attachmentIds[index])
  } catch { return false }
}
function descriptor(agent: AgentLike): Record<string, unknown> | undefined {
  const events = agent.session.events.filter(event => event.type === 'subagent/descriptor')
  if (events.length === 0) return undefined
  if (events.length !== 1 || !isRecord(events[0].data)) throw new Error('image batch child descriptor is invalid')
  return events[0].data
}
function errorCode(error: unknown, opened = false): string {
  if (isRecord(error) && typeof error.code === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(error.code)) return error.code
  return opened ? 'provider-outcome-unknown' : 'contract-failed'
}
class PersistenceError extends Error { readonly code = 'persistence-failed' }

interface Gate {
  readonly nonce: string
  readonly parentSessionId: string
  readonly parentCallId: string
  readonly taskId: string
  readonly task: NormalizedImageBatchTask
  readonly parent: AgentLike
  readonly sources: readonly ImageAttachmentRef[]
  readonly controller: AbortController
  readonly opened: Promise<string>
  readonly claimed: Promise<string>
  open(): void
  fail(reason: unknown): void
  claim(childId: string): void
  detach(): void
  claimedChildId?: string
  isOpen: boolean
  settled: boolean
  run?: SubagentRunLike
  timer: ReturnType<typeof setTimeout>
}
function createGate(parentSessionId: string, parentCallId: string, taskId: string, task: NormalizedImageBatchTask,
  sources: readonly ImageAttachmentRef[], parentSignal: AbortSignal, deadlineMs: number): Gate {
  const controller = new AbortController()
  let resolveOpen!: (value: string) => void
  let rejectOpen!: (reason: unknown) => void
  let resolveClaim!: (value: string) => void
  const opened = new Promise<string>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject })
  const claimed = new Promise<string>(resolve => { resolveClaim = resolve })
  void opened.catch(() => undefined)
  const onAbort = () => gate.fail(parentSignal.reason ?? new Error('image batch cancelled'))
  const gate: Gate = {
    nonce: randomBytes(32).toString('base64url'), parentSessionId, parentCallId, taskId, task, sources, controller, opened, claimed,
    isOpen: false, settled: false,
    open() { if (!gate.settled) { gate.isOpen = true; gate.settled = true; resolveOpen(gate.taskId) } },
    fail(reason) { controller.abort(reason); if (!gate.settled) { gate.settled = true; rejectOpen(reason) } },
    claim(childId) { if (gate.claimedChildId === undefined) { gate.claimedChildId = childId; resolveClaim(childId) } },
    detach() { parentSignal.removeEventListener('abort', onAbort); clearTimeout(gate.timer) },
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  }
  if (parentSignal.aborted) onAbort()
  else parentSignal.addEventListener('abort', onAbort, { once: true })
  gate.timer = setTimeout(() => gate.fail(new Error('image batch task deadline exceeded')), deadlineMs)
  return gate
}

/** Creates effect-owned nonce gates and a bounded native child executor for image_batch. */
export function createNativeImageTaskRuntime(ctx: RuntimeContext, options: {
  deadlineMs?: number
  resolveSources?(parent: AgentLike, attachmentIds: readonly string[], signal: AbortSignal): Promise<readonly ImageAttachmentRef[]>
  readDurableResult?(parent: AgentLike, batchId: string, signal: AbortSignal): Promise<unknown>
} = {}) {
  const deadlineMs = options.deadlineMs ?? 610_000
  const lookup = new Map<string, Gate>()
  const active = new Set<Gate>()
  let disposed = false

  const abort = (gate: Gate, reason: unknown) => { lookup.delete(gate.nonce); gate.fail(reason); gate.controller.abort(reason) }
  const cleanup = async (gate: Gate) => {
    lookup.delete(gate.nonce); gate.detach()
    try { if (gate.run !== undefined) await gate.run.dispose() } finally { active.delete(gate) }
  }
  const abortAll = (reason: unknown) => { for (const gate of [...active]) abort(gate, reason) }
  ctx.effect(() => async () => {
    disposed = true
    abortAll(new Error('image batch runtime disposed'))
    await Promise.allSettled([...active].map(cleanup))
  }, 'emate.image-batch: abort active native children')

  async function claim(agent: AgentLike, args: unknown): Promise<{ taskId: string; batchId: string; ordinal: number } | undefined> {
    if (agent.session.header.origin !== 'subagent') return undefined
    const value = descriptor(agent)
    if (value === undefined || typeof value.label !== 'string' || !value.label.startsWith(LABEL_PREFIX)) return undefined
    if (value.version !== 2 || value.mode !== 'one-shot' || value.provider !== PROVIDER) throw new Error('image batch child descriptor authority is invalid')
    const gate = lookup.get(value.label.slice(LABEL_PREFIX.length))
    if (gate === undefined) throw new Error('image batch authorization is unavailable or already claimed')
    lookup.delete(gate.nonce)
    const childId = nativeId(agent.session.header.id, 'image batch child Session ID')
    gate.claim(childId)
    if (disposed || agent.id !== childId || agent.session.header.origin !== 'subagent'
      || agent.session.header.parentSession !== gate.parentSessionId) {
      abort(gate, new Error('image batch child lineage is invalid'))
      throw new Error('image batch child lineage is invalid')
    }
    if (!exactTaskArgs(args, gate.task)) {
      abort(gate, new Error('image batch child arguments do not match the admitted task'))
      throw new Error('image batch child arguments do not match the admitted task')
    }
    const taskId = await gate.opened
    gate.controller.signal.throwIfAborted()
    return { taskId, batchId: imageBatchId(gate.parentSessionId, gate.parentCallId), ordinal: gate.task.ordinal }
  }

  const flush = async (session: SessionLike, label: string) => {
    let result: boolean
    try { result = await ctx.sessions.flush(session) } catch (error) {
      throw new PersistenceError(label + ' flush failed: ' + (error instanceof Error ? error.message : 'unknown error'))
    }
    if (result !== true) throw new PersistenceError(label + ' flush did not reach durable storage')
  }
  const preflight = () => {
    const provider = ctx.subagents.getProvider(PROVIDER)
    if (provider === undefined || provider.inheritsParentContext !== false
      || provider.capabilities?.toolFilter !== true || provider.capabilities?.persona !== true) throw new Error('native spawn provider lacks required image batch capabilities')
  }
  const replayGuard = (session: SessionLike, sessionId: string, callId: string) => {
    const expectedBatch = imageBatchId(sessionId, callId)
    let prior: ImageBatchReducerState | undefined
    for (const event of session.events) {
      if (event.type !== 'emate/image-batch' || !isRecord(event.data)) continue
      if (event.data.parent_call_id !== callId && event.data.batch_id !== expectedBatch) continue
      prior = reduceImageBatchEvent(prior, event.data, sessionId)
    }
    if (prior !== undefined) throw new Error('image batch call already has a durable created event; automatic replay is disabled')
  }

  async function execute(raw: unknown, exec: ToolExecution) {
    if (disposed) throw new Error('image batch runtime is disposed')
    const request = normalizeImageBatchRequest(raw)
    const parent = exec.agent
    const session = parent.session
    const sessionId = nativeId(session.header.id, 'image batch parent Session ID')
    if (parent.id !== sessionId) throw new Error('image batch parent Agent does not own its Session')
    const callId = nativeId(exec.callId, 'image batch parent Tool call ID')
    replayGuard(session, sessionId, callId)
    const preparedSources = new Map<number, readonly ImageAttachmentRef[]>()
    if (request.tasks.some(task => task.attachmentIds.length > 0)) {
      if (options.resolveSources === undefined) throw new Error('image batch source resolution is unavailable')
      const uniqueIds = [...new Set(request.tasks.flatMap(task => task.attachmentIds))]
      const resolved = await options.resolveSources(parent, uniqueIds, exec.signal)
      if (resolved.length !== uniqueIds.length
        || resolved.some((ref, index) => ref.attachmentId !== uniqueIds[index])) {
        throw new Error('image batch source resolution did not preserve normalized attachment order')
      }
      const byId = new Map(resolved.map(ref => [ref.attachmentId, Object.freeze({ ...ref })]))
      for (const task of request.tasks) {
        if (task.attachmentIds.length === 0) continue
        preparedSources.set(task.ordinal, Object.freeze(task.attachmentIds.map(id => byId.get(id)!)))
      }
    }
    preflight()
    await ctx.emateModelPolicy.assertModel('gpt-image-2-pro')
    exec.signal.throwIfAborted()

    let state: ImageBatchReducerState | undefined
    let fatal: unknown
    const batchActive = () => [...active].filter(gate => gate.parentSessionId === sessionId && gate.parentCallId === callId)
    const failFatal = (reason: unknown) => {
      if (fatal !== undefined) return
      fatal = reason
      for (const gate of batchActive()) abort(gate, reason)
    }
    const base = () => ({ schema_version: 1 as const,
      event_id: imageBatchEventId(sessionId, callId, (state?.accepted_events.length ?? 0) + 1),
      batch_id: imageBatchId(sessionId, callId), parent_session_id: sessionId, parent_call_id: callId,
      occurred_at: new Date().toISOString() })
    let eventLane = Promise.resolve()
    const append = (data: unknown, label: string) => {
      const operation = eventLane.then(async () => {
        if (fatal !== undefined) throw fatal
        if (!isRecord(data)) throw new Error('image batch event producer received invalid data')
        const committed = { ...data, ...base() }
        const nextState = reduceImageBatchEvent(state, committed, sessionId)
        session.append('emate/image-batch', committed, { ignorable: true })
        state = nextState
        try { await flush(session, label) } catch (error) { failFatal(error); throw error }
      })
      eventLane = operation.then(() => undefined, () => undefined)
      return operation
    }
    const created: ImageBatchTaskSnapshot[] = request.tasks.map(task => ({ task_id: imageBatchTaskId(sessionId, callId, task.ordinal),
      ordinal: task.ordinal, revision: 1, state: 'queued', submission_status: 'not-submitted',
      prompt_sha256: task.promptSha256, image_url: task.attachmentIds }))
    await append({ ...base(), kind: 'created', concurrency: request.concurrency, tasks: created }, 'image batch created')
    const current = (ordinal: number) => state!.tasks[ordinal - 1]
    const appendTask = (kind: 'task-linked' | 'task-state', task: ImageBatchTaskSnapshot, label: string) => append({ ...base(), kind, task }, label)
    const stopQueued = async (task: NormalizedImageBatchTask, code: string) => {
      const snapshot = current(task.ordinal)
      if (snapshot.state !== 'queued') return
      await appendTask('task-state', { ...snapshot, revision: snapshot.revision + 1,
        state: exec.signal.aborted ? 'cancelled' : 'failed', failure_code: code, updated_at: new Date().toISOString() }, 'image batch task failure')
    }

    const runTask = async (task: NormalizedImageBatchTask) => {
      if (fatal !== undefined || exec.signal.aborted || disposed) return
      const sources = preparedSources.get(task.ordinal) ?? []
      const gate = createGate(sessionId, callId, imageBatchTaskId(sessionId, callId, task.ordinal), task, sources, exec.signal, deadlineMs)
      lookup.set(gate.nonce, gate); active.add(gate)
      let proven: ProvenImage | undefined
      let terminalPointer: ImageBatchReceiptPointer | undefined
      let terminalReceipt: TerminalReceipt | undefined
      try {
        const args = { prompt: task.prompt, image_url: [...task.attachmentIds] }
        const prompt = [task.operation === 'generate'
          ? 'Generate exactly one new image for this instruction.'
          : 'Create exactly one edited image from the attached source images in their given order.',
          'Call imagegen exactly once with these exact arguments:', JSON.stringify(args),
          'Make no second Tool call and do not delegate. Do not change these arguments or infer another image. Internal typed gateway admission may retry according to its own policy. Stop after imagegen returns.'].join('\n')
        const content = [{ type: 'text' as const, text: prompt },
          ...sources.map(source => ({ type: 'image' as const, attachment: source }))]
        const run = await ctx.subagents.start(PROVIDER, { label: LABEL_PREFIX + gate.nonce,
          prompt: content, parent, signal: gate.controller.signal,
          toolFilter: { allow: ['imagegen'] }, persona: PERSONA })
        gate.run = run
        await Promise.race([gate.claimed, run.result.then(() => { throw new Error('native image child made no authorized imagegen call') })])
        gate.controller.signal.throwIfAborted()
        if (run.localAgent === undefined || run.id !== run.localAgent.id || gate.claimedChildId === undefined
          || run.id !== gate.claimedChildId) throw new Error('native image child identity did not match its claimed gate')
        const linked = current(task.ordinal)
        await appendTask('task-linked', { ...linked, revision: linked.revision + 1,
          child_session_id: gate.claimedChildId, updated_at: new Date().toISOString() }, 'image batch task link')
        gate.open()
        await run.result
        try { await flush(run.localAgent.session, 'image batch child result') } catch (error) { failFatal(error); throw error }

        const events = [...run.localAgent.session.events]
        const calls = events.filter(event => event.type === 'tool/call' && isRecord(event.data) && event.data.name === 'imagegen')
        const terminals = events.filter(event => event.type === 'emate/image-output' && isRecord(event.data)
          && typeof event.data.status === 'string' && TERMINAL_STATUSES.has(event.data.status))
        const reviewEvents = terminals.filter(event => isRecord(event.data) && event.data.status === 'needs-review')
        const finalEvents = terminals.filter(event => isRecord(event.data) && event.data.status !== 'needs-review')
        const reviews = reviewEvents.map(event => receipt(event.data, gate.claimedChildId!, event.seq, task, sources))
        const parsed = finalEvents.map(event => receipt(event.data, gate.claimedChildId!, event.seq, task, sources))
        if (reviewEvents.length > 1 || task.operation === 'generate' && reviewEvents.length !== 0
          || reviewEvents.length === 1 && (reviews[0].receipt.revision !== 2 || parsed[0]?.receipt.revision !== 3
            || reviews[0].receipt.call_id !== parsed[0]?.receipt.call_id || reviewEvents[0].seq >= finalEvents[0]?.seq)) {
          throw new Error('native image child review receipt sequence is invalid')
        }
        const expectedFinalRevision = reviewEvents.length === 1 ? 3 : 2
        const expectedClientRequestId = `image-${gate.taskId.slice('sha256:'.length)}`
        const authorizedCallId = isRecord(calls[0]?.data) && typeof calls[0].data.callId === 'string'
          ? calls[0].data.callId : undefined
        const completedCandidates = parsed.filter(item => item.receipt.status === 'completed'
          && item.receipt.output !== undefined && item.receipt.job_id !== undefined
          && item.receipt.call_id === authorizedCallId
          && item.receipt.client_request_id === expectedClientRequestId
          && item.receipt.revision === expectedFinalRevision
          && item.pointer.event_seq > (calls[0]?.seq ?? Number.MAX_SAFE_INTEGER))
        if (completedCandidates.length > 0) {
          const completed = completedCandidates[0]
          const job = ctx.jobs.get(completed.receipt.job_id!, run.localAgent)
          if (job.kind === 'emate-image' && job.ownerSession === gate.claimedChildId && job.status === 'completed') {
            proven = { pointer: completed.pointer, jobId: completed.receipt.job_id! }
          }
        }
        if (calls.length !== 1 || finalEvents.length !== 1 || authorizedCallId === undefined
          || parsed[0]?.receipt.revision !== expectedFinalRevision) {
          throw new Error('native image child must contain exactly one legal imagegen call and terminal receipt')
        }
        terminalReceipt = parsed[0].receipt; terminalPointer = parsed[0].pointer
        if (terminalPointer.event_seq <= calls[0].seq
          || terminalReceipt.call_id !== calls[0].data.callId
          || terminalReceipt.client_request_id !== expectedClientRequestId) {
          throw new Error('native image child receipt call correlation is invalid')
        }
        const needsJob = terminalReceipt.billing_status !== 'not-submitted' || terminalReceipt.output !== undefined
        let job: JobLike | undefined
        if (needsJob) {
          if (terminalReceipt.job_id === undefined) throw new Error('submitted native image receipt is missing its Job')
          job = ctx.jobs.get(terminalReceipt.job_id, run.localAgent)
          if (job.kind !== 'emate-image' || job.ownerSession !== gate.claimedChildId
            || !['completed', 'failed', 'killed'].includes(job.status)) throw new Error('native image Job correlation is invalid')
        } else if (terminalReceipt.job_id !== undefined) {
          job = ctx.jobs.get(terminalReceipt.job_id, run.localAgent)
          if (job.kind !== 'emate-image' || job.ownerSession !== gate.claimedChildId) throw new Error('native image Job correlation is invalid')
        }
        let snapshot = current(task.ordinal)
        if (job !== undefined) {
          await appendTask('task-state', { ...snapshot, revision: snapshot.revision + 1, state: 'running',
            submission_status: terminalReceipt.billing_status === 'unknown' ? 'unknown' : terminalReceipt.billing_status === 'recorded' ? 'submitted' : 'not-submitted',
            job_id: terminalReceipt.job_id!, updated_at: new Date().toISOString() }, 'image batch task running')
          snapshot = current(task.ordinal)
        }
        const done = terminalReceipt.status === 'completed' && terminalReceipt.output !== undefined && job?.status === 'completed'
        const nextState = done ? 'completed' : terminalReceipt.status === 'cancelled' ? 'cancelled'
          : terminalReceipt.status === 'unknown' ? 'unknown' : 'failed'
        await appendTask('task-state', { ...snapshot, revision: snapshot.revision + 1, state: nextState,
          submission_status: terminalReceipt.billing_status === 'not-submitted' ? 'not-submitted'
            : terminalReceipt.billing_status === 'recorded' ? 'submitted' : 'unknown',
          ...(terminalReceipt.job_id === undefined ? {} : { job_id: terminalReceipt.job_id }), receipt: terminalPointer,
          ...(done ? {} : { failure_code: terminalReceipt.failure_code ?? 'child-contract-failed' }),
          updated_at: new Date().toISOString() }, 'image batch task terminal')
      } catch (error) {
        abort(gate, error)
        if (error instanceof PersistenceError) { failFatal(error); return }
        try {
          const snapshot = current(task.ordinal)
          if (snapshot.state === 'queued' && proven !== undefined) await appendTask('task-state', { ...snapshot,
            revision: snapshot.revision + 1, state: 'failed', submission_status: 'submitted', job_id: proven.jobId,
            receipt: proven.pointer, failure_code: 'child-contract-failed', updated_at: new Date().toISOString() }, 'image batch task failure')
          else if (snapshot.state === 'queued' && terminalPointer !== undefined && terminalReceipt !== undefined) await appendTask('task-state', { ...snapshot,
            revision: snapshot.revision + 1, state: terminalReceipt.status === 'cancelled' ? 'cancelled' : 'failed',
            submission_status: terminalReceipt.billing_status === 'not-submitted' ? 'not-submitted' : 'unknown',
            receipt: terminalPointer, failure_code: terminalReceipt.failure_code ?? 'child-contract-failed',
            updated_at: new Date().toISOString() }, 'image batch task failure')
          else if (snapshot.state === 'queued' && gate.isOpen) await appendTask('task-state', { ...snapshot,
            revision: snapshot.revision + 1, state: exec.signal.aborted ? 'cancelled' : 'unknown',
            submission_status: 'unknown', failure_code: exec.signal.aborted ? 'cancelled' : 'provider-outcome-unknown',
            updated_at: new Date().toISOString() }, 'image batch task ambiguous outcome')
          else if (snapshot.state === 'queued') await stopQueued(task, errorCode(error, false))
          else if (snapshot.state === 'running') await appendTask('task-state', { ...snapshot, revision: snapshot.revision + 1,
            state: gate.isOpen ? 'unknown' : 'failed', submission_status: gate.isOpen ? 'unknown' : 'not-submitted',
            failure_code: errorCode(error, gate.isOpen), updated_at: new Date().toISOString() }, 'image batch task failure')
        } catch (projectionError) { failFatal(projectionError) }
      } finally {
        try { await cleanup(gate) } catch (cleanupError) { failFatal(cleanupError) }
      }
    }

    let next = 0
    await Promise.all(Array.from({ length: Math.min(request.concurrency, request.tasks.length) }, async () => {
      while (fatal === undefined && !exec.signal.aborted && !disposed) {
        const index = next++
        if (index >= request.tasks.length) return
        await runTask(request.tasks[index])
      }
    }))
    if (fatal !== undefined) {
      for (const gate of batchActive()) abort(gate, fatal)
      await Promise.allSettled(batchActive().map(cleanup))
      throw fatal
    }
    for (const task of request.tasks) await stopQueued(task, exec.signal.aborted ? 'cancelled' : 'not-submitted')
    const tasks = state!.tasks
    const imageCount = tasks.filter(task => task.receipt?.status === 'completed').length
    const failureCount = tasks.filter(task => task.state !== 'completed').length
    const status = tasks.every(task => task.state === 'completed') && imageCount === tasks.length ? 'completed'
      : imageCount > 0 && failureCount > 0 ? 'partial'
        : imageCount === 0 && tasks.every(task => task.state === 'cancelled' || task.state === 'interrupted') ? 'cancelled' : 'failed'
    await append({ ...base(), kind: 'terminal', status, tasks }, 'image batch terminal')
    if (options.readDurableResult === undefined) throw new Error('durable image batch result reader is unavailable')
    return await options.readDurableResult(parent, state!.batch_id, exec.signal)
  }
  return { claim, execute }
}
