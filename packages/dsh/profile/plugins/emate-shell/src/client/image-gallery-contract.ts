import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export type ImageGalleryStatus = 'completed' | 'review-required' | 'failed'

export interface ImageGalleryItem {
  readonly callId: string
  readonly revision: number
  readonly status: ImageGalleryStatus
  readonly operation: 'generate' | 'edit' | 'fusion' | 'unknown'
  /** Original receipt event time keeps projected filenames stable across revisions. */
  readonly createdAt?: number
  readonly attachment?: ImageAttachmentRef
  readonly failureCode?: string
  readonly failureMessage?: string
  /** Read-only presentation provenance; never written back into a receipt. */
  readonly source?: {
    readonly kind: 'subagent'
    readonly sessionId: string
    readonly label: string
    readonly ordinal: number
    readonly mode: 'one-shot' | 'continuable'
  }
}

const RECEIPT_KEYS = new Set([
  'billing_status', 'call_id', 'child_session_id', 'client_request_id', 'content', 'failure_code', 'job_id',
  'model', 'operation', 'output', 'parent_session_id', 'provider_request_id', 'revision', 'schema_version',
  'sources', 'status', 'verification', 'verifier',
])
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u
const FAILURE_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/u

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function imageRef(value: unknown, strict: boolean): ImageAttachmentRef | undefined {
  if (!record(value) || typeof value.attachmentId !== 'string' || value.attachmentId.length === 0) return undefined
  if (strict && (!ATTACHMENT_ID.test(value.attachmentId)
    || !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mediaType))
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1
    || !Number.isSafeInteger(value.width) || Number(value.width) < 1
    || !Number.isSafeInteger(value.height) || Number(value.height) < 1
    || value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255 || /[\\/\0]/u.test(value.name)))) return undefined
  return value as unknown as ImageAttachmentRef
}

function imageContent(value: unknown, strict: boolean): ImageAttachmentRef[] | undefined {
  if (!Array.isArray(value) || value.length > 1) return undefined
  const images: ImageAttachmentRef[] = []
  for (const block of value) {
    if (!record(block) || block.type !== 'image') return undefined
    const attachment = imageRef(block.attachment, strict)
    if (attachment === undefined) return undefined
    images.push(attachment)
  }
  return images
}

/** Parse only the frozen v2 receipt plus its exact pre-v2 historical terminal form. */
export function parseImageOutputReceipt(value: unknown): ImageGalleryItem | null {
  if (!record(value)) return null
  const keys = Object.keys(value)
  if (keys.length === 2 && keys.includes('call_id') && keys.includes('content')) {
    const images = imageContent(value.content, false)
    return typeof value.call_id === 'string' && value.call_id !== '' && images?.length === 1
      ? { callId: value.call_id, revision: 0, status: 'completed', operation: 'unknown', attachment: images[0] }
      : null
  }
  if (keys.some(key => !RECEIPT_KEYS.has(key))
    || value.schema_version !== 2
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 3
    || typeof value.call_id !== 'string' || value.call_id === ''
    || value.child_session_id !== undefined
      && (typeof value.child_session_id !== 'string' || value.child_session_id === '')
    || !['generate', 'edit', 'fusion'].includes(String(value.operation))
    || !['running', 'completed', 'needs-review', 'failed', 'cancelled', 'unknown'].includes(String(value.status))
    || !['not-submitted', 'recorded', 'unknown'].includes(String(value.billing_status))
    || typeof value.parent_session_id !== 'string' || value.parent_session_id === ''
    || !Array.isArray(value.sources) || !record(value.verifier) || !record(value.verification)) return null
  const images = imageContent(value.content, true)
  if (images === undefined) return null
  const status = String(value.status)
  if (status === 'running') return null
  if ((status === 'completed' || status === 'needs-review') !== (images.length === 1)) return null
  const failureCode = typeof value.failure_code === 'string' && FAILURE_CODE.test(value.failure_code)
    ? value.failure_code
    : undefined
  if (value.failure_code !== undefined && failureCode === undefined) return null
  return {
    callId: value.call_id,
    revision: Number(value.revision),
    status: status === 'completed' ? 'completed' : status === 'needs-review' ? 'review-required' : 'failed',
    operation: value.operation as ImageGalleryItem['operation'],
    ...(images[0] === undefined ? {} : { attachment: images[0] }),
    ...(failureCode === undefined ? {} : { failureCode }),
  }
}

