import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { LOGGED_OUT_CREDENTIAL } from './credentials-os.js'
import { loadTargetStorageDomain, loadTargetCompaction } from './target-runtime.js'
import { compactRequestHistory, requestSizeFailure } from './request-size.js'

export const name = 'emate-model-policy'
export const inject = ['apiProxy', 'connection', 'credentials', 'settings', 'storageDomain', 'llm', 'emateIdentity']
export const MODEL_POLICY_CHANNEL = '/emate.modelPolicy'

const CHAT_MODELS = new Map([
  ['gpt-5.6-luna', { reasoning_effort: 'max' }],
  ['gpt-5.6-sol', { reasoning_effort: 'medium' }],
  ['gpt-6-astra', { reasoning_effort: 'medium' }],
  ['deepseek', { reasoning_effort: 'max' }],
  ['doubao-seed-2-0-pro-260215', { reasoning_effort: 'medium' }],
])
const IMAGE_MODELS = new Set(['gpt-image-2-pro'])
const MANAGED_MODELS = new Set([...CHAT_MODELS.keys(), ...IMAGE_MODELS])
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u
const MAX_VALIDITY_MS = 32 * 24 * 60 * 60 * 1_000
const REFRESH_MS = 30_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000
const UNLIMITED = Number.MAX_SAFE_INTEGER

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

function usageBuckets(value) {
  if (!isRecord(value)) return undefined
  const buckets = {
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_read_tokens: value.cacheReadTokens ?? 0,
    cache_write_tokens: value.cacheWriteTokens ?? 0,
  }
  if (Object.values(buckets).some(token => !Number.isSafeInteger(token) || token < 0)) return undefined
  const total_tokens = Object.values(buckets).reduce((total, token) => total + token, 0)
  return Number.isSafeInteger(total_tokens) && total_tokens > 0 ? { ...buckets, total_tokens } : undefined
}

function quotaFactId(sessionId, seq) {
  const sessionIdSha256 = sha256(String(sessionId))
  return `auditfact_${sha256(`e-Mate audit v1\0harness:${sessionIdSha256}:${seq}`)}`
}

