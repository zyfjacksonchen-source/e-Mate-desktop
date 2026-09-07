import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { loadTargetStorageDomain } from './target-runtime.js'

export const name = 'emate-audit'
export const inject = ['connection', 'sessionPersistence', 'storageDomain', 'timer', 'tools', 'emateModelPolicy', 'emateIdentity']
export const AUDIT_CHANNEL = '/emate.audit'

const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u
const MAX_TOKEN_BUCKET = 1_000_000_000_000
const BATCH_SIZE = 64
const TASK_SCENARIOS = [
  'CONTENT_CREATION',
  'GENERAL',
  'DOCUMENT_EDITING',
  'ASSET_PRODUCTION',
  'SEARCH_QUERY',
]
const TASK_SCENARIO = new Set(TASK_SCENARIOS)
const TERMINAL_IMAGE_STATUSES = new Set(['completed', 'needs-review', 'failed', 'cancelled', 'unknown'])
const TRUSTED_TOOL_SCENARIOS = new Map([
  ['office_read', {
    moduleSpecifiers: new Set([
      '@e-mate/dsh-plugin-office-skills',
      './node_modules/@e-mate/dsh-plugin-office-skills/lib/index.js',
    ]),
    pluginName: 'emate-office-skills',
    scenario: 'DOCUMENT_EDITING',
  }],
  ['office_write', {
    moduleSpecifiers: new Set([
      '@e-mate/dsh-plugin-office-skills',
      './node_modules/@e-mate/dsh-plugin-office-skills/lib/index.js',
    ]),
    pluginName: 'emate-office-skills',
    scenario: 'DOCUMENT_EDITING',
  }],
  ['imagegen', {
    moduleSpecifiers: new Set(['./plugins/image-generation.js']),
    pluginName: 'emate-image-generation',
    scenario: 'ASSET_PRODUCTION',
  }],
  ['image_batch', {
    moduleSpecifiers: new Set(['./plugins/image-generation.js']),
    pluginName: 'emate-image-generation',
    scenario: 'ASSET_PRODUCTION',
  }],
  ['web_search', {
    moduleSpecifiers: new Set(['@deepseek-ai/dsh-tool-web']),
    pluginName: 'tool-web',
    scenario: 'SEARCH_QUERY',
  }],
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tokenBucket(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_BUCKET ? value : undefined
}

function validBinding(binding, provider, model) {
  return isRecord(binding)
    && binding.schema_version === 1
    && SHA256.test(binding.account_subject_sha256)
    && Number.isSafeInteger(binding.policy_revision) && binding.policy_revision >= 1
    && typeof binding.policy_receipt_id === 'string' && SAFE_ID.test(binding.policy_receipt_id)
    && typeof binding.policy_sha256 === 'string' && SHA256.test(binding.policy_sha256)
    && binding.provider === provider
    && binding.model === model
}

function bindingKey(sessionId, turn, step) {
  return `${sha256(String(sessionId))}:${turn}:${step}`
}

function taskBindingKey(sessionId, turn) {
  return `${sha256(String(sessionId))}:${turn}`
}

function taskIdFor(sessionId, turn) {
  return `task_${sha256(`e-Mate task v1\0${sha256(String(sessionId))}:${turn}`)}`
}

function terminalTaskScenario(candidates, envelopes, terminalType) {
  const values = new Set(candidates)
  if (values.has('GENERAL')
    || values.has('DOCUMENT_EDITING') && values.has('ASSET_PRODUCTION')) return 'GENERAL'
  if (values.has('ASSET_PRODUCTION')) return 'ASSET_PRODUCTION'
  if (values.has('DOCUMENT_EDITING')) return 'DOCUMENT_EDITING'
  if (values.has('SEARCH_QUERY')) return 'SEARCH_QUERY'
  const usedTool = envelopes.some(envelope => envelope.type === 'TOOL_EXECUTION')
  const modelResponded = envelopes.some(envelope => envelope.type === 'FIRST_RESPONSE')
  return !usedTool && modelResponded && terminalType === 'COMPLETED' ? 'CONTENT_CREATION' : 'GENERAL'
}

function trustedToolScenario(ctx, exec) {
  const trusted = TRUSTED_TOOL_SCENARIOS.get(exec?.name)
  if (trusted === undefined || !isRecord(exec?.agent)) return 'GENERAL'
  try {
    const provenance = ctx.tools.provenance(exec.name, exec.agent)
    return isRecord(provenance)
      && trusted.moduleSpecifiers.has(provenance.moduleSpecifier)
      && provenance.pluginName === trusted.pluginName
      ? trusted.scenario
      : 'GENERAL'
  } catch {
    return 'GENERAL'
  }
}

function exactImageRef(value) {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'attachmentId,bytes,height,mediaType,width' && keys !== 'attachmentId,bytes,height,mediaType,name,width'
    || typeof value.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.attachmentId)
    || typeof value.mediaType !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mediaType)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 5 * 1024 * 1024
    || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 65_535
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 65_535
    || value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255 || /[\u0000/\\]/u.test(value.name))) return undefined
  return value
}

