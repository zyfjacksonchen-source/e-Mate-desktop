/** Shell adapts its existing image owners for the read-only pet Cordis service. */
import { parseImageOutputReceipt } from './image-gallery-contract.ts'
import { createImageBatchProjectionSelector, type ImageBatchClientTask } from './image-batch-client.ts'
import type { PetImageFacts, PetImageFactsReader } from '../../../../../../dsh-plugin-pet/src/projection.ts'
import type { NativeSession, NativeSessions } from '../../../../../../dsh-plugin-pet/src/client/native-projection.ts'
type NativeConversation = ReturnType<NativeSession['getSnapshot']>
type NativeList = ReturnType<NativeSessions['list']['getSnapshot']>
type NativeTurn = NativeConversation['chat']['timeline']['turns'] extends ReadonlyMap<number, infer T> ? T : never
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function rows(value: unknown): readonly { seq: number; receipt: Record<string, unknown> }[] {
  return Array.isArray(value) ? value.filter(row => object(row) && Number.isSafeInteger(row.seq) && object(row.receipt)) : []
}
function completedImage(receipt: Record<string, unknown>): boolean {
  if (receipt.schema_version !== 2 || receipt.status !== 'completed' || !object(receipt.verification)
    || receipt.verification.structural !== 'passed' || !['passed', 'not-applicable'].includes(String(receipt.verification.semantic))
    || !object(receipt.output)) return false
  const item = parseImageOutputReceipt(receipt)
  return item?.status === 'completed' && item.attachment !== undefined
    && receipt.output.attachmentId === item.attachment.attachmentId
}
function imageOperation(value: unknown): PetImageFacts['operation'] {
  return value === 'generate' ? 'image-generate' : value === 'edit' || value === 'fusion' ? 'image-edit' : undefined
}
function exactChildImage(task: ImageBatchClientTask, list: NativeList): boolean {
  const pointer = task.receipt; const child = task.childSessionId
  if (task.state !== 'completed' || child === undefined || pointer?.status !== 'completed' || pointer.ownerSessionId !== child) return false
  return rows(list.byId[child]?.projectionValues?.eMateImageReceipts).some(row => row.seq === pointer.eventSeq
    && row.receipt.parent_session_id === child && row.receipt.child_session_id === undefined
    && row.receipt.call_id === pointer.callId && row.receipt.revision === pointer.revision && completedImage(row.receipt))
}
/** Reuse current-turn call provenance and admitted batch/receipt faces, never Tool text. */
function imageActivity(session: NativeSession, conversation: NativeConversation, list: NativeList, turn: NativeTurn | undefined, turnNumber: number | undefined,
  selectBatches: ReturnType<typeof createImageBatchProjectionSelector>): PetImageFacts {
  const current = conversation.sessionId
  const running = conversation.runningCalls.filter(call => call.turn === turnNumber)
  const receipts = rows(session.projections.faceOf('eMateImageReceipts').getSnapshot())
  let operation: PetImageFacts['operation']
  for (const call of running) {
    const row = receipts.find(row => row.receipt.parent_session_id === current && row.receipt.child_session_id === undefined
      && row.receipt.call_id === call.callId && row.receipt.schema_version === 2 && row.receipt.status === 'running')
    operation = imageOperation(row?.receipt.operation) ?? operation
  }
  const provenance = turn?.data.get('e-mate-image-calls')
  const callIds = (key: string): Set<string> => new Set(object(provenance) && Array.isArray(provenance[key])
    ? provenance[key].flatMap(item => object(item) && typeof item.callId === 'string' ? [item.callId] : []) : [])
  const direct = callIds('calls'); const batchCalls = callIds('batchCalls')
  const closed = turn?.status === 'closed' && turn.end?.data.reason.kind === 'completed'
  let delivered = closed && receipts.some(row => direct.has(String(row.receipt.call_id))
    && row.receipt.parent_session_id === current && row.receipt.child_session_id === undefined && completedImage(row.receipt))
  const batchRows = session.projections.faceOf('eMateImageBatches').getSnapshot()
  const currentBatches = Array.isArray(batchRows) ? batchRows.filter(row => object(row)
    && row.parent_session_id === current && batchCalls.has(String(row.parent_call_id))) : []
  for (const batch of selectBatches(currentBatches).batches) {
    if (running.some(call => call.callId === batch.parentCallId)) {
      const active = batch.tasks.filter(task => task.state === 'running')
      // imageIds are the batch owner's validated source identities, not command arguments.
      const operations = new Set(active.map(task => task.imageIds.length === 0 ? 'image-generate' as const : 'image-edit' as const))
      if (operations.size === 1) operation = [...operations][0]
    }
    if (closed && batch.status === 'completed' && batch.tasks.every(task => exactChildImage(task, list))) delivered = true
  }
  return { ...(operation === undefined ? {} : { operation }), delivered }
}

/** No subscriptions, RPC or copied Session state; the caller observes native owners. */
export function createPetImageFactsReader(ctx: { sessions: NativeSessions }): PetImageFactsReader {
  let selected: string | undefined
  let selectBatches = createImageBatchProjectionSelector('')
  return sessionId => {
    const list = ctx.sessions.list.getSnapshot()
    const session = list.current === sessionId ? ctx.sessions.binding(sessionId)?.session : undefined
    const conversation = session?.getSnapshot()
    if (session === undefined || conversation?.sessionId !== sessionId || conversation.openState !== 'open') return { delivered: false }
    if (selected !== sessionId) { selected = sessionId; selectBatches = createImageBatchProjectionSelector(sessionId) }
    const order = conversation.chat.timeline.turnOrder
    const turnNumber = order[order.length - 1]
    const turn = turnNumber === undefined ? undefined : conversation.chat.timeline.turns.get(turnNumber)
    return imageActivity(session, conversation, list, turn, turnNumber, selectBatches)
  }
}
