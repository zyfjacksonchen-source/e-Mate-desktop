import { decodeXinReply, fail, HASH, OPERATION, UUID, type Execution, type Scope } from './imports.ts'
import type { KnowledgeUiRead } from './ui-operations.ts'

type Reply = { scope_key: string; result: any }
type XinRead = { scope_key: string; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }
type Dependencies = {
  host: { call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<Reply> }
  workflow: { authorize(exec: Execution): Promise<string> }
  /** Trusted Host capture only: the native closure rejects account/connection epoch changes. */
  xinCapture(exec?: Execution): XinRead | Promise<XinRead>
}
const SOURCE_STATES = new Set(['draft', 'parsing', 'ready', 'error', 'deleted', 'superseded'])
function object(value: any): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function exact(value: any, keys: string[]) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-request')
}
function readScope(value: any): Scope {
  if (!object(value)) fail('invalid-request')
  if (value.kind === 'public' || value.kind === 'uploader-private') { exact(value, ['kind']); return { kind: value.kind } }
  exact(value, ['kind', 'project_id'])
  if (value.kind !== 'project' || !Number.isSafeInteger(value.project_id) || value.project_id < 1) fail('invalid-request')
  return { kind: 'project', project_id: value.project_id }
}
function sameScope(value: any, scope: Scope) {
  if (!object(value) || value.kind !== scope.kind || scope.kind === 'project' && value.project_id !== scope.project_id) fail('scope-changed')
}
function source(value: any, scope: Scope, id?: string, version?: string, allowShared = false) {
  if (!object(value) || !UUID.test(value.id) || !HASH.test(value.file_hash) || value.kind !== 'knowledge'
    || !SOURCE_STATES.has(value.status) || value.parse_revision != null && !HASH.test(value.parse_revision)) fail('invalid-response')
  // B's ProjectKnowledgeReader can cite an authorized shared original as well as
  // the selected project's originals. A project import lookup remains exact.
  if (scope.kind === 'project' && (!['xin', 'public'].includes(value.visibility)
    || value.project_id !== scope.project_id && !(allowShared && value.project_id === null))) fail('scope-changed')
  if (id !== undefined && value.id !== id || version !== undefined && value.file_hash !== version) fail('source-changed')
  return value
}
function revisions(value: any, scope: Scope, limit: number, revision?: string) {
  sameScope(value?.scope, scope)
  if (value.schema_version !== 1 || !HASH.test(value.corpus_revision) || !Array.isArray(value.items)
    || value.items.length > limit || typeof value.truncated !== 'boolean') fail('invalid-response')
  if (revision !== undefined && value.corpus_revision !== revision) fail('source-changed')
  const keys = new Set<string>()
  for (const item of value.items) {
    if (!object(item) || !UUID.test(item.revision_id) || typeof item.topic_key !== 'string' || !item.topic_key
      || keys.has(item.topic_key) || !Array.isArray(item.source_versions) || !item.source_versions.length
      || item.title !== undefined && (typeof item.title !== 'string' || !item.title || item.title.length > 300)) fail('invalid-response')
    keys.add(item.topic_key)
    for (const input of item.source_versions) if (!object(input) || !UUID.test(input.source_id) || !HASH.test(input.source_version) || !HASH.test(input.parse_revision)) fail('invalid-response')
  }
  return value
}

