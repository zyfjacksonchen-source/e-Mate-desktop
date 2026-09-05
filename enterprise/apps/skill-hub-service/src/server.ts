import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { serveRequest, MAX_BODY_BYTES } from '../../skill-hub-worker/src/core.ts'
import { beginHubTransaction, PostgresDatabase, schemaName } from './postgres.ts'
import { FilePackages, readRegular, sha256 } from './packages.ts'

export type ServiceOptions = {
  pool: Pool
  schema: string
  volume: string
  authorKey: string
  validationUrl: string
  minimumFreeBytes?: number
  fetchImplementation?: typeof fetch
}
export const unavailable = () => Response.json({ detail: 'Skill Hub service failed', error: { code: 'network', message: 'Skill Hub service failed' } }, { status: 503 })

export function createService(options: ServiceOptions) {
  schemaName(options.schema)
  if (!isAbsolute(options.volume) || options.authorKey.length < 32) throw new Error('Invalid Skill Hub service configuration')
  const validation = new URL(options.validationUrl)
  const internal = validation.protocol === 'http:' && ['model-gateway', 'localhost', '127.0.0.1', '[::1]'].includes(validation.hostname)
  if (validation.username || validation.password || validation.search || validation.hash ||
      (validation.protocol !== 'https:' && !internal) ||
      (internal ? validation.pathname !== '/v1/consents/current' :
        !validation.pathname.endsWith('/e-mate/model-api/v1/consents/current'))) throw new Error('Invalid model validation endpoint')
  let active = 0
  let probing = false
  let closing = false
  return {
    close() { closing = true },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === '/livez' && !url.search && request.method === 'GET') return Response.json({ schema_version: 1, alive: true })
      const probe = request.method === 'GET' && !url.search && ['/healthz', '/readyz'].includes(url.pathname)
      if (closing || active >= 4) return unavailable()
      if (probe) {
        if (probing || (options.pool.idleCount === 0 && options.pool.totalCount >= (options.pool.options.max ?? 10))) return unavailable()
        probing = true
      } else active++
      let client: Awaited<ReturnType<typeof beginHubTransaction>> | undefined
      try {
        const write = !['GET', 'HEAD'].includes(request.method)
        client = await beginHubTransaction(options.pool, options.schema, write, probe)
        const control = (await client.query<{ author_key_sha256: string; generation: string }>('SELECT author_key_sha256,generation FROM skill_hub_control WHERE singleton')).rows[0]
        if (!control || control.author_key_sha256 !== sha256(options.authorKey) || !/^[a-f0-9]{32}$/.test(control.generation)) throw new Error('Skill Hub migration is not activated')
        const packages = new FilePackages(join(options.volume, 'generations', control.generation), options.minimumFreeBytes)
        await packages.ready()
        if (probe) {
          await client.query('COMMIT')
          return Response.json({ schema_version: 1, ready: true }, { headers: { 'cache-control': 'no-store' } })
        }
        const path = new URL(request.url)
        if (path.pathname === '/readyz') path.pathname = '/healthz'
        const routed = path.href === request.url ? request : new Request(path, request)
        const result = await serveRequest(routed, { DB: new PostgresDatabase(client), PACKAGES: packages,
          AUTHOR_KEY: options.authorKey, MODEL_SESSION_VALIDATION_URL: options.validationUrl, INTERNAL_VALIDATION: true }, options.fetchImplementation)
        if (request.signal.aborted) throw new Error('Skill Hub request was cancelled')
        await client.query(result.status >= 400 ? 'ROLLBACK' : 'COMMIT')
        return result
      } catch {
        if (client) await client.query('ROLLBACK').catch(() => {})
        console.error(JSON.stringify({ event: 'skill_hub_request_failed', method: request.method,
          cancelled: request.signal.aborted }))
        return unavailable()
      } finally { client?.release(); if (probe) probing = false; else active-- }
    },
  }
}

