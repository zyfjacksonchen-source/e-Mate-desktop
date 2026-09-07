import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'

export const API_ROOT = 'https://mvdcm.ecoremedia.net/ecorex-agent/client/knowledge/v1'
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024
export const HASH = /^[a-f0-9]{64}$/
export const UUID = /^[a-f0-9-]{36}$/
export const OPERATION = /^[A-Za-z0-9_-]{16,80}$/
export type Scope = { kind: 'public' | 'uploader-private' } | { kind: 'project'; project_id: number }
export type Execution = { agent: any; signal?: AbortSignal; rootCallId?: string }
export function fail(code: string, message = '知识任务未完成，请回查原任务。'): never { throw Object.assign(new Error(message), { code }) }
export function digest(value: unknown): string {
  const ordered = (input: any): any => Array.isArray(input) ? input.map(ordered) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, ordered(input[key])])) : input
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
}
export function ownerOf(identity: any): string | undefined {
  const value = identity.localAccountPrincipal?.()
  return typeof value?.tenantId === 'string' && typeof value?.userId === 'string' ? digest([value.tenantId, value.userId]) : undefined
}
export async function persist(ctx: any, agent: any, data: Record<string, unknown>): Promise<void> {
  agent.session.append('knowledge/workflow', { schema_version: 1, ...data }, { ignorable: true })
  if (!await ctx.sessions.flush(agent.session)) fail('durability-unavailable', '知识任务需要原生会话持久化。')
}
export function events(agent: any): any[] { return agent.session.events.filter((event: any) => event.type === 'knowledge/workflow').map((event: any) => event.data) }
export function createKnowledgeTransport(identity: any) {
  let lifetime = new AbortController(); let owner = ownerOf(identity); let disposed = false
  const changed = () => { const next = ownerOf(identity); if (next !== owner) { owner = next; lifetime.abort(); lifetime = new AbortController() } }
  const check = (expected: string) => { if (disposed) fail('disposed'); changed(); if (!expected || expected !== owner) fail('scope-changed', '账号已变化，请在当前账号重新打开知识任务。') }
  const send = async (expected: string, method: string, url: URL, payload: unknown, signal: AbortSignal | undefined, verifyScope: boolean): Promise<any> => {
      check(expected)
      const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
      combined.throwIfAborted()
      const binary = payload instanceof Uint8Array
      const body = payload === undefined ? undefined : binary ? payload : JSON.stringify(payload)
      if (body !== undefined && (binary ? (body as Uint8Array).byteLength > MAX_ORIGINAL_BYTES : Buffer.byteLength(body as string) > 1024 * 1024)) fail('request-too-large')
      const response = await identity.request(url, { method, signal: combined, redirect: 'error',
        ...(payload === undefined ? {} : { body, headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' } }) })
      if (!(response instanceof Response) || response.headers.get('content-type')?.split(';')[0] !== 'application/json') fail('invalid-response')
      const reader = response.body?.getReader(); if (!reader) fail('invalid-response')
      const chunks: Uint8Array[] = []; let size = 0
      try { while (true) { combined.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 24 * 1024 * 1024) fail('response-too-large'); chunks.push(part.value) } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      combined.throwIfAborted(); check(expected)
      let value: any; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('invalid-response') }
      if (!response.ok) fail(value.error === 'INVALID_CITATION' ? 'invalid-citation' : value.error === 'IDEMPOTENCY_CONFLICT' ? 'idempotency-conflict' : response.status === 400 || response.status === 413 ? 'invalid-request' : response.status === 404 ? 'not-found' : response.status === 409 ? 'conflict' : response.status === 403 || response.status === 401 ? 'unauthorized' : 'unavailable')
      if (verifyScope && (value.schema_version !== 1 || !['enterprise-subject', 'public', 'uploader-private'].includes(value.scope?.kind))) fail('invalid-response')
      return value
  }
  return {
    changed, check, dispose() { disposed = true; lifetime.abort() },
    async capture() {
      if (disposed) fail('disposed')
      if (!ownerOf(identity)) await identity.state?.()
      changed(); if (!owner) fail('unauthorized', '请先完成企业登录。')
      return owner
    },
    request(expected: string, method: string, path: string, payload?: unknown, signal?: AbortSignal) {
      return send(expected, method, new URL(API_ROOT + path), payload, signal, true)
    },
    uploadOriginal(expected: string, ticketUrl: string, content: Uint8Array, signal?: AbortSignal) {
      const url = new URL(ticketUrl)
      if (url.origin !== 'https://mvdcm.ecoremedia.net' || !/^\/business-assistant\/api\/uploads\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) fail('invalid-upload-ticket')
      return send(expected, 'PUT', url, content, signal, false)
    },
  }
}

export type KnowledgeTransport = ReturnType<typeof createKnowledgeTransport>

/** A proven lookup miss may retry only the same durable idempotent request, never a new ID. */
export async function findOrCreate(transport: KnowledgeTransport, owner: string, collection: 'imports' | 'compilations', request: any, existed: boolean, signal?: AbortSignal) {
  const lookup = async () => {
    try { return await transport.request(owner, 'GET', `/${collection}?operation_id=${request.operation_id}`, undefined, signal) }
    catch (error: any) { signal?.throwIfAborted(); if (error.code !== 'not-found') throw error; return undefined }
  }
  if (existed) { const found = await lookup(); if (found !== undefined) return found }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await transport.request(owner, 'POST', `/${collection}`, request, signal) }
    catch (error: any) {
      signal?.throwIfAborted()
      if (['conflict', 'idempotency-conflict', 'unauthorized', 'scope-changed', 'disposed', 'invalid-request'].includes(error.code)) throw error
      const found = await lookup()
      if (found !== undefined) return found
      if (attempt === 1) throw error
    }
  }
  fail('unavailable')
}

export async function collectOriginals(fs: any, paths: string[], cwd: string | undefined, signal?: AbortSignal) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100 || paths.some(path => typeof path !== 'string' || !path || path.length > 4096)) fail('invalid-files')
  const seen = new Set<unknown>(); const result: { target: any; filename: string; version: unknown }[] = []
  const visit = async (target: any, depth: number) => {
    signal?.throwIfAborted()
    if (depth > 16) fail('too-many-files')
    if (seen.has(target.targetKey)) return
    if (seen.size >= 1000) fail('too-many-files')
    seen.add(target.targetKey)
    const info = await fs.stat(target, signal)
    if (info?.type === 'directory') {
      const children = await fs.listDir(target, signal)
      for (const child of children) {
        if (!fs.contains(target, child.target)) fail('outside-source-folder')
        await visit(child.target, depth + 1)
      }
    } else if (info?.type === 'file') {
      if (result.length >= 100 || (info.size !== undefined && (info.size < 1 || info.size > MAX_ORIGINAL_BYTES))) fail('file-too-large')
      result.push({ target, filename: basename(fs.processPath(target)), version: info.version })
    } else fail('invalid-file')
  }
  for (const path of paths) await visit(await fs.resolve(path, { cwd, signal }), 0)
  if (!result.length) fail('empty-folder')
  return result
}

