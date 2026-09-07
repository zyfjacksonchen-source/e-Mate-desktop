export const CHANNEL = '/emate.knowledge'
export const API_ROOT = 'https://mvdcm.ecoremedia.net/ecorex-agent/client/knowledge/v1'
export const GRAPH_MODULE = '@e-mate/dsh-plugin-knowledge/graph'
export const GRAPH_ASSET = '/emate-knowledge-assets/graph.js'
export const MAX_NODES = 500
export const HASH = /^[a-f0-9]{64}$/u
export const SOURCE_ID = /^[a-f0-9-]{36}$/u
export interface KnowledgeNode { id: string; title: string; source_id: string; source_version: string; layer: string; revision_id?: string }
export interface KnowledgeEdge { from: string; to: string; kind: string; source_id: string }
export interface KnowledgeGraph { schema_version: 1; scope: { kind: 'public' }; corpus_revision: string; nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; truncated: boolean }
export interface KnowledgeReply { scope_key: string; result: any }
export type CallKnowledge = (endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<KnowledgeReply>

export function parseGraph(value: any): KnowledgeGraph {
  if (value?.schema_version !== 1 || value.scope?.kind !== 'public' || !HASH.test(value.corpus_revision)
    || !Array.isArray(value.nodes) || value.nodes.length > MAX_NODES || !Array.isArray(value.edges) || value.edges.length > 20000
    || typeof value.truncated !== 'boolean') throw Error('知识图谱响应无效。')
  const ids = new Set<string>()
  for (const node of value.nodes) {
    if (typeof node.id !== 'string' || !HASH.test(node.id) || ids.has(node.id) || typeof node.title !== 'string' || node.title.length > 500
      || typeof node.source_id !== 'string' || typeof node.source_version !== 'string' || !SOURCE_ID.test(node.source_id) || !HASH.test(node.source_version) || !['expert', 'case', 'source'].includes(node.layer) || (node.revision_id !== undefined && (typeof node.revision_id !== 'string' || !SOURCE_ID.test(node.revision_id)))) throw Error('知识节点身份无效。')
    ids.add(node.id)
  }
  for (const edge of value.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || typeof edge.kind !== 'string' || typeof edge.source_id !== 'string' || !SOURCE_ID.test(edge.source_id)) throw Error('知识关系响应无效。')
  }
  return value
}

export const FAILURE_MESSAGES = {
  'invalid-request': '知识请求参数无效。', 'invalid-response': '知识服务响应无效，请重试。',
  'scope-changed': '登录账号已变化，请重新加载企业知识。', unauthorized: '当前账号暂不可读取企业知识，请确认登录与访问权限。',
  'revision-conflict': '资料版本已变化，请刷新后重新打开。', 'not-found': '资料不存在或当前不可读。',
  unavailable: '企业知识暂不可用，请稍后重试。', integrity: '原件版本核验失败。',
  'response-too-large': '知识响应超过读取上限。', cancelled: '知识请求已取消。',
} as const
export function knowledgeFailure(error: any) {
  const code: keyof typeof FAILURE_MESSAGES = error?.name === 'AbortError' ? 'cancelled'
    : typeof error?.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, error.code) ? error.code : 'unavailable'
  return { schema_version: 1, status: 'failure', error: { code, message: FAILURE_MESSAGES[code] } }
}
export function parseKnowledgeRpc(response: any): KnowledgeReply {
  const value = response?.ok === true ? response.value : undefined
  if (value?.schema_version === 1 && value.status === 'success' && typeof value.value?.scope_key === 'string' && HASH.test(value.value.scope_key)) return value.value
  const failure = value?.schema_version === 1 && value.status === 'failure' ? knowledgeFailure(value.error) : knowledgeFailure({ code: 'invalid-response' })
  throw Object.assign(Error(failure.error.message), { code: failure.error.code })
}