export function createQuotaService(ctx, snapshotsTable, reservationsTable, usageTable, now = Date.now) {
  const snapshots = new Map(snapshotsTable.entries())
  const reservations = new Map(reservationsTable.entries())
  const usage = new Map(usageTable.entries())
  const armed = new Map()
  const warnedWeeks = new Set()
  let queued = Promise.resolve()

  const enqueue = operation => {
    const result = queued.then(operation, operation)
    queued = result.then(() => undefined, () => undefined)
    return result
  }

  const activeSnapshot = (subject, at = now()) => {
    const snapshot = snapshots.get(subject)
    if (snapshot === undefined
      || snapshot.account_subject !== subject
      || Date.parse(snapshot.week_started_at) > at
      || at >= Date.parse(snapshot.week_started_at) + WEEK_MS
      || at >= Date.parse(snapshot.lease_expires_at)) {
      throw new Error('e-Mate local weekly quota snapshot is unavailable or expired')
    }
    return snapshot
  }

  const localTokens = snapshot => [...usage.values()]
    .filter(record => record.account_subject === snapshot.account_subject
      && record.week_started_at === snapshot.week_started_at
      && !(record.audit_delivered_at !== undefined
        && Date.parse(record.audit_delivered_at) <= Date.parse(snapshot.calculated_at)))
    .reduce((total, record) => total + record.total_tokens, 0)

  const activeReservation = snapshot => [...reservations.values()].find(record =>
    record.account_subject === snapshot.account_subject
      && record.week_started_at === snapshot.week_started_at
      && ![...usage.values()].some(entry => entry.reservation_id === record.reservation_id))

  const refresh = async policy => {
    const state = await ctx.emateIdentity.state()
    if (!isRecord(state)
      || state.authenticated !== true
      || state.workspace_unlocked !== true
      || state.account_subject !== policy.account_subject
      || !Number.isSafeInteger(state.weekly_token_limit)
      || state.weekly_token_limit < 1) {
      throw new Error('e-Mate local weekly quota account binding is invalid')
    }
    const projection = await ctx.emateIdentity.usage('UTC')
    const weekStartedAt = Date.parse(projection?.week_started_at)
    const calculatedAt = Date.parse(projection?.calculated_at)
    const leaseExpiresAt = Date.parse(policy.expires_at)
    if (!isRecord(projection)
      || projection.schema_version !== 1
      || projection.scope !== 'account'
      || projection.timezone !== 'UTC'
      || !isRecord(projection.week)
      || !Number.isSafeInteger(projection.week.total_tokens)
      || projection.week.total_tokens < 0
      || !Number.isFinite(weekStartedAt)
      || !Number.isFinite(calculatedAt)
      || !Number.isFinite(leaseExpiresAt)
      || calculatedAt < weekStartedAt
      || calculatedAt >= weekStartedAt + WEEK_MS
      || leaseExpiresAt <= now()) {
      throw new Error('e-Mate local weekly quota projection is invalid')
    }
    const snapshot = {
      schema_version: 1,
      account_subject: policy.account_subject,
      week_started_at: new Date(weekStartedAt).toISOString(),
      calculated_at: new Date(calculatedAt).toISOString(),
      lease_expires_at: new Date(leaseExpiresAt).toISOString(),
      weekly_token_limit: state.weekly_token_limit,
      enterprise_total_tokens: projection.week.total_tokens,
    }
    return enqueue(async () => {
      const current = snapshots.get(snapshot.account_subject)
      if (current !== undefined && Date.parse(current.calculated_at) > calculatedAt) return current
      await snapshotsTable.put(snapshot.account_subject, snapshot)
      snapshots.set(snapshot.account_subject, snapshot)
      return snapshot
    })
  }

  const armRequest = (payload, request) => {
    const sessionId = payload?.agent?.id
    if (typeof sessionId !== 'string' || sessionId.length < 1
      || !Number.isSafeInteger(payload?.turn) || payload.turn < 1
      || !Number.isSafeInteger(payload?.step) || payload.step < 1) return
    armed.set(sessionId, {
      session_id_sha256: sha256(sessionId),
      turn: payload.turn,
      step: payload.step,
      provider: request.provider,
      model: request.model,
    })
  }

  const isArmed = options => {
    const scope = typeof options?.sessionId === 'string' ? armed.get(options.sessionId) : undefined
    return scope !== undefined && scope.provider === options.provider && scope.model === options.model
  }

  const admit = options => enqueue(async () => {
    const scope = typeof options?.sessionId === 'string' ? armed.get(options.sessionId) : undefined
    if (scope === undefined || scope.provider !== options.provider || scope.model !== options.model) return undefined
    armed.delete(options.sessionId)
    const subject = ctx.emateIdentity.localAccountSubject?.()
    if (typeof subject !== 'string') throw new Error('e-Mate local weekly quota requires an authenticated account')
    const snapshot = activeSnapshot(subject)
    if (snapshot.weekly_token_limit === UNLIMITED) return { unlimited: true }
    if (activeReservation(snapshot) !== undefined) {
      throw new Error('e-Mate local weekly quota has an unsettled request; wait for it to finish')
    }
    const used = snapshot.enterprise_total_tokens + localTokens(snapshot)
    if (!Number.isSafeInteger(used) || used >= snapshot.weekly_token_limit) {
      throw new Error('e-Mate weekly Token allowance is exhausted')
    }
    const warningKey = `${snapshot.account_subject}\0${snapshot.week_started_at}`
    if (!warnedWeeks.has(warningKey)) {
      warnedWeeks.add(warningKey)
      ctx.logger?.warn?.('e-Mate finite weekly quota permits one in-flight request; one real request may exceed its remaining allowance')
    }
    const reservation = {
      schema_version: 1,
      reservation_id: `quota_${randomUUID()}`,
      account_subject: subject,
      week_started_at: snapshot.week_started_at,
      session_id_sha256: scope.session_id_sha256,
      turn: scope.turn,
      step: scope.step,
      provider: scope.provider,
      model: scope.model,
      reserved_tokens: snapshot.weekly_token_limit - used,
      created_at: new Date(now()).toISOString(),
    }
    await reservationsTable.put(reservation.reservation_id, reservation)
    reservations.set(reservation.reservation_id, reservation)
    return { reservation_id: reservation.reservation_id }
  })

  const finish = (handle, chunkUsage, reason) => {
    if (handle === undefined || handle.unlimited === true) return Promise.resolve()
    return enqueue(async () => {
      const reservation = reservations.get(handle.reservation_id)
      if (reservation === undefined) return
      if (reason === 'error' || reason === 'aborted') {
        await reservationsTable.delete(reservation.reservation_id)
        reservations.delete(reservation.reservation_id)
        return
      }
      const buckets = usageBuckets(chunkUsage)
      if (buckets === undefined || !['stop', 'tool-calls', 'max-tokens'].includes(reason)) return
      const terminal = {
        ...reservation,
        terminal_usage: buckets,
        terminal_at: new Date(now()).toISOString(),
      }
      await reservationsTable.put(reservation.reservation_id, terminal)
      reservations.set(reservation.reservation_id, terminal)
    })
  }

  const captureEvent = (sessionId, event) => {
    if (event?.type !== 'assistant/message' || !isRecord(event.data?.usage)) return Promise.resolve()
    return enqueue(async () => {
      const buckets = usageBuckets(event.data.usage)
      const provider = event.data?.message?.source?.provider
      const model = event.data?.message?.source?.model
      if (buckets === undefined || typeof provider !== 'string' || typeof model !== 'string') return
      const factId = quotaFactId(sessionId, event.seq)
      const existing = usage.get(factId)
      if (existing !== undefined) return
      const sessionIdSha256 = sha256(String(sessionId))
      const reservation = [...reservations.values()].find(record =>
        record.session_id_sha256 === sessionIdSha256
          && record.turn === event.data.turn
          && record.step === event.data.step
          && record.provider === provider
          && record.model === model
          && canonicalJson(record.terminal_usage) === canonicalJson(buckets))
      if (reservation === undefined) {
        ctx.logger?.warn?.(`e-Mate local weekly quota could not reconcile usage: ${factId.slice(-16)}`)
        return
      }
      const record = {
        schema_version: 1,
        fact_id: factId,
        reservation_id: reservation.reservation_id,
        account_subject: reservation.account_subject,
        week_started_at: reservation.week_started_at,
        total_tokens: buckets.total_tokens,
        occurred_at: new Date(event.time).toISOString(),
      }
      // Usage lands first. A crash before reservation deletion is conservative:
      // the reservation is ignored once its linked real usage record exists.
      await usageTable.put(factId, record)
      usage.set(factId, record)
      await reservationsTable.delete(reservation.reservation_id)
      reservations.delete(reservation.reservation_id)
    })
  }

  const markAuditDelivered = (factId, acceptedAt) => enqueue(async () => {
    const record = usage.get(factId)
    if (record === undefined || !Number.isFinite(Date.parse(acceptedAt))) return
    const delivered = { ...record, audit_delivered_at: new Date(Date.parse(acceptedAt)).toISOString() }
    await usageTable.put(factId, delivered)
    usage.set(factId, delivered)
  })

  return {
    refresh,
    armRequest,
    isArmed,
    disarmRequest(options) { if (isArmed(options)) armed.delete(options.sessionId) },
    admit,
    finish,
    captureEvent,
    markAuditDelivered,
    drain: () => queued,
    status() {
      const subject = ctx.emateIdentity.localAccountSubject?.()
      if (typeof subject !== 'string') return { ready: false }
      try {
        const snapshot = activeSnapshot(subject)
        return {
          ready: true,
          unlimited: snapshot.weekly_token_limit === UNLIMITED,
          enterprise_tokens: snapshot.enterprise_total_tokens,
          local_tokens: localTokens(snapshot),
          reservations: activeReservation(snapshot) === undefined ? 0 : 1,
        }
      } catch {
        return { ready: false }
      }
    },
  }
}

function publicPolicy(policy) {
  const { account_subject: _subject, ...value } = policy
  return structuredClone(value)
}

