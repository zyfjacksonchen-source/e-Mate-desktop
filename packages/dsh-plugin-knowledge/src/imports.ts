import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export const API_ROOT = 'https://mvdcm.ecoremedia.net/ecorex-agent/client/knowledge/v1'
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024
export const HASH = /^[a-f0-9]{64}$/
export const UUID = /^[a-f0-9-]{36}$/
export const OPERATION = /^[A-Za-z0-9_-]{16,80}$/
export type Scope = { kind: 'public' | 'uploader-private' } | { kind: 'project'; project_id: number }
export type SourceRef = { source_id: string; source_version: string; parse_revision: string }
export type GraphPath = { namespace_id: string; relative_path: string; layer: 'expert' | 'case' | 'source'; expected_binding: null | { binding_revision: string; source_id: string; source_version: string } }
export type GraphFile = { path: string; graph_path: GraphPath; source_ref?: SourceRef }
export type GraphOptions = { graph_files?: GraphFile[]; graph_root?: { path: string; namespace_id: string; layer: GraphPath['layer'] } }
const CANONICAL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function exactGraph(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-graph-path')
}
function graphLayer(value: unknown) { return ['expert', 'case', 'source'].includes(value as string) }
export function validateGraphPath(value: any): asserts value is GraphPath {
  exactGraph(value, ['namespace_id', 'relative_path', 'layer', 'expected_binding'])
  if (!CANONICAL_UUID.test(value.namespace_id) || !graphLayer(value.layer) || typeof value.relative_path !== 'string'
    || !value.relative_path || value.relative_path.length > 500 || !value.relative_path.endsWith('.md')
    || /[\\:%?#\x00-\x1f\x7f]/u.test(value.relative_path) || value.relative_path.split('/').some((part: string) => !part || part === '.' || part === '..')) fail('invalid-graph-path')
  if (value.expected_binding !== null) {
    exactGraph(value.expected_binding, ['binding_revision', 'source_id', 'source_version'])
    if (!HASH.test(value.expected_binding.binding_revision) || !CANONICAL_UUID.test(value.expected_binding.source_id) || !HASH.test(value.expected_binding.source_version)) fail('invalid-graph-path')
  }
}
export function graphOptions(value: GraphOptions): GraphOptions {
  if (value.graph_files !== undefined && value.graph_root !== undefined) fail('invalid-graph-path')
  if (value.graph_root !== undefined) {
    const root = value.graph_root; exactGraph(root, ['path', 'namespace_id', 'layer'])
    if (typeof root.path !== 'string' || !root.path || root.path.length > 4096 || !CANONICAL_UUID.test(root.namespace_id) || !graphLayer(root.layer)) fail('invalid-graph-path')
    return { graph_root: structuredClone(root) }
  }
  if (value.graph_files === undefined) return {}
  if (!Array.isArray(value.graph_files) || !value.graph_files.length || value.graph_files.length > 100) fail('invalid-graph-path')
  const paths = new Set<string>()
  for (const file of value.graph_files) {
    exactGraph(file, ['path', 'graph_path', 'source_ref']); validateGraphPath(file.graph_path)
    if (typeof file.path !== 'string' || !file.path || file.path.length > 4096 || paths.has(file.path)) fail('invalid-graph-path')
    paths.add(file.path)
    if (file.source_ref !== undefined) {
      exactGraph(file.source_ref, ['source_id', 'source_version', 'parse_revision'])
      if (!CANONICAL_UUID.test(file.source_ref.source_id) || !HASH.test(file.source_ref.source_version) || !HASH.test(file.source_ref.parse_revision)) fail('invalid-graph-path')
    }
  }
  return { graph_files: structuredClone(value.graph_files) }
}
/** A ready original can still have a replacement binding awaiting the existing compilation commit. */
export function graphReceipt(receipt: any, graph: GraphPath, version: string) {
  if (!['pending', 'active'].includes(receipt.graph_binding_status)) fail('invalid-response')
  const binding = receipt.graph_binding
  if (receipt.graph_binding_status === 'pending') {
    if (binding !== null) fail('invalid-response')
  } else {
    exactGraph(binding, ['namespace_id', 'relative_path', 'layer', 'binding_revision', 'source_id', 'source_version', 'parse_revision'])
    if (binding.namespace_id !== graph.namespace_id || binding.relative_path !== graph.relative_path || binding.layer !== graph.layer
      || !HASH.test(binding.binding_revision) || !CANONICAL_UUID.test(binding.source_id) || binding.source_version !== version
      || !HASH.test(binding.parse_revision) || receipt.source?.id !== binding.source_id || receipt.source?.file_hash !== version
      || receipt.source?.parse_revision !== binding.parse_revision || receipt.source?.status !== 'ready') fail('invalid-response')
  }
  return { graph_binding_status: receipt.graph_binding_status as 'pending' | 'active', graph_binding: binding }
}
export type Execution = { agent: any; signal?: AbortSignal; rootCallId?: string; xinSubject?: string }
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
export function events(agent: any): any[] { return agent.session.snapshotEvents().filter((event: any) => event.type === 'knowledge/workflow').map((event: any) => event.data) }
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
      if (result.length >= 100) fail('too-many-files')
      if (info.size !== undefined && (info.size < 1 || info.size > MAX_ORIGINAL_BYTES)) fail('file-too-large')
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
export type BindXin = (exec: Execution, expectedSubject?: string) => Promise<string>
export type ProjectCall = (name: string, args: Record<string, unknown>, exec: Execution, signal?: AbortSignal) => Promise<any>
export function createKnowledgeImports(ctx: any, transport: KnowledgeTransport, assertExecution: (exec: Execution, owner: string) => void, xinCall?: ProjectCall, bindXin?: BindXin) {
  type ImportOptions = GraphOptions & { paths: string[]; operationId: string; title?: string; publisher?: string; scope?: Scope; publicIntentId?: string; supersedes?: { source_id: string; source_version: string } }
  const activeBatches = new Map<string, { requestHash: string; promise: Promise<any> }>()
  const batchRequest = (options: ImportOptions) => {
    if (!OPERATION.test(options.operationId) || !Array.isArray(options.paths) || !options.paths.length || options.paths.length > 100 || options.paths.some(path => typeof path !== 'string' || !path || path.length > 4096)) fail('invalid-files')
    for (const text of [options.title, options.publisher]) if (text !== undefined && (typeof text !== 'string' || !text || text.length > 300)) fail('invalid-request')
    const scope = options.scope ?? { kind: 'uploader-private' }
    if (!['uploader-private', 'public', 'project'].includes(scope.kind) || (scope.kind === 'project' && (!Number.isSafeInteger(scope.project_id) || scope.project_id < 1))) fail('invalid-request')
    return structuredClone({ paths: options.paths, scope, title: options.title ?? null, publisher: options.publisher ?? '本人上传', supersedes: options.supersedes ?? null, ...graphOptions(options) })
  }
  const readOriginal = async (fs: any, file: any, signal?: AbortSignal) => {
    const before = await fs.stat(file.target, signal)
    if (before?.type !== 'file') fail('source-changed')
    const bytes = await fs.readBytes(file.target, signal, MAX_ORIGINAL_BYTES)
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_ORIGINAL_BYTES || (await fs.stat(file.target, signal))?.version !== before.version) fail('source-changed')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (file.sha256 !== undefined && (file.sha256 !== sha256 || file.byte_length !== bytes.length)) fail('source-changed', '原件已变化，未创建新的子操作；请查看原批次回执。')
    return { bytes, sha256 }
  }
  const prepareBatch = async (exec: Execution, options: ImportOptions, owner: string, request: any) => {
    const previous = events(exec.agent).find(event => event.kind === 'import-batch' && event.batchId === options.operationId && event.owner === owner)
    if (previous && digest(previous.request) !== digest(request)) fail('idempotency-conflict', '同一导入批次不能更换文件、范围或资料信息。')
    if (!previous) {
      if (events(exec.agent).some(event => ['import-request', 'project-import-request', 'project-import-receipt'].includes(event.kind) && event.batchId === options.operationId && event.owner === owner)) fail('source-changed', '原批次缺少完整原件快照，请先保留并查看原回执。')
      await persist(ctx, exec.agent, { kind: 'import-batch', owner, batchId: options.operationId, request, ...(exec.xinSubject ? { xin_subject: exec.xinSubject } : {}) })
    }
    const fs = exec.agent.ctx.get('fs'); if (!fs) fail('filesystem-unavailable')
    const snapshot = events(exec.agent).find(event => event.kind === 'import-batch-files' && event.batchId === options.operationId && event.owner === owner)
    let files
    try { files = await collectOriginals(fs, request.paths, exec.agent.session.header.cwd, exec.signal) }
    catch (error) { exec.signal?.throwIfAborted(); if (snapshot) fail('source-changed', '原批次的文件清单已变化，请查看原回执。'); throw error }
    const graphByTarget = new Map<unknown, { graph_path: GraphPath; source_ref?: SourceRef }>()
    if (request.graph_files) for (const item of request.graph_files as GraphFile[]) {
      const target = await fs.resolve(item.path, { cwd: exec.agent.session.header.cwd, signal: exec.signal })
      if (!files.some(file => file.target.targetKey === target.targetKey && file.filename.endsWith('.md')) || graphByTarget.has(target.targetKey)) fail('invalid-graph-path')
      graphByTarget.set(target.targetKey, { graph_path: item.graph_path, ...(item.source_ref ? { source_ref: item.source_ref } : {}) })
    }
    if (request.graph_root) {
      const root = await fs.resolve(request.graph_root.path, { cwd: exec.agent.session.header.cwd, signal: exec.signal })
      if ((await fs.stat(root, exec.signal))?.type !== 'directory') fail('invalid-graph-path')
      for (const file of files) {
        if (!fs.contains(root, file.target)) fail('outside-source-folder')
        if (!file.filename.endsWith('.md')) continue
        const path = relative(fs.processPath(root), fs.processPath(file.target)).split(sep).join('/')
        const graph_path = { namespace_id: request.graph_root.namespace_id, layer: request.graph_root.layer, relative_path: path, expected_binding: null }
        validateGraphPath(graph_path); graphByTarget.set(file.target.targetKey, { graph_path })
      }
    }
    const graphKeys = new Set<string>()
    for (const { graph_path } of graphByTarget.values()) {
      const key = digest([graph_path.namespace_id, graph_path.relative_path.normalize('NFC').toLowerCase()])
      if (graphKeys.has(key)) fail('invalid-graph-path'); graphKeys.add(key)
    }
    const manifest = []; const prepared = []
    for (const file of files) {
      assertExecution(exec, owner)
      const { bytes, sha256 } = await readOriginal(fs, file, exec.signal)
      const graph: { graph_path?: GraphPath; source_ref?: SourceRef } = graphByTarget.get(file.target.targetKey) ?? {}
      if ('source_ref' in graph && graph.source_ref && graph.source_ref.source_version !== sha256) fail('source-changed')
      const entry = { target_key: file.target.targetKey, filename: file.filename, sha256, byte_length: bytes.length, ...graph }
      manifest.push(entry); prepared.push({ ...file, sha256, byte_length: bytes.length, ...graph })
    }
    if (snapshot && digest(snapshot.files) !== digest(manifest)) fail('source-changed', '原批次的文件清单或内容已变化，未创建新的子操作；请查看原回执。')
    if (!snapshot) await persist(ctx, exec.agent, { kind: 'import-batch-files', owner, batchId: options.operationId, files: manifest })
    return { fs, files: prepared }
  }
  const recordUserPublicIntent = async (exec: Execution, paths: string[]) => {
    const owner = await transport.capture(); assertExecution(exec, owner)
    const log = exec.agent.session.snapshotEvents()
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
  const importProject = async (exec: Execution, options: any, owner: string, prepared: { fs: any; files: any[] }) => {
    if (!xinCall || !Number.isSafeInteger(options.scope.project_id) || options.scope.project_id < 1 || options.supersedes || !OPERATION.test(options.operationId)) fail('invalid-project-import')
    const call = async (name: string, args: Record<string, unknown>) => { assertExecution(exec, owner); const result = decodeXinReply(await xinCall(name, args, exec, exec.signal)); assertExecution(exec, owner); return result }
    const { fs, files } = prepared
    const sources = []
    for (const file of files) {
      const { bytes, sha256 } = await readOriginal(fs, file, exec.signal)
      const find = async () => call('find_imported_source', { project_id: options.scope.project_id, sha256, kind: 'knowledge', ...(file.graph_path ? { graph_path: file.graph_path } : {}) })
      let result: any
      try { result = await find() } catch (error: any) { if (error.code !== 'not-found') throw error }
      if (file.graph_path) {
        const old = events(exec.agent).find(event => event.kind === 'project-import-request' && event.owner === owner && event.batchId === options.operationId && event.target_key === file.target.targetKey)
        const source = result?.source
        const reused = file.source_ref ?? (source?.status === 'ready' && source.file_hash === sha256 && CANONICAL_UUID.test(source.id) && HASH.test(source.parse_revision)
          ? { source_id: source.id, source_version: source.file_hash, parse_revision: source.parse_revision } : undefined)
        const intent = old?.intent ?? { filename: file.filename, title: options.title ?? file.filename, publisher: options.publisher ?? '本人上传', kind: 'knowledge', project_id: options.scope.project_id, sha256, size: bytes.length, graph_path: file.graph_path, ...(reused ? { source_ref: reused } : {}) }
        if (old && digest(old.intent.graph_path) !== digest(file.graph_path)) fail('idempotency-conflict')
        if (!old) await persist(ctx, exec.agent, { kind: 'project-import-request', owner, batchId: options.operationId, projectId: options.scope.project_id, target_key: file.target.targetKey, sha256, filename: file.filename, intent })
        try {
          const prepared = await call('prepare_source_upload', { intent })
          if (prepared.source) result = prepared
          else {
            if (intent.source_ref || prepared.method !== 'PUT' || prepared.sha256 !== sha256 || prepared.size !== bytes.length || typeof prepared.upload_url !== 'string') fail('invalid-upload-ticket')
            result = await transport.uploadOriginal(owner, prepared.upload_url, bytes, exec.signal)
          }
        } catch (error: any) {
          exec.signal?.throwIfAborted()
          if (['conflict', 'idempotency-conflict', 'unauthorized', 'invalid-request', 'scope-changed'].includes(error.code)) throw error
          result = await find()
        }
        graphReceipt(result, file.graph_path, sha256)
        if (intent.source_ref && (result.source?.id !== intent.source_ref.source_id || result.source?.parse_revision !== intent.source_ref.parse_revision)) fail('source-changed')
      } else if (!result) {
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
      await persist(ctx, exec.agent, { kind: 'project-import-receipt', owner, batchId: options.operationId, projectId: options.scope.project_id, sourceId: source.id, sha256, ...(file.graph_path ? { graph_path: file.graph_path, ...graphReceipt(result, file.graph_path, sha256) } : {}) })
      sources.push(file.graph_path ? { ...source, ...graphReceipt(result, file.graph_path, sha256) } : source)
    }
    return { scope_key: owner, operation_id: options.operationId, scope: options.scope, sources }
  }
  const importFilesOnce = async (exec: Execution, options: ImportOptions, owner: string, request: any) => {
      const scope = options.scope ?? { kind: 'uploader-private' }
      const prior = events(exec.agent).find(event => event.kind === 'import-batch' && event.batchId === options.operationId && event.owner === owner)
      if (prior && digest(prior.request) !== digest(request)) fail('idempotency-conflict', '同一导入批次不能更换文件、范围或资料信息。')
      let provenance: any
      if (scope.kind === 'public') {
        const intentId = options.publicIntentId ?? await recordUserPublicIntent(exec, options.paths)
        const intent = events(exec.agent).find(event => event.kind === 'public-intent' && event.id === intentId && event.owner === owner && digest(event.paths) === digest(options.paths))
        if (!intent) fail('public-intent-required', '公共导入需要本次明确的公共知识库操作来源。')
        provenance = { kind: 'uploader_declared', classification: 'general_method', intent_receipt: { kind: intent.origin, id: intent.id } }
      }
      if (scope.kind === 'project') {
        if (prior && !HASH.test(prior.xin_subject ?? '') || !prior && events(exec.agent).some(event => ['project-import-request', 'project-import-receipt'].includes(event.kind) && event.batchId === options.operationId && event.owner === owner)) fail('xin-binding-missing')
        if (!bindXin) fail('project-unavailable')
        exec = { ...exec, xinSubject: await bindXin(exec, prior?.xin_subject ?? exec.xinSubject) }
        assertExecution(exec, owner)
      }
      const prepared = await prepareBatch(exec, options, owner, request)
      if (prepared.files.some(file => file.graph_path)) {
        const catalog = await transport.request(owner, 'GET', '/catalog', undefined, exec.signal)
        if (!Array.isArray(catalog.capabilities) || !catalog.capabilities.includes('graph-path-v1')
          || (scope.kind === 'project' || request.graph_files?.some((file: GraphFile) => file.source_ref)) && !catalog.capabilities.includes('import-source-ref-v1')) fail('graph-path-unavailable', '服务器尚未支持原目录知识关系，本批次未上传。')
      }
      if (scope.kind === 'project') return importProject(exec, options, owner, prepared)
      const { fs, files } = prepared
      if (options.supersedes && (files.length !== 1 || !UUID.test(options.supersedes.source_id) || !HASH.test(options.supersedes.source_version))) fail('invalid-replacement')
      const receipts = []
      for (const file of files) {
        assertExecution(exec, owner); transport.check(owner); exec.signal?.throwIfAborted()
        const { bytes, sha256 } = await readOriginal(fs, file, exec.signal)
        const operation_id = digest([options.operationId, file.target.targetKey, sha256])
        const request = { operation_id, filename: file.filename, title: options.title ?? file.filename, publisher: options.publisher ?? '本人上传', kind: 'knowledge', sha256, byte_length: bytes.length, scope, ...(provenance ? { provenance } : {}), ...(options.supersedes ? { supersedes: options.supersedes } : {}), ...(file.graph_path ? { graph_path: file.graph_path } : {}), ...(file.source_ref ? { source_ref: file.source_ref } : {}) }
        const previous = events(exec.agent).find(event => event.kind === 'import-request' && event.operationId === operation_id && event.owner === owner)
        if (previous && digest(previous.request) !== digest(request)) fail('idempotency-conflict')
        if (!previous) await persist(ctx, exec.agent, { kind: 'import-request', owner, batchId: options.operationId, operationId: operation_id, request })
        const frozen = previous?.request ?? events(exec.agent).findLast(event => event.kind === 'import-request' && event.operationId === operation_id && event.owner === owner).request
        let receipt = await findOrCreate(transport, owner, 'imports', frozen, previous !== undefined, exec.signal)
        if (!UUID.test(receipt.import_id) || receipt.operation_id !== operation_id || receipt.scope?.kind !== scope.kind || receipt.request_hash !== digest({ ...request, provenance: provenance ?? null, supersedes: options.supersedes ?? null })) fail('invalid-response')
        await persist(ctx, exec.agent, { kind: 'import-receipt', owner, operationId: operation_id, importId: receipt.import_id })
        if (file.graph_path) graphReceipt(receipt, file.graph_path, sha256)
        if (file.source_ref && receipt.status !== 'ready') fail('invalid-response')
        if (receipt.status === 'awaiting_content') {
          try { receipt = await transport.request(owner, 'PUT', `/imports/${receipt.import_id}/content`, bytes, exec.signal) }
          catch (error: any) { exec.signal?.throwIfAborted(); if (['conflict', 'idempotency-conflict', 'unauthorized'].includes(error.code)) throw error; receipt = await transport.request(owner, 'GET', `/imports/${receipt.import_id}`, undefined, exec.signal) }
        }
        if (file.source_ref && (receipt.source?.id !== file.source_ref.source_id || receipt.source?.file_hash !== file.source_ref.source_version || receipt.source?.parse_revision !== file.source_ref.parse_revision)) fail('source-changed')
        receipts.push({ import_id: receipt.import_id, operation_id, status: receipt.status, source: receipt.source, ...(file.graph_path ? graphReceipt(receipt, file.graph_path, sha256) : {}) })
      }
      return { scope_key: owner, operation_id: options.operationId, scope, imports: receipts }
  }
  return {
    recordUserPublicIntent,
    async importsStatus(exec: Execution, operationId: string, scope?: Scope) {
      const owner = await transport.capture(); assertExecution(exec, owner)
      if (!OPERATION.test(operationId)) fail('invalid-request')
      if (scope?.kind === 'project') {
        if (!xinCall || !Number.isSafeInteger(scope.project_id) || scope.project_id < 1) fail('invalid-project-import')
        const batch = events(exec.agent).find(event => event.kind === 'import-batch' && event.batchId === operationId && event.owner === owner)
        if (!HASH.test(batch?.xin_subject ?? '')) fail('xin-binding-missing')
        if (!bindXin) fail('project-unavailable')
        exec = { ...exec, xinSubject: await bindXin(exec, batch.xin_subject) }
        const hashes = new Set(events(exec.agent).filter(event => ['project-import-request', 'project-import-receipt'].includes(event.kind) && event.batchId === operationId && event.owner === owner && event.projectId === scope.project_id).map(event => event.sha256))
        const sources = []
        const manifest = events(exec.agent).find(event => event.kind === 'import-batch-files' && event.batchId === operationId && event.owner === owner)
        const files = manifest?.files.some((file: any) => file.graph_path) ? manifest.files : [...hashes].map(sha256 => ({ sha256 }))
        for (const file of files) {
          const sha256 = file.sha256
          const value = decodeXinReply(await xinCall('find_imported_source', { project_id: scope.project_id, sha256, kind: 'knowledge', ...(file.graph_path ? { graph_path: file.graph_path } : {}) }, exec, exec.signal))
          assertExecution(exec, owner)
          if (value.source?.file_hash !== sha256 || value.source?.project_id !== scope.project_id) fail('invalid-response')
          sources.push(file.graph_path ? { ...value.source, ...graphReceipt(value, file.graph_path, sha256) } : value.source)
        }
        return { scope_key: owner, operation_id: operationId, scope, sources }
      }
      const requests = events(exec.agent).filter(event => event.kind === 'import-request' && event.batchId === operationId && event.owner === owner)
      const imports = []
      for (const request of requests) {
        const value = await transport.request(owner, 'GET', '/imports?operation_id=' + request.operationId, undefined, exec.signal)
        if (value.operation_id !== request.operationId) fail('invalid-response')
        imports.push({ import_id: value.import_id, operation_id: value.operation_id, status: value.status, source: value.source, ...(request.request.graph_path ? graphReceipt(value, request.request.graph_path, request.request.sha256) : {}) })
      }
      return { scope_key: owner, operation_id: operationId, imports }
    },
    async recordPublicIntent(agent: any, paths: string[]) {
      const owner = await transport.capture(); assertExecution({ agent }, owner)
      if (!Array.isArray(paths) || paths.length < 1 || paths.some(path => typeof path !== 'string' || !path)) fail('invalid-files')
      const id = randomUUID()
      await persist(ctx, agent, { kind: 'public-intent', id, owner, paths, origin: 'public_library_action' })
      return id
    },
    async importFiles(exec: Execution, options: ImportOptions) {
      const owner = await transport.capture(); assertExecution(exec, owner)
      const request = batchRequest(options); const requestHash = digest(request); const key = owner + ':' + options.operationId
      const current = activeBatches.get(key)
      if (current) { if (current.requestHash !== requestHash) fail('idempotency-conflict'); const result = await current.promise; assertExecution(exec, owner); return result }
      const promise = importFilesOnce(exec, options, owner, request).finally(() => { activeBatches.delete(key) })
      activeBatches.set(key, { requestHash, promise })
      return promise
    },
  }
}
