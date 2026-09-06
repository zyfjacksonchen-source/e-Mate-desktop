/** Shell adapts existing work owners for the read-only pet Cordis service. */
import { parseImageOutputReceipt } from './image-gallery-contract.ts'
import { createImageBatchProjectionSelector, type ImageBatchClientTask } from './image-batch-client.ts'
import type { PetWorkFacts, PetWorkFactsReader } from '../../../../../../dsh-plugin-pet/src/projection.ts'
import type { NativeSession, NativeSessions } from '../../../../../../dsh-plugin-pet/src/client/native-projection.ts'
type NativeConversation = ReturnType<NativeSession['getSnapshot']>
type NativeList = ReturnType<NativeSessions['list']['getSnapshot']>
type NativeTurn = NativeConversation['chat']['timeline']['turns'] extends ReadonlyMap<number, infer T> ? T : never
type RunningCall = NativeConversation['runningCalls'][number]
type ToolNode = NonNullable<ReturnType<NativeConversation['chat']['nodes']['get']>>
type ToolRoot = NonNullable<NonNullable<ToolNode['data']>['root']>
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
function imageOperation(value: unknown): PetWorkFacts['operation'] {
  return value === 'generate' ? 'image-generate' : value === 'edit' || value === 'fusion' ? 'image-edit' : undefined
}
const BROWSER_OPERATIONS = new Set([
  'browser_tabs', 'browser_select_tab', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press',
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_scroll', 'browser_get_text', 'browser_wait',
])
// File-type evidence only: unknown, prose, data and configuration files stay generic.
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'java', 'kt', 'kts', 'swift', 'm', 'mm', 'php', 'lua', 'r', 'sql',
  'sh', 'bash', 'ps1', 'html', 'css', 'scss', 'vue', 'svelte'])