export function modelImageInputContract(metadata, provider, model) {
  let capability = 'unknown'
  if (isRecord(metadata)
    && metadata.provider === provider
    && metadata.id === model
    && Array.isArray(metadata.inputModalities)
    && metadata.inputModalities.length > 0
    && metadata.inputModalities.length <= 2
    && new Set(metadata.inputModalities).size === metadata.inputModalities.length
    && metadata.inputModalities.every(input => input === 'text' || input === 'image')) {
    capability = metadata.inputModalities.includes('image') ? 'image-capable' : 'text-only'
  }
  return {
    schema_version: 1,
    capability,
    request_boundary: capability === 'text-only' ? 'convert-at-request-boundary' : 'preserve-native',
  }
}

export function validateModelPolicy(value, accountSubject, now = Date.now()) {
  const keys = [
    'account_subject', 'allowed_model_ids', 'default_chat_model_id', 'default_chat_reasoning_effort',
    'expires_at', 'image_primary_model_id', 'issued_at',
    'receipt_id', 'revision', 'schema_version',
  ]
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schema_version !== 1
    || typeof value.account_subject !== 'string' || !SUBJECT.test(value.account_subject)
    || value.account_subject !== accountSubject
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.receipt_id !== 'string' || !RECEIPT.test(value.receipt_id)
    || typeof value.default_chat_model_id !== 'string'
    || !CHAT_MODELS.has(value.default_chat_model_id)
    || value.default_chat_reasoning_effort !== CHAT_MODELS.get(value.default_chat_model_id).reasoning_effort
    || value.image_primary_model_id !== 'gpt-image-2-pro'
    || !Array.isArray(value.allowed_model_ids)
    || value.allowed_model_ids.length < 1
    || value.allowed_model_ids.length > MANAGED_MODELS.size
    || new Set(value.allowed_model_ids).size !== value.allowed_model_ids.length
    || value.allowed_model_ids.some(model => typeof model !== 'string' || !MANAGED_MODELS.has(model))
    || !value.allowed_model_ids.includes(value.default_chat_model_id)) {
    throw new Error('e-Mate enterprise model policy is invalid')
  }
  const issuedAt = Date.parse(value.issued_at)
  const expiresAt = Date.parse(value.expires_at)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now + 5 * 60_000
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_VALIDITY_MS) {
    throw new Error('e-Mate enterprise model policy lifetime is invalid')
  }
  const policy = {
    schema_version: 1,
    account_subject: value.account_subject,
    revision: value.revision,
    allowed_model_ids: [...value.allowed_model_ids].sort(),
    default_chat_model_id: value.default_chat_model_id,
    default_chat_reasoning_effort: value.default_chat_reasoning_effort,
    image_primary_model_id: value.image_primary_model_id,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    receipt_id: value.receipt_id,
  }
  return {
    ...policy,
    policy_sha256: createHash('sha256').update(canonicalJson(policy)).digest('hex'),
  }
}

function encodeDurableModelPolicy(policy) {
  const { policy_sha256: _currentHash, ...current } = policy
  const allowedModelIds = [...current.allowed_model_ids]
  if (allowedModelIds.includes('gpt-image-2-pro')) allowedModelIds.push('gpt-image-2')
  const durable = {
    ...current,
    allowed_model_ids: [...new Set(allowedModelIds)].sort(),
    image_fallback_upstream_model_id: 'gpt-image-2',
  }
  return { ...durable, policy_sha256: sha256(canonicalJson(durable)) }
}

function decodeDurableModelPolicy(value, accountSubject, now) {
  if (!isRecord(value) || typeof value.policy_sha256 !== 'string') {
    throw new Error('e-Mate stored model policy is invalid')
  }
  const { policy_sha256: expected, ...stored } = value
  if (stored.image_fallback_upstream_model_id !== undefined) {
    if (stored.image_fallback_upstream_model_id !== 'gpt-image-2'
      || !Array.isArray(stored.allowed_model_ids)
      || new Set(stored.allowed_model_ids).size !== stored.allowed_model_ids.length
      || stored.allowed_model_ids.includes('gpt-image-2') && !stored.allowed_model_ids.includes('gpt-image-2-pro')
      || sha256(canonicalJson(stored)) !== expected) {
      throw new Error('e-Mate legacy model policy is invalid')
    }
    const { image_fallback_upstream_model_id: _fallback, ...current } = stored
    return validateModelPolicy({
      ...current,
      allowed_model_ids: current.allowed_model_ids.filter(model => MANAGED_MODELS.has(model)),
    }, accountSubject, now)
  }
  const policy = validateModelPolicy(stored, accountSubject, now)
  if (policy.policy_sha256 !== expected) throw new Error('e-Mate stored model policy is invalid')
  return policy
}

function policyModelId(model) {
  return model === 'deepseek-v4-flash' ? 'deepseek' : model
}

function allowed(policy, model) {
  return policy.allowed_model_ids.includes(policyModelId(model))
}

// Product display order is independent of policy defaults and session selection.
const MODEL_DISPLAY_ORDER = [
  'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'deepseek',
  'doubao-seed-2-0-pro-260215', 'gpt-image-2-pro',
]
function modelDisplayRank(id) {
  const index = MODEL_DISPLAY_ORDER.indexOf(policyModelId(id))
  return index < 0 ? MODEL_DISPLAY_ORDER.length : index
}

export function filterGroups(groups, policy) {
  return groups
    .map(group => ({ ...group, models: group.models.filter(model => allowed(policy, model.id))
      .sort((a, b) => modelDisplayRank(a.id) - modelDisplayRank(b.id)) }))
    .filter(group => group.models.length > 0)
    .sort((a, b) => modelDisplayRank(a.models[0].id) - modelDisplayRank(b.models[0].id))
}

function unavailableCatalog(value, message) {
  return {
    ...value,
    groups: [],
    failures: [...value.failures, { id: 'e-mate-policy', name: 'e-Mate', message }],
  }
}

function modelUnavailable(request, provider, model, message = `Model "${model}" is not allowed by the current e-Mate policy.`) {
  return {
    rpcId: request.rpcId,
    result: { ok: false, error: { code: 'model-unavailable', message, details: { provider, model } } },
  }
}

