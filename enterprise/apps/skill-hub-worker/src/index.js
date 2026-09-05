import core, { BASE_PATH, MAX_BODY_BYTES } from './core.ts'
export { handleRequest, inspectSkillArchive, versionSort } from './core.ts'

// A forward failure never falls back to D1/R2 or writes both stores.
export default {
  async fetch(request, env) {
    if (env.SKILL_HUB_FORWARD_ENABLED === undefined || env.SKILL_HUB_FORWARD_ENABLED === 'false') {
      if (env.SKILL_HUB_READ_ONLY === 'true' && !['GET', 'HEAD'].includes(request.method)) {
        return Response.json({ detail: 'Skill Hub migration is in progress', error: { code: 'network', message: 'Skill Hub migration is in progress' } }, { status: 503 })
      }
      return core.fetch(request, env)
    }
    try {
      if (env.SKILL_HUB_FORWARD_ENABLED !== 'true') throw new Error('Invalid forwarder activation')
      const target = new URL(env.SKILL_HUB_FORWARD_ORIGIN)
      const incoming = new URL(request.url)
      if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/'
        || target.search || target.hash || target.origin === incoming.origin
        || (!incoming.pathname.startsWith(`${BASE_PATH}/`) && incoming.pathname !== BASE_PATH && incoming.pathname !== '/healthz')) {
        throw new Error('Invalid fixed forwarder')
      }
      if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return Response.json({ detail: 'Skill Hub request is too large' }, { status: 413 })
      const headers = new Headers(request.headers)
      headers.delete('host')
      headers.delete('cookie')
      const response = await fetch(new Request(`${target.origin}${incoming.pathname}${incoming.search}`, {
        method: request.method, headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(45_000),
        ...(request.body ? { duplex: 'half' } : {}),
      }))
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Fixed forwarder cannot redirect') }
      return response
    } catch {
      return Response.json({ detail: 'Skill Hub service failed', error: { code: 'network', message: 'Skill Hub service failed' } }, { status: 503 })
    }
  },
}
