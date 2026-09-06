import { createHash } from 'node:crypto'

export const name = 'emate-share'
export const inject = ['apiProxy', 'connection', 'credentials']
export const SHARE_CHANNEL = '/emate.share'

const SHARE_ID = /^[A-Za-z0-9_-]{32}$/u
const MODEL_SESSION_REF = 'E_MATE_MODEL_SESSION_TOKEN'
const JSON_MAX_BYTES = 16 * 1024
const REQUEST_TIMEOUT_MS = 5 * 60 * 1_000

type ShareOperation = 'status' | 'create' | 'list' | 'revoke'
type ShareStage = 'preparing' | 'uploading' | 'created' | 'listing' | 'revoking' | 'failed'
type ShareFailureAt = Exclude<ShareStage, 'created' | 'failed'>
type ShareErrorCode =
  | 'bad-request'
  | 'authentication-required'
  | 'archive-unavailable'
  | 'archive-too-large'
  | 'owner-required'
  | 'request-timeout'
  | 'service-unavailable'
  | 'service-rejected'
  | 'invalid-response'

const ERROR_MESSAGES: Record<ShareErrorCode, string> = {
  'bad-request': '在线分享请求无效，请刷新后重试。',
  'authentication-required': '登录状态已失效，请重新登录后再试。',
  'archive-unavailable': '无法准备当前任务归档，请先改用本地导出检查任务数据。',
  'archive-too-large': '任务归档超过在线分享大小限制，请改用本地导出。',
  'owner-required': '当前账号或任务无权管理这个公开链接。',
  'request-timeout': '在线分享请求超时，请稍后重试。',
  'service-unavailable': '在线分享服务暂时不可用，请稍后重试。',
  'service-rejected': '在线分享服务拒绝了请求，请稍后重试。',
  'invalid-response': '分享服务返回了无效响应。',
}

type ShareConfig = {
  rootUrl?: string
  fetchImplementation?: typeof fetch
}

class ShareRequestError extends Error {
  constructor(readonly code: ShareErrorCode, readonly failedAt: ShareFailureAt) {
    super(ERROR_MESSAGES[code])
  }
}

function failed(operation: ShareOperation, error: unknown, fallbackAt: ShareFailureAt) {
  const timeout = error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)
  const failure = error instanceof ShareRequestError
    ? error
    : new ShareRequestError(timeout ? 'request-timeout' : 'service-unavailable', fallbackAt)
  return {
    ok: false,
    error: {
      schema_version: 1,
      stage: 'failed' as const,
      operation,
      failed_at: failure.failedAt,
      code: failure.code,
      message: failure.message,
    },
  }
}

function badRequest(operation: ShareOperation) {
  return failed(operation, new ShareRequestError('bad-request', operation === 'revoke' ? 'revoking'
    : operation === 'list' ? 'listing' : 'preparing'), 'preparing')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).toSorted()
  const expected = [...keys].toSorted()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function shareRoot(value: unknown): string {
  if (typeof value !== 'string') throw new Error('e-Mate public share service is not configured')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || !['/', '/e-mate/share', '/e-mate/share/'].includes(url.pathname) || url.search !== '' || url.hash !== '') {
    throw new Error('e-Mate public share service must be a fixed HTTPS origin')
  }
  return url.origin + (url.pathname === '/' ? '' : '/e-mate/share')
}

async function readJson(response: Response, failedAt: ShareFailureAt): Promise<unknown> {
  // Fetch decodes gzip/br but preserves the wire Content-Length header.
  const encoding = response.headers.get('content-encoding')
  const declared = encoding === null || encoding === 'identity' ? response.headers.get('content-length') : null
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > JSON_MAX_BYTES)) {
    throw new ShareRequestError('invalid-response', failedAt)
  }
  if (response.body === null) throw new ShareRequestError('invalid-response', failedAt)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!(value instanceof Uint8Array) || (length += value.byteLength) > JSON_MAX_BYTES) {
      await reader.cancel()
      throw new ShareRequestError('invalid-response', failedAt)
    }
    chunks.push(value)
  }
  if (declared !== null && length !== Number(declared)) throw new ShareRequestError('invalid-response', failedAt)
  try {
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ShareRequestError('invalid-response', failedAt)
  }
}

