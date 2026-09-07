import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createKnowledgeWorkflow } from './workflow.ts'
import { resolveKnowledgeSelection } from './model-selection.ts'
import { API_ROOT, CHANNEL, GRAPH_ASSET, HASH, SOURCE_ID, knowledgeFailure } from './contract.ts'
export const name = 'emate-knowledge'
export const inject = ['emateIdentity', 'connection', 'webServer', 'timer', 'agents', 'sessions', 'sessionPersistence', 'subagents', 'jobs', 'goals', 'tools', 'emateXinKnowledge', 'apiProxy', 'agentDefaultModel', 'emateModelPolicy', 'llm']
const MAX_BYTES = 20 * 1024 * 1024
const DOWNLOAD_ROOT = '/emate-knowledge-downloads/'
const allowed: Record<string, { method: string; path: string; keys: string[] }> = {
  catalog: { method: 'GET', path: '/catalog', keys: ['scope'] },
  graph: { method: 'GET', path: '/graph', keys: ['root_id', 'depth', 'limit', 'corpus_revision', 'scope'] },
  sources: { method: 'GET', path: '/sources', keys: ['kind', 'offset', 'limit', 'corpus_revision', 'scope'] },
  source: { method: 'GET', path: '/sources', keys: ['source_id', 'version', 'scope'] },
  node: { method: 'GET', path: '/nodes', keys: ['node_id', 'version', 'scope'] },
  search: { method: 'POST', path: '/search', keys: ['question', 'limit', 'layer', 'corpus_revision', 'scope'] },
  benchmarks: { method: 'GET', path: '/benchmark', keys: ['keyword'] },
  benchmark: { method: 'POST', path: '/benchmark', keys: ['media', 'industry', 'metric', 'period', 'source_id', 'marketing_purpose'] },
  evidence: { method: 'GET', path: '/evidence', keys: ['query_id', 'scope'] },
  original: { method: 'GET', path: '/sources', keys: ['source_id', 'version', 'scope'] },
  revisions: { method: 'GET', path: '/revisions', keys: ['question', 'limit', 'corpus_revision', 'scope'] },
  revision: { method: 'GET', path: '/revisions', keys: ['revision_id'] },
}
function reject(message: string, code = 'invalid-request'): never { throw Object.assign(Error(message), { code }) }
export function knowledgeTarget(endpoint: string, payload: any) {
  const operation = Object.hasOwn(allowed, endpoint) ? allowed[endpoint] : undefined
  if (!operation || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !operation.keys.includes(key))) reject('知识请求字段无效。')
  const url = new URL(API_ROOT + operation.path)
  const input = { ...payload }
  if (input.scope !== undefined && !['public', 'uploader-private'].includes(input.scope)) reject('知识范围无效。')
  if (endpoint === 'revisions') input.scope ??= 'public'
  const field = endpoint === 'revision' ? 'revision_id' : endpoint === 'node' ? 'node_id' : endpoint === 'evidence' ? 'query_id' : ['source', 'original'].includes(endpoint) ? 'source_id' : null
  if (field) {
    if (typeof input[field] !== 'string' || !(field === 'node_id' ? HASH : SOURCE_ID).test(input[field])) reject('知识来源身份无效。')
    url.pathname += '/' + input[field] + (endpoint === 'original' ? '/original' : '')
    delete input[field]
  }
  for (const key of ['version', 'corpus_revision', 'root_id']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !HASH.test(input[key]))) reject('知识版本无效。')
  if (endpoint === 'original' && !HASH.test(input.version ?? '')) reject('读取原件必须明确版本。')
  for (const [key, max] of [['limit', endpoint === 'graph' ? 500 : endpoint === 'search' ? 20 : 100], ['depth', 2], ['offset', 100000]] as const) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < (key === 'limit' ? 1 : 0) || input[key] > max)) reject('知识查询范围无效。')
  }
  if (operation.method === 'GET') {
    for (const [key, value] of Object.entries(input)) {
      if (!['string', 'number'].includes(typeof value) || String(value).length > 4000) reject('知识请求参数无效。')
      url.searchParams.set(key, String(value))
    }
  }
  const body = operation.method === 'POST' ? JSON.stringify(input) : undefined
  if (body && Buffer.byteLength(body) > 65536) reject('知识查询内容过长。')
  return { url, method: operation.method, body }
}
async function bytes(response: Response, maximum: number, signal: AbortSignal) {
  const reader = response.body?.getReader()
  if (!reader) reject('知识服务未返回内容。', 'invalid-response')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > maximum) reject('知识响应超过读取上限。', 'response-too-large')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return Buffer.concat(chunks, length)
}
export function createKnowledgeHost(identity: any, schedule = (callback: () => void, delay: number) => { const timer = setTimeout(callback, delay); timer.unref(); return () => clearTimeout(timer) }) {
  let lifetime = new AbortController(); let disposed = false
  const downloads = new Map<string, { owner: string; bytes: Buffer; disposition: string; expires: number; cancel: () => void }>()
  const owner = () => {
    const value = identity.localAccountPrincipal?.()
    return typeof value?.tenantId === 'string' && typeof value?.userId === 'string'
      ? createHash('sha256').update(JSON.stringify([value.tenantId, value.userId])).digest('hex') : undefined
  }
  const clearDownloads = () => { for (const entry of downloads.values()) entry.cancel(); downloads.clear() }
  let lastOwner = owner()
  const synchronize = () => { const next = owner(); if (!disposed && next !== lastOwner) { lastOwner = next; lifetime.abort(); lifetime = new AbortController(); clearDownloads() } return next }
  const check = (key: string | undefined) => { if (disposed) reject('知识页面已关闭。', 'cancelled'); if (!key || owner() !== key) reject('登录账号已变化，请重新加载企业知识。', 'scope-changed') }
  return {
    changed() { synchronize() },
    dispose() { disposed = true; lifetime.abort(); clearDownloads() },
    takeDownload(id: string) {
      const value = downloads.get(id); downloads.delete(id); value?.cancel()
      if (!value || value.expires < Date.now()) return undefined
      try { check(value.owner); return value } catch { return undefined }
    },
    async call(endpoint: string, payload: unknown, signal?: AbortSignal) {
      if (disposed) reject('知识页面已关闭。', 'cancelled')
      const target = knowledgeTarget(endpoint, payload)
      signal?.throwIfAborted()
      if (!owner()) {
        const bootstrap = await identity.state?.()
        if (bootstrap?.authenticated === false || bootstrap?.workspace_unlocked === false) reject('请先完成企业登录与使用协议。', 'unauthorized')
      }
      signal?.throwIfAborted()
      const key = synchronize(); check(key)
      const timeout = AbortSignal.timeout(30000)
      const combined = AbortSignal.any([lifetime.signal, timeout, ...(signal ? [signal] : [])])
      let response: Response
      try { response = await identity.request(target.url, { method: target.method, ...(target.body ? { body: target.body, headers: { 'content-type': 'application/json' } } : {}), signal: combined }) }
      catch (error) { check(key); throw error }
      if (!(response instanceof Response)) reject('知识服务响应无效。', 'invalid-response')
      let content: Buffer
      try { content = await bytes(response, endpoint === 'original' ? MAX_BYTES : 4 * 1024 * 1024, combined) }
      catch (error) { check(key); throw error }
      combined.throwIfAborted(); check(key)
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) reject('当前登录账号暂不可读取企业知识。', 'unauthorized')
        if (response.status === 409) reject('资料版本已变化，请刷新后重新打开。', 'revision-conflict')
        if (response.status === 404) reject('资料不存在或当前不可读。', 'not-found')
        reject('企业知识服务暂不可用，请稍后重试。', 'unavailable')
      }
      if (endpoint === 'original') {
        const expected = (payload as any).version
        if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/octet-stream' || createHash('sha256').update(content).digest('hex') !== expected) reject('原件版本核验失败。', 'integrity')
        for (const [id, entry] of downloads) if (entry.expires < Date.now()) { entry.cancel(); downloads.delete(id) }
        while (downloads.size >= 2) { const first = downloads.keys().next().value!; downloads.get(first)?.cancel(); downloads.delete(first) }
        const id = randomUUID()
        const header = response.headers.get('content-disposition') ?? ''
        const disposition = /^attachment; filename\*=UTF-8''[A-Za-z0-9%._~!$&'()*+,;=:@-]{1,1600}$/u.test(header) ? header : 'attachment'
        downloads.set(id, { owner: key!, bytes: content, disposition, expires: Date.now() + 60000, cancel: schedule(() => downloads.delete(id), 60000) })
        return { scope_key: key, result: { url: DOWNLOAD_ROOT + id, sha256: expected, bytes: content.length } }
      }
      if (response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') reject('知识服务响应格式无效。', 'invalid-response')
      let result: any
      try { result = JSON.parse(content.toString('utf8')) } catch { reject('知识服务响应无效。', 'invalid-response') }
      const expectedScope = endpoint === 'revision' ? 'enterprise-subject' : (payload as any).scope ?? 'public'
      if (result?.schema_version !== 1 || result.scope?.kind !== expectedScope || endpoint !== 'revision' && !HASH.test(result.corpus_revision)) reject('知识服务返回了不匹配的资料范围。', 'invalid-response')
      if (endpoint === 'revision' && (result.revision_id !== (payload as any).revision_id || typeof result.markdown !== 'string' || !Array.isArray(result.source_versions))) reject('知识修订身份无效。', 'invalid-response')
      return { scope_key: key, result }
    },
  }
}
export function apply(ctx: any): void {
  const host = createKnowledgeHost(ctx.get('emateIdentity'), (callback, delay) => ctx.timeout(callback, delay))
  const xinOperations = new WeakMap<object, { call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }>()
  const workflow = createKnowledgeWorkflow(ctx, { installModelSelection,
    resolveSelection: exec => resolveKnowledgeSelection(ctx, exec),
    xinKnowledgeCall(name, args, exec, signal) {
      let operation = xinOperations.get(exec)
      if (!operation) {
        // The workflow validates a Host-created operation Agent before reaching
        // this seam; model-initiated operations must also bind their root call.
        operation = ctx.emateXinKnowledge.capture(exec.rootCallId ? exec : { signal: exec.signal })
        xinOperations.set(exec, operation!)
      }
      return operation!.call(name, args, signal)
    },
  })
  ctx.provide('emateKnowledgeWorkflow', workflow)
  ctx.provide('emateKnowledgeSelection', (exec: any) => resolveKnowledgeSelection(ctx, exec))
  ctx.on('credentials/updated', (ref: string) => { if (String(ref) === 'E_MATE_ENTERPRISE_SESSION') { host.changed(); workflow.changed(); ctx.timeout(() => { host.changed(); workflow.changed() }, 0) } })
  ctx.effect(() => ctx.connection.rpc.handle(CHANNEL, (endpoint: string, payload: unknown, signal: AbortSignal) => knowledgeRpc(host, endpoint, payload, signal), { authority: 'loopback' }), 'emate.knowledge: account-bound native RPC')
  ctx.effect(() => () => host.dispose(), 'emate.knowledge: release pending reads')
  ctx.effect(() => () => workflow.dispose(), 'emate.knowledge: pause native compilation and preserve checkpoints')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: GRAPH_ASSET, async handler(req: any, res: any) {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    try { const body = await readFile(new URL('./assets/graph.js', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }); res.end(body) }
    catch { res.writeHead(404); res.end() }
  } }), 'emate.knowledge: local lazy graph module')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: DOWNLOAD_ROOT.slice(0, -1), handler(req: any, res: any) {
    const path = new URL(req.url, 'http://local').pathname.slice(DOWNLOAD_ROOT.length)
    const download = req.method === 'GET' && /^[a-f0-9-]{36}$/u.test(path) ? host.takeDownload(path) : undefined
    if (!download) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': download.disposition, 'Content-Length': download.bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(download.bytes)
  } }), 'emate.knowledge: verified one-time original download')
}

export async function knowledgeRpc(host: ReturnType<typeof createKnowledgeHost>, endpoint: string, payload: unknown, signal?: AbortSignal) {
  try { return { ok: true, value: { schema_version: 1, status: 'success', value: await host.call(endpoint, payload, signal) } } }
  catch (error) { return { ok: true, value: knowledgeFailure(error) } }
}