function runningOperation(call: RunningCall): PetWorkFacts['operation'] {
  if (call.name === 'web_search') return 'web-search'
  if (call.name === 'grep' || call.name === 'glob') return 'file-search'
  if (BROWSER_OPERATIONS.has(call.name)) return 'browser'
  const files = call.callView?.locations
  if ((call.name === 'write' || call.name === 'edit') && call.callView?.card === 'diff' && files?.length
    && files.every(file => typeof file.path === 'string' && CODE_EXTENSIONS.has(file.path.match(/\.([A-Za-z][A-Za-z0-9]*)$/)?.[1]?.toLowerCase() ?? ''))) return 'code-write'
  return undefined
}
function officeResult(root: ToolRoot): { operation: NonNullable<PetWorkFacts['completedOperation']>; written: boolean } | undefined {
  const name = root.call?.name; const meta = root.meta
  if (root.kind !== 'tool-result' || root.isError !== false || (name !== 'office_write' && name !== 'office_read') || !object(meta)
    || Object.keys(meta).length !== 5 || !['operation', 'format', 'job_id', 'relative_path', 'bytes'].every(key => Object.hasOwn(meta, key))
    || meta.operation !== (name === 'office_write' ? 'write' : 'read')
    || !['docx', 'xlsx', 'pptx', 'pdf'].includes(String(meta.format))
    || typeof meta.job_id !== 'string' || !/^[^\u0000-\u001f\u007f]{1,256}$/.test(meta.job_id)
    || !Number.isSafeInteger(meta.bytes) || Number(meta.bytes) < 1 || Number(meta.bytes) > 32 * 1024 * 1024
    || typeof meta.relative_path !== 'string' || /[\\\u0000-\u001f\u007f]/.test(meta.relative_path)
    || meta.relative_path.split('/').some(part => part === '' || part === '.' || part === '..')
    || /^[A-Za-z]:/.test(meta.relative_path) || !meta.relative_path.toLowerCase().endsWith('.' + meta.format)
    || meta.operation === 'write' && !meta.relative_path.startsWith('.e-mate/office/')) return undefined
  const written = meta.operation === 'write'
  const operation = meta.format === 'xlsx' ? 'spreadsheet' : meta.format === 'pptx' ? 'slides'
    : meta.format === 'pdf' && !written ? 'pdf-read' : written ? 'document-write' : 'document-read'
  return { operation, written }
}
function settledWork(conversation: NativeConversation, turn: NativeTurn | undefined, turnNumber: number | undefined): Pick<PetWorkFacts, 'completedOperation' | 'delivered'> {
  if (turnNumber === undefined || turn?.status !== 'closed' || turn.end?.data.reason.kind !== 'completed') return { delivered: false }
  const roots = conversation.chat.locations.getTurn(turnNumber).flatMap(key => {
    const node = conversation.chat.nodes.get(key)
    return node?.kind === 'tool-call' && node.data?.root ? [node.data.root] : []
  })
  const office = roots.map(root => officeResult(root))
  const recent = office.at(-1)
  // The native produced-file accumulator carries call-time paths. Office's final
  // collision-resolved file comes only from its canonical result metadata.
  const produced = turn.data.get('deliverables')
  const files = object(produced) && Array.isArray(produced.produced) ? produced.produced : []
  const ordinaryFile = files.some(file => object(file) && Number.isSafeInteger(file.seq) && roots.some(root =>
    root.kind === 'tool-result' && root.isError === false && root.seq === file.seq && root.call?.name !== undefined
      && root.call.name !== 'office_write' && root.call.name !== 'office_read'))
  return { ...(recent === undefined ? {} : { completedOperation: recent.operation }), delivered: ordinaryFile || office.some(item => item?.written) }
}
function exactChildImage(task: ImageBatchClientTask, list: NativeList): boolean {
  const pointer = task.receipt; const child = task.childSessionId
  if (child === undefined || pointer?.status !== 'completed' || pointer.ownerSessionId !== child) return false
  return rows(list.byId[child]?.projectionValues?.eMateImageReceipts).some(row => row.seq === pointer.eventSeq
    && row.receipt.parent_session_id === child && row.receipt.child_session_id === undefined
    && row.receipt.call_id === pointer.callId && row.receipt.revision === pointer.revision && completedImage(row.receipt))
}
/** Reuse current-turn call provenance and admitted batch/receipt faces, never Tool text. */
function imageActivity(session: NativeSession, conversation: NativeConversation, list: NativeList, turn: NativeTurn | undefined, turnNumber: number | undefined,
  selectBatches: ReturnType<typeof createImageBatchProjectionSelector>): PetWorkFacts {
  const current = conversation.sessionId
  const running = conversation.runningCalls.filter(call => call.turn === turnNumber)
  const receipts = rows(session.projections.faceOf('eMateImageReceipts').getSnapshot())
  let operation: PetWorkFacts['operation']
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
  const currentReceipts = receipts.filter(row => direct.has(String(row.receipt.call_id))
    && row.receipt.parent_session_id === current && row.receipt.child_session_id === undefined && parseImageOutputReceipt(row.receipt) !== null)
  let hasUsableOutput = currentReceipts.some(row => completedImage(row.receipt))
  let needsAttention = currentReceipts.some(row => row.receipt.status === 'unknown' || row.receipt.status === 'needs-review')
  let failed = currentReceipts.some(row => row.receipt.status === 'failed')
  let delivered = closed && hasUsableOutput
  const batchRows = session.projections.faceOf('eMateImageBatches').getSnapshot()
  const currentBatches = Array.isArray(batchRows) ? batchRows.filter(row => object(row)
    && row.parent_session_id === current && batchCalls.has(String(row.parent_call_id))) : []
  for (const batch of selectBatches(currentBatches).batches) {
    needsAttention ||= batch.tasks.some(task => task.state === 'unknown' || task.state === 'needs-review' || task.state === 'interrupted')
    failed ||= batch.tasks.some(task => task.state === 'failed')
    hasUsableOutput ||= batch.tasks.some(task => exactChildImage(task, list))
    if (running.some(call => call.callId === batch.parentCallId)) {
      const active = batch.tasks.filter(task => task.state === 'running')
      // imageIds are the batch owner's validated source identities, not command arguments.
      const operations = new Set(active.map(task => task.imageIds.length === 0 ? 'image-generate' as const : 'image-edit' as const))
      if (operations.size === 1) operation = [...operations][0]
    }
    if (closed && batch.status === 'completed' && batch.tasks.every(task => exactChildImage(task, list))) delivered = true
  }
  return { ...(operation === undefined ? {} : { operation }), delivered: delivered && !needsAttention && !failed,
    needsAttention, failed, hasUsableOutput }
}

/** No subscriptions, RPC or copied Session state; the caller observes native owners. */
export function createPetWorkFactsReader(ctx: { sessions: NativeSessions }): PetWorkFactsReader {
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
    const images = imageActivity(session, conversation, list, turn, turnNumber, selectBatches)
    const running = conversation.runningCalls.filter(call => call.turn === turnNumber)
    const operation = images.operation ?? running.map(runningOperation).findLast(value => value !== undefined)
    const completed = settledWork(conversation, turn, turnNumber)
    return { ...images, ...completed, ...(operation === undefined ? {} : { operation }),
      hasUsableOutput: images.hasUsableOutput || completed.delivered,
      delivered: (images.delivered || completed.delivered) && !images.needsAttention && !images.failed }
  }
}
