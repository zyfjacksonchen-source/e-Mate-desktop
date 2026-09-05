import { createHash } from 'node:crypto'

const MIN_TASKS = 2
const MAX_TASKS = 8
const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 4
const MAX_PROMPT_CHARS = 20_000
const MAX_IMAGE_URLS = 16
const MAX_NATIVE_ID_CHARS = 256
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u
const NATIVE_ID = /^[^\u0000-\u001f\u007f]+$/u

type ImageOperation = 'generate' | 'edit' | 'fusion'

export interface NormalizedImageBatchTask {
  readonly ordinal: number
  readonly prompt: string
  readonly promptSha256: string
  readonly attachmentIds: readonly string[]
  readonly operation: ImageOperation
}

export interface NormalizedImageBatchRequest {
  readonly tasks: readonly NormalizedImageBatchTask[]
  readonly concurrency: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function nativeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NATIVE_ID_CHARS || !NATIVE_ID.test(value)) {
    throw new Error(`${label} must be a valid 1 to ${MAX_NATIVE_ID_CHARS} character native ID`)
  }
  return value
}

function ordinal(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`)
  }
  return value as number
}

function tupleSha256(values: readonly (string | number)[]): string {
  const hash = createHash('sha256')
  for (const value of values) {
    const bytes = Buffer.from(String(value), 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    hash.update(length).update(bytes)
  }
  return hash.digest('hex')
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('image batch task prompt must be a string')
  const prompt = value.trim()
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS || prompt.includes('\0')) {
    throw new Error(`image batch task prompt must contain 1 to ${MAX_PROMPT_CHARS} characters without NUL`)
  }
  return prompt
}

export function imageBatchPromptSha256(prompt: unknown): string {
  return createHash('sha256').update(normalizePrompt(prompt), 'utf8').digest('hex')
}

export function imageBatchId(parentSessionId: unknown, parentCallId: unknown): string {
  return `sha256:${tupleSha256([
    'emate-image-batch-v1',
    nativeId(parentSessionId, 'parentSessionId'),
    nativeId(parentCallId, 'parentCallId'),
    0,
  ])}`
}

export function imageBatchTaskId(parentSessionId: unknown, parentCallId: unknown, taskOrdinal: unknown): string {
  return `sha256:${tupleSha256([
    'emate-image-task-v1',
    nativeId(parentSessionId, 'parentSessionId'),
    nativeId(parentCallId, 'parentCallId'),
    ordinal(taskOrdinal, MAX_TASKS, 'task ordinal'),
  ])}`
}

export function imageBatchEventId(parentSessionId: unknown, parentCallId: unknown, eventOrdinal: unknown): string {
  return `sha256:${tupleSha256([
    'emate-image-batch-event-v1',
    nativeId(parentSessionId, 'parentSessionId'),
    nativeId(parentCallId, 'parentCallId'),
    ordinal(eventOrdinal, Number.MAX_SAFE_INTEGER, 'event ordinal'),
  ])}`
}

export function normalizeImageBatchRequest(value: unknown): NormalizedImageBatchRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tasks', 'concurrency'])
    || !Object.hasOwn(value, 'tasks') || !Array.isArray(value.tasks)) {
    throw new Error('image batch accepts only tasks and optional concurrency')
  }
  if (value.tasks.length < MIN_TASKS || value.tasks.length > MAX_TASKS) {
    throw new Error(`image batch requires ${MIN_TASKS} to ${MAX_TASKS} tasks`)
  }
  const concurrency = value.concurrency === undefined ? DEFAULT_CONCURRENCY : value.concurrency
  if (!Number.isSafeInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > MAX_CONCURRENCY) {
    throw new Error(`image batch concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`)
  }
  const tasks = value.tasks.map((raw, index): NormalizedImageBatchTask => {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ['prompt', 'image_url']) || !Object.hasOwn(raw, 'prompt')) {
      throw new Error('image batch tasks accept only prompt and optional image_url')
    }
    const prompt = normalizePrompt(raw.prompt)
    const imageUrl = raw.image_url
    const ids = imageUrl === undefined ? [] : Array.isArray(imageUrl) ? imageUrl : [imageUrl]
    if (ids.length > MAX_IMAGE_URLS || ids.some(id => typeof id !== 'string' || !ATTACHMENT_ID.test(id))) {
      throw new Error(`image_url must contain at most ${MAX_IMAGE_URLS} exact sha256 attachment IDs`)
    }
    const attachmentIds = Object.freeze([...new Set(ids as string[])])
    const operation: ImageOperation = attachmentIds.length === 0 ? 'generate' : attachmentIds.length === 1 ? 'edit' : 'fusion'
    return Object.freeze({
      ordinal: index + 1,
      prompt,
      promptSha256: imageBatchPromptSha256(prompt),
      attachmentIds,
      operation,
    })
  })
  return Object.freeze({ tasks: Object.freeze(tasks), concurrency: concurrency as number })
}

/**
 * Fresh public parameter mapping using only the pinned rc.7 defineTool subset.
 * normalizeImageBatchRequest enforces all omitted lengths, patterns, bounds, defaults, and deduplication before effects.
 */
export function imageBatchParameters() {
  return {
    tasks: {
      type: 'array', required: true,
      description: 'Two to eight ordered independent image outputs, including explicitly sourced edits or fusion; dependent outputs must run serially.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true, description: 'One non-empty image instruction of at most 20,000 characters.' },
          image_url: {
            description: 'Optional exact current-session sha256 attachment ID or ordered list of at most 16 IDs for edit or reference fusion; omitted or empty means a new image.',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
    },
    concurrency: { type: 'integer', description: 'Optional worker concurrency from 1 to 4; defaults to 3 when omitted.' },
  }
}

/**
 * Fresh exact Tool-output mapping for the public image_batch result.
 * Pinned rc.7 Tool schemas cannot express regex, numeric, or collection bounds;
 * the native runner therefore remains the mandatory validator for those constraints.
 */
export function imageBatchResultSchema() {
  const receipt = (statuses = ['completed', 'failed', 'cancelled', 'unknown']) => ({
    type: 'object', additionalProperties: false,
    properties: {
      owner_session_id: { type: 'string', required: true },
      call_id: { type: 'string', required: true },
      revision: { type: 'integer', required: true },
      event_seq: { type: 'integer', required: true },
      status: { type: 'string', required: true, enum: statuses },
    },
  })
  const task = () => ({
    type: 'object', additionalProperties: false,
    properties: {
      task_id: { type: 'string', required: true }, ordinal: { type: 'integer', required: true },
      revision: { type: 'integer', required: true },
      state: { type: 'string', required: true, enum: ['completed', 'failed', 'cancelled', 'unknown', 'interrupted'] },
      submission_status: { type: 'string', required: true, enum: ['not-submitted', 'submitted', 'unknown'] },
      prompt_sha256: { type: 'string', required: true },
      image_url: { type: 'array', required: true, items: { type: 'string' } },
      child_session_id: { type: 'string' }, job_id: { type: 'string' }, receipt: receipt(),
      failure_code: { type: 'string' }, updated_at: { type: 'string' },
    },
  })
  const attachment = () => ({
    type: 'object', additionalProperties: false,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp'] },
      bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true },
      height: { type: 'integer', required: true }, name: { type: 'string' },
    },
  })
  const image = () => ({
    type: 'object', additionalProperties: false,
    properties: {
      task_id: { type: 'string', required: true }, ordinal: { type: 'integer', required: true },
      child_session_id: { type: 'string', required: true }, receipt: { ...receipt(['completed']), required: true },
      attachment: { ...attachment(), required: true },
    },
  })
  const failure = () => ({
    type: 'object', additionalProperties: false,
    properties: {
      task_id: { type: 'string', required: true }, ordinal: { type: 'integer', required: true },
      state: { type: 'string', required: true, enum: ['failed', 'cancelled', 'unknown', 'interrupted'] },
      failure_code: { type: 'string', required: true }, child_session_id: { type: 'string' },
      job_id: { type: 'string' }, receipt: receipt(),
    },
  })
  return {
    type: 'object', additionalProperties: false,
    properties: {
      schema_version: { type: 'integer', required: true, const: 1 },
      batch_id: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: ['completed', 'partial', 'failed', 'cancelled'] },
      tasks: { type: 'array', required: true, items: task() },
      images: { type: 'array', required: true, items: image() },
      failures: { type: 'array', required: true, items: failure() },
      terminal_event_id: { type: 'string', required: true },
    },
  }
}