const RUNTIME_REASONING = new Map([
  ['gpt-5.6-luna', { max: 'high' }],
  ['gpt-5.6-sol', { medium: 'medium' }],
  ['gpt-6-astra', { medium: 'medium' }],
  ['deepseek', { max: 'max' }],
  ['doubao-seed-2-0-pro-260215', { medium: 'medium' }],
])
const MODEL_SESSION_REF = 'E_MATE_MODEL_SESSION_TOKEN'
const SEARCH_CREDENTIAL_REF = 'E_MATE_SEARCH_KEY_DEEPSEEK'
const OBSOLETE_MODEL_CREDENTIAL_REFS = new Set([
  'E_MATE_MODEL_KEY_GPT',
  'E_MATE_MODEL_KEY_DEEPSEEK',
  'E_MATE_MODEL_KEY_DOUBAO',
])
const RUNTIME_CREDENTIAL_REFS = new Set([MODEL_SESSION_REF, SEARCH_CREDENTIAL_REF])
const STORED_CREDENTIAL_REFS = new Set([...RUNTIME_CREDENTIAL_REFS, ...OBSOLETE_MODEL_CREDENTIAL_REFS])
const PROJECTED_CREDENTIAL_REFS = new Set([...OBSOLETE_MODEL_CREDENTIAL_REFS, SEARCH_CREDENTIAL_REF])
const IDENTITY_SESSION_REF = 'E_MATE_ENTERPRISE_SESSION'
const SEARCH_GRANT_ERROR_CODE = 'E_MATE_SEARCH_GRANT_INVALID'
const PROJECTION_SUPERSEDED = 'E_MATE_RUNTIME_PROJECTION_SUPERSEDED'
const RUNTIME_PROJECTION_KEY = 'active'

function searchGrantError(message = 'e-Mate managed search credential projection is invalid') {
  return Object.assign(new Error(message), { code: SEARCH_GRANT_ERROR_CODE })
}

function isSearchGrantError(error) {
  return isRecord(error) && error.code === SEARCH_GRANT_ERROR_CODE
}

function projectionSuperseded() {
  return Object.assign(new Error('e-Mate runtime model projection was superseded'), {
    code: PROJECTION_SUPERSEDED,
  })
}

async function presentRuntimeCredentialRefs(ctx) {
  const refs = []
  for (const ref of RUNTIME_CREDENTIAL_REFS) {
    const hit = await ctx.credentials.resolve(ref)
    if (typeof hit?.value === 'string' && hit.value.length > 0) refs.push(ref)
  }
  return refs.sort()
}

async function runtimeProjectionMarker(ctx, policy, searchStatus) {
  const marker = {
    schema_version: 1,
    account_subject: policy.account_subject,
    policy_revision: policy.revision,
    policy_sha256: policy.policy_sha256,
    expires_at: policy.expires_at,
    search_status: searchStatus,
    llm_settings_sha256: sha256(canonicalJson(ctx.settings.get('llm-pi-ai') ?? {})),
    default_model_sha256: sha256(canonicalJson(ctx.settings.get('agent-default-model') ?? {})),
    credential_refs: await presentRuntimeCredentialRefs(ctx),
  }
  return { ...marker, projection_sha256: sha256(canonicalJson(marker)) }
}

async function matchesRuntimeProjection(ctx, marker, policy) {
  if (!isRecord(marker)
    || marker.schema_version !== 1
    || marker.account_subject !== policy.account_subject
    || marker.policy_revision !== policy.revision
    || marker.policy_sha256 !== policy.policy_sha256
    || marker.expires_at !== policy.expires_at
    || !['granted', 'denied', 'unavailable'].includes(marker.search_status)
    || marker.llm_settings_sha256 !== sha256(canonicalJson(ctx.settings.get('llm-pi-ai') ?? {}))
    || marker.default_model_sha256 !== sha256(canonicalJson(ctx.settings.get('agent-default-model') ?? {}))
    || !Array.isArray(marker.credential_refs)
    || marker.credential_refs.some(ref => !RUNTIME_CREDENTIAL_REFS.has(ref))
    || new Set(marker.credential_refs).size !== marker.credential_refs.length
    || marker.projection_sha256 !== sha256(canonicalJson({
      schema_version: marker.schema_version,
      account_subject: marker.account_subject,
      policy_revision: marker.policy_revision,
      policy_sha256: marker.policy_sha256,
      expires_at: marker.expires_at,
      search_status: marker.search_status,
      llm_settings_sha256: marker.llm_settings_sha256,
      default_model_sha256: marker.default_model_sha256,
      credential_refs: marker.credential_refs,
    }))) return false
  const refs = await presentRuntimeCredentialRefs(ctx)
  return canonicalJson(refs) === canonicalJson(marker.credential_refs)
    && marker.credential_refs.includes(SEARCH_CREDENTIAL_REF) === (marker.search_status === 'granted')
}

