import { createHash, createPublicKey } from 'node:crypto'
import { decodedContentLength } from '../http-response.ts'
import {
  agreementBundleSha256,
  agreementDocuments,
} from './agreements.js'
import { LOGGED_OUT_CREDENTIAL } from '../credentials-os.js'

const SESSION_REF = 'E_MATE_ENTERPRISE_SESSION'
export const MODEL_SESSION_REF = 'E_MATE_MODEL_SESSION_TOKEN'
const MAX_JSON_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const REFRESH_EARLY_MS = 60_000
const KNOWLEDGE_ROOT = new URL('https://mvdcm.ecoremedia.net/ecorex-agent/client/knowledge/v1')
const SKILL_HUB_ROOTS = [
  new URL('https://mvdcm.ecoremedia.net/ecorex-agent/client/skill-hub/v1'),
  new URL('https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1'),
]
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
const REFRESH_TOKEN = /^emate_rt_[A-Za-z0-9_-]{43}$/u
const USAGE_DECIMAL = /^(0|[1-9][0-9]{0,127})$/u
const CHAT_MODELS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'deepseek',
  'gpt-6-astra',
]
const RUNTIME_MODEL_CONTRACT = new Map([
  ['gpt-5.6-luna', { upstreamModelId: 'gpt-5.6-luna', apiMode: 'responses', provider: 'e-mate-enterprise', credentialRef: MODEL_SESSION_REF }],
  ['gpt-5.6-sol', { upstreamModelId: 'gpt-5.6-sol', apiMode: 'responses', provider: 'e-mate-enterprise', credentialRef: MODEL_SESSION_REF }],
  ['gpt-6-astra', { upstreamModelId: 'gpt-6-astra', apiMode: 'responses', provider: 'e-mate-enterprise', credentialRef: MODEL_SESSION_REF }],
  ['deepseek', { upstreamModelId: 'deepseek-v4-flash-vision-exp', apiMode: 'responses', provider: 'e-mate-enterprise-deepseek', credentialRef: MODEL_SESSION_REF }],
])
export const RUNTIME_MODEL_CREDENTIAL_REFS = Object.freeze([MODEL_SESSION_REF])
const OBSOLETE_RUNTIME_MODEL_CREDENTIAL_REFS = Object.freeze([
  'E_MATE_MODEL_KEY_GPT',
  'E_MATE_MODEL_KEY_DEEPSEEK',
  'E_MATE_MODEL_KEY_DOUBAO',
])
const LOCAL_CREDENTIAL_REFS = Object.freeze([
  SESSION_REF,
  MODEL_SESSION_REF,
  ...OBSOLETE_RUNTIME_MODEL_CREDENTIAL_REFS,
  'E_MATE_SEARCH_KEY_DEEPSEEK',
])
const ADMIN_ROLES = new Set(['TENANT_ADMIN', 'AUDIT_ADMIN'])
const REGISTRATION_REJECTION_MESSAGES = {
  INVALID_CHALLENGE: '验证码无效或已过期',
  ACCOUNT_EXISTS: '该账号已存在',
} as const
const LOGIN_REJECTION_MESSAGE = '账号或密码错误'
const REFRESH_FAILURE_CODES = [
  'INVALID_GRANT', 'SESSION_REVOKED', 'TOKEN_REUSED', 'CLIENT_FORBIDDEN',
  'APPROVAL_REQUIRED', 'POLICY_REQUIRED', 'RATE_LIMITED', 'INVALID_REQUEST',
] as const
type RefreshFailureCode = typeof REFRESH_FAILURE_CODES[number] | 'UNKNOWN'
const TERMINAL_REFRESH_FAILURE_CODES = new Set<RefreshFailureCode>([
  'INVALID_GRANT', 'SESSION_REVOKED', 'TOKEN_REUSED',
])

class RegistrationRejection extends Error {
  constructor(readonly code: keyof typeof REGISTRATION_REJECTION_MESSAGES) {
    super(REGISTRATION_REJECTION_MESSAGES[code])
  }
}

export function registrationRejectionMessage(error: unknown): string | undefined {
  return error instanceof RegistrationRejection ? REGISTRATION_REJECTION_MESSAGES[error.code] : undefined
}

class LoginRejection extends Error {}

export function loginRejectionMessage(error: unknown): string | undefined {
  return error instanceof LoginRejection ? LOGIN_REJECTION_MESSAGE : undefined
}

class RefreshFailure extends Error {
  constructor(readonly code: RefreshFailureCode, readonly status: number, message: string) {
    super(message)
  }
}

/**
 * The model gateway rejected the runtime-models *query* because it does not know one of its
 * parameters. A deployment older than the `capabilities` parameter answers 400 INVALID_REQUEST
 * for the whole query instead of ignoring the extra parameter, so the caller asks once more
 * without it. Every other rejection keeps its own error and is never retried.
 */
class RuntimeModelsQueryRejection extends Error {}

/** Typed failure for authenticated consumers; no provider credentials leave this boundary. */
export class EnterpriseAuthenticationRequired extends Error {
  readonly code = 'auth'
  constructor() { super('e-Mate login is required') }
}

export class IdentityServiceUnavailable extends Error {
  constructor(readonly reason: 'transport' | 'upstream-http', readonly status?: number) {
    super('企业身份服务暂时不可用，请稍后重试。')
  }
}

