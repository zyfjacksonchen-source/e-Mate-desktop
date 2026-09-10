import { useMemo } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Untrusted Profile wire rows parsed by the strict e-Mate client selector. */
    eMateImageBatches: readonly unknown[]
  }
}

const PROJECTION_KEY = 'eMateImageBatches'
const DERIVED_ID = /^sha256:[0-9a-f]{64}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const NATIVE_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u
const FAILURE_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const TASK_STATES = new Set(['queued', 'running', 'needs-review', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'])
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'unknown', 'interrupted'])
const BATCH_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])
const SUBMISSION_STATUSES = new Set(['not-submitted', 'submitted', 'unknown'])
const RECEIPT_STATUSES = new Set(['completed', 'needs-review', 'failed', 'cancelled', 'unknown'])

export type ImageBatchClientTaskState = 'queued' | 'running' | 'needs-review' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted'
export type ImageBatchClientStatus = 'completed' | 'partial' | 'failed' | 'cancelled'

export interface ImageBatchClientReceiptPointer {
  readonly ownerSessionId: string
  readonly callId: string
  readonly revision: number
  readonly eventSeq: number
  readonly status: 'completed' | 'needs-review' | 'failed' | 'cancelled' | 'unknown'
}

export interface ImageBatchClientTask {
  readonly taskId: string
  readonly ordinal: number
  readonly revision: number
  readonly state: ImageBatchClientTaskState
  readonly terminal: boolean
  readonly submissionStatus: 'not-submitted' | 'submitted' | 'unknown'
  readonly promptSha256: string
  readonly imageIds: readonly string[]
  readonly childSessionId?: string
  readonly jobId?: string
  readonly receipt?: ImageBatchClientReceiptPointer
  readonly failureCode?: string
  readonly updatedAt?: string
}

export interface ImageBatchClientBatch {
  readonly batchId: string
  readonly parentSessionId: string
  readonly parentCallId: string
  readonly concurrency: number
  readonly tasks: readonly ImageBatchClientTask[]
  readonly tasksById: Readonly<Record<string, ImageBatchClientTask>>
  readonly terminal: boolean
  readonly status?: ImageBatchClientStatus
  readonly terminalEventId?: string
}

export interface ImageBatchClientView {
  readonly batches: readonly ImageBatchClientBatch[]
  readonly batchesById: Readonly<Record<string, ImageBatchClientBatch>>
}

const EMPTY_VIEW: ImageBatchClientView = Object.freeze({ batches: Object.freeze([]), batchesById: Object.freeze({}) })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key))
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 35) return false
  const match = TIMESTAMP.exec(value)
  if (match === null) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText)
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText)
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const offset = value.endsWith('Z') ? undefined : value.slice(-6)
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59
    && (offset === undefined || Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) <= 59)
}

function receiptPointer(value: unknown): ImageBatchClientReceiptPointer | undefined {
  if (!record(value) || !exactKeys(value, ['owner_session_id', 'call_id', 'revision', 'event_seq', 'status'])
    || typeof value.owner_session_id !== 'string' || !NATIVE_ID.test(value.owner_session_id)
    || typeof value.call_id !== 'string' || !NATIVE_ID.test(value.call_id)
    || !integer(value.revision, 1, 3) || !integer(value.event_seq, 0, Number.MAX_SAFE_INTEGER)
    || typeof value.status !== 'string' || !RECEIPT_STATUSES.has(value.status)) return undefined
  return Object.freeze({
    ownerSessionId: value.owner_session_id,
    callId: value.call_id,
    revision: value.revision,
    eventSeq: value.event_seq,
    status: value.status as ImageBatchClientReceiptPointer['status'],
  })
}