export function imageBatchAuditCorrelation(event) {
  if (!Number.isSafeInteger(event?.time) || event.time < 0 || !Number.isFinite(new Date(event.time).getTime())) return undefined
  const occurredAt = new Date(event.time).toISOString()
  const data = event?.data
  if (event?.type === 'emate/image-output' && isRecord(data) && data.schema_version === 2
    && data.status === 'completed' && data.billing_status === 'recorded'
    && typeof data.client_request_id === 'string' && /^image-[0-9a-f]{64}$/u.test(data.client_request_id)
    && Array.isArray(data.content) && data.content.length === 1 && isRecord(data.content[0]) && data.content[0].type === 'image') {
    const output = exactImageRef(data.output)
    const content = exactImageRef(data.content[0].attachment)
    if (output === undefined || content === undefined || canonicalJson(output) !== canonicalJson(content)) return undefined
    return {
      schema_version: 1,
      stage: 'attachment_commit',
      trace_id: data.client_request_id,
      client_request_id: data.client_request_id,
      task_id: `sha256:${data.client_request_id.slice('image-'.length)}`,
      occurred_at: occurredAt,
    }
  }
  const task = data?.task
  if (event?.type !== 'emate/image-batch' || !isRecord(data) || data.kind !== 'task-state'
    || typeof data.batch_id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(data.batch_id)
    || !isRecord(task) || typeof task.task_id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(task.task_id)
    || !Number.isSafeInteger(task.ordinal) || task.ordinal < 1 || task.ordinal > 8) return undefined
  const clientRequestId = `image-${task.task_id.slice('sha256:'.length)}`
  return {
    schema_version: 1,
    stage: 'parent_projection_append',
    trace_id: clientRequestId,
    client_request_id: clientRequestId,
    task_id: task.task_id,
    batch_id: data.batch_id,
    ordinal: task.ordinal,
    occurred_at: occurredAt,
  }
}

function terminalImageReceipt(sessionId, event) {
  return event?.type === 'emate/image-output'
    && isRecord(event.data)
    && event.data.schema_version === 2
    && typeof event.data.call_id === 'string' && event.data.call_id.length > 0
    && event.data.parent_session_id === String(sessionId)
    && TERMINAL_IMAGE_STATUSES.has(event.data.status)
}

function taskType(event) {
  if (event.type === 'turn/start') return 'RECEIVED'
  if (event.type === 'tool/call') return 'TOOL_EXECUTION'
  if (event.type === 'approval/asked') return 'PERMISSION_REQUESTED'
  if (event.type === 'assistant/message'
    && isRecord(event.data?.message?.source)
    && event.data.message.source.kind === 'model') return 'FIRST_RESPONSE'
  if (event.type !== 'turn/end' || !isRecord(event.data?.reason)) return undefined
  if (event.data.reason.kind === 'completed') return 'COMPLETED'
  if (['aborted', 'disposed', 'interrupted'].includes(event.data.reason.kind)) return 'CANCELLED'
  return 'FAILED'
}

export function createTaskAuditFact(sessionId, event, type, binding, turn = event?.data?.turn, scenario = 'GENERAL') {
  if (!isRecord(event)
    || !['RECEIVED', 'FIRST_RESPONSE', 'COMPLETED', 'FAILED', 'CANCELLED', 'TOOL_EXECUTION', 'PERMISSION_REQUESTED'].includes(type)
    || !Number.isSafeInteger(event.seq) || event.seq < 0
    || !Number.isSafeInteger(event.time) || event.time < 0
    || !Number.isSafeInteger(turn) || turn < 1
    || !isRecord(binding)
    || binding.schema_version !== 1
    || !SHA256.test(binding.account_subject_sha256)
    || !TASK_SCENARIO.has(scenario)) return undefined
  const occurredAt = new Date(event.time)
  if (!Number.isFinite(occurredAt.getTime())) return undefined
  const sessionIdSha256 = sha256(String(sessionId))
  const taskId = taskIdFor(sessionId, turn)
  const eventId = `taskevent_${sha256(`e-Mate task event v1\0${sessionIdSha256}:${event.seq}:${type}`)}`
  const payload = {
    schemaVersion: 1,
    eventId,
    taskId,
    type,
    scenario,
    occurredAt: occurredAt.toISOString(),
  }
  return {
    schema_version: 1,
    event_id: eventId,
    account_subject_sha256: binding.account_subject_sha256,
    payload,
    payload_sha256: sha256(canonicalJson(payload)),
    source_seq: event.seq,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: payload.occurredAt,
  }
}