type Credentials = {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

type Fetch = typeof fetch

type EnterpriseConfig = {
  authBaseUrl: string
  modelBaseUrl: string
  clientId: string
  organization: string
}

type Session = {
  schemaVersion: 1
  sessionId: string
  accessToken: string
  refreshToken: string
  expiresAt: string
  identity: {
    tenantId: string
    userId: string
    displayName: string
    roles: string[]
    weeklyTokenLimit: number
  }
  modelGateway: {
    baseUrl: string
    sessionToken: string
    expiresAt: string
    usageKeyId: string
    usagePublicKey: string
    allowedModelIds: string[]
  }
}

type ConsentPolicy = {
  schemaVersion: 1
  agreementId: string
  agreementVersion: string
  disclaimerVersion: string
  contentHash: string
}

type ConsentAcceptance = ConsentPolicy & {
  acceptanceId: string
  userId: string
  acceptedAt: string
  clientVersion: string
  locale: string
}

type ConsentStatus = {
  schemaVersion: 1
  policy: ConsentPolicy
  required: boolean
  acceptance: ConsentAcceptance | null
}

type StoredSession = {
  schema_version: 1
  remember_login: boolean
  received_at: string
  session: Session
  consent?: ConsentStatus
}

export type RuntimeModel = {
  id: string
  provider: string
  credentialRef: string
  api: 'openai-responses' | 'openai-completions'
  upstreamModelId: string
  upstreamBaseUrl: string
  label: string
  input: Array<'text' | 'image'>
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

type SearchCredentialGrantBase = {
  schemaVersion: 1
  purpose: 'web-search'
  provider: 'deepseek-official'
  credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK'
}

export type SearchCredentialGrant = SearchCredentialGrantBase & (
  | { status: 'granted'; upstreamApiKey: string }
  | { status: 'denied' | 'unavailable' }
)

type ProviderOptions = {
  credentials: Credentials
  enterprise: EnterpriseConfig
  fetchImplementation?: Fetch
  now?: () => number
}

function agreementExempt(value: StoredSession): boolean {
  return value.session.identity.roles.some(role => ADMIN_ROLES.has(role))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function baseUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`e-Mate enterprise ${label} URL is invalid`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`e-Mate enterprise ${label} URL must be HTTPS without credentials, query, or fragment`)
  }
  return url.toString().replace(/\/+$/u, '')
}

function endpoint(root: string, path: string): URL {
  return new URL(`${root}/${path.replace(/^\/+/, '')}`)
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`e-Mate enterprise ${label} is invalid`)
  }
  return new Date(Date.parse(value)).toISOString()
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`e-Mate enterprise ${label} is invalid`)
  }
  return value
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new Error(`e-Mate enterprise ${label} is invalid`)
  }
  return value
}

function usagePublicKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8_192 || value.includes('\u0000')) {
    throw new Error('e-Mate enterprise usage public key is invalid')
  }
  const pem = value.trim()
  if (!pem.startsWith('-----BEGIN PUBLIC KEY-----') || !pem.endsWith('-----END PUBLIC KEY-----')) {
    throw new Error('e-Mate enterprise usage public key is invalid')
  }
  try {
    const key = createPublicKey(pem)
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new Error('not Ed25519')
    }
    return key.export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    throw new Error('e-Mate enterprise usage public key is invalid')
  }
}

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 20
    || value.some(id => typeof id !== 'string' || !MODEL_ID.test(id))
    || new Set(value).size !== value.length) {
    throw new Error('e-Mate enterprise allowed model ids are invalid')
  }
  return [...value]
}

function runtimeModels(value: unknown, allowed: readonly string[], gatewayRoot: string): RuntimeModel[] {
  if (!isRecord(value)
    || !exact(value, ['schemaVersion', 'models', 'searchCredentialGrant'])
    || value.schemaVersion !== 1
    || !Array.isArray(value.models)
    || value.models.length < 1
    || value.models.length > RUNTIME_MODEL_CONTRACT.size) {
    throw new Error('e-Mate enterprise runtime models are invalid')
  }
  const seen = new Set<string>()
  return value.models.map(model => {
    if (!isRecord(model)
      || !exact(model, [
        'id', 'apiMode', 'upstreamModelId', 'label', 'input', 'reasoning', 'contextWindow', 'maxTokens',
      ])) {
      throw new Error('e-Mate enterprise runtime model is invalid')
    }
    const id = identifier(model.id, 'runtime model id')
    const contract = RUNTIME_MODEL_CONTRACT.get(id)
    if (contract === undefined
      || !allowed.includes(id)
      || seen.has(id)
      || model.upstreamModelId !== contract.upstreamModelId
      || model.apiMode !== contract.apiMode
      || typeof model.reasoning !== 'boolean'
      || !Array.isArray(model.input)
      || model.input.length < 1
      || model.input.length > 2
      || new Set(model.input).size !== model.input.length
      || model.input.some(input => input !== 'text' && input !== 'image')
      || id === 'deepseek' && (!model.input.includes('text') || !model.input.includes('image'))
      || !Number.isSafeInteger(model.contextWindow)
      || Number(model.contextWindow) < 1
      || Number(model.contextWindow) > 10_000_000
      || !Number.isSafeInteger(model.maxTokens)
      || Number(model.maxTokens) < 1
      || Number(model.maxTokens) > 10_000_000) {
      throw new Error('e-Mate enterprise runtime model is invalid')
    }
    seen.add(id)
    return {
      id,
      provider: contract.provider,
      credentialRef: contract.credentialRef,
      api: 'openai-responses',
      upstreamModelId: id,
      upstreamBaseUrl: `${gatewayRoot}/v1`,
      label: text(model.label, 'runtime model label', 80),
      input: [...model.input] as Array<'text' | 'image'>,
      reasoning: model.reasoning,
      contextWindow: Number(model.contextWindow),
      maxTokens: Number(model.maxTokens),
    }
  })
}