async function projectRuntimeModels(ctx, models, policy, searchGrant, isCurrent = () => true) {
  if (!Array.isArray(models) || models.length < 1 || models.length > CHAT_MODELS.size) {
    throw new Error('e-Mate runtime model projection is invalid')
  }
  if (!isRecord(searchGrant)
    || (searchGrant.status !== 'granted'
      && searchGrant.status !== 'denied'
      && searchGrant.status !== 'unavailable')
    || Object.keys(searchGrant).sort().join(',') !== [
      'credentialRef', 'provider', 'purpose', 'schemaVersion', 'status',
      ...(searchGrant.status === 'granted' ? ['upstreamApiKey'] : []),
    ].sort().join(',')
    || searchGrant.schemaVersion !== 1
    || searchGrant.purpose !== 'web-search'
    || searchGrant.provider !== 'deepseek-official'
    || searchGrant.credentialRef !== SEARCH_CREDENTIAL_REF
    || (searchGrant.status === 'granted' && (
      typeof searchGrant.upstreamApiKey !== 'string'
      || searchGrant.upstreamApiKey.length < 20
      || searchGrant.upstreamApiKey.length > 8_192
      || /\s/u.test(searchGrant.upstreamApiKey)
    ))) {
    throw searchGrantError()
  }
  const credentials = new Map(searchGrant.status === 'granted'
    ? [[SEARCH_CREDENTIAL_REF, searchGrant.upstreamApiKey]]
    : [])
  const providers = {}
  for (const model of models) {
    if (!isRecord(model)
      || typeof model.id !== 'string'
      || typeof model.provider !== 'string'
      || typeof model.credentialRef !== 'string'
      || typeof model.api !== 'string'
      || typeof model.upstreamModelId !== 'string'
      || typeof model.upstreamBaseUrl !== 'string'
      || typeof model.label !== 'string'
      || !Array.isArray(model.input)
      || !Number.isSafeInteger(model.contextWindow)
      || !Number.isSafeInteger(model.maxTokens)
      || model.id === 'deepseek' && model.upstreamModelId !== 'deepseek'
      || model.credentialRef !== MODEL_SESSION_REF
      || !RUNTIME_REASONING.has(model.upstreamModelId)
      || model.api !== 'openai-responses') {
      throw new Error('e-Mate runtime model projection is invalid')
    }
    const existing = providers[model.provider]
    if (existing !== undefined
      && (existing.api !== model.api
        || existing.baseURL !== model.upstreamBaseUrl
        || existing.apiKeyEnv !== model.credentialRef)) {
      throw new Error('e-Mate runtime model routes sharing a provider disagree')
    }
    const provider = existing ?? {
      displayName: 'e-Mate',
      apiKeyEnv: model.credentialRef,
      api: model.api,
      baseURL: model.upstreamBaseUrl,
      models: [],
    }
    provider.models.push({
      id: model.upstreamModelId,
      name: model.upstreamModelId,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      reasoningEfforts: RUNTIME_REASONING.get(model.upstreamModelId),
    })
    providers[model.provider] = provider
  }

  const modelSession = await ctx.credentials.resolve(MODEL_SESSION_REF)
  if (typeof modelSession?.value !== 'string'
    || modelSession.value.length < 16
    || modelSession.value.length > 16_384
    || /\s/u.test(modelSession.value)) {
    throw new Error('e-Mate model session credential is unavailable')
  }
  const previousCredentials = new Map([
    [SEARCH_CREDENTIAL_REF, await ctx.credentials.resolve(SEARCH_CREDENTIAL_REF)],
  ])
  const current = async operation => {
    if (!isCurrent()) throw projectionSuperseded()
    const result = await operation()
    if (!isCurrent()) throw projectionSuperseded()
    return result
  }
  if (!isCurrent()) throw projectionSuperseded()
  const previousLlmSettings = structuredClone(ctx.settings.get('llm-pi-ai') ?? {})
  const previousUsedObsoleteModelCredential = isRecord(previousLlmSettings.providers)
    && Object.values(previousLlmSettings.providers).some(provider => isRecord(provider)
      && typeof provider.apiKeyEnv === 'string'
      && OBSOLETE_MODEL_CREDENTIAL_REFS.has(provider.apiKeyEnv))
  const previousDefaultModel = structuredClone(ctx.settings.get('agent-default-model') ?? {})
  const settingRevisions = new Map(ctx.settings.describe().map(({ ns, revision }) => [ns, revision]))
  const llmRevision = settingRevisions.get('llm-pi-ai')
  const defaultRevision = settingRevisions.get('agent-default-model')
  if (typeof llmRevision !== 'number' || !Number.isSafeInteger(llmRevision)
    || typeof defaultRevision !== 'number' || !Number.isSafeInteger(defaultRevision)) {
    throw new Error('e-Mate runtime model Settings revisions are unavailable')
  }
  let projectedLlmRevision
  let projectedDefaultRevision
  try {
    for (const [ref, value] of credentials) await current(() => ctx.credentials.set(ref, value))
    const next = { providers }
    if (canonicalJson(ctx.settings.get('llm-pi-ai')) !== canonicalJson(next)) {
      await current(async () => {
        await ctx.settings.replace('llm-pi-ai', next, llmRevision)
        projectedLlmRevision = llmRevision + 1
      })
    }
    const defaultModel = models.find(model => model.id === policy.default_chat_model_id)
    if (defaultModel === undefined) throw new Error('e-Mate default runtime model is unavailable')
    const defaultSelection = {
      provider: defaultModel.provider,
      model: defaultModel.upstreamModelId,
      reasoningEffort: policy.default_chat_reasoning_effort,
    }
    if (canonicalJson(ctx.settings.get('agent-default-model')) !== canonicalJson(defaultSelection)) {
      await current(async () => {
        await ctx.settings.replace('agent-default-model', defaultSelection, defaultRevision)
        projectedDefaultRevision = defaultRevision + 1
      })
    }
    for (const ref of PROJECTED_CREDENTIAL_REFS) {
      if (!credentials.has(ref)) {
        try {
          await current(() => ctx.credentials.unset(ref))
        } catch (error) {
          if (error?.code !== PROJECTION_SUPERSEDED
            && ref === SEARCH_CREDENTIAL_REF && searchGrant.status !== 'granted') {
            throw searchGrantError('e-Mate managed search credential revocation failed')
          }
          throw error
        }
      }
    }
  } catch (error) {
    const rollbackFailures = []
    let superseded = error?.code === PROJECTION_SUPERSEDED || !isCurrent()
    if (!superseded) {
      for (const { ns, value, revision } of [
        { ns: 'agent-default-model', value: previousDefaultModel, revision: projectedDefaultRevision },
        { ns: 'llm-pi-ai', value: previousLlmSettings, revision: previousUsedObsoleteModelCredential ? undefined : projectedLlmRevision },
      ]) {
        if (revision === undefined) continue
        try {
          await current(() => ctx.settings.replace(ns, value, revision))
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
          if (rollbackError?.code === PROJECTION_SUPERSEDED || !isCurrent()) {
            superseded = true
            break
          }
        }
      }
    }
    if (!superseded && previousUsedObsoleteModelCredential) {
      try {
        await current(() => ctx.settings.replace(
          'llm-pi-ai',
          { providers: {} },
          projectedLlmRevision ?? llmRevision,
        ))
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError)
        if (rollbackError?.code === PROJECTION_SUPERSEDED || !isCurrent()) superseded = true
      }
    }
    if (!superseded) {
      for (const [ref, hit] of previousCredentials) {
        try {
          await current(() => hit === undefined
            ? ctx.credentials.unset(ref)
            : ctx.credentials.set(ref, hit.value))
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
          if (rollbackError?.code === PROJECTION_SUPERSEDED || !isCurrent()) {
            superseded = true
            break
          }
        }
      }
    }
    if (!superseded) {
      await Promise.allSettled([...OBSOLETE_MODEL_CREDENTIAL_REFS]
        .map(ref => ctx.credentials.set(ref, LOGGED_OUT_CREDENTIAL)))
      const deleted = await Promise.allSettled([...OBSOLETE_MODEL_CREDENTIAL_REFS]
        .map(ref => ctx.credentials.unset(ref)))
      rollbackFailures.push(...deleted.filter(result => result.status === 'rejected').map(result => result.reason))
    }
    if (superseded) {
      await Promise.allSettled([...PROJECTED_CREDENTIAL_REFS].map(ref => ctx.credentials.set(ref, LOGGED_OUT_CREDENTIAL)))
      const deleted = await Promise.allSettled([...PROJECTED_CREDENTIAL_REFS].map(ref => ctx.credentials.unset(ref)))
      rollbackFailures.push(...deleted.filter(result => result.status === 'rejected').map(result => result.reason))
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError([error, ...rollbackFailures], 'e-Mate runtime model projection rollback failed')
    }
    throw error
  }
}

