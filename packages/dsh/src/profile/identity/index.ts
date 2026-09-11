import {
  agreementBundleSha256,
  describeAgreements,
  requiredAcknowledgements,
} from './agreements.js'
import {
  createEnterpriseIdentityProvider,
  IdentityServiceUnavailable,
  loginRejectionMessage,
  registrationRejectionMessage,
} from './enterprise-provider.js'
export { createEnterpriseIdentityProvider, MODEL_SESSION_REF } from './enterprise-provider.js'

export const inject = [
  'webServer','connection', 'credentials', 'timer']
export const IDENTITY_CHANNEL = '/emate.identity'
export const ENTERPRISE_KEEP_ALIVE_MS = 30_000

const badRequest = message => ({
  ok: false,
  error: { code: 'bad-request', message, details: { issues: [] } },
})

const internalFailure = message => ({
  ok: false,
  error: { code: 'internal', message, details: {} },
})

const usageUnavailable = () => ({
  ok: false,
  error: {
    code: 'unavailable',
    message: 'Token 使用数据暂时不可用，请稍后重试。',
    details: { reason: 'usage-service-unavailable' },
  },
})

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u
const VERIFICATION_CODE = /^[A-Za-z0-9]{4,12}$/u
const ACTIVITY_DATE = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u
const USAGE_DECIMAL = /^(0|[1-9][0-9]{0,127})$/u
const DAY_MS = 86_400_000

function validRealName(value) {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length >= 2
    && normalized.length <= 128
    && ![...normalized].some(character => character.codePointAt(0) < 32)
}

function validChallenge(value) {
  if (!isRecord(value)
    || value.schema_version !== 1
    || !validRequestId(value.challenge_id)
    || typeof value.image_data_url !== 'string'
    || typeof value.expires_at !== 'string'
    || !Number.isFinite(Date.parse(value.expires_at))
    || Date.parse(value.expires_at) <= Date.now()) {
    return false
  }
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value.image_data_url)
  if (match === null || match[1].length > 350_000) return false
  const image = Buffer.from(match[1], 'base64')
  return image.byteLength > 0
    && image.byteLength <= 256 * 1024
    && image.toString('base64') === match[1]
}

function validRegistration(value) {
  return isRecord(value)
    && value.schema_version === 1
    && validRequestId(value.registration_id)
    && value.status === 'pending_approval'
}

function identityUnavailable(config) {
  const agreements = describeAgreements(config.providerLegalName)
  return {
    schema_version: 1,
    ready: false,
    authenticated: false,
    workspace_unlocked: false,
    blocker: agreements.blocker ?? 'enterprise-identity-provider-not-configured',
    agreements,
  }
}

async function bootstrap(config, includeAccountSubject = false) {
  const agreements = describeAgreements(config.providerLegalName)
  if (!agreements.ready || typeof config.identityProvider?.bootstrap !== 'function') {
    return identityUnavailable(config)
  }
  const value = await config.identityProvider.bootstrap()
  if (!isRecord(value)
    || typeof value.authenticated !== 'boolean'
    || typeof value.workspace_unlocked !== 'boolean'
    || value.workspace_unlocked && !value.authenticated
    || value.authenticated && (value.account_status !== 'active'
      || !Number.isSafeInteger(value.weekly_token_limit)
      || value.weekly_token_limit < 1)) {
    throw new Error('e-Mate enterprise identity bootstrap is invalid')
  }
  return {
    schema_version: 1,
    ready: true,
    authenticated: value.authenticated,
    workspace_unlocked: value.workspace_unlocked,
    display_name: typeof value.display_name === 'string' ? value.display_name : undefined,
    account_status: value.authenticated ? value.account_status : undefined,
    weekly_token_limit: value.authenticated ? value.weekly_token_limit : undefined,
    agreement_exempt: value.agreement_exempt === true ? true : undefined,
    agreement_receipt_id: typeof value.agreement_receipt_id === 'string'
      ? value.agreement_receipt_id
      : undefined,
    ...(includeAccountSubject && typeof value.account_subject === 'string'
      ? { account_subject: value.account_subject }
      : {}),
    agreements,
  }
}

function exactAcknowledgements(value) {
  if (!Array.isArray(value)
    || value.length !== requiredAcknowledgements.length
    || new Set(value).size !== value.length
    || requiredAcknowledgements.some(id => !value.includes(id))) {
    return false
  }
  return value.every(id => typeof id === 'string')
}