export function createUsageFact(sessionId, event, binding) {
  if (!isRecord(event)
    || event.type !== 'assistant/message'
    || !Number.isSafeInteger(event.seq) || event.seq < 0
    || !Number.isSafeInteger(event.time) || event.time < 0
    || !isRecord(event.data)
    || !Number.isSafeInteger(event.data.turn) || event.data.turn < 1
    || !Number.isSafeInteger(event.data.step) || event.data.step < 1
    || !isRecord(event.data.message)
    || !isRecord(event.data.message.source)
    || event.data.message.source.kind !== 'model'
    || typeof event.data.message.source.provider !== 'string' || !SAFE_ID.test(event.data.message.source.provider)
    || typeof event.data.message.source.model !== 'string' || !SAFE_ID.test(event.data.message.source.model)
    || !isRecord(event.data.usage)) return undefined

  const usage = event.data.usage
  const inputTokens = tokenBucket(usage.inputTokens)
  const outputTokens = tokenBucket(usage.outputTokens)
  const cacheReadTokens = tokenBucket(usage.cacheReadTokens ?? 0)
  const cacheWriteTokens = tokenBucket(usage.cacheWriteTokens ?? 0)
  const reasoningTokens = tokenBucket(usage.reasoningTokens ?? 0)
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].includes(undefined)) {
    return undefined
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (!Number.isSafeInteger(totalTokens) || totalTokens > MAX_TOKEN_BUCKET) return undefined

  const sessionIdSha256 = sha256(String(sessionId))
  const sourceId = `harness:${sessionIdSha256}:${event.seq}`
  const provider = event.data.message.source.provider
  const model = event.data.message.source.model
  const bound = validBinding(binding, provider, model)
  const payload = {
    schema_version: 1,
    source_service: 'e-mate-audit',
    source_id: sourceId,
    usage_kind: 'chat',
    session_id_sha256: sessionIdSha256,
    event_seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    provider_created_at: new Date(event.time).toISOString(),
    requested_model_id: model,
    actual_model_id: model,
    actual_provider_id: provider,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    ...(bound ? {
      account_subject_sha256: binding.account_subject_sha256,
      policy_revision: binding.policy_revision,
      policy_receipt_id: binding.policy_receipt_id,
      policy_sha256: binding.policy_sha256,
    } : {}),
  }
  const payloadSha256 = sha256(canonicalJson(payload))
  return {
    schema_version: 1,
    fact_id: `auditfact_${sha256(`e-Mate audit v1\0${sourceId}`)}`,
    payload,
    payload_sha256: payloadSha256,
    status: bound && totalTokens > 0 ? 'pending' : 'blocked',
    attempt_count: 0,
    next_attempt_at: new Date(event.time).toISOString(),
    ...(bound ? {} : { last_error_code: 'identity-policy-binding-missing-or-conflicting' }),
    ...(totalTokens > 0 ? {} : { last_error_code: 'provider-usage-zero' }),
  }
}

function bindUsageFact(fact, binding) {
  const payload = fact?.payload
  if (!isRecord(payload) || !validBinding(binding, payload.actual_provider_id, payload.actual_model_id)) return fact
  const boundPayload = {
    ...payload,
    account_subject_sha256: binding.account_subject_sha256,
    policy_revision: binding.policy_revision,
    policy_receipt_id: binding.policy_receipt_id,
    policy_sha256: binding.policy_sha256,
  }
  const { last_error_code: _lastError, ...base } = fact
  return {
    ...base,
    payload: boundPayload,
    payload_sha256: sha256(canonicalJson(boundPayload)),
    status: payload.total_tokens > 0 ? 'pending' : 'blocked',
    ...(payload.total_tokens > 0 ? {} : { last_error_code: 'provider-usage-zero' }),
  }
}

function errorCode(error) {
  const text = error instanceof Error ? error.message : String(error)
  return sha256(text).slice(0, 16)
}

function validateUploadReceipts(value, records) {
  if (!isRecord(value)
    || value.schema_version !== 1
    || !Array.isArray(value.receipts)
    || value.receipts.length !== records.length) {
    throw new Error('e-Mate enterprise audit receipt batch is invalid')
  }
  const expected = new Map(records.map(record => [record.fact_id, record.payload_sha256]))
  const receipts = new Map()
  for (const receipt of value.receipts) {
    if (!isRecord(receipt)
      || Object.keys(receipt).sort().join(',') !== 'accepted_at,fact_id,payload_sha256,receipt_id'
      || typeof receipt.fact_id !== 'string'
      || expected.get(receipt.fact_id) !== receipt.payload_sha256
      || typeof receipt.receipt_id !== 'string' || !SAFE_ID.test(receipt.receipt_id)
      || typeof receipt.accepted_at !== 'string' || !Number.isFinite(Date.parse(receipt.accepted_at))
      || receipts.has(receipt.fact_id)) {
      throw new Error('e-Mate enterprise audit receipt is invalid')
    }
    receipts.set(receipt.fact_id, receipt)
  }
  if (receipts.size !== expected.size) throw new Error('e-Mate enterprise audit receipt set is incomplete')
  return receipts
}

function validateTaskUploadReceipts(value, records) {
  if (!isRecord(value)
    || value.schema_version !== 1
    || !Array.isArray(value.receipts)) {
    throw new Error('e-Mate enterprise task audit receipt batch is invalid')
  }
  const expected = new Map(records.map(record => [record.event_id, record.payload_sha256]))
  const receipts = new Map()
  for (const receipt of value.receipts) {
    if (!isRecord(receipt)
      || Object.keys(receipt).sort().join(',') !== 'accepted_at,event_id,payload_sha256,receipt_id'
      || typeof receipt.event_id !== 'string'
      || expected.get(receipt.event_id) !== receipt.payload_sha256
      || typeof receipt.receipt_id !== 'string' || !SAFE_ID.test(receipt.receipt_id)
      || typeof receipt.accepted_at !== 'string' || !Number.isFinite(Date.parse(receipt.accepted_at))
      || receipts.has(receipt.event_id)) {
      continue
    }
    receipts.set(receipt.event_id, receipt)
  }
  return receipts
}