function providerFailure(response: Response, failedAt: ShareFailureAt): never {
  if (response.status === 401) throw new ShareRequestError('authentication-required', failedAt)
  if (response.status === 403) throw new ShareRequestError('owner-required', failedAt)
  if (response.status === 413) throw new ShareRequestError('archive-too-large', failedAt)
  throw new ShareRequestError(response.status >= 500 ? 'service-unavailable' : 'service-rejected', failedAt)
}

type ShareValue = { share_id: string; public_url: string; expires_at: string }

function parseShareValue(value: unknown, root: string, failedAt: ShareFailureAt, allowExpired = false): ShareValue {
  if (!isRecord(value) || !exact(value, ['id', 'public_url', 'expires_at'])
    || typeof value.id !== 'string' || !SHARE_ID.test(value.id)
    || typeof value.public_url !== 'string' || typeof value.expires_at !== 'string') {
    throw new ShareRequestError('invalid-response', failedAt)
  }
  const publicUrl = new URL(value.public_url)
  if (publicUrl.toString() !== `${root}/s/${value.id}`
    || publicUrl.username !== '' || publicUrl.password !== '' || publicUrl.search !== '' || publicUrl.hash !== ''
    || !Number.isFinite(Date.parse(value.expires_at)) || (!allowExpired && Date.parse(value.expires_at) <= Date.now())) {
    throw new ShareRequestError('invalid-response', failedAt)
  }
  return {
    share_id: value.id,
    public_url: publicUrl.toString(),
    expires_at: value.expires_at,
  }
}

function parseShare(value: unknown, root: string): { schema_version: 1 } & ShareValue {
  if (!isRecord(value) || !exact(value, ['schema_version', 'share']) || value.schema_version !== 1) {
    throw new ShareRequestError('invalid-response', 'uploading')
  }
  return { schema_version: 1, ...parseShareValue(value.share, root, 'uploading') }
}

function parseShares(value: unknown, root: string): { schema_version: 1; shares: ShareValue[] } {
  if (!isRecord(value) || !exact(value, ['schema_version', 'shares']) || value.schema_version !== 1
    || !Array.isArray(value.shares) || value.shares.length > 50) {
    throw new ShareRequestError('invalid-response', 'listing')
  }
  const shares = value.shares.map(share => parseShareValue(share, root, 'listing', true))
  if (new Set(shares.map(share => share.share_id)).size !== shares.length) {
    throw new ShareRequestError('invalid-response', 'listing')
  }
  return { schema_version: 1, shares: shares.filter(share => Date.parse(share.expires_at) > Date.now()) }
}

function sessionSha256(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/\p{Cc}/u.test(value)
    ? createHash('sha256').update(value).digest('hex')
    : undefined
}

async function modelToken(ctx: any, failedAt: ShareFailureAt): Promise<string> {
  let credential
  try {
    credential = await ctx.credentials.resolve(MODEL_SESSION_REF)
  } catch {
    throw new ShareRequestError('authentication-required', failedAt)
  }
  if (typeof credential?.value !== 'string' || credential.value.length < 32) {
    throw new ShareRequestError('authentication-required', failedAt)
  }
  return credential.value
}

/**
 * Publish the pinned DSH Session ZIP through one authenticated share provider.
 * The ZIP remains the only session/attachment projection; this adapter adds no
 * second event store, transcript renderer, or client-side upload path.
 */