function task(value: unknown, expectedOrdinal: number): ImageBatchClientTask | undefined {
  const required = ['task_id', 'ordinal', 'revision', 'state', 'submission_status', 'prompt_sha256', 'image_url']
  const optional = ['child_session_id', 'job_id', 'receipt', 'failure_code', 'updated_at']
  if (!record(value) || !exactKeys(value, required, optional)
    || typeof value.task_id !== 'string' || !DERIVED_ID.test(value.task_id)
    || value.ordinal !== expectedOrdinal || !integer(value.revision, 1, 2_147_483_647)
    || typeof value.state !== 'string' || !TASK_STATES.has(value.state)
    || typeof value.submission_status !== 'string' || !SUBMISSION_STATUSES.has(value.submission_status)
    || typeof value.prompt_sha256 !== 'string' || !SHA256.test(value.prompt_sha256)
    || !Array.isArray(value.image_url) || value.image_url.length > 16
    || value.image_url.some(id => typeof id !== 'string' || !DERIVED_ID.test(id))
    || new Set(value.image_url).size !== value.image_url.length
    || value.child_session_id !== undefined && (typeof value.child_session_id !== 'string' || !NATIVE_ID.test(value.child_session_id))
    || value.job_id !== undefined && (typeof value.job_id !== 'string' || !NATIVE_ID.test(value.job_id))
    || value.failure_code !== undefined && (typeof value.failure_code !== 'string' || !FAILURE_CODE.test(value.failure_code))
    || value.updated_at !== undefined && !timestamp(value.updated_at)) return undefined
  const pointer = value.receipt === undefined ? undefined : receiptPointer(value.receipt)
  if (value.receipt !== undefined && pointer === undefined) return undefined
  if (value.job_id !== undefined && value.child_session_id === undefined) return undefined
  if (pointer !== undefined && pointer.ownerSessionId !== value.child_session_id) return undefined
  const state = value.state as ImageBatchClientTaskState
  const child = value.child_session_id !== undefined
  const job = value.job_id !== undefined
  const failure = value.failure_code !== undefined
  if (state === 'queued' && (value.submission_status !== 'not-submitted' || job || pointer !== undefined || failure)
    || state === 'running' && (!child || !job || pointer !== undefined || failure)
    || (state === 'needs-review' || state === 'completed')
      && (!child || !job || pointer === undefined || value.submission_status !== 'submitted' || failure
        || pointer.status !== (state === 'completed' ? 'completed' : 'needs-review'))
    || state === 'interrupted' && (value.submission_status !== 'not-submitted' || child || job || pointer !== undefined || !failure)
    || TERMINAL_TASK_STATES.has(state) && state !== 'completed' && !failure) return undefined
  return Object.freeze({
    taskId: value.task_id,
    ordinal: value.ordinal,
    revision: value.revision,
    state,
    terminal: TERMINAL_TASK_STATES.has(state),
    submissionStatus: value.submission_status as ImageBatchClientTask['submissionStatus'],
    promptSha256: value.prompt_sha256,
    imageIds: Object.freeze([...(value.image_url as string[])]),
    ...(value.child_session_id === undefined ? {} : { childSessionId: value.child_session_id as string }),
    ...(value.job_id === undefined ? {} : { jobId: value.job_id as string }),
    ...(pointer === undefined ? {} : { receipt: pointer }),
    ...(value.failure_code === undefined ? {} : { failureCode: value.failure_code as string }),
    ...(value.updated_at === undefined ? {} : { updatedAt: value.updated_at as string }),
  })
}

function validDerivedRows(
  value: unknown,
  kind: 'image' | 'failure',
  tasks: Readonly<Record<string, ImageBatchClientTask>>,
): boolean {
  if (!Array.isArray(value)) return false
  const expected = Object.values(tasks).filter(item => kind === 'image'
    ? item.receipt?.status === 'completed'
    : item.terminal && item.state !== 'completed')
  if (value.length !== expected.length) return false
  const seen = new Set<string>()
  return value.every(row => {
    const required = kind === 'image'
      ? ['task_id', 'ordinal', 'child_session_id', 'receipt']
      : ['task_id', 'ordinal', 'state', 'failure_code']
    if (!record(row) || !exactKeys(row, required, kind === 'image' ? [] : ['child_session_id', 'job_id', 'receipt'])) return false
    const item = typeof row.task_id === 'string' ? tasks[row.task_id] : undefined
    if (item === undefined || seen.has(item.taskId) || row.ordinal !== item.ordinal) return false
    seen.add(item.taskId)
    if (row.child_session_id !== undefined && row.child_session_id !== item.childSessionId) return false
    if (row.job_id !== undefined && row.job_id !== item.jobId) return false
    if (row.state !== undefined && row.state !== item.state) return false
    if (row.failure_code !== undefined && row.failure_code !== item.failureCode) return false
    const pointer = row.receipt === undefined ? undefined : receiptPointer(row.receipt)
    if (row.receipt !== undefined && (pointer === undefined || JSON.stringify(pointer) !== JSON.stringify(item.receipt))) return false
    return kind === 'image' ? item.receipt?.status === 'completed' : item.terminal && item.state !== 'completed'
  })
}

