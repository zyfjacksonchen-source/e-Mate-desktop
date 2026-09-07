import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { digest, fail, HASH, OPERATION, UUID, type Execution, type Scope } from './imports.ts'
import { knowledgeFailure, type CallKnowledge } from './contract.ts'
import type { createKnowledgeWorkflow } from './workflow.ts'

type Workflow = ReturnType<typeof createKnowledgeWorkflow> & {
  operationStatus(exec: Execution, operationId: string, scope?: Scope): Promise<unknown>
}
const READ_ENDPOINTS = ['catalog', 'graph', 'sources', 'source', 'node', 'search', 'benchmarks', 'benchmark', 'evidence', 'original', 'revisions', 'revision'] as const
const fields: Record<string, readonly string[]> = {
  read: ['action', 'endpoint', 'request'],
  import: ['action', 'paths', 'scope', 'title', 'publisher', 'supersedes', 'graph_files', 'graph_root', 'batch_key'],
  compile: ['action', 'source_versions', 'topics', 'scope', 'benchmark_query_ids', 'source_replacements', 'batch_key'],
  'import-status': ['action', 'operation_id', 'scope'],
  status: ['action', 'operation_id', 'compilation_id', 'scope'],
  resume: ['action', 'compilation_id', 'scope'],
  stop: ['action', 'compilation_id', 'scope'],
}
const string = (maximum: number): JsonSchemaNode => ({ type: 'string', description: `非空文本，最多 ${maximum} 字符；范围由现有知识服务核验。` })
const id: JsonSchemaNode = { type: 'string', description: '真实来源或任务 UUID。' }
const hash: JsonSchemaNode = { type: 'string', description: '准确的 64 位小写 SHA-256 版本。' }
const scopeSchema: JsonSchemaNode = { oneOf: [
  { type: 'object', properties: { kind: { type: 'string', enum: ['public', 'uploader-private'] } }, required: ['kind'], additionalProperties: false },
  { type: 'object', properties: { kind: { type: 'string', const: 'project' }, project_id: { type: 'integer' } }, required: ['kind', 'project_id'], additionalProperties: false },
] }
const sourceVersion: JsonSchemaNode = { type: 'object', properties: { source_id: id, source_version: hash, parse_revision: hash }, required: ['source_id', 'source_version', 'parse_revision'], additionalProperties: false }
const sourceReplacement: JsonSchemaNode = { type: 'object', properties: { source_id: id, source_version: hash, replacement_source_id: id }, required: ['source_id', 'source_version', 'replacement_source_id'], additionalProperties: false }
const graphPath: JsonSchemaNode = { type: 'object', additionalProperties: false, properties: {
  namespace_id: id, relative_path: string(500), layer: { type: 'string', enum: ['expert', 'case', 'source'] },
  expected_binding: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { binding_revision: hash, source_id: id, source_version: hash }, required: ['binding_revision', 'source_id', 'source_version'] }] },
}, required: ['namespace_id', 'relative_path', 'layer', 'expected_binding'] }
const parameters: JsonSchemaNode = {
  type: 'object', required: ['action'], additionalProperties: false,
  properties: {
    action: { type: 'string', enum: Object.keys(fields) }, endpoint: { type: 'string', enum: [...READ_ENDPOINTS] },
    request: { type: 'object', additionalProperties: false, properties: {
      root_id: hash, depth: { type: 'integer' }, limit: { type: 'integer' }, corpus_revision: hash, offset: { type: 'integer' },
      kind: { type: 'string', enum: ['knowledge', 'benchmark'] }, source_id: id, version: hash, node_id: hash, query_id: id, revision_id: id,
      scope: { type: 'string', enum: ['public', 'uploader-private'] }, question: string(4000), keyword: { type: 'string' },
      layer: { type: 'string', enum: ['expert', 'case', 'source'] }, media: string(80), industry: string(200), metric: string(120), marketing_purpose: string(80),
      period: { type: 'object', properties: { start: string(10), end: string(10) }, required: ['start', 'end'], additionalProperties: false },
    } },
    paths: { type: 'array', items: string(4096), description: '本次完整的 1 至 100 个文件或目录路径。' }, scope: scopeSchema,
    batch_key: { type: 'string', description: '同一用户消息需要多个导入或编译批次时，为每批指定固定标识，如 public-001。限 1 至 64 位英文字母、数字、下划线、短横线，首位字母或数字。同批重试保持此值及完整输入；结果未知先回查原 operation_id，不换标识重放。单批可省略。' },
    title: string(300), publisher: string(300),
    graph_files: { type: 'array', description: '逐文件冻结的原目录关系，与graph_root互斥。source_ref只使用已核实ready原件，不能猜测版本。', items: { type: 'object', additionalProperties: false, properties: { path: string(4096), graph_path: graphPath, source_ref: sourceVersion }, required: ['path', 'graph_path'] } },
    graph_root: { type: 'object', additionalProperties: false, description: '文件夹根及跨批次复用的命名空间；保留根内Markdown相对路径。初次绑定expected_binding为null，冲突须回查。', properties: { path: string(4096), namespace_id: id, layer: { type: 'string', enum: ['expert', 'case', 'source'] } }, required: ['path', 'namespace_id', 'layer'] },
    supersedes: { type: 'object', properties: { source_id: id, source_version: hash }, required: ['source_id', 'source_version'], additionalProperties: false },
    source_versions: { type: 'array', items: sourceVersion },
    topics: { type: 'array', items: { type: 'object', properties: { key: string(160), expected_revision_id: { oneOf: [id, { type: 'null' }] } }, required: ['key'], additionalProperties: false } },
    benchmark_query_ids: { type: 'array', items: id }, source_replacements: { type: 'array', items: sourceReplacement },
    operation_id: { type: 'string', description: '回查时使用已经返回的原操作编号。' }, compilation_id: id,
  },
}
assertSupportedJsonSchema(parameters)