function searchCredentialGrant(value: unknown): SearchCredentialGrant {
  const grant = isRecord(value) && isRecord(value.searchCredentialGrant)
    ? value.searchCredentialGrant
    : undefined
  if (!isRecord(value)
    || !exact(value, ['schemaVersion', 'models', 'searchCredentialGrant'])
    || !isRecord(grant)
    || (grant.status !== 'granted' && grant.status !== 'denied' && grant.status !== 'unavailable')
    || !exact(grant, [
      'schemaVersion', 'status', 'purpose', 'provider', 'credentialRef',
      ...(grant.status === 'granted' ? ['upstreamApiKey'] : []),
    ])
    || grant.schemaVersion !== 1
    || grant.purpose !== 'web-search'
    || grant.provider !== 'deepseek-official'
    || grant.credentialRef !== 'E_MATE_SEARCH_KEY_DEEPSEEK'
    || (grant.status === 'granted' && (
      typeof grant.upstreamApiKey !== 'string'
      || grant.upstreamApiKey.length < 20
      || grant.upstreamApiKey.length > 8_192
      || /\s/u.test(grant.upstreamApiKey)
    ))) {
    const error = new Error('e-Mate enterprise search credential grant is invalid')
    ;(error as Error & { code: string }).code = 'E_MATE_SEARCH_GRANT_INVALID'
    throw error
  }
  const base: SearchCredentialGrantBase = {
    schemaVersion: 1,
    purpose: 'web-search',
    provider: 'deepseek-official',
    credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
  }
  return grant.status === 'granted'
    ? { ...base, status: 'granted', upstreamApiKey: grant.upstreamApiKey as string }
    : { ...base, status: grant.status }
}

function usageActivityProjection(value, query) {
  if (!isRecord(value)
    || !exact(value, [
      'schemaVersion', 'timezone', 'startDate', 'endDate', 'days', 'periodTotal', 'calculatedAt',
    ])
    || value.schemaVersion !== 1
    || value.timezone !== query.timezone
    || value.startDate !== query.start_date
    || value.endDate !== query.end_date
    || !Array.isArray(value.days)
    || value.days.length < 1
    || value.days.length > 366
    || typeof value.periodTotal !== 'string'
    || !USAGE_DECIMAL.test(value.periodTotal)
    || typeof value.calculatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.calculatedAt))) {
    throw new Error('e-Mate enterprise usage activity is invalid')
  }
  const days = value.days.map(day => {
    if (!isRecord(day)
      || !exact(day, ['date', 'total', 'input', 'output', 'cacheRead', 'cacheWrite'])
      || typeof day.date !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/u.test(day.date)
      || [day.total, day.input, day.output, day.cacheRead, day.cacheWrite]
        .some(count => typeof count !== 'string' || !USAGE_DECIMAL.test(count))
      || BigInt(day.total) !== BigInt(day.input) + BigInt(day.output) + BigInt(day.cacheRead) + BigInt(day.cacheWrite)) {
      throw new Error('e-Mate enterprise usage activity day is invalid')
    }
    return {
      date: day.date,
      total: day.total,
      input: day.input,
      output: day.output,
      cache_read: day.cacheRead,
      cache_write: day.cacheWrite,
    }
  })
  if (days.reduce((total, day) => total + BigInt(day.total), 0n) !== BigInt(value.periodTotal)) {
    throw new Error('e-Mate enterprise usage activity total is invalid')
  }
  return {
    schema_version: 1,
    timezone: value.timezone,
    start_date: value.startDate,
    end_date: value.endDate,
    days,
    period_total: value.periodTotal,
    calculated_at: new Date(Date.parse(value.calculatedAt)).toISOString(),
  }
}

function session(value: unknown, expectedModelRoot: string): Session {
  if (!isRecord(value)
    || !exact(value, [
      'schemaVersion', 'sessionId', 'accessToken', 'refreshToken', 'expiresAt', 'identity', 'modelGateway',
    ])
    || value.schemaVersion !== 1
    || !isRecord(value.identity)
    || !exact(value.identity, ['tenantId', 'userId', 'displayName', 'roles', 'weeklyTokenLimit'])
    || !isRecord(value.modelGateway)
    || !exact(value.modelGateway, [
      'baseUrl', 'sessionToken', 'expiresAt', 'usageKeyId', 'usagePublicKey', 'allowedModelIds',
    ])) {
    throw new Error('e-Mate enterprise session response is invalid')
  }
  const accessToken = text(value.accessToken, 'access token', 16_384)
  const refreshToken = text(value.refreshToken, 'refresh token', 256)
  const modelToken = text(value.modelGateway.sessionToken, 'model session token', 16_384)
  const accessExpiry = timestamp(value.expiresAt, 'access expiry')
  const modelExpiry = timestamp(value.modelGateway.expiresAt, 'model expiry')
  if (!JWT.test(accessToken) || !JWT.test(modelToken) || !REFRESH_TOKEN.test(refreshToken)
    || Date.parse(modelExpiry) > Date.parse(accessExpiry)
    || baseUrl(text(value.modelGateway.baseUrl, 'model gateway URL', 2_048), 'model gateway') !== expectedModelRoot
    || !Array.isArray(value.identity.roles)
    || value.identity.roles.length < 1
    || value.identity.roles.some(role => !['TENANT_ADMIN', 'AUDIT_ADMIN', 'MEMBER'].includes(String(role)))
    || !Number.isSafeInteger(value.identity.weeklyTokenLimit)
    || Number(value.identity.weeklyTokenLimit) < 1) {
    throw new Error('e-Mate enterprise session response is invalid')
  }
  return {
    schemaVersion: 1,
    sessionId: identifier(value.sessionId, 'session id'),
    accessToken,
    refreshToken,
    expiresAt: accessExpiry,
    identity: {
      tenantId: identifier(value.identity.tenantId, 'tenant id'),
      userId: identifier(value.identity.userId, 'user id'),
      displayName: text(value.identity.displayName, 'display name', 160),
      roles: value.identity.roles.map(role => String(role)),
      weeklyTokenLimit: Number(value.identity.weeklyTokenLimit),
    },
    modelGateway: {
      baseUrl: expectedModelRoot,
      sessionToken: modelToken,
      expiresAt: modelExpiry,
      usageKeyId: identifier(value.modelGateway.usageKeyId, 'usage key id'),
      usagePublicKey: usagePublicKey(value.modelGateway.usagePublicKey),
      allowedModelIds: modelIds(value.modelGateway.allowedModelIds),
    },
  }
}