function validTaskFactRecord(record) {
  if (!isRecord(record)
    || record.schema_version !== 1
    || typeof record.event_id !== 'string' || !/^taskevent_[0-9a-f]{64}$/u.test(record.event_id)
    || typeof record.account_subject_sha256 !== 'string' || !SHA256.test(record.account_subject_sha256)
    || !isRecord(record.payload)
    || Object.keys(record.payload).sort().join(',') !== 'eventId,occurredAt,scenario,schemaVersion,taskId,type'
    || record.payload.schemaVersion !== 1
    || record.payload.eventId !== record.event_id
    || typeof record.payload.taskId !== 'string' || !/^task_[0-9a-f]{64}$/u.test(record.payload.taskId)
    || !['RECEIVED', 'FIRST_RESPONSE', 'COMPLETED', 'FAILED', 'CANCELLED', 'TOOL_EXECUTION', 'PERMISSION_REQUESTED'].includes(record.payload.type)
    || !TASK_SCENARIO.has(record.payload.scenario)
    || typeof record.payload.occurredAt !== 'string' || !Number.isFinite(Date.parse(record.payload.occurredAt))
    || typeof record.payload_sha256 !== 'string'
    || record.payload_sha256 !== sha256(canonicalJson(record.payload))
    || !Number.isSafeInteger(record.source_seq) || record.source_seq < 0) return false
  return true
}

function validTaskOutboxRecord(record) {
  if (!validTaskFactRecord(record)
    || !Number.isSafeInteger(record.attempt_count) || record.attempt_count < 0
    || typeof record.next_attempt_at !== 'string' || !Number.isFinite(Date.parse(record.next_attempt_at))
    || record.status !== 'pending') return false
  return true
}