function validRequestId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/u.test(value)
}

function accountUsage(value, timezone) {
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.scope !== 'account'
    || value.timezone !== timezone
    || !isRecord(value.week)
    || !Number.isSafeInteger(value.week.total_tokens)
    || value.week.total_tokens < 0
    || typeof value.week_started_at !== 'string'
    || !Number.isFinite(Date.parse(value.week_started_at))
    || typeof value.calculated_at !== 'string'
    || !Number.isFinite(Date.parse(value.calculated_at))) {
    throw new Error('e-Mate enterprise usage projection is invalid')
  }
  return {
    schema_version: 1,
    scope: 'account',
    timezone,
    week: { total_tokens: value.week.total_tokens },
    week_started_at: value.week_started_at,
    calculated_at: value.calculated_at,
  }
}

function activityDateMs(value) {
  if (typeof value !== 'string' || !ACTIVITY_DATE.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number)
  const result = Date.UTC(year, month - 1, day)
  return new Date(result).toISOString().slice(0, 10) === value ? result : undefined
}

function activityQuery(value) {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'end_date,start_date,timezone'
    || typeof value.timezone !== 'string'
    || value.timezone.length < 1
    || value.timezone.length > 64) return undefined
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value.timezone })
  } catch {
    return undefined
  }
  const start = activityDateMs(value.start_date)
  const end = activityDateMs(value.end_date)
  if (start === undefined || end === undefined || end < start || (end - start) / DAY_MS + 1 > 366) return undefined
  return { timezone: value.timezone, start_date: value.start_date, end_date: value.end_date }
}

function accountUsageActivity(value, query) {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== [
      'calculated_at', 'days', 'end_date', 'period_total', 'schema_version', 'start_date', 'timezone',
    ].sort().join(',')
    || value.schema_version !== 1
    || value.timezone !== query.timezone
    || value.start_date !== query.start_date
    || value.end_date !== query.end_date
    || !Array.isArray(value.days)
    || typeof value.period_total !== 'string'
    || !USAGE_DECIMAL.test(value.period_total)
    || typeof value.calculated_at !== 'string'
    || !Number.isFinite(Date.parse(value.calculated_at))) {
    throw new Error('e-Mate enterprise usage activity projection is invalid')
  }
  const start = activityDateMs(query.start_date)
  const end = activityDateMs(query.end_date)
  const expectedDates = []
  for (let current = start; current <= end; current += DAY_MS) {
    expectedDates.push(new Date(current).toISOString().slice(0, 10))
  }
  if (value.days.length !== expectedDates.length) {
    throw new Error('e-Mate enterprise usage activity projection is incomplete')
  }
  const days = value.days.map((day, index) => {
    if (!isRecord(day)
      || Object.keys(day).sort().join(',') !== 'cache_read,cache_write,date,input,output,total'
      || day.date !== expectedDates[index]
      || [day.total, day.input, day.output, day.cache_read, day.cache_write]
        .some(count => typeof count !== 'string' || !USAGE_DECIMAL.test(count))
      || BigInt(day.total) !== BigInt(day.input) + BigInt(day.output) + BigInt(day.cache_read) + BigInt(day.cache_write)) {
      throw new Error('e-Mate enterprise usage activity day is invalid')
    }
    return {
      date: day.date,
      total: day.total,
      input: day.input,
      output: day.output,
      cache_read: day.cache_read,
      cache_write: day.cache_write,
    }
  })
  if (days.reduce((total, day) => total + BigInt(day.total), 0n) !== BigInt(value.period_total)) {
    throw new Error('e-Mate enterprise usage activity total is invalid')
  }
  return {
    schema_version: 1,
    ...query,
    days,
    period_total: value.period_total,
    calculated_at: new Date(Date.parse(value.calculated_at)).toISOString(),
  }
}

function requireReceipt(value, operation) {
  if (!isRecord(value)
    || typeof value.receipt_id !== 'string'
    || value.receipt_id.length < 1
    || (operation === 'password' && value.reauthentication_required !== true)) {
    throw new Error(`e-Mate enterprise ${operation} receipt is invalid`)
  }
  return value.receipt_id
}

