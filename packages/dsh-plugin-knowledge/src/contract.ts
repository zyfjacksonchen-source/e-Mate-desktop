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
  'public-intent-required': '无法确认公共导入范围，未执行导入；原件仍保留在本机私有范围。',
  'submission-unknown': '此前提交结果未知，请回查原编译和子任务；暂不重新生成。',
  conflict: '任务或来源版本已变化，请回查原回执；不会覆盖其他修改。',
  'idempotency-conflict': '该操作编号已绑定其他内容，请保留并回查原回执。',
  'durability-unavailable': '无法可靠保存任务断点，已停止继续；请保留并回查现有回执。',
  'invalid-recovery-session': '原生会话与恢复回执不一致，已停止继续；现有回执已保留。',
  'agent-unavailable': '原生任务已不可用，请从知识页面或当前任务重新打开。',
  'model-unavailable': '当前模型暂不可调用，请检查企业授权和模型选择。',
  'model-selection-unavailable': '无法读取原生模型选择，尚未开始本次整理。',
  'model-changed': '本次模型选择与冻结记录不一致，已停止继续；请回查原任务。',
  'model-incomplete': '模型没有返回完整的结构化结果，请回查原子任务。',
  'invalid-model-output': '模型整理结果未通过结构和引用检查，尚未发布。',
  'invalid-citation': '引用未通过原文版本和位置检查，尚未发布。',
  'source-changed': '原件或解析版本已变化，请重新读取来源后继续。',
  'file-too-large': '单个原件超过 20 MiB，未导入该文件。',
  'too-many-files': '本次文件数量超过范围，请分批导入。',
  'empty-folder': '所选目录没有可导入的原件。',
  'outside-source-folder': '文件超出所选来源目录，未导入。',
  'invalid-file': '原件不是可读取的普通文件，未导入。',
  'invalid-files': '请选择有效的原件文件或文件夹。',
  'filesystem-unavailable': '当前原生任务无法读取本机文件。',
  'project-unavailable': '芯助手项目知识暂不可用，请检查本人连接和项目权限。',
  'invalid-project-import': '项目资料导入范围无效，未执行导入。',
  'invalid-upload-ticket': '原件上传凭据与文件身份不一致，已停止上传。',
  'commit-incomplete': '发布回执尚未完成，请回查同一知识任务。',
  'failed-compilation': '该知识任务已失败，请保留原回执后重新准备来源。',
  disposed: '知识服务已关闭，现有任务保留断点等待恢复。',
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