function consentPolicy(value: unknown): ConsentPolicy {
  if (!isRecord(value)
    || !exact(value, ['schemaVersion', 'agreementId', 'agreementVersion', 'disclaimerVersion', 'contentHash'])
    || value.schemaVersion !== 1
    || typeof value.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.contentHash)) {
    throw new Error('e-Mate enterprise consent policy is invalid')
  }
  return {
    schemaVersion: 1,
    agreementId: identifier(value.agreementId, 'agreement id'),
    agreementVersion: text(value.agreementVersion, 'agreement version', 64),
    disclaimerVersion: text(value.disclaimerVersion, 'disclaimer version', 64),
    contentHash: value.contentHash,
  }
}

function consentAcceptance(value: unknown, policy: ConsentPolicy): ConsentAcceptance {
  if (!isRecord(value)
    || !exact(value, [
      'schemaVersion', 'agreementId', 'agreementVersion', 'disclaimerVersion', 'contentHash',
      'acceptanceId', 'userId', 'acceptedAt', 'clientVersion', 'locale',
    ])) {
    throw new Error('e-Mate enterprise consent acceptance is invalid')
  }
  const acceptedPolicy = consentPolicy({
    schemaVersion: value.schemaVersion,
    agreementId: value.agreementId,
    agreementVersion: value.agreementVersion,
    disclaimerVersion: value.disclaimerVersion,
    contentHash: value.contentHash,
  })
  if (JSON.stringify(acceptedPolicy) !== JSON.stringify(policy)) {
    throw new Error('e-Mate enterprise consent acceptance policy is invalid')
  }
  return {
    ...acceptedPolicy,
    acceptanceId: identifier(value.acceptanceId, 'consent acceptance id'),
    userId: identifier(value.userId, 'consent user id'),
    acceptedAt: timestamp(value.acceptedAt, 'consent accepted time'),
    clientVersion: text(value.clientVersion, 'consent client version', 64),
    locale: text(value.locale, 'consent locale', 32),
  }
}

function consentStatus(value: unknown): ConsentStatus {
  if (!isRecord(value)
    || !exact(value, ['schemaVersion', 'policy', 'required', 'acceptance'])
    || value.schemaVersion !== 1
    || typeof value.required !== 'boolean') {
    throw new Error('e-Mate enterprise consent status is invalid')
  }
  const policy = consentPolicy(value.policy)
  const acceptance = value.acceptance === null ? null : consentAcceptance(value.acceptance, policy)
  if (value.required !== (acceptance === null)) throw new Error('e-Mate enterprise consent status is invalid')
  return { schemaVersion: 1, policy, required: value.required, acceptance }
}

