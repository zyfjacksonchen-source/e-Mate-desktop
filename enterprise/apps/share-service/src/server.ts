import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { handleRequest } from '../../share-worker/src/core.ts'
import { ArchiveFiles, MAX_UPLOAD_BYTES } from './files.ts'
import { ShareStore } from './store.ts'

export const PUBLIC_BASE = 'https://mvdcm.ecoremedia.net/e-mate/share'
const failure = (status = 503, code = 'SERVICE_UNAVAILABLE') => Response.json({ schema_version: 1, error: { code } },
  { status, headers: { 'cache-control': 'no-store' } })

export function createService(options: { pool: Pool; volume: string; validationUrl: string; fetchImplementation?: typeof fetch; maxUploadBytes?: number }) {
  const files = new ArchiveFiles(options.volume, options.maxUploadBytes)
  const env = { PUBLIC_ORIGIN: PUBLIC_BASE, MODEL_SESSION_VALIDATION_URL: options.validationUrl, INTERNAL_VALIDATION: true,
    SHARE_TTL_SECONDS: '604800', MAX_UPLOAD_BYTES: String(files.limit) }
  let closing = false
  return {
    files,
    close() { closing = true },
    async fetch(request: Request): Promise<Response> {
      if (closing) return failure()
      try {
        const state = await options.pool.query('SELECT manifest_sha256 FROM emate_share.service_state WHERE singleton=true')
        if (state.rowCount !== 1) return failure(503, 'SHARE_DATA_NOT_READY')
        const store = new ShareStore(options.pool, files, request.signal)
        if (request.method === 'GET' && ['/healthz', '/readyz', '/v2/healthz', '/e-mate/share/v2/healthz', '/e-mate/share/healthz'].includes(new URL(request.url).pathname)) {
          await options.pool.query('SELECT key FROM emate_share.objects LIMIT 0')
          await files.health()
          if (new URL(request.url).pathname === '/readyz') return Response.json({ schema_version: 1, ready: true, data_ready: true })
        }
        return await handleRequest(request, { ...env, SHARES: store }, options.fetchImplementation)
      } catch {
        console.error(JSON.stringify({ event: 'share_request_failed', method: request.method, cancelled: request.signal.aborted }))
        return failure()
      }
    },
    async maintenance() { return new ShareStore(options.pool, files).collect() },
  }
}

export async function environment(env: NodeJS.ProcessEnv) {
  if ((env.SHARE_DATABASE_URL === undefined) === (env.SHARE_DATABASE_URL_FILE === undefined)) throw new Error('Use exactly one database secret source')
  const databaseUrl = (env.SHARE_DATABASE_URL ?? await readFile(env.SHARE_DATABASE_URL_FILE!, 'utf8')).trim()
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('Invalid share database')
  const validationUrl = env.SHARE_MODEL_VALIDATION_URL
  if (!validationUrl) throw new Error('Model Gateway validation endpoint is required')
  const url = new URL(validationUrl)
  const internal = url.protocol === 'http:' && ['model-gateway', 'localhost', '127.0.0.1'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || (!internal && url.protocol !== 'https:') ||
      (internal ? url.pathname !== '/v1/consents/current' : !url.pathname.endsWith('/e-mate/model-api/v1/consents/current'))) throw new Error('Invalid Model Gateway endpoint')
  const host = env.SHARE_HOST ?? '127.0.0.1'
  const port = Number(env.SHARE_PORT ?? 8789)
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid share listen address')
  return { databaseUrl, validationUrl, host, port, volume: env.SHARE_VOLUME ?? '/var/lib/e-mate-share' }
}

function requestHeaders(incoming: IncomingMessage) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  return headers
}

// Cancelling a Web stream made by Readable.toWeb(IncomingMessage) destroys
// the HTTP socket. Core legitimately cancels a retried upload when its existing
// link is found, so keep that socket alive until the JSON response is flushed.
export function incomingBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  const iterator = incoming.iterator({ destroyOnReturn: false })
  let cancelled = false
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (cancelled) return
        if (next.done) controller.close()
        else controller.enqueue(new Uint8Array(next.value))
      } catch (error) { if (!cancelled) controller.error(error) }
    },
    cancel() {
      cancelled = true
      // An in-flight iterator.next may be waiting on a stalled sender. Do not
      // wait for its return before flushing an auth/idempotency response.
      void iterator.return?.().catch(() => {})
      incoming.pause()
    },
  }, { highWaterMark: 1 })
}

export async function start(env: NodeJS.ProcessEnv = process.env) {
  const config = await environment(env)
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 })
  pool.on('error', () => { console.error(JSON.stringify({ event: 'share_database_connection_failed' })) })
  const service = createService({ ...config, pool })
  await service.files.ready()
  await pool.query('SELECT key FROM emate_share.objects LIMIT 0')
  let active = 0
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)])
    incoming.once('aborted', () => controller.abort())
    outgoing.once('close', () => controller.abort())
    if (incoming.method === 'GET' && incoming.url === '/livez') {
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      outgoing.end(JSON.stringify({ schema_version: 1, alive: true }))
      return
    }
    if (active >= 4) {
      outgoing.writeHead(503, { 'content-type': 'application/json', connection: 'close', 'retry-after': '2' })
      outgoing.end(JSON.stringify({ schema_version: 1, error: { code: 'SERVICE_BUSY' } }))
      return
    }
    active++
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) throw new Error('Invalid request path')
      let response: Response
      if (Number(incoming.headers['content-length']) > MAX_UPLOAD_BYTES) response = failure(413, 'SHARE_ARCHIVE_TOO_LARGE')
      else {
        const hasBody = !['GET', 'HEAD'].includes(incoming.method ?? 'GET')
        const request = new Request(`http://share.internal${incoming.url}`, { method: incoming.method, headers: requestHeaders(incoming), signal,
          ...(hasBody ? { body: incomingBody(incoming), duplex: 'half' } : {}) } as RequestInit)
        response = await service.fetch(request)
      }
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(!['GET', 'HEAD'].includes(incoming.method ?? 'GET') || response.status >= 400 ? { connection: 'close' } : {}) })
      if (response.body) {
        const reader = response.body.getReader()
        const abort = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', abort, { once: true })
        try {
          while (true) {
            signal.throwIfAborted()
            const next = await reader.read()
            if (next.done) break
            if (!outgoing.write(next.value)) await once(outgoing, 'drain', { signal })
          }
        } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
      }
      outgoing.end()
    } catch {
      if (outgoing.destroyed) return
      if (outgoing.headersSent) outgoing.destroy()
      else {
        outgoing.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' })
        outgoing.end(JSON.stringify({ schema_version: 1, error: { code: 'SERVICE_UNAVAILABLE' } }))
      }
    } finally { active-- }
  })
  server.requestTimeout = 300_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100
  server.maxConnections = 64
  server.listen(config.port, config.host)
  await once(server, 'listening')
  let maintenance: Promise<unknown> | undefined
  const timer = setInterval(() => {
    if (maintenance) return
    maintenance = service.maintenance().catch(() => {
      console.error(JSON.stringify({ event: 'share_maintenance_failed' }))
    }).finally(() => { maintenance = undefined })
  }, 3_600_000)
  timer.unref()
  let stopping: Promise<void> | undefined
  const shutdown = () => stopping ??= (async () => {
    service.close()
    clearInterval(timer)
    const deadline = setTimeout(() => server.closeAllConnections(), 30_000)
    deadline.unref()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await maintenance
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
  void start().catch(() => { console.error(JSON.stringify({ event: 'share_start_failed' })); process.exitCode = 1 })
}
