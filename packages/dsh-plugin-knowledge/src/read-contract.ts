import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

const hash: JsonSchemaNode = { type: 'string', description: '真实的 64 位小写 SHA-256；不要将 corpus_revision 与 source_version 混用。' }
const id: JsonSchemaNode = { type: 'string', description: '已返回的真实 UUID，不按来源名称或其他 ID 猜测。' }
const scope: JsonSchemaNode = { type: 'string', enum: ['public', 'uploader-private'] }
const limit: JsonSchemaNode = { type: 'integer', description: '正整数；graph 最多 500，search 最多 20，其他最多 100。' }
const question: JsonSchemaNode = { type: 'string', description: '实际问题，最多 4000 字符。' }
type ReadOperation = { method: string; path: string; properties: Record<string, JsonSchemaNode>; required?: string[]; help: string }

/** One field contract serves both the model-visible schema and Host target allowlist. */
export const READ_OPERATIONS: Record<string, ReadOperation> = {
  catalog: { method: 'GET', path: '/catalog', properties: { scope }, help: 'catalog 仅接收可选 scope；返回 corpus_revision 用于核对查询快照。' },
  graph: { method: 'GET', path: '/graph', properties: { root_id: hash, depth: { type: 'integer', description: '0 至 2。' }, limit, corpus_revision: hash, scope }, help: 'graph 使用 root_id/depth/limit/corpus_revision/scope；复用查询时保留 corpus_revision。' },
  sources: { method: 'GET', path: '/sources', properties: { kind: { type: 'string', enum: ['knowledge', 'benchmark'] }, offset: { type: 'integer' }, limit, corpus_revision: hash, scope }, help: 'sources 列表使用 kind/offset/limit/corpus_revision/scope。' },
  source: { method: 'GET', path: '/sources', properties: { source_id: id, version: hash, scope }, required: ['source_id'], help: 'source 只接收 source_id、version、scope，返回来源元数据。把已知 source_version 填入 version，不传 corpus_revision；读取正文应使用返回的 node_id 调用 node。' },
  node: { method: 'GET', path: '/nodes', properties: { node_id: hash, version: hash, scope }, required: ['node_id'], help: 'node 只接收 node_id、version、scope，返回该节点正文。version 使用对应 source_version；不传 corpus_revision。' },
  search: { method: 'POST', path: '/search', properties: { question, limit, layer: { type: 'string', enum: ['expert', 'case', 'source'] }, corpus_revision: hash, scope }, help: 'search 使用 question/limit/layer/corpus_revision/scope；返回的 query_id 才能用于 evidence。' },
  benchmarks: { method: 'GET', path: '/benchmark', properties: { keyword: { type: 'string' } }, help: 'benchmarks 目录只接收 keyword。' },
  benchmark: { method: 'POST', path: '/benchmark', properties: { media: { type: 'string' }, industry: { type: 'string' }, metric: { type: 'string' }, period: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'], additionalProperties: false }, source_id: id, marketing_purpose: { type: 'string' } }, help: 'benchmark 使用 media/industry/metric/period/source_id/marketing_purpose；指标范围由知识服务核验。' },
  evidence: { method: 'GET', path: '/evidence', properties: { query_id: id, scope }, required: ['query_id'], help: 'evidence 只接收已返回的 query_id 和 scope；source_id、node_id、version 不能替代 query_id。没有查询 ID 时先执行对应查询。' },
  original: { method: 'GET', path: '/sources', properties: { source_id: id, version: hash, scope }, required: ['source_id', 'version'], help: 'original 只接收 source_id、version、scope，不接收 source_version 或 corpus_revision。它是原生知识页面的下载端点，不是 Agent 正文读取接口；正文优先用已知 node_id/version 的 node。' },
  revisions: { method: 'GET', path: '/revisions', properties: { question, limit, offset: { type: 'integer', description: '0 至 10000；后续分页必须保留原 corpus_revision。' }, corpus_revision: hash, scope }, help: 'revisions 列表使用 question/limit/offset/corpus_revision/scope；后续分页保留原 corpus_revision，revision_id 从实际结果取得。' },
  revision: { method: 'GET', path: '/revisions', properties: { revision_id: id }, required: ['revision_id'], help: 'revision 只接收已返回的 revision_id；不接收 source_id、version、corpus_revision 或 scope。没有修订 ID 时先用 revisions 查询。' },
  import: { method: 'GET', path: '/imports', properties: { operation_id: { type: 'string' } }, required: ['operation_id'], help: 'import 回查使用原 operation_id。' },
}
export const READ_ENDPOINTS = Object.keys(READ_OPERATIONS).filter(endpoint => endpoint !== 'import')
export function readRequestSchema(endpoint: string): JsonSchemaNode {
  const operation = READ_OPERATIONS[endpoint]!
  return { type: 'object', properties: operation.properties, additionalProperties: false,
    ...(operation.required ? { required: operation.required } : {}), description: operation.help }
}
export function readRequestError(endpoint: string) {
  return Object.assign(Error('知识读取参数不符合端点契约。'), { code: 'invalid-request', read_endpoint: endpoint })
}