export function apply(ctx: any, config: ShareConfig = {}): void {
  const root = shareRoot(config.rootUrl)
  const request = config.fetchImplementation ?? fetch
  // Coalesce overlapping modal/reconnect calls only while the exact account
  // and session upload is in flight; this is not a retry or persistent cache.
  const creating = new Map<string, Promise<unknown>>()
  ctx.effect(() => ctx.connection.rpc.handle(
    SHARE_CHANNEL,
    async (endpoint: string, payload: unknown) => {
      if (!['status', 'create', 'list', 'revoke'].includes(endpoint)) return badRequest('status')
      const operation = endpoint as ShareOperation
      if (!isRecord(payload)) return badRequest(operation)

      if (endpoint === 'status') {
        if (!exact(payload, [])) return badRequest('status')
        try {
          const response = await request(`${root}/v2/healthz`, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          })
          const value = response.ok ? await readJson(response, 'preparing') : undefined
          const ready = isRecord(value) && exact(value, ['schema_version', 'service', 'version', 'ready'])
            && value.schema_version === 1 && value.service === 'emate-share'
            && value.version === 1 && value.ready === true
          return {
            ok: true,
            value: ready
              ? { schema_version: 1, stage: 'preparing', service_version: 1, ready: true }
              : { schema_version: 1, stage: 'preparing', service_version: 1, ready: false, blocker: 'public-share-service-unavailable' },
          }
        } catch {
          return {
            ok: true,
            value: { schema_version: 1, stage: 'preparing', service_version: 1, ready: false, blocker: 'public-share-service-unavailable' },
          }
        }
      }

      if (endpoint === 'create') {
        const sessionHash = exact(payload, ['session_id']) ? sessionSha256(payload.session_id) : undefined
        if (sessionHash === undefined) return badRequest('create')
        try {
          const token = await modelToken(ctx, 'preparing')
          const key = createHash('sha256').update(token).update('\0').update(sessionHash).digest('hex')
          const active = creating.get(key)
          if (active !== undefined) return await active
          const upload = (async () => {
            const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            let archive
            try {
              archive = await ctx.apiProxy.downloads.sessionLog({
                sessionId: payload.session_id as string,
                includeDescendants: true,
              }, signal)
            } catch (error) {
              if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) throw error
              throw new ShareRequestError('archive-unavailable', 'preparing')
            }
            if (!archive.ok || archive.body === null
              || archive.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/zip') {
              throw new ShareRequestError('archive-unavailable', 'preparing')
            }
            const response = await request(`${root}/v1/shares`, {
              method: 'POST',
              redirect: 'error',
              signal,
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/zip',
                'x-emate-session-sha256': sessionHash,
              },
              body: archive.body,
              duplex: 'half',
            } as RequestInit & { duplex: 'half' })
            if (!response.ok) providerFailure(response, 'uploading')
            return { ok: true, value: { stage: 'created' as const, ...parseShare(await readJson(response, 'uploading'), root) } }
          })()
          creating.set(key, upload)
          try { return await upload } finally { creating.delete(key) }
        } catch (error) {
          return failed('create', error, 'uploading')
        }
      }

      if (endpoint === 'list') {
        const sessionHash = exact(payload, ['session_id']) ? sessionSha256(payload.session_id) : undefined
        if (sessionHash === undefined) return badRequest('list')
        try {
          const response = await request(`${root}/v1/shares?session_sha256=${sessionHash}`, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
            headers: { authorization: `Bearer ${await modelToken(ctx, 'listing')}` },
          })
          if (!response.ok) providerFailure(response, 'listing')
          return { ok: true, value: { stage: 'listing' as const, ...parseShares(await readJson(response, 'listing'), root) } }
        } catch (error) {
          return failed('list', error, 'listing')
        }
      }

      if (endpoint === 'revoke') {
        const sessionHash = exact(payload, ['share_id', 'session_id']) ? sessionSha256(payload.session_id) : undefined
        if (sessionHash === undefined || typeof payload.share_id !== 'string' || !SHARE_ID.test(payload.share_id)) {
          return badRequest('revoke')
        }
        try {
          const response = await request(`${root}/v2/shares/${payload.share_id}`, {
            method: 'DELETE',
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
            headers: {
              authorization: `Bearer ${await modelToken(ctx, 'revoking')}`,
              'x-emate-session-sha256': sessionHash,
            },
          })
          if (!response.ok) providerFailure(response, 'revoking')
          const value = await readJson(response, 'revoking')
          if (!isRecord(value) || !exact(value, ['schema_version', 'revoked'])
            || value.schema_version !== 1 || value.revoked !== true) {
            throw new ShareRequestError('invalid-response', 'revoking')
          }
          return { ok: true, value: { schema_version: 1, stage: 'revoking' as const, revoked: true } }
        } catch (error) {
          return failed('revoke', error, 'revoking')
        }
      }

      return badRequest('status')
    },
    { authority: 'loopback' },
  ), 'emate.share: native Session ZIP public-share adapter')
}
