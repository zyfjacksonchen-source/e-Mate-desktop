/** Shell adapts existing work owners for the read-only pet Cordis service. */
import { parseImageOutputReceipt, parseImageOutputGroup } from './image-gallery-contract.ts'
import { createImageBatchProjectionSelector, type ImageBatchClientTask } from './image-batch-client.ts'
import type { PetWorkFacts, PetWorkFactsReader } from '../../../../../../dsh-plugin-pet/src/projection.ts'
import type {
  NativeChat, NativeConversationService, NativeSession, NativeSessions, NativeToolRoot,
} from '../../../../../../dsh-plugin-pet/src/client/native-projection.ts'
type NativeList = ReturnType<NativeSessions['list']['getSnapshot']>
type NativeTurn = NativeChat['timeline']['turns'] extends ReadonlyMap<number, infer T> ? T : never
type RunningCall = NativeChat['legacy']['runningCalls'][number]
type ToolRoot = NativeToolRoot
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function rows(value: unknown): readonly { seq: number; receipt: Record<string, unknown> }[] {
  return Array.isArray(value) ? value.filter(row => object(row) && Number.isSafeInteger(row.seq) && object(row.receipt)) : []
}
function completedImage(receipt: Record<string, unknown>): boolean {
  if (receipt.schema_version === 3) return parseImageOutputGroup(receipt)?.items.some(item => item.status === 'completed' && item.attachment !== undefined) ?? false
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
// Media types the attachment store may hold after its own normalization: a
// screenshot's PNG can be re-encoded to WebP (kept alpha) or JPEG (opaque), so
// the stored attachment's type is the store's, not the producer's.
const STORED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const BROWSER_OPERATIONS = new Set([
  'browser_tabs', 'browser_select_tab', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press',
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_scroll', 'browser_get_text', 'browser_wait',
])
// An operation comes only from an admitted native tool name or a native result
// envelope. No call presentation model exists outside ui-tool's rendered cards,
// so a running write/edit cannot prove a code file and stays generic.
function runningOperation(call: RunningCall): PetWorkFacts['operation'] {
  const univer = univerRunningOperation(call.name)
  if (univer) return univer
  if (call.name === 'web_search') return 'web-search'
  if (call.name === 'grep' || call.name === 'glob') return 'file-search'
  if (BROWSER_OPERATIONS.has(call.name)) return 'browser'
  return undefined
}
const UNIVER_OPERATIONS: Readonly<Record<string, string>> = {
  univer_new: 'new', univer_status: 'status', univer_inspect: 'inspect', univer_execute: 'execute',
  univer_import: 'import', univer_export: 'export', univer_print_pdf: 'print-pdf', univer_screenshot: 'screenshot',
  univer_resources: 'resources', univer_unit: 'unit', univer_worktree: 'worktree', univer_lint: 'lint',
  univer_api: 'api', univer_compile_svg: 'compile-svg',
}
function univerOperation(name: string | undefined): string | undefined {
  return name !== undefined && Object.hasOwn(UNIVER_OPERATIONS, name) ? UNIVER_OPERATIONS[name] : undefined
}
function univerRunningOperation(name: string | undefined): PetWorkFacts['operation'] {
  const operation = univerOperation(name)
  if (!operation || operation === 'resources') return undefined
  return ['status', 'inspect', 'screenshot', 'lint', 'api'].includes(operation) ? 'document-read' : 'document-write'
}
function outputPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 8192 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && (value.startsWith('/') && !value.startsWith('//') || /^[A-Za-z]:[/\\]/u.test(value))
    && !value.split(/[/\\]/u).some(part => part === '.' || part === '..')
}
/** Only a named native Tool's full output envelope is data; Code stdout is not. */
function univerResult(root: ToolRoot): { operation: NonNullable<PetWorkFacts['completedOperation']>; written: boolean } | undefined {
  const operation = univerOperation(root.call?.name)
  if (!operation || root.kind !== 'tool-result' || root.isError !== false) return undefined
  const texts = (root.content ?? []).filter(block => block.type === 'text')
  if (texts.length !== 1 || typeof texts[0]?.text !== 'string') return undefined
  let value: unknown
  try { value = JSON.parse(texts[0].text) } catch { return undefined }
  if (!object(value) || value.ok !== true || value.operation !== operation || !Object.hasOwn(value, 'result')
    || !['resources', 'api'].includes(operation) && !outputPath(value.file)) return undefined
  if (['status', 'inspect', 'lint', 'api'].includes(operation)) return { operation: 'document-read', written: false }
  if (!object(value.result)) return undefined
  const result = value.result
  let written = false
  let kind: unknown
  if (operation === 'new') {
    if (result.created !== true || result.filePath !== value.file) return undefined
    written = true
  } else if (operation === 'execute') {
    if (typeof result.committed !== 'boolean' || result.filePath !== value.file) return undefined
    written = result.committed
  } else if (operation === 'export') {
    if (result.filePath !== value.file || !outputPath(result.outputPath) || !['sheet', 'doc', 'slide', 'base', 'board'].includes(String(result.kind))) return undefined
    written = true; kind = result.kind
  } else if (operation === 'print-pdf') {
    if (!outputPath(result.output) || !Number.isSafeInteger(result.pageCount) || Number(result.pageCount) < 1) return undefined
    written = true; kind = result.unitType
  } else if (operation === 'screenshot') {
    if (!Array.isArray(result.images)) return undefined
    written = result.images.some(item => object(item) && outputPath(item.path) && item.mediaType === 'image/png'
      && object(item.image) && STORED_IMAGE_MEDIA_TYPES.has(String(item.image.mediaType)) && typeof item.image.attachmentId === 'string'
      && /^sha256:[a-f0-9]{64}$/u.test(item.image.attachmentId))
    kind = result.unitType
  } else if (operation === 'resources') {
    written = Array.isArray(result.exported) && result.exported.some(item => object(item) && outputPath(item.path))
  }
  return { operation: kind === 'sheet' ? 'spreadsheet' : kind === 'slide' ? 'slides'
    : written || ['import', 'unit', 'worktree', 'compile-svg'].includes(operation) ? 'document-write' : 'document-read', written }
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
function settledWork(chat: NativeChat, turn: NativeTurn | undefined, turnNumber: number | undefined): PetWorkFacts {
  if (turnNumber === undefined) return { delivered: false }
  const roots = chat.locations.getTurn(turnNumber).flatMap(key => {
    const node = chat.nodes.get(key)
    return node?.kind === 'tool-call' && node.data?.root ? [node.data.root] : []
  })
  const blocks = (root: ToolRoot): ToolRoot[] => [root, ...(root.subCalls ?? []).flatMap(blocks)]
  const all = roots.flatMap(blocks)
  const univer = all.filter(root => univerOperation(root.call?.name ?? root.name) !== undefined)
  const closed = turn?.status === 'closed'
  const completed = closed && turn.end?.data.reason.kind === 'completed'
  const failed = univer.some(root => root.kind === 'tool-result' && root.isError === true)
    || roots.some(root => root.isError === true && blocks(root).some(child => univerOperation(child.call?.name ?? child.name)))
    || univer.length > 0 && closed && !completed
  const needsAttention = univer.some(root => root.kind === 'tool-result' && root.isError === false && univerResult(root) === undefined
    || closed && root.kind !== 'tool-result')
  const operation = all.filter(root => root.kind !== 'tool-result').map(root => univerRunningOperation(root.name)).findLast(value => value !== undefined)
  const office = all.toSorted((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
    .map(root => univerResult(root) ?? officeResult(root)).filter(value => value !== undefined)
  const recent = office.at(-1)
  // The native produced-file accumulator carries call-time paths. Office's final
  // collision-resolved file comes only from its canonical result metadata.
  const produced = turn?.data.get('deliverables')
  const files = object(produced) && Array.isArray(produced.produced) ? produced.produced : []
  const ordinaryFile = files.some(file => object(file) && Number.isSafeInteger(file.seq) && roots.some(root =>
    root.kind === 'tool-result' && root.isError === false && root.seq === file.seq && root.call?.name !== undefined
      && root.call.name !== 'office_write' && root.call.name !== 'office_read' && univerOperation(root.call.name) === undefined))
  const hasUsableOutput = ordinaryFile || office.some(item => item.written)
  return { ...(operation === undefined ? {} : { operation }), failed, needsAttention, hasUsableOutput,
    ...(completed && !failed && !needsAttention && recent !== undefined ? { completedOperation: recent.operation } : {}),
    delivered: completed && !failed && !needsAttention && hasUsableOutput }
}
function exactChildImage(task: ImageBatchClientTask, list: NativeList): boolean {
  const pointer = task.receipt; const child = task.childSessionId
  if (child === undefined || pointer?.status !== 'completed' || pointer.ownerSessionId !== child) return false
  return rows(list.byId[child]?.projectionValues?.eMateImageReceipts).some(row => row.seq === pointer.eventSeq
    && row.receipt.parent_session_id === child && row.receipt.child_session_id === undefined
    && row.receipt.call_id === pointer.callId && row.receipt.revision === pointer.revision && completedImage(row.receipt))
}
/** Reuse current-turn call provenance and admitted batch/receipt faces, never Tool text. */
function imageActivity(session: NativeSession, chat: NativeChat, list: NativeList, turn: NativeTurn | undefined, turnNumber: number | undefined,
  selectBatches: ReturnType<typeof createImageBatchProjectionSelector>): PetWorkFacts {
  const current = session.sessionId
  const running = chat.legacy.runningCalls.filter(call => call.turn === turnNumber)
  const receipts = rows(session.projections.faceOf('eMateImageReceipts').getSnapshot())
  let operation: PetWorkFacts['operation']
  for (const call of running) {
    const row = receipts.find(row => row.receipt.parent_session_id === current && row.receipt.child_session_id === undefined
      && (row.receipt.call_id === call.callId || row.receipt.root_call_id === call.callId)
      && [2, 3].includes(Number(row.receipt.schema_version)) && row.receipt.status === 'running')
    operation = imageOperation(row?.receipt.operation)
      ?? (call.name === 'generate_image' ? 'image-generate' : call.name === 'edit_image' ? 'image-edit' : operation)
  }
  const provenance = turn?.data.get('e-mate-image-calls')
  const callIds = (key: string): Set<string> => new Set(object(provenance) && Array.isArray(provenance[key])
    ? provenance[key].flatMap(item => object(item) && typeof item.callId === 'string' ? [item.callId] : []) : [])
  const direct = callIds('calls'); const batchCalls = callIds('batchCalls')
  const closed = turn?.status === 'closed' && turn.end?.data.reason.kind === 'completed'
  const currentReceipts = receipts.filter(row => (direct.has(String(row.receipt.call_id))
    || row.receipt.schema_version === 3 && row.receipt.turn === turnNumber)
    && row.receipt.parent_session_id === current && row.receipt.child_session_id === undefined && parseImageOutputGroup(row.receipt) !== null)
  let hasUsableOutput = currentReceipts.some(row => completedImage(row.receipt))
  let needsAttention = currentReceipts.some(row => row.receipt.status === 'unknown' || row.receipt.status === 'needs-review')
  let failed = currentReceipts.some(row => ['failed', 'cancelled'].includes(String(row.receipt.status)) || Number(row.receipt.failed_count) > 0)
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
export function createPetWorkFactsReader(ctx: {
  sessions: NativeSessions
  /** ui-conversation's per-Session binding, the owner of the chat target. */
  uiConversation: NativeConversationService
}): PetWorkFactsReader {
  let selected: string | undefined
  let selectBatches = createImageBatchProjectionSelector('')
  return sessionId => {
    const list = ctx.sessions.list.getSnapshot()
    const session = list.current === sessionId ? ctx.sessions.binding(sessionId)?.session : undefined
    const snapshot = session?.getSnapshot()
    if (session === undefined || snapshot?.sessionId !== sessionId || snapshot.openState !== 'open') return { delivered: false }
    // Running calls and Turn boundaries live only in ui-chat's Conversation chat target.
    const chat = ctx.uiConversation.binding(sessionId).target('chat').getSnapshot()
    if (chat === undefined) return { delivered: false }
    if (selected !== sessionId) { selected = sessionId; selectBatches = createImageBatchProjectionSelector(sessionId) }
    const order = chat.timeline.turnOrder
    const turnNumber = order[order.length - 1]
    const turn = turnNumber === undefined ? undefined : chat.timeline.turns.get(turnNumber)
    const images = imageActivity(session, chat, list, turn, turnNumber, selectBatches)
    const running = chat.legacy.runningCalls.filter(call => call.turn === turnNumber)
    const completed = settledWork(chat, turn, turnNumber)
    const operation = images.operation ?? completed.operation ?? running.map(runningOperation).findLast(value => value !== undefined)
    const failed = images.failed || completed.failed
    const needsAttention = images.needsAttention || completed.needsAttention
    return { ...images, ...completed, ...(operation === undefined ? {} : { operation }),
      failed, needsAttention, hasUsableOutput: images.hasUsableOutput || completed.hasUsableOutput,
      delivered: (images.delivered || completed.delivered) && !needsAttention && !failed }
  }
}
