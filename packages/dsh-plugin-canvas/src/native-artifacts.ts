import { imageRef, intentMarker, record, reject, sessionId, type CanvasAsset, type CanvasIntent, type ImageRef } from './contract.ts'

export interface NativeEvent { seq: number; type: string; data: any }
/** The kernel Session face this package reads; rc.1 publishes snapshotEvents(), not an events array. */
export interface NativeKernelSession {
  header: NativeSession['header']
  snapshotEvents(): readonly NativeEvent[]
}
export interface NativeSession { header: { id: string; parentSession?: string }; events: readonly NativeEvent[] }
export interface SessionContext {
  sessions: { get(id: string): NativeKernelSession | undefined }
  sessionPersistence: { load(id: string): Promise<{ meta: NativeSession['header']; events: readonly NativeEvent[] }> }
}
export async function inspectSession(ctx: SessionContext, id: string): Promise<NativeSession> {
  sessionId(id)
  const live = ctx.sessions.get(id)
  if (live) return { header: live.header, events: live.snapshotEvents() }
  const persisted = await ctx.sessionPersistence.load(id)
  if (persisted.meta.id !== id) reject('会话身份不一致。', 'scope')
  return { header: persisted.meta, events: persisted.events }
}
export async function assertOwner(ctx: SessionContext, current: string, owner: string): Promise<NativeSession> {
  const original = await inspectSession(ctx, owner)
  let candidate = original
  const seen = new Set<string>()
  for (let depth = 0; depth < 16; depth += 1) {
    if (candidate.header.id === current) return original
    if (!candidate.header.parentSession || seen.has(candidate.header.id)) break
    seen.add(candidate.header.id)
    candidate = await inspectSession(ctx, candidate.header.parentSession)
  }
  return reject('附件不属于当前会话或其原生子任务。', 'scope')
}
function refsInEvents(events: readonly NativeEvent[]): ImageRef[] {
  const result: ImageRef[] = []
  // Only native ContentBlocks and completed durable image receipts confer attachment scope.
  const content = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const block of value) if (record(block) && block.type === 'image') {
      try { result.push(imageRef(block.attachment)) } catch {}
    }
  }
  for (const event of events) {
    if (['user/message', 'assistant/message', 'emate/image-draft-staged'].includes(event.type)) {
      content(event.data?.content); content(event.data?.message?.content)
    }
    if (event.type === 'tool/result') for (const part of event.data?.message?.content ?? []) {
      if (part.type === 'tool-result' && !part.isError) content(part.content)
    }
    if (event.type === 'emate/image-output' && (event.data?.schema_version === 2 && event.data.status === 'completed'
      || event.data?.schema_version === 3 && ['completed', 'failed', 'cancelled'].includes(event.data.status))) content(event.data.content)
  }
  return result
}
export async function resolveSessionAsset(ctx: SessionContext, current: string, owner: string, attachmentId: string): Promise<CanvasAsset> {
  const session = await assertOwner(ctx, current, owner)
  const ref = refsInEvents(session.events).find(item => item.attachmentId === attachmentId)
  if (!ref) return reject('附件尚无可验证的会话记录。', 'scope')
  return { ownerSessionId: owner, ref }
}
export function requestCalls(events: readonly NativeEvent[], intent: CanvasIntent): { turn: number; calls: Set<string> } | null {
  let turn: number | undefined
  let selected: number | undefined
  let matches = 0
  const markersByTurn = new Map<number, number>()
  for (const event of events) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn
    if (event.type === 'user/message' && event.data?.source?.kind === 'user' && turn !== undefined && Array.isArray(event.data.content)
      && event.data.content.some((block: any) => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[e-Mate canvas '))) markersByTurn.set(turn, (markersByTurn.get(turn) ?? 0) + 1)
    if (event.type === 'user/message' && event.data?.source?.kind === 'user' && Array.isArray(event.data.content)
      && event.data.content.some((block: any) => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(intentMarker(intent.id) + '\n'))) {
      selected = turn; matches += 1
    }
  }
  if (matches !== 1 || selected === undefined || markersByTurn.get(selected) !== 1) return null
  return { turn: selected, calls: new Set(events.filter(event => event.type === 'tool/call' && event.data?.turn === selected).map(event => event.data.callId)) }
}
export async function nativeImageOutputs(ctx: SessionContext, current: string, intent: CanvasIntent): Promise<CanvasAsset[]> {
  const session = await assertOwner(ctx, current, intent.sessionId)
  const request = requestCalls(session.events, intent)
  if (!request) return []
  const outputs: CanvasAsset[] = []
  for (const event of session.events) {
    if (event.type === 'emate/image-output' && event.data?.schema_version === 3
      && ['completed', 'failed', 'cancelled'].includes(event.data.status) && event.data.revision === 2
      && event.data.parent_session_id === intent.sessionId
      && request.calls.has(event.data.root_call_id)
      && session.events.some(call => call.type === 'tool/call' && call.data.callId === event.data.root_call_id
        && call.data.turn === request.turn && (call.data.name === event.data.tool_name || call.data.name === 'run_code'))
      && ['generate_image', 'edit_image'].includes(event.data.tool_name)
      && Array.isArray(event.data.content) && event.data.content.length >= 1 && event.data.content.length <= 4) {
      const refs: ImageRef[] = []
      for (const block of event.data.content) {
        if (block?.type !== 'image') break
        try { refs.push(imageRef(block.attachment)) } catch { break }
      }
      if (refs.length === event.data.content.length) outputs.push(...refs.map(ref => ({ ownerSessionId: intent.sessionId, ref })))
    }
    if (event.type === 'tool/result' && event.data?.turn === request.turn) {
      for (const part of event.data.message?.content ?? []) {
        if (part.type !== 'tool-result' || part.isError || !request.calls.has(part.toolCallId)) continue
        for (const block of part.content ?? []) if (block.type === 'image') {
          try { outputs.push({ ownerSessionId: intent.sessionId, ref: imageRef(block.attachment) }) } catch {}
        }
      }
    }
    if (event.type === 'emate/image-output' && event.data?.schema_version === 2 && event.data.status === 'completed'
      && event.data.parent_session_id === intent.sessionId && request.calls.has(event.data.call_id)
      && session.events.some(call => call.type === 'tool/call' && call.data.callId === event.data.call_id && call.data.name === 'imagegen')) {
      const ref = imageRef(event.data.output)
      if (event.data.content?.length === 1 && event.data.content[0]?.attachment?.attachmentId === ref.attachmentId) outputs.push({ ownerSessionId: intent.sessionId, ref })
    }
    if (event.type !== 'emate/image-batch' || !request.calls.has(event.data?.parent_call_id)
      || !session.events.some(call => call.type === 'tool/call' && call.data.callId === event.data.parent_call_id && call.data.name === 'image_batch')) continue
    const tasks = Array.isArray(event.data.tasks) ? event.data.tasks : record(event.data.task) ? [event.data.task] : []
    for (const task of tasks) {
      const pointer = task.receipt
      if (task.state !== 'completed' || pointer?.status !== 'completed' || pointer.owner_session_id !== task.child_session_id) continue
      const child = await assertOwner(ctx, intent.sessionId, task.child_session_id)
      if (child.header.parentSession !== intent.sessionId) continue
      const receipt = child.events.find(item => item.seq === pointer.event_seq && item.type === 'emate/image-output')?.data
      if (receipt?.schema_version !== 2 || receipt.status !== 'completed' || receipt.call_id !== pointer.call_id || receipt.revision !== pointer.revision
        || receipt.parent_session_id !== task.child_session_id || receipt.client_request_id !== `image-${String(task.task_id).slice(7)}`) continue
      outputs.push({ ownerSessionId: task.child_session_id, ref: imageRef(receipt.output) })
    }
  }
  return [...new Map(outputs.map(asset => [asset.ref.attachmentId, asset])).values()]
}