export function imageReceiptRole(item: ImageGalleryItem): 'start' | 'update' {
  return item.revision === 3 ? 'update' : 'start'
}

export interface ImageOutputGroup {
  readonly callId: string
  readonly rootCallId?: string
  readonly revision: number
  readonly items: readonly ImageGalleryItem[]
}
const V3_KEYS = new Set(['turn', 'schema_version', 'revision', 'call_id', 'root_call_id', 'tool_name', 'task_id',
  'parent_session_id', 'operation', 'status', 'sources', 'content', 'model', 'job_id',
  'request_receipts', 'provider_request_ids', 'client_request_ids', 'requested_count', 'returned_count', 'failed_count', 'error'])

/** New jobs have one durable receipt containing every saved native attachment. */
export function parseImageOutputGroup(value: unknown): ImageOutputGroup | null {
  if (!record(value) || value.schema_version !== 3) {
    const item = parseImageOutputReceipt(value)
    return item === null ? null : { callId: item.callId, revision: item.revision, items: [item] }
  }
  if (Object.keys(value).some(key => !V3_KEYS.has(key))
    || !['call_id', 'root_call_id', 'task_id', 'parent_session_id'].every(key => typeof value[key] === 'string' && value[key] !== '')
    || value.turn !== undefined && (!Number.isSafeInteger(value.turn) || Number(value.turn) < 0)
    || !['generate', 'edit'].includes(String(value.operation))
    || value.tool_name !== (value.operation === 'edit' ? 'edit_image' : 'generate_image')
    || !['running', 'completed', 'failed', 'cancelled'].includes(String(value.status))
    || value.revision !== (value.status === 'running' ? 1 : 2)
    || value.model !== 'gpt-image-2.5-flare'
    || !Array.isArray(value.sources) || value.sources.some(ref => imageRef(ref, true) === undefined)
    || !Array.isArray(value.content) || value.content.length > 4
    || value.status === 'completed' && value.content.length === 0
    || value.status === 'running' && value.content.length !== 0
    || !Number.isSafeInteger(value.requested_count) || Number(value.requested_count) < 1 || Number(value.requested_count) > 4
    || value.returned_count !== value.content.length
    || value.failed_count !== (value.status === 'running' ? 0 : Number(value.requested_count) - value.content.length)
    || Number(value.returned_count) > Number(value.requested_count)
    || ['provider_request_ids', 'client_request_ids'].some(key => value[key] !== undefined
      && (!Array.isArray(value[key]) || value[key].some(id => typeof id !== 'string' || id === '')))
    || value.error !== undefined && typeof value.error !== 'string') return null
  const images: ImageAttachmentRef[] = []
  for (const block of value.content) {
    if (!record(block) || block.type !== 'image') return null
    const ref = imageRef(block.attachment, true)
    if (ref === undefined) return null
    if (!images.some(image => image.attachmentId === ref.attachmentId)) images.push(ref)
  }
  const base = { callId: value.call_id as string, revision: value.revision as number,
    operation: value.operation as 'generate' | 'edit' }
  return { callId: base.callId, rootCallId: value.root_call_id as string, revision: base.revision,
    items: value.status === 'running' ? [] : images.length > 0
      ? images.map(attachment => ({ ...base, status: 'completed', attachment }))
      : [{ ...base, status: 'failed', failureMessage: typeof value.error === 'string' && value.error !== ''
        ? value.error : value.status === 'cancelled' ? '已取消' : '生成失败' }],
  }
}