function batch(value: unknown, parentSessionId: string): ImageBatchClientBatch | undefined {
  const required = ['schema_version', 'batch_id', 'parent_session_id', 'parent_call_id', 'concurrency', 'tasks', 'image_evidence', 'failures']
  const optional = ['status', 'terminal_event_id']
  if (!record(value) || !exactKeys(value, required, optional) || value.schema_version !== 1
    || typeof value.batch_id !== 'string' || !DERIVED_ID.test(value.batch_id)
    || value.parent_session_id !== parentSessionId
    || typeof value.parent_call_id !== 'string' || !NATIVE_ID.test(value.parent_call_id)
    || !integer(value.concurrency, 1, 4) || !Array.isArray(value.tasks)
    || value.tasks.length < 2 || value.tasks.length > 8
    || value.status !== undefined && (typeof value.status !== 'string' || !BATCH_STATUSES.has(value.status))
    || value.terminal_event_id !== undefined && (typeof value.terminal_event_id !== 'string' || !DERIVED_ID.test(value.terminal_event_id))
    || (value.status === undefined) !== (value.terminal_event_id === undefined)) return undefined
  const tasks = value.tasks.map((item, index) => task(item, index + 1))
  if (tasks.some(item => item === undefined)) return undefined
  const typedTasks = tasks as ImageBatchClientTask[]
  const ids = new Set(typedTasks.map(item => item.taskId))
  if (ids.size !== typedTasks.length) return undefined
  const tasksById = Object.freeze(Object.fromEntries(typedTasks.map(item => [item.taskId, item])))
  if (!validDerivedRows(value.image_evidence, 'image', tasksById)
    || !validDerivedRows(value.failures, 'failure', tasksById)) return undefined
  const terminal = value.status !== undefined
  if (terminal && !typedTasks.every(item => item.terminal)) return undefined
  if (terminal) {
    const images = typedTasks.filter(item => item.receipt?.status === 'completed').length
    const failures = typedTasks.filter(item => item.state !== 'completed').length
    const expectedStatus = typedTasks.every(item => item.state === 'completed') && images === typedTasks.length
      ? 'completed'
      : images > 0 && failures > 0
        ? 'partial'
        : images === 0 && typedTasks.every(item => item.state === 'cancelled' || item.state === 'interrupted')
          ? 'cancelled'
          : 'failed'
    if (value.status !== expectedStatus) return undefined
  }
  return Object.freeze({
    batchId: value.batch_id,
    parentSessionId,
    parentCallId: value.parent_call_id,
    concurrency: value.concurrency,
    tasks: Object.freeze(typedTasks),
    tasksById,
    terminal,
    ...(value.status === undefined ? {} : { status: value.status as ImageBatchClientStatus }),
    ...(value.terminal_event_id === undefined ? {} : { terminalEventId: value.terminal_event_id as string }),
  })
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function shareBatch(next: ImageBatchClientBatch, previous: ImageBatchClientBatch | undefined): ImageBatchClientBatch {
  if (previous === undefined) return next
  const tasks = next.tasks.map(item => {
    const prior = previous.tasksById[item.taskId]
    return prior !== undefined && same(prior, item) ? prior : item
  })
  const tasksById = Object.freeze(Object.fromEntries(tasks.map(item => [item.taskId, item])))
  const shared = Object.freeze({ ...next, tasks: Object.freeze(tasks), tasksById })
  return same(previous, shared) ? previous : shared
}

/** Build one stateful selector for rc.7's whole-value projection hook. */
export function createImageBatchProjectionSelector(parentSessionId: string): (value: unknown) => ImageBatchClientView {
  let previous = EMPTY_VIEW
  return value => {
    if (!NATIVE_ID.test(parentSessionId) || !Array.isArray(value)) return EMPTY_VIEW
    const batches: ImageBatchClientBatch[] = []
    const seen = new Set<string>()
    for (const item of value) {
      const parsed = batch(item, parentSessionId)
      if (parsed === undefined || seen.has(parsed.batchId)) continue
      seen.add(parsed.batchId)
      batches.push(shareBatch(parsed, previous.batchesById[parsed.batchId]))
    }
    const batchesById = Object.freeze(Object.fromEntries(batches.map(item => [item.batchId, item])))
    const next = Object.freeze({ batches: Object.freeze(batches), batchesById })
    if (same(previous, next)) return previous
    previous = next
    return next
  }
}

/** Subscribe one future batch integration subtree to the native per-key projection face. */
export function useImageBatchProjection(useProjection: UseProjection, parentSessionId: string): ImageBatchClientView {
  const selector = useMemo(() => createImageBatchProjectionSelector(parentSessionId), [parentSessionId])
  return useProjection(PROJECTION_KEY, selector, Object.is)
}