function createAuditService(
  ctx,
  bindingsTable,
  outboxTable,
  auditProvider,
  taskBindingsTable,
  taskOutboxTable,
  taskAuditProvider,
) {
  const bindings = new Map(bindingsTable.entries())
  const outbox = new Map(outboxTable.entries())
  const taskBindings = new Map(taskBindingsTable.entries())
  const taskOutbox = new Map(taskOutboxTable.entries())
  const durableUsageFacts = new Set(outbox.keys())
  const durableTaskFacts = new Set(taskOutbox.keys())
  const firstResponseTasks = new Set(
    [...taskOutbox.values()]
      .filter(record => validTaskFactRecord(record) && record.payload.type === 'FIRST_RESPONSE')
      .map(record => record.payload.taskId),
  )
  const lockedTaskScenarios = new Map()
  for (const record of taskOutbox.values()) {
    if (!validTaskFactRecord(record)) continue
    const taskId = record?.payload?.taskId
    const scenario = record?.payload?.scenario
    if (typeof taskId !== 'string' || !TASK_SCENARIO.has(scenario)) continue
    const existing = lockedTaskScenarios.get(taskId)
    lockedTaskScenarios.set(taskId, existing === undefined || existing === scenario ? scenario : 'GENERAL')
  }
  const openTurns = new Map()
  const taskStates = new Map()
  const writeQueues = new Map()
  const pendingUsageFacts = new Map()
  const failedUsageBindings = new Set()
  const quarantinedTaskFacts = new Set()
  let flushPromise

  const queueKey = sessionId => sha256(String(sessionId))
  const enqueue = (key, operation) => {
    const previous = writeQueues.get(key) ?? Promise.resolve()
    const queued = previous.then(operation, operation).catch((error) => {
      ctx.logger?.warn?.(`e-Mate audit outbox write failed: ${errorCode(error)}`)
    })
    writeQueues.set(key, queued)
    void queued.finally(() => {
      if (writeQueues.get(key) === queued) writeQueues.delete(key)
    })
    return queued
  }
  const drain = async (sessionId) => {
    const only = sessionId === undefined ? undefined : queueKey(sessionId)
    while (true) {
      const pending = only === undefined
        ? [...writeQueues.values()]
        : [writeQueues.get(only)].filter(Boolean)
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  const persistUsageFact = (fact) => {
    const existing = outbox.get(fact.fact_id)
    if (existing !== undefined) {
      if (existing.payload_sha256 !== fact.payload_sha256) {
        ctx.logger?.warn?.(`e-Mate audit fact conflict: ${fact.fact_id.slice(-16)}`)
      }
      return
    }
    outbox.set(fact.fact_id, fact)
    enqueue(fact.payload.session_id_sha256, async () => {
      await outboxTable.put(fact.fact_id, fact)
      durableUsageFacts.add(fact.fact_id)
    })
  }

  const captureBinding = (sessionId, turn, step, provider, model, context) => {
    const key = bindingKey(sessionId, turn, step)
    const binding = {
      schema_version: 1,
      account_subject_sha256: context.account_subject_sha256,
      policy_revision: context.policy_revision,
      policy_receipt_id: context.policy_receipt_id,
      policy_sha256: context.policy_sha256,
      provider,
      model,
      created_at: new Date().toISOString(),
    }
    const existing = bindings.get(key)
    if (existing !== undefined) {
      const { created_at: _existingAt, ...existingIdentity } = existing
      const { created_at: _nextAt, ...nextIdentity } = binding
      if (canonicalJson(existingIdentity) !== canonicalJson(nextIdentity)) {
        ctx.logger?.warn?.(`e-Mate audit binding conflict: ${sha256(key).slice(0, 16)}`)
      }
      return
    }
    bindings.set(key, binding)
    enqueue(queueKey(sessionId), () => bindingsTable.put(key, binding))
    failedUsageBindings.delete(key)
    const pending = pendingUsageFacts.get(key)
    if (pending !== undefined) {
      pendingUsageFacts.delete(key)
      persistUsageFact(bindUsageFact(pending, binding))
    }
  }

  const captureBindingFailure = (sessionId, turn, step) => {
    const key = bindingKey(sessionId, turn, step)
    failedUsageBindings.add(key)
    const pending = pendingUsageFacts.get(key)
    if (pending !== undefined) {
      pendingUsageFacts.delete(key)
      persistUsageFact(pending)
    }
  }

  const captureEvent = (sessionId, event, live = true) => {
    if (event?.type !== 'assistant/message' || event.data?.usage === undefined) return
    const key = bindingKey(sessionId, event.data.turn, event.data.step)
    const binding = bindings.get(key)
    const fact = createUsageFact(sessionId, event, binding)
    if (fact === undefined) {
      ctx.logger?.warn?.(`e-Mate audit rejected malformed usage: ${sha256(`${String(sessionId)}:${event?.seq}`).slice(0, 16)}`)
      return
    }
    if (binding === undefined && live && !failedUsageBindings.has(key)) {
      const pending = pendingUsageFacts.get(key)
      if (pending !== undefined && pending.payload_sha256 !== fact.payload_sha256) {
        ctx.logger?.warn?.(`e-Mate audit pending fact conflict: ${fact.fact_id.slice(-16)}`)
      }
      if (pending === undefined) pendingUsageFacts.set(key, fact)
      return
    }
    persistUsageFact(fact)
  }

  const taskState = (sessionId, turn, binding) => {
    const key = taskBindingKey(sessionId, turn)
    let state = taskStates.get(key)
    if (state !== undefined) return state
    const taskId = taskIdFor(sessionId, turn)
    state = {
      key,
      sessionId,
      turn,
      binding,
      taskId,
      candidates: new Set(Array.isArray(binding.scenario_candidates)
        ? binding.scenario_candidates.filter(candidate => TASK_SCENARIO.has(candidate))
        : []),
      lockedScenario: lockedTaskScenarios.get(taskId)
        ?? (TASK_SCENARIO.has(binding.locked_scenario) ? binding.locked_scenario : undefined),
      envelopes: [],
      envelopeIds: new Set(),
      firstResponse: firstResponseTasks.has(taskId),
    }
    taskStates.set(key, state)
    return state
  }

  const persistTaskBinding = (state, binding) => {
    state.binding = binding
    taskBindings.set(state.key, binding)
    enqueue(queueKey(state.sessionId), () => taskBindingsTable.put(state.key, binding))
  }

  const addCandidate = (state, scenario) => {
    if (state.lockedScenario !== undefined || !TASK_SCENARIO.has(scenario) || state.candidates.has(scenario)) return
    state.candidates.add(scenario)
    const scenarioCandidates = TASK_SCENARIOS.filter(candidate => state.candidates.has(candidate))
    persistTaskBinding(state, { ...state.binding, scenario_candidates: scenarioCandidates })
  }

  const addEnvelope = (state, event, type) => {
    const id = `${event.seq}:${type}`
    if (state.envelopeIds.has(id)) return
    if (type === 'FIRST_RESPONSE') {
      if (state.firstResponse) return
      state.firstResponse = true
      firstResponseTasks.add(state.taskId)
    }
    state.envelopeIds.add(id)
    state.envelopes.push({ seq: event.seq, time: event.time, turn: state.turn, type })
  }

  const lockTask = (state, terminalType, forcedScenario) => {
    const scenario = state.lockedScenario
      ?? forcedScenario
      ?? terminalTaskScenario(state.candidates, state.envelopes, terminalType)
    state.lockedScenario = scenario
    lockedTaskScenarios.set(state.taskId, scenario)
    persistTaskBinding(state, {
      ...state.binding,
      scenario_candidates: TASK_SCENARIOS.filter(candidate => state.candidates.has(candidate)),
      locked_scenario: scenario,
    })
    for (const envelope of state.envelopes.sort((left, right) => left.seq - right.seq)) {
      const fact = createTaskAuditFact(
        state.sessionId,
        { seq: envelope.seq, time: envelope.time, data: { turn: state.turn } },
        envelope.type,
        state.binding,
        state.turn,
        scenario,
      )
      if (fact === undefined) continue
      const existing = taskOutbox.get(fact.event_id)
      if (existing !== undefined) {
        if (existing.payload_sha256 !== fact.payload_sha256) {
          ctx.logger?.warn?.(`e-Mate task audit fact conflict: ${fact.event_id.slice(-16)}`)
        }
        continue
      }
      taskOutbox.set(fact.event_id, fact)
      enqueue(queueKey(state.sessionId), async () => {
        await taskOutboxTable.put(fact.event_id, fact)
        durableTaskFacts.add(fact.event_id)
      })
    }
    taskStates.delete(state.key)
    openTurns.delete(String(state.sessionId))
    return scenario
  }

  const captureTaskEvent = (sessionId, event, live) => {
    if (!isRecord(event) || !isRecord(event.data)) return
    const imageCorrelation = live ? imageBatchAuditCorrelation(event) : undefined
    if (imageCorrelation !== undefined) {
      queueMicrotask(() => {
        try { ctx.logger?.info?.(JSON.stringify({ event: 'image_observation', ...imageCorrelation })) } catch { /* Audit logging cannot own Tool success. */ }
      })
    }
    const sessionKey = String(sessionId)
    let turn = Number.isSafeInteger(event.data.turn) ? event.data.turn : openTurns.get(sessionKey)
    if (event.type === 'turn/start') {
      if (!Number.isSafeInteger(turn) || turn < 1) return
      const previousTurn = openTurns.get(sessionKey)
      if (Number.isSafeInteger(previousTurn) && previousTurn !== turn) {
        const previous = taskStates.get(taskBindingKey(sessionId, previousTurn))
        if (previous !== undefined) lockTask(previous, undefined, 'GENERAL')
      }
      openTurns.set(sessionKey, turn)
      const key = taskBindingKey(sessionId, turn)
      if (live && !taskBindings.has(key)) {
        const subject = ctx.emateIdentity.localAccountSubject?.()
        if (typeof subject === 'string' && subject.length > 0) {
          const binding = {
            schema_version: 1,
            account_subject_sha256: sha256(subject),
            created_at: new Date(event.time).toISOString(),
          }
          taskBindings.set(key, binding)
          enqueue(queueKey(sessionId), () => taskBindingsTable.put(key, binding))
        }
      }
    }
    if (event.type !== 'turn/start' && openTurns.get(sessionKey) !== turn) return
    if (!Number.isSafeInteger(turn) || turn < 1) return
    const key = taskBindingKey(sessionId, turn)
    const binding = taskBindings.get(key)
    if (!isRecord(binding)) {
      if (live) ctx.logger?.warn?.(`e-Mate task audit binding unavailable: ${sha256(key).slice(0, 16)}`)
      if (event.type === 'turn/end') openTurns.delete(sessionKey)
      return
    }
    const state = taskState(sessionId, turn, binding)
    if (event.type === 'assistant/message'
      && isRecord(event.data.message?.source)
      && event.data.message.source.kind === 'model') {
      addCandidate(state, 'CONTENT_CREATION')
    }
    if (terminalImageReceipt(sessionId, event)) addCandidate(state, 'ASSET_PRODUCTION')
    const type = taskType(event)
    if (type !== undefined) addEnvelope(state, event, type)
    if (event.type === 'turn/end') {
      lockTask(state, type, type === undefined ? 'GENERAL' : undefined)
    }
  }

  const captureToolResult = (exec) => {
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string') return
    const turn = openTurns.get(sessionId)
    if (!Number.isSafeInteger(turn) || turn < 1) return
    const key = taskBindingKey(sessionId, turn)
    const binding = taskBindings.get(key)
    if (!isRecord(binding)) return
    const scenario = trustedToolScenario(ctx, exec)
    if (scenario !== undefined) addCandidate(taskState(sessionId, turn, binding), scenario)
  }

  const closeSession = (sessionId) => {
    const turn = openTurns.get(String(sessionId))
    if (!Number.isSafeInteger(turn) || turn < 1) return
    const state = taskStates.get(taskBindingKey(sessionId, turn))
    if (state !== undefined) lockTask(state, undefined, 'GENERAL')
  }

  const status = () => {
    const counts = { pending: 0, delivered: 0, blocked: 0 }
    let pendingTokens = 0
    let deliveredTokens = 0
    for (const record of outbox.values()) {
      if (Object.hasOwn(counts, record.status)) counts[record.status] += 1
      if (record.status === 'pending') pendingTokens += record.payload.total_tokens
      if (record.status === 'delivered') deliveredTokens += record.payload.total_tokens
    }
    let taskPending = 0
    let taskDelivered = 0
    for (const record of taskOutbox.values()) {
      if (record.status === 'pending') taskPending += 1
      if (record.status === 'delivered') taskDelivered += 1
    }
    return {
      schema_version: 1,
      ...counts,
      pending_tokens: pendingTokens,
      delivered_tokens: deliveredTokens,
      task_events_pending: taskPending,
      task_events_delivered: taskDelivered,
    }
  }

  const flushUsageCore = async (force) => {
    if (typeof auditProvider?.upload !== 'function') return { ...status(), delivered_now: 0, provider_ready: false }
    const now = Date.now()
    const pending = [...outbox.values()]
      .filter(record => durableUsageFacts.has(record.fact_id)
        && record.status === 'pending'
        && (force || Date.parse(record.next_attempt_at) <= now))
      .sort((left, right) => left.payload.provider_created_at.localeCompare(right.payload.provider_created_at))
      .slice(0, BATCH_SIZE)
    if (pending.length === 0) return { ...status(), delivered_now: 0, provider_ready: true }
    try {
      const receipts = validateUploadReceipts(await auditProvider.upload(pending.map(record => ({
        fact_id: record.fact_id,
        payload_sha256: record.payload_sha256,
        payload: structuredClone(record.payload),
      }))), pending)
      for (const record of pending) {
        const receipt = receipts.get(record.fact_id)
        const { last_error_code: _lastError, ...withoutError } = record
        const delivered = {
          ...withoutError,
          status: 'delivered',
          receipt_id: receipt.receipt_id,
          delivered_at: new Date(Date.parse(receipt.accepted_at)).toISOString(),
          next_attempt_at: record.next_attempt_at,
        }
        outbox.set(record.fact_id, delivered)
        enqueue(record.payload.session_id_sha256, () => outboxTable.put(record.fact_id, delivered))
        await Promise.resolve(ctx.emateModelPolicy.markAuditDelivered?.(record.fact_id, receipt.accepted_at))
          .catch(error => ctx.logger?.warn?.(`e-Mate local quota audit reconciliation failed: ${errorCode(error)}`))
      }
      return { ...status(), delivered_now: pending.length, provider_ready: true }
    } catch (error) {
      const code = errorCode(error)
      for (const record of pending) {
        const attempts = record.attempt_count + 1
        const deferred = {
          ...record,
          attempt_count: attempts,
          next_attempt_at: new Date(now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8))).toISOString(),
          last_error_code: code,
        }
        outbox.set(record.fact_id, deferred)
        enqueue(record.payload.session_id_sha256, () => outboxTable.put(record.fact_id, deferred))
      }
      return { ...status(), delivered_now: 0, provider_ready: true, error_code: code }
    }
  }


  const flushTaskCore = async (force) => {
    if (typeof taskAuditProvider?.upload !== 'function') {
      return { delivered_now: 0, provider_ready: false }
    }
    const now = Date.now()
    const pending = [...taskOutbox.values()]
      .filter((record) => {
        if (!durableTaskFacts.has(record?.event_id) || record?.status !== 'pending') return false
        if (!validTaskOutboxRecord(record)) {
          if (!quarantinedTaskFacts.has(record.event_id)) {
            quarantinedTaskFacts.add(record.event_id)
            ctx.logger?.warn?.(`e-Mate task audit quarantined malformed record: ${sha256(String(record.event_id)).slice(0, 16)}`)
          }
          return false
        }
        return force || Date.parse(record.next_attempt_at) <= now
      })
      .sort((left, right) => left.payload.occurredAt.localeCompare(right.payload.occurredAt) || left.source_seq - right.source_seq)
      .slice(0, BATCH_SIZE)
    if (pending.length === 0) return { delivered_now: 0, provider_ready: true }
    try {
      const receipts = validateTaskUploadReceipts(await taskAuditProvider.upload(pending.map(record => ({
        event_id: record.event_id,
        account_subject_sha256: record.account_subject_sha256,
        payload_sha256: record.payload_sha256,
        payload: structuredClone(record.payload),
      }))), pending)
      let deliveredNow = 0
      for (const record of pending) {
        const receipt = receipts.get(record.event_id)
        if (receipt === undefined) {
          const attempts = record.attempt_count + 1
          const deferred = {
            ...record,
            attempt_count: attempts,
            next_attempt_at: new Date(now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8))).toISOString(),
            last_error_code: errorCode('e-Mate enterprise task audit receipt is missing or invalid'),
          }
          taskOutbox.set(record.event_id, deferred)
          enqueue(record.payload.taskId, () => taskOutboxTable.put(record.event_id, deferred))
          continue
        }
        const { last_error_code: _lastError, ...withoutError } = record
        const delivered = {
          ...withoutError,
          status: 'delivered',
          receipt_id: receipt.receipt_id,
          delivered_at: new Date(Date.parse(receipt.accepted_at)).toISOString(),
        }
        taskOutbox.set(record.event_id, delivered)
        enqueue(record.payload.taskId, () => taskOutboxTable.put(record.event_id, delivered))
        deliveredNow += 1
      }
      return { delivered_now: deliveredNow, provider_ready: true }
    } catch (error) {
      const code = errorCode(error)
      for (const record of pending) {
        const attempts = record.attempt_count + 1
        const deferred = {
          ...record,
          attempt_count: attempts,
          next_attempt_at: new Date(now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8))).toISOString(),
          last_error_code: code,
        }
        taskOutbox.set(record.event_id, deferred)
        enqueue(record.payload.taskId, () => taskOutboxTable.put(record.event_id, deferred))
      }
      return { delivered_now: 0, provider_ready: true, error_code: code }
    }
  }

  const flush = ({ force = false } = {}) => {
    if (flushPromise !== undefined) return flushPromise
    flushPromise = (async () => {
      const [usage, tasks] = await Promise.all([flushUsageCore(force), flushTaskCore(force)])
      return { ...usage, task_delivered_now: tasks.delivered_now, task_provider_ready: tasks.provider_ready }
    })().finally(() => { flushPromise = undefined })
    return flushPromise
  }

  // Reuse the original turn's account binding for Host-only restoration checks.
  // Missing historical evidence must never be assigned to the current account.
  const ownsTask = (sessionId, turn) => {
    if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(turn) || turn < 1) return false
    const principal = ctx.emateIdentity.localAccountPrincipal?.()
    const subject = ctx.emateIdentity.localAccountSubject?.()
    if (!principal?.tenantId || !principal?.userId || typeof subject !== 'string' || !subject) return false
    return taskBindings.get(taskBindingKey(sessionId, turn))?.account_subject_sha256 === sha256(subject)
  }

  return { captureBinding, captureBindingFailure, captureEvent, captureTaskEvent, captureToolResult, closeSession, drain, flush, status, ownsTask }
}