function createService(ctx, table, projectionTable, quota) {
  let cached = [...table.entries()].find(([key]) => key === 'active')?.[1]
  let validatedCache
  const hasRuntimePolicy = typeof ctx.emateIdentity.modelRuntimePolicy === 'function'
  let runtimeReady = !hasRuntimePolicy
  let checkingRuntime
  let lastRefresh = 0
  let refreshing
  let identityCredentialGeneration = 0
  ctx.on('credentials/updated', ref => {
    if (ref === IDENTITY_SESSION_REF) identityCredentialGeneration += 1
  })

  const degradeInvalidSearchGrant = async policy => {
    runtimeReady = false
    let markerDeleteError
    try {
      await projectionTable.delete(RUNTIME_PROJECTION_KEY)
    } catch (error) {
      markerDeleteError = error
    }
    try {
      await ctx.credentials.unset(SEARCH_CREDENTIAL_REF)
    } catch (error) {
      throw new AggregateError(
        markerDeleteError === undefined ? [error] : [error, markerDeleteError],
        'e-Mate invalid search grant revocation failed',
      )
    }
    if (policy !== undefined) {
      const marker = await runtimeProjectionMarker(ctx, policy, 'unavailable')
      await projectionTable.put(RUNTIME_PROJECTION_KEY, marker)
      runtimeReady = true
    }
  }

  const identityState = async () => {
    const state = await ctx.emateIdentity.state()
    if (!isRecord(state)
      || state.authenticated !== true
      || state.workspace_unlocked !== true
      || typeof state.account_subject !== 'string'
      || !SUBJECT.test(state.account_subject)) {
      throw new Error('e-Mate model policy requires an authenticated, agreement-unlocked account')
    }
    return state
  }

  const validCached = (subject, now) => {
    try {
      if (!isRecord(cached) || typeof cached.policy_sha256 !== 'string') return undefined
      if (validatedCache?.source === cached
        && validatedCache.subject === subject
        && now < validatedCache.expiresAt) return validatedCache.policy
      const policy = decodeDurableModelPolicy(cached, subject, now)
      validatedCache = { source: cached, subject, expiresAt: Date.parse(policy.expires_at), policy }
      return policy
    } catch {
      return undefined
    }
  }

  const refresh = async ({ force = false } = {}) => {
    const state = await identityState()
    const requestStartedAt = Date.now()
    const current = validCached(state.account_subject, requestStartedAt)
    if (!force && current !== undefined && requestStartedAt - lastRefresh < REFRESH_MS) return current
    if (refreshing !== undefined) {
      const inFlight = refreshing
      try {
        const result = await inFlight.promise
        return result.account_subject === state.account_subject ? result : refresh({ force: true })
      } catch (error) {
        if (error?.code !== PROJECTION_SUPERSEDED) throw error
        if (refreshing === inFlight) refreshing = undefined
        return refresh({ force: true })
      }
    }
    const expectedIdentityGeneration = identityCredentialGeneration
    const isCurrent = () => expectedIdentityGeneration === identityCredentialGeneration
    const promise = (async () => {
      try {
        const runtime = typeof ctx.emateIdentity.modelRuntimePolicy === 'function'
          ? await ctx.emateIdentity.modelRuntimePolicy()
          : { policy: await ctx.emateIdentity.modelPolicy() }
        const current = async operation => {
          if (!isCurrent()) throw projectionSuperseded()
          const result = await operation()
          if (!isCurrent()) throw projectionSuperseded()
          return result
        }
        if (!isCurrent()) throw projectionSuperseded()
        const policy = validateModelPolicy(runtime.policy, state.account_subject, Date.now())
        if (runtime.models !== undefined) {
          runtimeReady = false
          try {
            await current(() => ctx.credentials.unset(SEARCH_CREDENTIAL_REF))
          } catch (error) {
            if (error?.code === PROJECTION_SUPERSEDED) throw error
            throw searchGrantError('e-Mate managed search credential invalidation failed')
          }
          await current(() => projectionTable.delete(RUNTIME_PROJECTION_KEY))
        }
        await current(() => quota.refresh(policy))
        if (runtime.models !== undefined) {
          await projectRuntimeModels(ctx, runtime.models, policy, runtime.searchCredentialGrant, isCurrent)
        }
        const durablePolicy = encodeDurableModelPolicy(policy)
        await current(() => table.put('active', durablePolicy))
        if (runtime.models !== undefined) {
          const marker = await runtimeProjectionMarker(ctx, policy, runtime.searchCredentialGrant.status)
          await current(() => projectionTable.put(
            RUNTIME_PROJECTION_KEY,
            marker,
          ))
          runtimeReady = true
        }
        cached = durablePolicy
        validatedCache = { source: durablePolicy, subject: policy.account_subject, expiresAt: Date.parse(policy.expires_at), policy }
        lastRefresh = Date.now()
        return policy
      } catch (error) {
        if (error?.code === PROJECTION_SUPERSEDED) throw error
        if (!isCurrent()) throw projectionSuperseded()
        const fallback = validCached(state.account_subject, Date.now())
        if (isSearchGrantError(error)) {
          await degradeInvalidSearchGrant(fallback)
        }
        if (fallback !== undefined) {
          lastRefresh = Date.now()
          return fallback
        }
        throw error
      }
    })()
    refreshing = { subject: state.account_subject, promise }
    try {
      return await promise
    } finally {
      if (refreshing?.promise === promise) refreshing = undefined
    }
  }

  const ensureRuntimeReady = async () => {
    if (runtimeReady || !hasRuntimePolicy) return
    if (checkingRuntime !== undefined) return checkingRuntime
    checkingRuntime = (async () => {
      const state = await identityState()
      const current = validCached(state.account_subject, Date.now())
      if (current !== undefined
        && await matchesRuntimeProjection(ctx, projectionTable.get(RUNTIME_PROJECTION_KEY), current)) {
        runtimeReady = true
        return
      }
      await refresh({ force: true })
      if (!runtimeReady) throw new Error('e-Mate native runtime model projection is not ready')
    })()
    try {
      await checkingRuntime
    } finally {
      checkingRuntime = undefined
    }
  }

  const activeCached = (recover = false) => {
    if (!runtimeReady) throw new Error('e-Mate native runtime model projection is not ready')
    const subject = typeof ctx.emateIdentity.localAccountSubject === 'function'
      ? ctx.emateIdentity.localAccountSubject()
      : cached?.account_subject
    const policy = typeof subject === 'string' ? validCached(subject, Date.now()) : undefined
    if (policy === undefined) {
      if (recover) return undefined
      throw new Error('e-Mate model policy cache is unavailable or expired')
    }
    if (Date.now() - lastRefresh >= REFRESH_MS && refreshing === undefined) {
      void refresh().catch(error => ctx.logger?.warn?.('e-Mate model policy background refresh failed', error))
    }
    return policy
  }
  const activePolicy = async () => {
    await ensureRuntimeReady()
    return activeCached(true) ?? refresh({ force: true })
  }

  return {
    refresh,
    async current() { return publicPolicy(await refresh()) },
    async auditContext(model) {
      const policy = await activePolicy()
      if (!allowed(policy, model)) throw new Error(`Model "${model}" is not allowed by the current e-Mate policy.`)
      return {
        account_subject_sha256: createHash('sha256').update(policy.account_subject).digest('hex'),
        policy_revision: policy.revision,
        policy_receipt_id: policy.receipt_id,
        policy_sha256: policy.policy_sha256,
      }
    },
    async assertModel(model) {
      const policy = await activePolicy()
      if (!allowed(policy, model)) throw new Error(`Model "${model}" is not allowed by the current e-Mate policy.`)
      return publicPolicy(policy)
    },
    async imageInputContract(provider, model) {
      try {
        const metadata = typeof ctx.llm?.resolveModelInfo === 'function'
          ? await ctx.llm.resolveModelInfo(provider, model)
          : undefined
        return modelImageInputContract(metadata, provider, model)
      } catch {
        return modelImageInputContract(undefined, provider, model)
      }
    },
    markAuditDelivered: quota.markAuditDelivered,
  }
}