export function decodeXinReply(raw: any): any {
  if (raw?.isError) fail('project-unavailable')
  if (raw?.value !== undefined) raw = raw.value
  let value = raw?.structuredContent ?? raw
  if (!raw?.structuredContent && Array.isArray(raw?.content)) {
    if (raw.content.length !== 1 || raw.content[0]?.type !== 'text' || typeof raw.content[0].text !== 'string') fail('invalid-response')
    try { value = JSON.parse(raw.content[0].text) } catch { fail('invalid-response') }
  }
  if (value?.error || value?.status === 'failed') fail(value.error === 'INVALID_CITATION' ? 'invalid-citation' : value.error === 'IDEMPOTENCY_CONFLICT' ? 'idempotency-conflict' : value.error === 'INVALID_QUERY' ? 'invalid-request' : value.error === 'FORBIDDEN' ? 'unauthorized' : value.error === 'NOT_FOUND' ? 'not-found' : ['REVISION_CONFLICT', 'LEASE_CONFLICT', 'SCOPE_CHANGED'].includes(value.error) ? 'conflict' : 'project-unavailable')
  return value
}
export type ProjectCall = (name: string, args: Record<string, unknown>, exec: Execution, signal?: AbortSignal) => Promise<any>
export function createKnowledgeImports(ctx: any, transport: KnowledgeTransport, assertExecution: (exec: Execution, owner: string) => void, xinCall?: ProjectCall) {
  const recordUserPublicIntent = async (exec: Execution, paths: string[]) => {
    const owner = await transport.capture(); assertExecution(exec, owner)
    const log = exec.agent.session.events
    const call = log.find((event: any) => event.type === 'tool/call' && event.data.callId === exec.rootCallId)
    const start = call && log.find((event: any) => event.type === 'turn/start' && event.data.turn === call.data.turn)
    const message = start && log.findLast((event: any) => event.seq > start.seq && event.seq < call.seq && event.type === 'user/message' && event.data.source.kind === 'user')
    const text = message?.data.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') ?? ''
    const instruction = text.trim()
    const ambiguous = /不要|不能|不得|不许|不可|禁止|别(?:传|导入|上传|公开)|排除|除外|除了|不包括|不含|例外|但是|除.{0,120}外|\b(?:not|except|excluding|exclude)\b/iu.test(instruction)
    const match = /^(?:请)?(?:把|将)\s*(.+?)\s*(?:导入|上传|加入|整理)(?:到|至|进)?\s*(?:公司)?(?:公共|公开)知识库[。.!！]?$/u.exec(instruction)
      ?? /^(?:请)?(?:导入|上传|加入)\s*(.+?)\s*(?:到|至|进)\s*(?:公司)?(?:公共|公开)知识库[。.!！]?$/u.exec(instruction)
    const names = match?.[1]?.split(/[,，、]|\s+(?:和|及|以及)\s+/u).map(name => name.trim().replace(/^(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)$/u, (_match, double, single, tick) => double ?? single ?? tick)) ?? []
    const cwd = exec.agent.session.header.cwd
    const bound = Array.isArray(paths) && paths.length > 0 && paths.every(path => typeof path === 'string' && names.some(name => name === path || (typeof cwd === 'string' && !isAbsolute(name) && resolve(cwd, name) === resolve(cwd, path))))
    if (ambiguous || !match || !bound) fail('public-intent-required', '无法将本次文件绑定到明确的公共导入指令；未执行导入，原件仍保留在本机私有范围。')
    const id = message.data.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) fail('public-intent-required')
    await persist(ctx, exec.agent, { kind: 'public-intent', id, owner, paths, origin: 'user_message' })
    return id
  }
  const importProject = async (exec: Execution, options: any, owner: string) => {
    if (!xinCall || !Number.isSafeInteger(options.scope.project_id) || options.scope.project_id < 1 || options.supersedes || !OPERATION.test(options.operationId)) fail('invalid-project-import')
    const call = async (name: string, args: Record<string, unknown>) => { assertExecution(exec, owner); const result = decodeXinReply(await xinCall(name, args, exec, exec.signal)); assertExecution(exec, owner); return result }
    const fs = exec.agent.ctx.get('fs'); if (!fs) fail('filesystem-unavailable')
    const files = await collectOriginals(fs, options.paths, exec.agent.session.header.cwd, exec.signal)
    const sources = []
    for (const file of files) {
      const bytes = await fs.readBytes(file.target, exec.signal, MAX_ORIGINAL_BYTES)
      if (!bytes.length || (await fs.stat(file.target, exec.signal))?.version !== file.version) fail('source-changed')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const find = async () => call('find_imported_source', { project_id: options.scope.project_id, sha256, kind: 'knowledge' })
      let result: any
      try { result = await find() } catch (error: any) { if (error.code !== 'not-found') throw error }
      if (!result) {
        await persist(ctx, exec.agent, { kind: 'project-import-request', owner, batchId: options.operationId, projectId: options.scope.project_id, sha256, filename: file.filename })
        let ticket: any
        try { ticket = await call('prepare_source_upload', { intent: { filename: file.filename, title: options.title ?? file.filename, publisher: options.publisher ?? '本人上传', kind: 'knowledge', project_id: options.scope.project_id, sha256, size: bytes.length } }) }
        catch (error) { result = await find() }
        if (ticket) {
          if (ticket.method !== 'PUT' || ticket.sha256 !== sha256 || ticket.size !== bytes.length || typeof ticket.upload_url !== 'string') fail('invalid-upload-ticket')
          try { result = await transport.uploadOriginal(owner, ticket.upload_url, bytes, exec.signal) }
          catch (error) { exec.signal?.throwIfAborted(); result = await find() }
        }
      }
      const source = result?.source ?? result
      if (!UUID.test(source?.id) || source.file_hash !== sha256 || source.project_id !== options.scope.project_id) fail('invalid-response')
      await persist(ctx, exec.agent, { kind: 'project-import-receipt', owner, batchId: options.operationId, projectId: options.scope.project_id, sourceId: source.id, sha256 })
      sources.push(source)
    }
    return { scope_key: owner, scope: options.scope, sources }
  }
  return {
    recordUserPublicIntent,
    async importsStatus(exec: Execution, operationId: string, scope?: Scope) {
      const owner = await transport.capture(); assertExecution(exec, owner)
      if (!OPERATION.test(operationId)) fail('invalid-request')
      if (scope?.kind === 'project') {
        if (!xinCall || !Number.isSafeInteger(scope.project_id) || scope.project_id < 1) fail('invalid-project-import')
        const hashes = new Set(events(exec.agent).filter(event => ['project-import-request', 'project-import-receipt'].includes(event.kind) && event.batchId === operationId && event.owner === owner && event.projectId === scope.project_id).map(event => event.sha256))
        const sources = []
        for (const sha256 of hashes) {
          const value = decodeXinReply(await xinCall('find_imported_source', { project_id: scope.project_id, sha256, kind: 'knowledge' }, exec, exec.signal))
          assertExecution(exec, owner)
          if (value.source?.file_hash !== sha256 || value.source?.project_id !== scope.project_id) fail('invalid-response')
          sources.push(value.source)
        }
        return { scope_key: owner, scope, sources }
      }
      const requests = events(exec.agent).filter(event => event.kind === 'import-request' && event.batchId === operationId && event.owner === owner)
      const imports = []
      for (const request of requests) {
        const value = await transport.request(owner, 'GET', '/imports?operation_id=' + request.operationId, undefined, exec.signal)
        if (value.operation_id !== request.operationId) fail('invalid-response')
        imports.push({ import_id: value.import_id, operation_id: value.operation_id, status: value.status, source: value.source })
      }
      return { scope_key: owner, imports }
    },
    async recordPublicIntent(agent: any, paths: string[]) {
      const owner = await transport.capture(); assertExecution({ agent }, owner)
      if (!Array.isArray(paths) || paths.length < 1 || paths.some(path => typeof path !== 'string' || !path)) fail('invalid-files')
      const id = randomUUID()
      await persist(ctx, agent, { kind: 'public-intent', id, owner, paths, origin: 'public_library_action' })
      return id
    },
    async importFiles(exec: Execution, options: { paths: string[]; operationId: string; title?: string; publisher?: string; scope?: Scope; publicIntentId?: string; supersedes?: { source_id: string; source_version: string } }) {
      const owner = await transport.capture(); assertExecution(exec, owner)
      const scope = options.scope ?? { kind: 'uploader-private' }
      if (scope.kind === 'project') return importProject(exec, options, owner)
      if (!OPERATION.test(options.operationId) || !['public', 'uploader-private'].includes(scope.kind)) fail('invalid-request')
      let provenance: any
      if (scope.kind === 'public') {
        const intentId = options.publicIntentId ?? await recordUserPublicIntent(exec, options.paths)
        const intent = events(exec.agent).find(event => event.kind === 'public-intent' && event.id === intentId && event.owner === owner && digest(event.paths) === digest(options.paths))
        if (!intent) fail('public-intent-required', '公共导入需要本次明确的公共知识库操作来源。')
        provenance = { kind: 'uploader_declared', classification: 'general_method', intent_receipt: { kind: intent.origin, id: intent.id } }
      }
      const fs = exec.agent.ctx.get('fs')
      if (!fs) fail('filesystem-unavailable')
      const files = await collectOriginals(fs, options.paths, exec.agent.session.header.cwd, exec.signal)
      if (options.supersedes && (files.length !== 1 || !UUID.test(options.supersedes.source_id) || !HASH.test(options.supersedes.source_version))) fail('invalid-replacement')
      const receipts = []
      for (const file of files) {
        assertExecution(exec, owner); transport.check(owner); exec.signal?.throwIfAborted()
        const bytes = await fs.readBytes(file.target, exec.signal, MAX_ORIGINAL_BYTES)
        if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_ORIGINAL_BYTES || (await fs.stat(file.target, exec.signal))?.version !== file.version) fail('source-changed')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const operation_id = digest([options.operationId, file.target.targetKey, sha256])
        const request = { operation_id, filename: file.filename, title: options.title ?? file.filename, publisher: options.publisher ?? '本人上传', kind: 'knowledge', sha256, byte_length: bytes.length, scope, ...(provenance ? { provenance } : {}), ...(options.supersedes ? { supersedes: options.supersedes } : {}) }
        const previous = events(exec.agent).find(event => event.kind === 'import-request' && event.operationId === operation_id && event.owner === owner)
        if (previous && digest(previous.request) !== digest(request)) fail('idempotency-conflict')
        if (!previous) await persist(ctx, exec.agent, { kind: 'import-request', owner, batchId: options.operationId, operationId: operation_id, request })
        const frozen = previous?.request ?? events(exec.agent).findLast(event => event.kind === 'import-request' && event.operationId === operation_id && event.owner === owner).request
        let receipt = await findOrCreate(transport, owner, 'imports', frozen, previous !== undefined, exec.signal)
        if (!UUID.test(receipt.import_id) || receipt.operation_id !== operation_id || receipt.scope?.kind !== scope.kind || receipt.request_hash !== digest({ ...request, provenance: provenance ?? null, supersedes: options.supersedes ?? null })) fail('invalid-response')
        await persist(ctx, exec.agent, { kind: 'import-receipt', owner, operationId: operation_id, importId: receipt.import_id })
        if (receipt.status === 'awaiting_content') {
          try { receipt = await transport.request(owner, 'PUT', `/imports/${receipt.import_id}/content`, bytes, exec.signal) }
          catch (error) { exec.signal?.throwIfAborted(); receipt = await transport.request(owner, 'GET', `/imports/${receipt.import_id}`, undefined, exec.signal) }
        }
        receipts.push({ import_id: receipt.import_id, operation_id, status: receipt.status, source: receipt.source })
      }
      return { scope_key: owner, scope, imports: receipts }
    },
  }
}