async function backfill(ctx, service) {
  const headers = await ctx.sessionPersistence.list()
  await Promise.allSettled(headers.map(async (header) => {
    const { events } = await ctx.sessionPersistence.readFrom(header.id, 0)
    for (const event of events) {
      service.captureEvent(header.id, event, false)
      service.captureTaskEvent(header.id, event, false)
    }
    service.closeSession(header.id)
    await service.drain(header.id)
  }))
}

export async function apply(ctx, config = {}) {
  const flushIntervalMs = config.flushIntervalMs ?? 30_000
  if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs < 1_000 || flushIntervalMs > 3_600_000) {
    throw new Error('e-Mate audit flush interval is invalid')
  }
  const { defineDomain, domainTable, z } = await loadTargetStorageDomain(
    config.bindingPath ?? join(import.meta.dirname, 'runtime-binding.json'),
  )
  const binding = z.object({
    schema_version: z.literal(1),
    account_subject_sha256: z.string().regex(SHA256),
    policy_revision: z.number().int().min(1),
    policy_receipt_id: z.string().regex(SAFE_ID),
    policy_sha256: z.string().regex(SHA256),
    provider: z.string().regex(SAFE_ID),
    model: z.string().regex(SAFE_ID),
    created_at: z.iso.datetime(),
  })
  const outbox = z.object({
    schema_version: z.literal(1),
    fact_id: z.string().regex(/^auditfact_[0-9a-f]{64}$/u),
    payload: z.json(),
    payload_sha256: z.string().regex(SHA256),
    status: z.enum(['pending', 'blocked', 'delivered']),
    attempt_count: z.number().int().min(0),
    next_attempt_at: z.iso.datetime(),
    last_error_code: z.string().max(128).optional(),
    receipt_id: z.string().regex(SAFE_ID).optional(),
    delivered_at: z.iso.datetime().optional(),
  })
  const taskBinding = z.object({
    schema_version: z.literal(1),
    account_subject_sha256: z.string().regex(SHA256),
    created_at: z.iso.datetime(),
    scenario_candidates: z.array(z.enum(TASK_SCENARIOS)).max(TASK_SCENARIOS.length).optional(),
    locked_scenario: z.enum(TASK_SCENARIOS).optional(),
  })
  const taskOutbox = z.object({
    schema_version: z.literal(1),
    event_id: z.string().regex(/^taskevent_[0-9a-f]{64}$/u),
    account_subject_sha256: z.string().regex(SHA256),
    payload: z.json(),
    payload_sha256: z.string().regex(SHA256),
    source_seq: z.number().int().min(0),
    status: z.enum(['pending', 'delivered']),
    attempt_count: z.number().int().min(0),
    next_attempt_at: z.iso.datetime(),
    last_error_code: z.string().max(128).optional(),
    receipt_id: z.string().regex(SAFE_ID).optional(),
    delivered_at: z.iso.datetime().optional(),
  })
  const domain = await ctx.storageDomain.open(defineDomain({
    name: 'emate_audit',
    version: 1,
    tables: { bindings: domainTable(binding), outbox: domainTable(outbox) },
  }))
  ctx.effect(() => () => domain.close(), 'emate.audit: close target storage domain')
  const taskDomain = await ctx.storageDomain.open(defineDomain({
    name: 'emate_task_audit',
    version: 1,
    tables: { bindings: domainTable(taskBinding), outbox: domainTable(taskOutbox) },
  }))
  ctx.effect(() => () => taskDomain.close(), 'emate.audit: close task audit storage domain')
  const service = createAuditService(
    ctx,
    domain.table('bindings'),
    domain.table('outbox'),
    config.auditProvider ?? { upload: records => ctx.emateIdentity.uploadAudit(records) },
    taskDomain.table('bindings'),
    taskDomain.table('outbox'),
    config.taskAuditProvider ?? { upload: records => ctx.emateIdentity.uploadTaskAudit(records) },
  )
  ctx.provide('emateAudit', service)
  ctx.on('agent/request', async (payload, next) => {
    const request = await next()
    try {
      void Promise.resolve(ctx.emateModelPolicy.auditContext(request.model)).then(
        context => service.captureBinding(
          payload.agent.id,
          payload.turn,
          payload.step,
          request.provider,
          request.model,
          context,
        ),
        error => {
          service.captureBindingFailure(payload.agent.id, payload.turn, payload.step)
          ctx.logger?.warn?.(`e-Mate audit could not bind request policy: ${errorCode(error)}`)
        },
      )
    } catch (error) {
      service.captureBindingFailure(payload.agent.id, payload.turn, payload.step)
      ctx.logger?.warn?.(`e-Mate audit could not bind request policy: ${errorCode(error)}`)
    }
    return request
  })
  ctx.on('session/event', (session, event) => {
    service.captureEvent(session.id, event)
    service.captureTaskEvent(session.id, event, true)
  })
  ctx.on('tools/result', (exec) => { service.captureToolResult(exec) })
  ctx.on('agent/disposed', ({ agent }) => { service.closeSession(agent.id) })
  ctx.on('session/flush', () => undefined)
  const flushSafely = () => {
    void service.flush().catch((error) => {
      ctx.logger?.warn?.(`e-Mate audit flush failed: ${errorCode(error)}`)
    })
  }
  ctx.interval(flushSafely, flushIntervalMs)
  ctx.effect(() => ctx.connection.rpc.handle(
    AUDIT_CHANNEL,
    async (endpoint, payload) => {
      if (endpoint !== 'audit.status' || !isRecord(payload) || Object.keys(payload).length !== 0) {
        return { ok: false, error: { code: 'bad-request', message: 'unknown e-Mate audit endpoint', details: { issues: [] } } }
      }
      return { ok: true, value: service.status() }
    },
    { authority: 'loopback' },
  ), 'emate.audit: target-native RPC channel')
  void backfill(ctx, service).then(
    flushSafely,
    error => { ctx.logger?.warn?.(`e-Mate audit backfill failed: ${errorCode(error)}`) },
  )
}