/** Identity and message provenance come only from the actual native root call. */
function nativeCall(ctx: any, exec: any) {
  if (!exec.agent || typeof exec.rootCallId !== 'string' || ctx.agents.get(exec.agent.id) !== exec.agent) fail('unauthorized')
  const call = exec.agent.session.events.findLast((event: any) => event.type === 'tool/call' && event.data.callId === exec.rootCallId)
  if (!call) fail('unauthorized')
  return call
}
function operationId(exec: any, call: any, action: 'import' | 'compile', owner: string, batchKey?: string) {
  const session = exec.agent.session
  const start = session.events.find((event: any) => event.type === 'turn/start' && event.data.turn === call.data.turn)
  const message = start && session.events.findLast((event: any) => event.seq > start.seq && event.seq < call.seq && event.type === 'user/message' && event.data.source?.kind === 'user')
  if (typeof session.header.id !== 'string' || !session.header.id || typeof message?.data.id !== 'string' || !message.data.id) fail('invalid-request')
  const identity = ['enterprise_knowledge', owner, session.header.id, message.data.id, action]
  if (batchKey !== undefined) identity.push(batchKey)
  return digest(identity)
}
const PRIVATE_FIELDS = new Set(['leasetoken', 'accesstoken', 'refreshtoken', 'idtoken', 'clientsecret', 'authorization', 'oauth', 'uploadurl'])
function publicValue(value: unknown, depth = 0): void {
  if (depth > 64) fail('invalid-response')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(key.replace(/[-_]/g, '').toLowerCase())) fail('invalid-response')
    publicValue(child, depth + 1)
  }
}
/** One native Tool; the injected owners retain transport, operation persistence and execution. */
export function registerKnowledgeAgentTools(ctx: any, { workflow, read }: { workflow: Workflow; read: CallKnowledge }) {
  return ctx.tools.register({
    name: 'enterprise_knowledge',
    description: '读取企业知识、原件和同一版本证据；导入本次用户指定的完整文件或目录批次，并用本机原生任务编译主题。默认上传者私有；公共库必须有明确用户用途，客户资料使用已授权的 project。一次用户消息的同种导入/编译共用操作编号，请一次传完整批次，冲突时回查原操作。模型和身份由宿主确定，不传凭据或地址。',
    parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args: any, execution: any) {
      const exec = { ...execution, rootCallId: execution.rootCallId ?? execution.callId }
      let owner: string | undefined
      const verify = async () => {
        const current = await workflow.authorize(exec)
        if (!HASH.test(current) || owner !== undefined && current !== owner) fail('scope-changed')
        owner ??= current
      }
      const checked = async (task: () => Promise<any>) => {
        await verify()
        let result: any
        try { result = await task() } catch (error) { await verify(); throw error }
        await verify()
        return result
      }
      try {
        const call = nativeCall(ctx, exec)
        await verify()
        if (validateJsonSchemaValue(parameters, args).length) fail('invalid-request')
        if (!fields[args.action] || Object.keys(args).some(key => !fields[args.action]!.includes(key))) fail('invalid-request')
        if (args.batch_key !== undefined && (typeof args.batch_key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(args.batch_key))) fail('invalid-request')
        const scope = args.scope ?? { kind: 'uploader-private' }
        let result: any
        if (args.action === 'read') {
          if (!READ_ENDPOINTS.includes(args.endpoint)) fail('invalid-request')
          const reply = await checked(() => read(args.endpoint, args.request ?? {}, exec.signal))
          if (reply?.scope_key !== owner) fail('scope-changed')
          result = reply.result
        } else if (args.action === 'import') {
          if (!Array.isArray(args.paths) || !args.paths.length) fail('invalid-request')
          const batch = operationId(exec, call, 'import', owner!, args.batch_key)
          const publicIntentId = scope.kind === 'public' ? await checked(() => workflow.recordUserPublicIntent(exec, args.paths)) : undefined
          result = await checked(() => workflow.importFiles(exec, { paths: args.paths, operationId: batch, scope,
            ...(args.graph_files !== undefined ? { graph_files: args.graph_files } : {}), ...(args.graph_root !== undefined ? { graph_root: args.graph_root } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}), ...(args.publisher !== undefined ? { publisher: args.publisher } : {}),
            ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}), ...(publicIntentId ? { publicIntentId } : {}) }))
          if (result.operation_id !== undefined && result.operation_id !== batch) fail('invalid-response')
          result = { ...result, operation_id: batch }
        } else if (args.action === 'compile') {
          if (!Array.isArray(args.source_versions) || !args.source_versions.length || !Array.isArray(args.topics) || !args.topics.length || typeof ctx.emateKnowledgeSelection !== 'function') fail('invalid-request')
          const selected = await checked(() => Promise.resolve(ctx.emateKnowledgeSelection(exec)))
          const effort = selected?.reasoningEffort ?? 'none'
          if (typeof selected?.provider !== 'string' || !selected.provider || selected.provider.length > 128 || typeof selected.model !== 'string' || !selected.model || selected.model.length > 128 || typeof effort !== 'string' || !effort || effort.length > 64) fail('invalid-response')
          result = await checked(() => workflow.start(exec, { operationId: operationId(exec, call, 'compile', owner!, args.batch_key), sourceVersions: args.source_versions, topics: args.topics, scope,
            model: { id: selected.model, reasoning_effort: effort }, benchmarkQueryIds: args.benchmark_query_ids ?? [],
            ...(args.source_replacements !== undefined ? { sourceReplacements: args.source_replacements } : {}) }))
        } else if (args.action === 'import-status') {
          if (!OPERATION.test(args.operation_id ?? '')) fail('invalid-request')
          result = await checked(() => workflow.importsStatus(exec, args.operation_id, args.scope))
        } else if (args.action === 'status' && args.operation_id !== undefined) {
          if (args.compilation_id !== undefined || !OPERATION.test(args.operation_id)) fail('invalid-request')
          result = await checked(() => workflow.operationStatus(exec, args.operation_id, args.scope))
        } else {
          if (!UUID.test(args.compilation_id ?? '')) fail('invalid-request')
          result = await checked(() => args.action === 'status' ? workflow.status(exec, args.compilation_id, args.scope)
            : args.action === 'resume' ? workflow.resume(exec, args.compilation_id, args.scope) : workflow.stop(exec, args.compilation_id, args.scope))
        }
        await verify()
        if (result === undefined || result === null) fail('invalid-response')
        if (result.scope_key !== undefined && result.scope_key !== owner) fail('scope-changed')
        publicValue(result)
        return { schema_version: 1, status: 'success', value: { scope_key: owner, result } }
      } catch (error) { return knowledgeFailure(error) }
    },
  })
}