function logoutResult(value) {
  if (!isRecord(value)
    || !['revoked', 'unknown'].includes(value.remote_revocation)
    || Object.keys(value).sort().join(',') !== (value.remote_revocation === 'revoked'
      ? 'receipt_id,remote_revocation'
      : 'remote_revocation')
    || (value.remote_revocation === 'revoked'
      ? typeof value.receipt_id !== 'string' || value.receipt_id.length < 1
      : value.receipt_id !== undefined)) {
    throw new Error('e-Mate enterprise logout result is invalid')
  }
  return value.remote_revocation === 'revoked'
    ? { remote_revocation: 'revoked', receipt_id: value.receipt_id }
    : { remote_revocation: 'unknown' }
}

export function apply(ctx, config = {}) {
  if (config.identityProvider === undefined && config.enterprise !== undefined) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('e-Mate enterprise identity requires target credentials')
    const provider = createEnterpriseIdentityProvider({
      credentials,
      enterprise: config.enterprise,
      ...(config.fetchImplementation === undefined ? {} : { fetchImplementation: config.fetchImplementation }),
      ...(config.now === undefined ? {} : { now: config.now }),
    })
    ctx.effect(() => () => provider.dispose(), 'emate.identity: dispose enterprise lease')
    ctx.interval(() => {
      void provider.keepAlive().catch(error => {
        ctx.logger?.warn?.('e-Mate enterprise lease refresh failed; retrying on the next host tick', error)
      })
    }, ENTERPRISE_KEEP_ALIVE_MS)
    config = {
      ...config,
      identityProvider: provider,
      authenticatedRequest: provider.authenticatedRequest,
    }
  }
  ctx.provide('emateIdentity', {
    localAccountPrincipal() {
      return typeof config.identityProvider?.localAccountPrincipal === 'function'
        ? config.identityProvider.localAccountPrincipal()
        : undefined
    },
    localAccountSubject() {
      return typeof config.identityProvider?.localAccountSubject === 'function'
        ? config.identityProvider.localAccountSubject()
        : undefined
    },
    async request(url, init) {
      if (typeof config.authenticatedRequest !== 'function') {
        throw new Error('e-Mate enterprise identity transport is unavailable; sign in after the verified provider policy is installed')
      }
      return config.authenticatedRequest(url, init)
    },
    async state() {
      return bootstrap(config, true)
    },
    async modelPolicy() {
      if (typeof config.identityProvider?.modelPolicy !== 'function') {
        throw new Error('e-Mate enterprise model policy provider is unavailable')
      }
      return config.identityProvider.modelPolicy()
    },
    async modelRuntimePolicy() {
      if (typeof config.identityProvider?.modelRuntimePolicy !== 'function') {
        throw new Error('e-Mate enterprise runtime model policy provider is unavailable')
      }
      return config.identityProvider.modelRuntimePolicy()
    },
    async usage(timezone = 'UTC') {
      if (typeof config.identityProvider?.usage !== 'function') {
        throw new Error('e-Mate enterprise usage projection is unavailable')
      }
      return accountUsage(await config.identityProvider.usage(timezone), timezone)
    },
    async usageActivity(query) {
      const parsed = activityQuery(query)
      if (parsed === undefined || typeof config.identityProvider?.usageActivity !== 'function') {
        throw new Error('e-Mate enterprise usage activity projection is unavailable')
      }
      return accountUsageActivity(await config.identityProvider.usageActivity(parsed), parsed)
    },
    async uploadAudit(records) {
      if (typeof config.identityProvider?.auditUpload !== 'function') {
        throw new Error('e-Mate enterprise audit transport is unavailable')
      }
      return config.identityProvider.auditUpload(records)
    },
    async uploadTaskAudit(records) {
      if (typeof config.identityProvider?.taskAuditUpload !== 'function') {
        throw new Error('e-Mate enterprise task audit transport is unavailable')
      }
      return config.identityProvider.taskAuditUpload(records)
    },
  })
  ctx.effect(() => ctx.connection.rpc.handle(
    IDENTITY_CHANNEL,
    async (endpoint, payload) => {
      try {
      if (!isRecord(payload)) return badRequest('e-Mate identity payload must be an object')
      if (endpoint === 'agreements.describe') {
        if (Object.keys(payload).length !== 0) {
          return badRequest('agreements.describe payload must be an empty object')
        }
        return { ok: true, value: describeAgreements(config.providerLegalName) }
      }
      if (endpoint === 'identity.bootstrap') {
        if (Object.keys(payload).length !== 0) {
          return badRequest('identity.bootstrap payload must be an empty object')
        }
        return { ok: true, value: await bootstrap(config) }
      }
      if (endpoint === 'identity.usage') {
        if (Object.keys(payload).sort().join(',') !== 'timezone'
          || typeof payload.timezone !== 'string'
          || payload.timezone.length < 1
          || payload.timezone.length > 64
          || [...payload.timezone].some(character => character.codePointAt(0) < 33)) {
          return badRequest('identity.usage payload is invalid')
        }
        if (typeof config.identityProvider?.usage !== 'function') {
          throw new Error('e-Mate enterprise usage projection is unavailable')
        }
        return { ok: true, value: accountUsage(await config.identityProvider.usage(payload.timezone), payload.timezone) }
      }
      if (endpoint === 'identity.usage.activity') {
        const query = activityQuery(payload)
        if (query === undefined) return badRequest('identity.usage.activity payload is invalid')
        if (typeof config.identityProvider?.usageActivity !== 'function') {
          throw new Error('e-Mate enterprise usage activity projection is unavailable')
        }
        return {
          ok: true,
          value: accountUsageActivity(await config.identityProvider.usageActivity(query), query),
        }
      }
      if (endpoint === 'verification.issue') {
        if (Object.keys(payload).sort().join(',') !== 'purpose'
          || payload.purpose !== 'registration') {
          return badRequest('verification.issue payload is invalid')
        }
        if (typeof config.identityProvider?.issueRegistrationChallenge !== 'function') {
          throw new Error('e-Mate enterprise registration verification is unavailable')
        }
        const challenge = await config.identityProvider.issueRegistrationChallenge()
        if (!validChallenge(challenge)) {
          throw new Error('e-Mate enterprise registration challenge is invalid')
        }
        return { ok: true, value: challenge }
      }
      if (endpoint === 'session.register') {
        if (Object.keys(payload).sort().join(',') !== 'account,challenge_id,password,real_name,verification_code'
          || typeof payload.account !== 'string'
          || !ACCOUNT.test(payload.account.trim())
          || !validRealName(payload.real_name)
          || typeof payload.password !== 'string'
          || payload.password.length < 10
          || payload.password.length > 256
          || !validRequestId(payload.challenge_id)
          || typeof payload.verification_code !== 'string'
          || !VERIFICATION_CODE.test(payload.verification_code.trim())) {
          return badRequest('session.register payload is invalid')
        }
        if (typeof config.identityProvider?.register !== 'function') {
          throw new Error('e-Mate enterprise registration is unavailable')
        }
        let registration
        try {
          registration = await config.identityProvider.register({
            account: payload.account.trim(),
            real_name: payload.real_name.trim(),
            password: payload.password,
            challenge_id: payload.challenge_id,
            verification_code: payload.verification_code.trim(),
          })
        } catch (error) {
          const message = registrationRejectionMessage(error)
          if (message !== undefined) return badRequest(message)
          throw error
        }
        if (!validRegistration(registration)) {
          throw new Error('e-Mate enterprise registration receipt is invalid')
        }
        return { ok: true, value: registration }
      }
      if (endpoint === 'session.login') {
        if (Object.keys(payload).sort().join(',') !== 'identifier,password,remember_login'
          || typeof payload.identifier !== 'string'
          || payload.identifier.trim().length < 1
          || payload.identifier.length > 256
          || typeof payload.password !== 'string'
          || payload.password.length < 1
          || payload.password.length > 256
          || typeof payload.remember_login !== 'boolean') {
          return badRequest('session.login payload is invalid')
        }
        if (typeof config.identityProvider?.login !== 'function') {
          throw new Error('e-Mate enterprise identity login is unavailable')
        }
        try {
          await config.identityProvider.login({
            identifier: payload.identifier.trim(),
            password: payload.password,
            remember_login: payload.remember_login,
          })
        } catch (error) {
          const message = loginRejectionMessage(error)
          if (message !== undefined) return badRequest(message)
          throw error
        }
        const state = await bootstrap(config)
        if (!state.authenticated) {
          throw new Error('e-Mate login requires administrator approval and a weekly Token allowance')
        }
        return { ok: true, value: state }
      }
      if (endpoint === 'session.logout') {
        if (Object.keys(payload).sort().join(',') !== 'client_request_id,confirmed'
          || payload.confirmed !== true
          || !validRequestId(payload.client_request_id)) {
          return badRequest('session.logout payload is invalid')
        }
        if (typeof config.identityProvider?.logout !== 'function') {
          throw new Error('e-Mate enterprise identity logout is unavailable')
        }
        let outcome
        try {
          outcome = await config.identityProvider.logout({
            client_request_id: payload.client_request_id,
          })
        } catch {
          return internalFailure('当前应用已停止使用此登录；本机凭据清理未确认完成，请勿关闭或重启应用并联系管理员。')
        }
        let result
        try {
          result = logoutResult(outcome)
        } catch {
          return internalFailure('当前应用已停止使用此登录；退出结果未确认完成，请保持应用打开并联系管理员。')
        }
        let state
        try {
          state = await bootstrap(config)
          if (state.authenticated || state.workspace_unlocked) {
            return internalFailure('当前应用已停止使用此登录；退出后的本机状态复核失败，请保持应用打开并联系管理员。')
          }
        } catch {
          return internalFailure('当前应用已停止使用此登录；退出后的本机状态复核失败，请保持应用打开并联系管理员。')
        }
        return {
          ok: true,
          value: { schema_version: 1, ...result, state },
        }
      }
      if (endpoint === 'session.password') {
        if (Object.keys(payload).sort().join(',') !== 'client_request_id,current_password,new_password'
          || !validRequestId(payload.client_request_id)
          || typeof payload.current_password !== 'string'
          || payload.current_password.length < 8
          || payload.current_password.length > 256
          || typeof payload.new_password !== 'string'
          || payload.new_password.length < 10
          || payload.new_password.length > 256) {
          return badRequest('session.password payload is invalid')
        }
        if (typeof config.identityProvider?.changePassword !== 'function') {
          throw new Error('e-Mate enterprise password change is unavailable')
        }
        const receiptId = requireReceipt(await config.identityProvider.changePassword({
          current_password: payload.current_password,
          new_password: payload.new_password,
          client_request_id: payload.client_request_id,
        }), 'password')
        const state = await bootstrap(config)
        if (state.authenticated || state.workspace_unlocked) {
          throw new Error('e-Mate password change did not revoke the active lease')
        }
        return {
          ok: true,
          value: {
            schema_version: 1,
            receipt_id: receiptId,
            reauthentication_required: true,
            state,
          },
        }
      }
      if (endpoint === 'agreements.accept') {
        if (Object.keys(payload).sort().join(',') !== 'acknowledgements,bundle_sha256'
          || payload.bundle_sha256 !== agreementBundleSha256
          || !exactAcknowledgements(payload.acknowledgements)) {
          return badRequest('agreements.accept payload is invalid')
        }
        if (typeof config.identityProvider?.acceptAgreements !== 'function') {
          throw new Error('e-Mate enterprise agreement archive is unavailable')
        }
        await config.identityProvider.acceptAgreements({
          bundle_sha256: agreementBundleSha256,
          acknowledgements: [...requiredAcknowledgements],
        })
        const state = await bootstrap(config)
        if (!state.workspace_unlocked || typeof state.agreement_receipt_id !== 'string') {
          throw new Error('e-Mate enterprise agreement receipt is missing')
        }
        return { ok: true, value: state }
      }
      return badRequest('unknown e-Mate identity endpoint')
      } catch (error) {
        if (error instanceof IdentityServiceUnavailable) {
          ctx.logger?.warn?.(
            `e-Mate enterprise identity ${endpoint} unavailable (${error.reason}${error.status === undefined ? '' : ` ${error.status}`})`,
          )
          return endpoint === 'identity.usage.activity' ? usageUnavailable() : internalFailure(error.message)
        }
        ctx.logger?.warn?.(`e-Mate enterprise identity ${endpoint} failed (unexpected)`)
        return internalFailure('企业身份服务暂时不可用，请稍后重试。')
      }
    },
    { authority: 'loopback' },
  ), 'emate.identity: target-native RPC channel')
}