/** Fixed read adapters for the import UI; transport, authorization and credentials stay with their native owners. */
export function createKnowledgeUiRead({ host, workflow, xinCapture }: Dependencies): KnowledgeUiRead {
  return async ({ endpoint, payload, exec, signal }) => {
    signal?.throwIfAborted(); exec?.signal?.throwIfAborted()
    if (!['projects', 'source', 'import', 'revisions'].includes(endpoint)) fail('invalid-request')
    const owner = exec ? await workflow.authorize(exec) : undefined
    const check = async (key: string) => {
      signal?.throwIfAborted(); exec?.signal?.throwIfAborted()
      if (!HASH.test(key) || owner !== undefined && (key !== owner || await workflow.authorize(exec!) !== owner)) fail('scope-changed')
    }
    if (endpoint === 'projects') {
      exact(payload, [])
      const operation = await xinCapture(exec)
      await check(operation.scope_key)
      const value = decodeXinReply(await operation.call('query_knowledge_projects', { keyword: '' }, signal))
      await check(operation.scope_key)
      if (!object(value) || value.schema_version !== 1 || value.source !== 'xin-assistant'
        || !['complete', 'partial'].includes(value.status) || !Array.isArray(value.data)) fail('invalid-response')
      const seen = new Set<number>()
      const items = value.data.map((item: any) => {
        if (!object(item) || !Number.isSafeInteger(item.id) || item.id < 1 || seen.has(item.id)
          || typeof item.project_name !== 'string' || !item.project_name.trim() || typeof item.can_import !== 'boolean') fail('invalid-response')
        seen.add(item.id)
        return { id: item.id, title: item.project_name, can_import: item.can_import }
      })
      return { scope_key: operation.scope_key, result: { items, complete: value.status === 'complete' } }
    }
    // Source reads belong to a validated native operation Agent, never a renderer identity.
    if (!exec || owner === undefined) fail('unauthorized')
    exact(payload, endpoint === 'source' ? ['scope', 'source_id', 'version'] : endpoint === 'import' ? ['scope', 'operation_id', 'sha256'] : ['scope', 'question', 'limit', 'corpus_revision'])
    const scope = readScope(payload.scope)
    const args: Record<string, unknown> = {}
    if (endpoint === 'source') {
      if (typeof payload.source_id !== 'string' || !UUID.test(payload.source_id) || typeof payload.version !== 'string' || !HASH.test(payload.version)) fail('invalid-request')
      Object.assign(args, { source_id: payload.source_id, version: payload.version })
    } else if (endpoint === 'import') {
      if (scope.kind === 'project') {
        if (payload.operation_id !== undefined || typeof payload.sha256 !== 'string' || !HASH.test(payload.sha256)) fail('invalid-request')
        Object.assign(args, { project_id: scope.project_id, sha256: payload.sha256, kind: 'knowledge' })
      } else {
        if (payload.sha256 !== undefined || typeof payload.operation_id !== 'string' || !OPERATION.test(payload.operation_id)) fail('invalid-request')
        args.operation_id = payload.operation_id
      }
    } else {
      const limit = payload.limit ?? 100
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100
        || payload.question !== undefined && (typeof payload.question !== 'string' || payload.question.length > 4000)
        || payload.corpus_revision !== undefined && (typeof payload.corpus_revision !== 'string' || !HASH.test(payload.corpus_revision))) fail('invalid-request')
      Object.assign(args, { limit, ...(payload.question !== undefined ? { question: payload.question } : {}), ...(payload.corpus_revision !== undefined ? { corpus_revision: payload.corpus_revision } : {}) })
    }
    let reply: Reply
    if (scope.kind === 'project') {
      const operation = await xinCapture(exec)
      await check(operation.scope_key)
      const name = endpoint === 'source' ? 'inspect_source' : endpoint === 'import' ? 'find_imported_source' : 'list_knowledge_revisions'
      const parameters = endpoint === 'source' ? { source_id: args.source_id } : endpoint === 'revisions' ? { ...args, project_id: scope.project_id } : args
      reply = { scope_key: operation.scope_key, result: decodeXinReply(await operation.call(name, parameters, signal)) }
    } else {
      // B imports.lookup only accepts operation_id. Its receipt carries the actual original scope.
      reply = await host.call(endpoint, endpoint === 'import' ? args : { ...args, scope: scope.kind }, signal)
    }
    await check(reply.scope_key)
    const value = reply.result
    if (!object(value) || value.error || value.status === 'failed') fail('invalid-response')
    if (endpoint === 'source') source(value.source, scope, payload.source_id as string, payload.version as string, true)
    else if (endpoint === 'revisions') revisions(value, scope, args.limit as number, payload.corpus_revision as string | undefined)
    else if (scope.kind === 'project') {
      if (value.schema_version !== 1) fail('invalid-response')
      source(value.source, scope, undefined, payload.sha256 as string)
    } else {
      sameScope(value.scope, scope)
      if (value.schema_version !== 1 || value.operation_id !== args.operation_id || !UUID.test(value.import_id) || !HASH.test(value.request_hash)) fail('invalid-response')
      if (value.source === null) { if (value.status !== 'awaiting_content') fail('invalid-response') }
      else if (source(value.source, scope).status !== value.status) fail('invalid-response')
    }
    return reply
  }
}