function installApiPolicy(ctx, service) {
  const originalSessionModels = ctx.apiProxy.sessions.models
  const originalSelectModel = ctx.apiProxy.sessions.selectModel
  const originalLlmModels = ctx.apiProxy.llm.models

  const sessionModels = async (request) => {
    const response = await originalSessionModels(request)
    if (!response.result.ok) return response
    try {
      const policy = await service.refresh()
      const currentAllowed = allowed(policy, response.result.value.current.model)
      return {
        ...response,
        result: {
          ok: true,
          value: {
            ...response.result.value,
            routable: response.result.value.routable && currentAllowed,
            groups: filterGroups(response.result.value.groups, policy),
          },
        },
      }
    } catch (error) {
      return {
        ...response,
        result: {
          ok: true,
          value: {
            ...unavailableCatalog(response.result.value, error instanceof Error ? error.message : String(error)),
            routable: false,
          },
        },
      }
    }
  }

  const selectModel = async (request) => {
    try {
      await service.assertModel(request.payload.model)
    } catch (error) {
      return modelUnavailable(
        request,
        request.payload.provider,
        request.payload.model,
        error instanceof Error ? error.message : String(error),
      )
    }
    return originalSelectModel({
      ...request,
      payload: {
        ...request.payload,
        reasoningEffort: request.payload.reasoningEffort
          ?? CHAT_MODELS.get(policyModelId(request.payload.model))?.reasoning_effort,
      },
    })
  }

  const llmModels = async (request) => {
    const response = await originalLlmModels(request)
    if (!response.result.ok) return response
    try {
      const policy = await service.refresh()
      return {
        ...response,
        result: { ok: true, value: { ...response.result.value, groups: filterGroups(response.result.value.groups, policy) } },
      }
    } catch (error) {
      return {
        ...response,
        result: {
          ok: true,
          value: unavailableCatalog(response.result.value, error instanceof Error ? error.message : String(error)),
        },
      }
    }
  }

  ctx.apiProxy.sessions.models = sessionModels
  ctx.apiProxy.sessions.selectModel = selectModel
  ctx.apiProxy.llm.models = llmModels
  return () => {
    if (ctx.apiProxy.sessions.models === sessionModels) ctx.apiProxy.sessions.models = originalSessionModels
    if (ctx.apiProxy.sessions.selectModel === selectModel) ctx.apiProxy.sessions.selectModel = originalSelectModel
    if (ctx.apiProxy.llm.models === llmModels) ctx.apiProxy.llm.models = originalLlmModels
  }
}