function storedSession(value: unknown, modelRoot: string): StoredSession {
  if (!isRecord(value)
    || !['consent,received_at,remember_login,schema_version,session', 'received_at,remember_login,schema_version,session']
      .includes(Object.keys(value).sort().join(','))
    || value.schema_version !== 1
    || typeof value.remember_login !== 'boolean') {
    throw new Error('e-Mate stored enterprise session is invalid')
  }
  return {
    schema_version: 1,
    remember_login: value.remember_login,
    received_at: timestamp(value.received_at, 'session received time'),
    session: session(value.session, modelRoot),
    ...(value.consent === undefined ? {} : { consent: consentStatus(value.consent) }),
  }
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  if (response.status >= 500) throw new IdentityServiceUnavailable('upstream-http', response.status)
  const declared = decodedContentLength(response)
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    throw new Error(`e-Mate enterprise ${label} response exceeds its boundary`)
  }
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > MAX_JSON_BYTES || (declared !== null && body.byteLength !== Number(declared))) {
    throw new Error(`e-Mate enterprise ${label} response exceeds its boundary`)
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') throw new Error(`e-Mate enterprise ${label} response is not JSON`)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new Error(`e-Mate enterprise ${label} response contains invalid JSON`)
  }
  if (!response.ok) {
    const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string'
      ? value.error.code
      : `HTTP_${response.status}`
    if (label === 'registration'
      && (response.status === 400 && code === 'INVALID_CHALLENGE'
        || response.status === 409 && code === 'ACCOUNT_EXISTS')) {
      throw new RegistrationRejection(code)
    }
    if (label === 'login' && response.status === 401 && code === 'INVALID_GRANT') {
      throw new LoginRejection(LOGIN_REJECTION_MESSAGE)
    }
    // Named exactly so the caller can retry the query without the parameter it sent; any other
    // 400 (a real policy or boundary error) must keep failing.
    if (label === 'runtime models' && response.status === 400 && code === 'INVALID_REQUEST') {
      throw new RuntimeModelsQueryRejection(code)
    }
    const messages: Record<string, string> = {
      INVALID_GRANT: '账号或密码错误',
      APPROVAL_REQUIRED: '账号正在等待管理员审核',
      POLICY_REQUIRED: '管理员尚未配置周用量和可用模型',
      SESSION_REVOKED: '登录已失效，请重新登录',
      TOKEN_REUSED: '登录刷新凭据已失效，请重新登录',
    }
    if (label === 'session refresh') {
      const closedCode = REFRESH_FAILURE_CODES.includes(code as typeof REFRESH_FAILURE_CODES[number])
        ? code as typeof REFRESH_FAILURE_CODES[number]
        : 'UNKNOWN'
      throw new RefreshFailure(
        closedCode,
        response.status,
        messages[code] ?? `e-Mate enterprise session refresh failed (HTTP_${response.status})`,
      )
    }
    throw new Error(messages[code] ?? `e-Mate enterprise ${label} failed (${code})`)
  }
  return value
}

function registration(value: unknown) {
  if (!isRecord(value)
    || !exact(value, ['schemaVersion', 'registrationId', 'status'])
    || value.schemaVersion !== 1
    || value.status !== 'PENDING_APPROVAL') {
    throw new Error('e-Mate enterprise registration receipt is invalid')
  }
  return { schema_version: 1, registration_id: identifier(value.registrationId, 'registration id'), status: 'pending_approval' }
}

function mutationReceipt(value: unknown, password: boolean) {
  if (!isRecord(value)
    || !exact(value, password
      ? ['schemaVersion', 'receiptId', 'reauthenticationRequired']
      : ['schemaVersion', 'receiptId', 'reauthenticationRequired'])
    || value.schemaVersion !== 1
    || value.reauthenticationRequired !== password) {
    throw new Error('e-Mate enterprise mutation receipt is invalid')
  }
  return {
    receipt_id: identifier(value.receiptId, 'mutation receipt id'),
    ...(password ? { reauthentication_required: true } : {}),
  }
}

function policyFor(value: StoredSession, runtime: readonly RuntimeModel[]) {
  const managed = [
    ...runtime.map(({ id }) => id),
    ...value.session.modelGateway.allowedModelIds.filter(id => id === 'gpt-image-2.5-flare'),
  ]
  const chat = CHAT_MODELS.find(id => managed.includes(id))
  if (chat === undefined) throw new Error('e-Mate enterprise policy contains no chat model')
  const allowed = new Set(managed)
  return {
    schema_version: 1,
    account_subject: `${value.session.identity.tenantId}:${value.session.identity.userId}`,
    revision: Math.max(1, Date.parse(value.received_at)),
    allowed_model_ids: [...allowed],
    default_chat_model_id: chat,
    default_chat_reasoning_effort: chat === 'gpt-5.6-luna' || chat === 'deepseek' ? 'max' : chat === 'gpt-6-astra' ? 'low' : 'medium',
    image_primary_model_id: 'gpt-image-2.5-flare',
    issued_at: value.received_at,
    expires_at: value.session.expiresAt,
    receipt_id: value.session.sessionId,
  }
}