async function secret(env: NodeJS.ProcessEnv, name: string): Promise<string> {
  if ((env[name] === undefined) === (env[`${name}_FILE`] === undefined)) throw new Error('Use exactly one secret source')
  return env[name] ?? (await readRegular(env[`${name}_FILE`]!, 8192)).toString('utf8')
}

export async function environment(env: NodeJS.ProcessEnv) {
  const databaseUrl = (await secret(env, 'SKILL_HUB_DATABASE_URL')).trim()
  const database = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('Invalid Skill Hub database')
  const authorKey = await secret(env, 'SKILL_HUB_AUTHOR_KEY') // Exact bytes: never trim an existing HMAC key.
  const schema = schemaName(env.SKILL_HUB_SCHEMA ?? 'skill_hub')
  const volume = env.SKILL_HUB_VOLUME ?? '/var/lib/e-mate-skill-hub'
  const validationUrl = env.SKILL_HUB_MODEL_VALIDATION_URL
  if (!validationUrl) throw new Error('A fixed real Model Gateway validation URL is required')
  const port = Number(env.SKILL_HUB_PORT ?? 8788)
  const host = env.SKILL_HUB_HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Skill Hub listen address')
  return { databaseUrl, authorKey, schema, volume, validationUrl, port, host }
}

class BodyTooLarge extends Error {}
const tooLarge = () => ({ detail: 'Skill Hub request is too large', error: { code: 'bad-request', message: 'Skill Hub request is too large' } })

async function body(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(bytes)
  }
  return new Uint8Array(Buffer.concat(chunks, total))
}

export async function start(env: NodeJS.ProcessEnv = process.env) {
  const config = await environment(env)
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 })
  pool.on('error', () => { console.error(JSON.stringify({ event: 'skill_hub_database_connection_failed' })) })
  const service = createService({ ...config, pool })
  let inFlight = 0
  let readinessInFlight = false
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/livez') {
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      outgoing.end(JSON.stringify({ schema_version: 1, alive: true }))
      return
    }
    const probe = incoming.method === 'GET' && ['/readyz', '/healthz'].includes(incoming.url ?? '')
    if (inFlight >= 4 || (probe && readinessInFlight)) {
      outgoing.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
      outgoing.end(JSON.stringify({ detail: 'Skill Hub service failed', error: { code: 'network', message: 'Skill Hub service failed' } }))
      return
    }
    if (probe) readinessInFlight = true
    else inFlight++
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
    incoming.once('aborted', () => controller.abort())
    outgoing.once('close', () => controller.abort())
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) throw new Error('Invalid request path')
      if (Number(incoming.headers['content-length']) > MAX_BODY_BYTES) {
        outgoing.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
        outgoing.end(JSON.stringify(tooLarge()))
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const payload = await body(incoming)
      const request = new Request(`http://skill-hub.internal${incoming.url}`, { method: incoming.method, headers,
        ...(payload ? { body: new Uint8Array(payload) } : {}), signal })
      const response = await service.fetch(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            if (!outgoing.write(next.value)) await once(outgoing, 'drain', { signal })
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      }
      outgoing.end()
    } catch (error) {
      if (outgoing.destroyed) return
      if (!outgoing.headersSent) outgoing.writeHead(error instanceof BodyTooLarge ? 413 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
      outgoing.end(JSON.stringify(error instanceof BodyTooLarge ? tooLarge() : { detail: 'Skill Hub service failed', error: { code: 'network', message: 'Skill Hub service failed' } }))
    } finally { if (probe) readinessInFlight = false; else inFlight-- }
  })
  server.requestTimeout = 45_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100
  server.maxConnections = 64
  server.listen(config.port, config.host)
  await once(server, 'listening')
  let stopping: Promise<void> | undefined
  const shutdown = () => stopping ??= (async () => {
    service.close()
    const deadline = setTimeout(() => server.closeAllConnections(), 45_000)
    deadline.unref()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
    clearTimeout(deadline)
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
  })()
  const onSignal = () => { void shutdown().catch(() => { process.exitCode = 1 }) }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  return { server, shutdown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { console.error(JSON.stringify({ event: 'skill_hub_start_failed' })); process.exitCode = 1 })
}
