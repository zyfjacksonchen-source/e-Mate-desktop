import { createServer, type Server } from 'node:http'

export interface CallbackIssuer { issuer?: string; required?: boolean }

export function parseOAuthCallback(value: string, expectedPath: string, state: string, binding: CallbackIssuer = {}): { code?: string; error?: string } {
  const url = new URL(value, 'http://127.0.0.1')
  const allowed = new Set(['code', 'state', 'error', 'error_description', 'iss'])
  if (!value.startsWith('/') || value.startsWith('//') || url.hash !== ''
    || url.pathname !== expectedPath
    || [...url.searchParams.keys()].some(key => !allowed.has(key))
    || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.get('state') !== state) {
    throw new Error('Invalid OAuth callback')
  }
  const issuer = url.searchParams.get('iss')
  if ((binding.required && issuer === null)
    || (issuer !== null && (!binding.issuer || issuer !== binding.issuer))) throw new Error('Invalid OAuth callback')
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  if (code !== null && code !== '' && code.length <= 4096 && error === null) return { code }
  if (error !== null && error !== '' && error.length <= 4096 && code === null) return { error }
  throw new Error('Invalid OAuth callback')
}

interface OAuthCallbackHandle {
  redirectUrl: string
  result: Promise<string>
  bindIssuer(issuer: string | undefined, required: boolean): void
  close(): Promise<void>
}

export async function startOAuthCallback(redirectUrl: string, state: string, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<OAuthCallbackHandle> {
  if (signal?.aborted) throw new Error('外部服务授权已取消。')
  const redirect = new URL(redirectUrl)
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('Invalid OAuth redirect')
  const path = redirect.pathname
  let binding: CallbackIssuer | undefined
  let resolveResult!: (code: string) => void
  let rejectResult!: (error: Error) => void
  let settled = false
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // Discovery/browser launch may still be pending when cancellation rejects this promise.
  void result.catch(() => {})
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: string) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end(body)
    }
    if (request.method !== 'GET' || request.socket.remoteAddress !== '127.0.0.1') {
      send(404, 'Not found')
      return
    }
    if (settled) { send(410, 'OAuth callback expired'); return }
    if (!binding) { send(400, 'Invalid OAuth callback'); return }
    let callback: { code?: string; error?: string }
    try { callback = parseOAuthCallback(request.url ?? '/', path, state, binding) } catch {
      send(400, 'Invalid OAuth callback')
      return
    }
    if (callback.code !== undefined) {
      send(200, '<h1>已收到授权回调</h1><p>正在验证连接，请返回 e-Mate 查看结果。</p>')
      if (!settled) {
        settled = true
        resolveResult(callback.code)
      }
      return
    }
    send(400, '<h1>授权未完成</h1><p>请返回 e-Mate 后重试。</p>')
    if (callback.error !== undefined && !settled) {
      settled = true
      rejectResult(new Error('用户未完成外部服务授权。'))
    }
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(Number(redirect.port || 80), '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  }).catch((error) => {
    server.close()
    throw new Error(`无法启动 OAuth 本机回调端口 ${redirect.port}。请关闭其他 e-Mate 实例后重试。`, { cause: error })
  })
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true
      rejectResult(new Error('外部服务授权已超时。'))
    }
  }, timeoutMs)
  timeout.unref()
  const onAbort = () => {
    if (!settled) {
      settled = true
      rejectResult(new Error('外部服务授权已取消。'))
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const address = server.address()
  if (address && typeof address !== 'string') redirect.port = String(address.port)
  return {
    redirectUrl: redirect.href,
    bindIssuer: (issuer, required) => {
      if (settled || binding) throw new Error('OAuth callback expired')
      if (required && !issuer) throw new Error('OAuth issuer metadata missing')
      if (issuer) {
        const url = new URL(issuer)
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Invalid OAuth issuer')
      }
      binding = { issuer, required }
    },
    result,
    close: async () => {
      if (!settled) { settled = true; rejectResult(new Error('外部服务授权已取消。')) }
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (server.listening) await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