export async function apply(ctx, config = {}) {
  const { defineDomain, domainTable, z } = await loadTargetStorageDomain(
    config.bindingPath ?? join(import.meta.dirname, 'runtime-binding.json'),
  )
  const policyShape = {
    schema_version: z.literal(1),
    account_subject: z.string().regex(SUBJECT),
    revision: z.number().int().min(1),
    allowed_model_ids: z.array(z.enum([...MANAGED_MODELS])).min(1).max(MANAGED_MODELS.size),
    default_chat_model_id: z.enum([...CHAT_MODELS.keys()]),
    default_chat_reasoning_effort: z.enum(['max', 'medium']),
    image_primary_model_id: z.literal('gpt-image-2-pro'),
    issued_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    receipt_id: z.string().regex(RECEIPT),
    policy_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }
  const policyRecord = z.object(policyShape).strict()
  const legacyPolicyRecord = z.object({
    ...policyShape,
    allowed_model_ids: z.array(z.enum([...MANAGED_MODELS, 'gpt-image-2']))
      .min(1).max(MANAGED_MODELS.size + 1),
    image_fallback_upstream_model_id: z.literal('gpt-image-2'),
  }).strict().transform(value => {
    const { policy_sha256: expected, ...legacy } = value
    if (new Set(legacy.allowed_model_ids).size !== legacy.allowed_model_ids.length
      || legacy.allowed_model_ids.includes('gpt-image-2') && !legacy.allowed_model_ids.includes('gpt-image-2-pro')
      || sha256(canonicalJson(legacy)) !== expected) {
      throw new Error('e-Mate legacy model policy is invalid')
    }
    return value
  })
  const runtimeProjectionRecord = z.object({
    schema_version: z.literal(1),
    account_subject: z.string().regex(SUBJECT),
    policy_revision: z.number().int().min(1),
    policy_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    expires_at: z.iso.datetime(),
    search_status: z.enum(['granted', 'denied', 'unavailable']),
    llm_settings_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    default_model_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    credential_refs: z.array(z.enum([...STORED_CREDENTIAL_REFS])).max(STORED_CREDENTIAL_REFS.size),
    projection_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  const domain = await ctx.storageDomain.open(defineDomain({
    name: 'emate_model_policy',
    version: 1,
    tables: { active: domainTable(z.union([policyRecord, legacyPolicyRecord])), runtime_projection: domainTable(runtimeProjectionRecord) },
  }))
  ctx.effect(() => () => domain.close(), 'emate.modelPolicy: close target storage domain')
  const policyTable = domain.table('active')
  const storedPolicy = policyTable.get('active')
  if (storedPolicy !== undefined) {
    const policy = decodeDurableModelPolicy(
      storedPolicy,
      storedPolicy.account_subject,
      Date.parse(storedPolicy.issued_at),
    )
    await policyTable.put('active', encodeDurableModelPolicy(policy))
  }
  const quotaSnapshot = z.object({
    schema_version: z.literal(1),
    account_subject: z.string().regex(SUBJECT),
    week_started_at: z.iso.datetime(),
    calculated_at: z.iso.datetime(),
    lease_expires_at: z.iso.datetime(),
    weekly_token_limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    enterprise_total_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  const quotaReservation = z.object({
    schema_version: z.literal(1),
    reservation_id: z.string().regex(/^quota_[0-9a-f-]{36}$/u),
    account_subject: z.string().regex(SUBJECT),
    week_started_at: z.iso.datetime(),
    session_id_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    turn: z.number().int().min(1),
    step: z.number().int().min(1),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    reserved_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    created_at: z.iso.datetime(),
    terminal_usage: z.json().optional(),
    terminal_at: z.iso.datetime().optional(),
  })
  const quotaUsage = z.object({
    schema_version: z.literal(1),
    fact_id: z.string().regex(/^auditfact_[0-9a-f]{64}$/u),
    reservation_id: z.string().regex(/^quota_[0-9a-f-]{36}$/u),
    account_subject: z.string().regex(SUBJECT),
    week_started_at: z.iso.datetime(),
    total_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    occurred_at: z.iso.datetime(),
    audit_delivered_at: z.iso.datetime().optional(),
  })
  const quotaDomain = await ctx.storageDomain.open(defineDomain({
    name: 'emate_weekly_quota',
    version: 1,
    tables: {
      snapshots: domainTable(quotaSnapshot),
      reservations: domainTable(quotaReservation),
      usage: domainTable(quotaUsage),
    },
  }))
  ctx.effect(() => () => quotaDomain.close(), 'emate.modelPolicy: close weekly quota storage domain')
  const quota = createQuotaService(
    ctx,
    quotaDomain.table('snapshots'),
    quotaDomain.table('reservations'),
    quotaDomain.table('usage'),
  )
  const service = createService(ctx, policyTable, domain.table('runtime_projection'), quota)
  ctx.provide('emateModelPolicy', service)
  ctx.effect(() => installApiPolicy(ctx, service), 'emate.modelPolicy: target ApiProxy policy projection')
  const pairing = await loadTargetCompaction(config.bindingPath)
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter' && !payload.signal.aborted) {
      await compactRequestHistory(ctx, { ...payload, messages: decision.messages }, pairing)
    }
    return decision
  })
  ctx.on('agent/request', async (payload, next) => {
    const request = await next()
    await service.assertModel(request.model)
    quota.armRequest(payload, request)
    return request
  })
  ctx.on('llm/stream', (options, next) => (async function* () {
    if (!quota.isArmed(options)) await service.assertModel(options.model)
    const oversized = requestSizeFailure(options)
    if (oversized) {
      quota.disarmRequest(options)
      yield { type: 'finish', reason: { kind: 'error', failure: oversized } }
      return
    }
    const reservation = await quota.admit(options)
    let terminal
    let realUsage
    try {
      for await (const chunk of next()) {
        if (chunk?.type === 'usage') realUsage = chunk.usage
        if (chunk?.type === 'finish') terminal = chunk.reason?.kind
        const sizeFailure = chunk?.type === 'finish' && chunk.reason?.kind === 'error'
          ? requestSizeFailure(options, chunk.reason.failure) : undefined
        yield sizeFailure ? { ...chunk, reason: { ...chunk.reason, failure: sizeFailure } } : chunk
      }
    } catch (error) {
      try {
        await quota.finish(reservation, undefined, options.signal?.aborted ? 'aborted' : 'error')
      } catch {
        ctx.logger?.warn?.('e-Mate local weekly quota failed to release an errored request')
      }
      const sizeFailure = requestSizeFailure(options, error)
      if (sizeFailure) {
        yield { type: 'finish', reason: { kind: 'error', failure: sizeFailure } }
        return
      }
      throw error
    }
    await quota.finish(reservation, realUsage, terminal)
  })())
  ctx.on('session/event', (session, event) => { void quota.captureEvent(session.id, event) })
  ctx.on('session/flush', () => quota.drain())
  ctx.effect(() => ctx.connection.rpc.handle(
    MODEL_POLICY_CHANNEL,
    async (endpoint, payload) => {
      if (endpoint !== 'policy.current' || !isRecord(payload) || Object.keys(payload).length !== 0) {
        return { ok: false, error: { code: 'bad-request', message: 'unknown e-Mate model policy endpoint', details: { issues: [] } } }
      }
      return { ok: true, value: await service.current() }
    },
    { authority: 'loopback' },
  ), 'emate.modelPolicy: target-native RPC channel')
}