export function createEnterpriseIdentityProvider(options: ProviderOptions) {
  const authRoot = baseUrl(options.enterprise.authBaseUrl, 'auth')
  const modelRoot = baseUrl(options.enterprise.modelBaseUrl, 'model')
  const clientId = identifier(options.enterprise.clientId, 'client id')
  const organization = text(options.enterprise.organization, 'organization', 160).trim()
  const request = options.fetchImplementation ?? fetch
  const now = options.now ?? Date.now
  let current: StoredSession | undefined
  let initialized = false
  let loading: Promise<StoredSession | undefined> | undefined
  let refreshing: Promise<StoredSession> | undefined
  let checkingConsent: { revision: number; token: string; promise: Promise<ConsentStatus> } | undefined
  let leaseRevision = 0
  let credentialMutation: Promise<void> = Promise.resolve()
  let loggingOut: Promise<{ remote_revocation: 'revoked'; receipt_id: string } | { remote_revocation: 'unknown' }> | undefined

  const mutateCredentials = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = credentialMutation.then(mutation, mutation)
    credentialMutation = result.then(() => undefined, () => undefined)
    return result
  }

  const clearCredentials = async (refs: readonly string[]) => {
    await Promise.allSettled(refs.map(ref => Promise.resolve()
      .then(() => options.credentials.set(ref, LOGGED_OUT_CREDENTIAL))))
    const results = await Promise.allSettled(refs.map(ref => Promise.resolve()
      .then(() => options.credentials.unset(ref))))
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('e-Mate enterprise credentials could not be cleared')
    }
  }

  const call = async (root: string, path: string, init: RequestInit, label: string) => {
    let response: Response
    try {
      response = await request(endpoint(root, path), {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json', ...init.headers },
      })
    } catch {
      throw new IdentityServiceUnavailable('transport')
    }
    return responseJson(response, label)
  }

  const clear = () => {
    leaseRevision += 1
    current = undefined
    initialized = true
    loading = undefined
    return mutateCredentials(() => clearCredentials(LOCAL_CREDENTIAL_REFS))
  }

  const save = (value: StoredSession, expectedRevision = leaseRevision) => mutateCredentials(async () => {
    let sessionWritten = false
    let modelSessionWritten = false
    try {
      if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
      if (current?.session.identity.tenantId !== value.session.identity.tenantId
        || current.session.identity.userId !== value.session.identity.userId) current = undefined
      await options.credentials.set(SESSION_REF, JSON.stringify(value))
      sessionWritten = true
      if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
      await options.credentials.set(MODEL_SESSION_REF, value.session.modelGateway.sessionToken)
      modelSessionWritten = true
      if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
      current = value
    } catch (error) {
      const currentMutation = expectedRevision === leaseRevision
      const credentialsWritten = sessionWritten || modelSessionWritten
      if (currentMutation || credentialsWritten) current = undefined
      const refs = currentMutation || credentialsWritten ? LOCAL_CREDENTIAL_REFS : []
      await clearCredentials(refs).catch(() => undefined)
      throw error
    }
  })

  const load = async () => {
    if (current !== undefined) return current
    if (loading !== undefined) return loading
    if (initialized) return undefined
    const expectedRevision = leaseRevision
    loading = (async () => {
      const hit = await options.credentials.resolve(SESSION_REF)
      if (hit === undefined) return undefined
      if (hit.value === LOGGED_OUT_CREDENTIAL) return undefined
      let value: StoredSession
      try {
        value = storedSession(JSON.parse(hit.value), modelRoot)
      } catch {
        await clear().catch(() => undefined)
        throw new Error('e-Mate stored enterprise session is invalid; sign in again')
      }
      if (!value.remember_login) {
        await clear()
        return undefined
      }
      await mutateCredentials(async () => {
        if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
        await options.credentials.set(MODEL_SESSION_REF, value.session.modelGateway.sessionToken)
        if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
        current = value
      })
      return value
    })()
    try {
      const value = await loading
      initialized = true
      return value
    } finally {
      loading = undefined
    }
  }

  const refresh = async (value: StoredSession) => {
    if (refreshing !== undefined) return refreshing
    const expectedRevision = leaseRevision
    refreshing = (async () => {
      const refreshed = session(await call(authRoot, '/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          refreshToken: value.session.refreshToken,
          clientVersion: '2.0.18',
          refreshRequestId: `refresh-v1-${createHash('sha256')
            .update('e-mate-refresh-request-v1\0', 'utf8')
            .update(value.session.refreshToken, 'utf8')
            .digest('base64url')}`,
        }),
      }, 'session refresh'), modelRoot)
      const next: StoredSession = {
        schema_version: 1,
        remember_login: value.remember_login,
        received_at: new Date(now()).toISOString(),
        session: refreshed,
        ...(value.consent === undefined ? {} : { consent: value.consent }),
      }
      await save(next, expectedRevision)
      return next
    })()
    try {
      return await refreshing
    } catch (error) {
      if (expectedRevision === leaseRevision
        && error instanceof RefreshFailure
        && TERMINAL_REFRESH_FAILURE_CODES.has(error.code)) {
        try {
          await clear()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'e-Mate terminal enterprise credential clearing failed')
        }
      }
      throw error
    } finally {
      refreshing = undefined
    }
  }

  const active = async () => {
    const value = await load()
    if (value === undefined) return undefined
    const accessExpired = Date.parse(value.session.expiresAt) <= now()
    const modelExpired = Date.parse(value.session.modelGateway.expiresAt) <= now()
    if (accessExpired || modelExpired || Date.parse(value.session.modelGateway.expiresAt) <= now() + REFRESH_EARLY_MS) {
      try {
        return await refresh(value)
      } catch (error) {
        if (current !== value || accessExpired || modelExpired) throw error
      }
    }
    return value
  }

  const activeAccessSession = async () => {
    let value: StoredSession | undefined
    try {
      value = await active()
    } catch (error) {
      if (error instanceof RefreshFailure && TERMINAL_REFRESH_FAILURE_CODES.has(error.code)) return undefined
      if (!(error instanceof IdentityServiceUnavailable)
        && !(error instanceof RefreshFailure && error.code === 'RATE_LIMITED')) throw error
      value = await load()
    }
    return value !== undefined && Date.parse(value.session.expiresAt) > now() ? value : undefined
  }

  const modelCall = (value: StoredSession, path: string, init: RequestInit, label: string) => {
    return call(modelRoot, path, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${value.session.modelGateway.sessionToken}`,
      },
    }, label)
  }

  const authorized = async (path: string, init: RequestInit, label: string) => {
    const value = await active()
    if (value === undefined) throw new Error('e-Mate login is required')
    return modelCall(value, path, init, label)
  }

  const requestConsent = async (value: StoredSession) => {
    const expectedRevision = leaseRevision
    try {
      const status = consentStatus(await modelCall(value, '/v1/consents/current', { method: 'GET' }, 'consent status'))
      if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
      if (status.policy.contentHash !== agreementBundleSha256) {
        throw new Error('e-Mate enterprise agreement policy does not match this installed version')
      }
      if (JSON.stringify(value.consent) !== JSON.stringify(status)) {
        await save({ ...value, consent: status }, expectedRevision)
      }
      return status
    } catch (error) {
      if (expectedRevision !== leaseRevision) throw error
      if (value.consent?.policy.contentHash === agreementBundleSha256) return value.consent
      throw error
    }
  }

  // Gate, account controls and settings can bootstrap together. Share only the
  // in-flight read; every later check still validates the live policy.
  const liveConsent = (value: StoredSession) => {
    const token = value.session.modelGateway.sessionToken
    if (checkingConsent?.revision === leaseRevision && checkingConsent.token === token) return checkingConsent.promise
    const pending = { revision: leaseRevision, token, promise: requestConsent(value) }
    checkingConsent = pending
    const clearPending = () => { if (checkingConsent === pending) checkingConsent = undefined }
    void pending.promise.then(clearPending, clearPending)
    return pending.promise
  }

  const modelRuntimePolicy = async () => {
    const expectedRevision = leaseRevision
    const value = await active()
    if (value === undefined) throw new Error('e-Mate login is required')
    if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
    const readRuntimeModels = (query: string) => modelCall(value, '/v1/runtime-models' + query, { method: 'GET' }, 'runtime models')
    let response: unknown
    try {
      response = await readRuntimeModels('?client_version=2.0.18&capabilities=responses-multimodal')
    } catch (error) {
      // Compatibility with a gateway older than the capability: it rejects the whole query, so
      // ask once without the parameter. The version gate and the response validation below are
      // untouched, and a second failure propagates unchanged.
      if (!(error instanceof RuntimeModelsQueryRejection)) throw error
      response = await readRuntimeModels('?client_version=2.0.18')
    }
    if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
    const grant = searchCredentialGrant(response)
    const models = runtimeModels(response, value.session.modelGateway.allowedModelIds, modelRoot)
    return { policy: policyFor(value, models), models, searchCredentialGrant: grant }
  }

  const provider = {
    localAccountPrincipal() {
      if (current === undefined || Date.parse(current.session.expiresAt) <= now()) return undefined
      const { tenantId, userId } = current.session.identity
      return { tenantId, userId }
    },
    localAccountSubject() {
      return current === undefined
        ? undefined
        : `${current.session.identity.tenantId}:${current.session.identity.userId}`
    },
    async bootstrap() {
      const value = await activeAccessSession()
      if (value === undefined) return { authenticated: false, workspace_unlocked: false }
      if (agreementExempt(value)) {
        return {
          authenticated: true,
          workspace_unlocked: true,
          agreement_exempt: true,
          display_name: value.session.identity.displayName,
          account_status: 'active',
          weekly_token_limit: value.session.identity.weeklyTokenLimit,
          account_subject: `${value.session.identity.tenantId}:${value.session.identity.userId}`,
        }
      }
      const consent = await liveConsent(value)
      return {
        authenticated: true,
        workspace_unlocked: !consent.required,
        display_name: value.session.identity.displayName,
        account_status: 'active',
        weekly_token_limit: value.session.identity.weeklyTokenLimit,
        account_subject: `${value.session.identity.tenantId}:${value.session.identity.userId}`,
        agreement_receipt_id: consent.acceptance?.acceptanceId,
      }
    },
    async keepAlive() {
      await active()
    },
    async issueRegistrationChallenge() {
      const value = await call(authRoot, '/v1/auth/registration/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId }),
      }, 'registration challenge')
      if (!isRecord(value)
        || !exact(value, ['schemaVersion', 'challengeId', 'imageDataUrl', 'expiresAt'])
        || value.schemaVersion !== 1) {
        throw new Error('e-Mate enterprise registration challenge is invalid')
      }
      return {
        schema_version: 1,
        challenge_id: identifier(value.challengeId, 'registration challenge id'),
        image_data_url: text(value.imageDataUrl, 'registration challenge image', 350_000),
        expires_at: timestamp(value.expiresAt, 'registration challenge expiry'),
      }
    },
    async register(input: Record<string, string>) {
      return registration(await call(authRoot, '/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          organization,
          account: input.account,
          realName: input.real_name,
          password: input.password,
          challengeId: input.challenge_id,
          verificationCode: input.verification_code,
        }),
      }, 'registration'))
    },
    async login(input: { identifier: string; password: string; remember_login: boolean }) {
      leaseRevision += 1
      const expectedRevision = leaseRevision
      const authenticated = session(await call(authRoot, '/v1/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          organization,
          user: input.identifier,
          clientVersion: '2.0.18',
          password: input.password,
        }),
      }, 'login'), modelRoot)
      if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
      await save({
        schema_version: 1,
        remember_login: input.remember_login,
        received_at: new Date(now()).toISOString(),
        session: authenticated,
      }, expectedRevision)
    },
    async logout(input: { client_request_id: string }) {
      if (loggingOut !== undefined) return loggingOut
      loggingOut = (async () => {
        const value = current
        let cleanupFailure: unknown
        try {
          await clear()
        } catch (error) {
          cleanupFailure = error
        }
        let result: { remote_revocation: 'revoked'; receipt_id: string } | { remote_revocation: 'unknown' } = {
          remote_revocation: 'unknown',
        }
        try {
          if (value !== undefined) {
            result = {
              remote_revocation: 'revoked',
              ...mutationReceipt(await call(authRoot, '/v1/auth/logout', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  clientId,
                  refreshToken: value.session.refreshToken,
                  clientRequestId: input.client_request_id,
                }),
              }, 'logout'), false),
            }
          }
        } catch {
          // A missing receipt leaves remote completion unknown; explicit logout still invalidates this device.
        }
        if (cleanupFailure !== undefined) throw cleanupFailure
        return result
      })()
      try {
        return await loggingOut
      } finally {
        loggingOut = undefined
      }
    },
    async changePassword(input: { current_password: string; new_password: string; client_request_id: string }) {
      const value = await active()
      if (value === undefined) throw new Error('e-Mate login is required')
      const receipt = mutationReceipt(await call(authRoot, '/v1/auth/password/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          refreshToken: value.session.refreshToken,
          clientRequestId: input.client_request_id,
          currentPassword: input.current_password,
          newPassword: input.new_password,
        }),
      }, 'password change'), true)
      await clear()
      return receipt
    },
    async acceptAgreements() {
      const value = await active()
      if (value === undefined) throw new Error('e-Mate login is required')
      const expectedRevision = leaseRevision
      const status = consentStatus(await modelCall(value, '/v1/consents/current', { method: 'GET' }, 'consent status'))
      if (expectedRevision !== leaseRevision) throw new Error('e-Mate enterprise session mutation was superseded')
      if (status.policy.contentHash !== agreementBundleSha256) {
        throw new Error('e-Mate enterprise agreement policy does not match this installed version')
      }
      const acceptance = consentAcceptance(await modelCall(value, '/v1/consents/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...status.policy,
          termsAccepted: true,
          policyRead: true,
          lawfulUseConfirmed: true,
          clientVersion: '2.0.18',
          locale: 'zh-CN',
        }),
      }, 'consent acceptance'), status.policy)
      await save({ ...value, consent: { schemaVersion: 1, policy: status.policy, required: false, acceptance } }, expectedRevision)
    },
    async modelRuntimePolicy() {
      return modelRuntimePolicy()
    },
    async modelPolicy() {
      return (await modelRuntimePolicy()).policy
    },
    async usage(timezone: string) {
      const value = await authorized('/v1/usage/current', { method: 'GET' }, 'account usage')
      if (!isRecord(value)
        || !exact(value, ['schemaVersion', 'totalTokens', 'weekStartedAt', 'calculatedAt'])
        || value.schemaVersion !== 1
        || !Number.isSafeInteger(value.totalTokens)
        || Number(value.totalTokens) < 0) {
        throw new Error('e-Mate enterprise account usage is invalid')
      }
      return {
        schema_version: 1,
        scope: 'account',
        timezone,
        week: { total_tokens: Number(value.totalTokens) },
        week_started_at: timestamp(value.weekStartedAt, 'usage week start'),
        calculated_at: timestamp(value.calculatedAt, 'usage calculation time'),
      }
    },
    async usageActivity(query) {
      const search = new URLSearchParams([
        ['timezone', query.timezone],
        ['start_date', query.start_date],
        ['end_date', query.end_date],
      ])
      return usageActivityProjection(
        await authorized(`/v1/usage/activity?${search}`, { method: 'GET' }, 'usage activity'),
        query,
      )
    },
    async auditUpload(records: unknown[]) {
      return authorized('/v1/audit/usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: 1, records }),
      }, 'audit usage')
    },
    async taskAuditUpload(records: unknown[]) {
      return authorized('/v1/audit/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: 1, records }),
      }, 'task audit')
    },
    async authenticatedRequest(url: URL | string, init: RequestInit = {}) {
      const target = new URL(url)
      const modelTarget = target.search === '' && target.toString().startsWith(`${modelRoot}/`)
      const skillHubTarget = SKILL_HUB_ROOTS.some(root => target.origin === root.origin
        && (target.pathname === root.pathname || target.pathname.startsWith(`${root.pathname}/`)))
      const knowledgeTarget = target.origin === KNOWLEDGE_ROOT.origin
        && (target.pathname === KNOWLEDGE_ROOT.pathname || target.pathname.startsWith(`${KNOWLEDGE_ROOT.pathname}/`))
      if (target.username || target.password || target.hash || (!modelTarget && !skillHubTarget && !knowledgeTarget)) {
        throw new Error('e-Mate authenticated request target is outside the managed enterprise root')
      }
      let value: StoredSession | undefined
      try {
        value = await (knowledgeTarget ? activeAccessSession() : active())
      } catch (error) {
        // active() already clears revoked credentials. Preserve that terminal outcome
        // as authentication, rather than making downstream consumers guess from text.
        if (error instanceof RefreshFailure && TERMINAL_REFRESH_FAILURE_CODES.has(error.code)) {
          throw new EnterpriseAuthenticationRequired()
        }
        throw error
      }
      if (value === undefined) throw new EnterpriseAuthenticationRequired()
      const revision = leaseRevision
      const headers = new Headers(init.headers)
      if (headers.has('authorization')) throw new Error('e-Mate authenticated request cannot override authorization')
      headers.set('authorization', `Bearer ${knowledgeTarget ? value.session.accessToken : value.session.modelGateway.sessionToken}`)
      const response = await request(target, { ...init, redirect: 'error', headers })
      if (knowledgeTarget && revision !== leaseRevision) {
        await response.body?.cancel().catch(() => {})
        throw new Error('e-Mate enterprise session mutation was superseded')
      }
      return response
    },
    async dispose() {
      if (current?.remember_login === false) await clear()
    },
  }

  return provider
}

export const enterpriseAgreementVersions = Object.freeze({
  agreement: agreementDocuments.find(document => document.id === 'e-mate-user-agreement')?.version,
  disclaimer: agreementDocuments.find(document => document.id === 'yixin-enterprise-disclaimer')?.version,
})
