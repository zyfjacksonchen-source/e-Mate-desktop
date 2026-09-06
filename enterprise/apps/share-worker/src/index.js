import { handleRequest } from './core.ts'
export { handleRequest } from './core.ts'

const ENTERPRISE_BASE = 'https://mvdcm.ecoremedia.net/e-mate/share'

export async function forwardRequest(request, env, fetchImplementation = fetch) {
  if (env.SHARE_SERVICE_BASE !== ENTERPRISE_BASE) throw new Error('Invalid fixed share service')
  const original = new URL(request.url)
  const target = new URL(`${ENTERPRISE_BASE}${original.pathname}${original.search}`)
  const response = await fetchImplementation(new Request(target, request), { redirect: 'manual' })
  // Old Desktop clients bind URLs to the old origin. Preserve that alias while
  // all bytes, metadata, authentication and mutations have a single new owner.
  if (response.ok && original.pathname === '/v1/shares' && ['GET', 'POST'].includes(request.method)) {
    const value = await response.json()
    const legacy = new URL(env.PUBLIC_ORIGIN).origin
    for (const share of value.shares ?? [value.share]) {
      if (!share || !/^[A-Za-z0-9_-]{32}$/u.test(share.id)) throw new Error('Invalid share response')
      share.public_url = `${legacy}/s/${share.id}`
    }
    return Response.json(value, { status: response.status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  return response
}

export default {
  async fetch(request, env) {
    try {
      return env.SHARE_SERVICE_BASE
        ? await forwardRequest(request, env)
        : await handleRequest(request, env)
    } catch {
      console.error(JSON.stringify({ event: 'share_request_failed', method: request.method }))
      return Response.json({ schema_version: 1, error: { code: 'INTERNAL_ERROR' } },
        { status: 500, headers: { 'cache-control': 'no-store' } })
    }
  },
}
