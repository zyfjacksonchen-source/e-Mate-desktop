import { randomUUID } from 'node:crypto'
import type { SessionPersistenceSnapshot } from '../../../upstream/deepseek-harness/packages/session/session-persistence'
import { digest, events, fail, graphOptions, graphReceipt, HASH, ownerOf, persist, UUID, type GraphOptions, type Execution, type Scope } from './imports.ts'

type Selection = { provider: string; model: string; reasoningEffort?: string }
export type ImportPhase = 'prepared' | 'importing' | 'parsing' | 'compiling' | 'complete' | 'partial' | 'paused' | 'stopping' | 'stopped' | 'unknown' | 'failed'
export interface ImportSource { key: string; name: string; sha256: string; status: string; source_id?: string; parse_revision?: string; graph_binding_status?: 'pending' | 'active' }
export interface UiImportStatus { operation_id: string; session_id: string; title: string; scope: Scope; model: { id: string; reasoning_effort: string }; phase: ImportPhase; sources: ImportSource[]; file_count?: number; compiled_count: number; compilation_session_id?: string; job_id?: string; reason?: string; updated_at: number }
type Reference = { operation_id: string; session_id: string }
type Marker = GraphOptions & { xin_subject?: string; kind: 'ui-import'; owner: string; operationId: string; batchId: string; paths: string[]; scope: Scope; title: string; selection: Selection; publicIntentId?: string; supersedes?: { source_id: string; source_version: string } }
type Plan = { operationId: string; sources: any[]; topics: any[]; replacements?: any[] }
type Entry = { agent: any; marker: Marker; controller: AbortController; jobId: string; done?: Promise<any>; stopping?: Promise<void>; userStop: boolean; shutdown: boolean; automatic: boolean; currentCompilation?: string }
export type KnowledgeUiRead = (request: { endpoint: string; payload: Record<string, unknown>; exec?: Execution; signal?: AbortSignal }) => Promise<{ scope_key: string; result: any }>
export const UI_IMPORT_MESSAGES: Record<string, string> = {
  'invalid-graph-path': '知识目录路径或绑定快照无效，未改变已有资料。',
  'graph-path-unavailable': '服务器尚未支持原目录知识关系，本批次未上传。',
  'xin-binding-missing': '旧项目任务缺少原芯助手账号绑定，未继续上传。请保留回执并在确认账号后发起新任务。',
  'scope-changed': '任务绑定的账号已变化，未继续上传。请切回原账号继续。',
  'too-many-files': '当前一次最多处理100份原件。大库自动分批尚未完成，请拆分选择；本任务不会标记为已完成。',
  'file-too-large': '单份原件不能超过20 MiB，请调整文件后重新发起。',
  'source-changed': '原件或解析版本已变化，已保留原批次回执；请核对原件后继续或发起新的明确操作。',
  'idempotency-conflict': '本次请求已冻结，不能更换原件或范围；已保留原回执。',
  'conflict': '知识版本已变化，已保留导入原件及完成部分，请核对现有知识。',
  'library-too-large': '现有知识关联超过本次处理上限；已保留导入回执，完整大库整理尚未闭合。',
  'submission-unknown': '模型提交结果未知，暂不重新生成；请查看原任务回执。',
  'project-unavailable': '项目连接暂不可用，请先通过外部连接授权芯助手。',
  'public-intent-required': '无法确认公共导入范围，未执行导入，原件仍保留在本机。',
  'unavailable': '知识任务暂未完成，已保留已有回执，可稍后继续。',
}
function exact(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-request')
}
function scopeOf(value: any): Scope {
  if (value === undefined) return { kind: 'uploader-private' }
  exact(value, value.kind === 'project' ? ['kind', 'project_id'] : ['kind'])
  if (value.kind === 'public' || value.kind === 'uploader-private') return { kind: value.kind }
  if (value.kind === 'project' && Number.isSafeInteger(value.project_id) && value.project_id > 0) return { kind: 'project', project_id: value.project_id }
  fail('invalid-request')
}
function sourceVersion(source: any) {
  if (!UUID.test(source?.id) || !HASH.test(source.file_hash) || !HASH.test(source.parse_revision) || source.status !== 'ready') fail('source-changed')
  return { source_id: source.id, source_version: source.file_hash, parse_revision: source.parse_revision }
}

/** UI admission and projection only; execution remains native Jobs, Sessions and the existing workflow. */
export function createKnowledgeUiOperations(ctx: any, { workflow, read, resolveSelection }: { workflow: any; read: KnowledgeUiRead; resolveSelection(exec?: Execution): Promise<Selection> }) {
  const identity = ctx.get('emateIdentity')
  let lifetime = new AbortController(), disposed = false, owner = ownerOf(identity), cursor = 0, recoveryCursor = 0
  let recoverySnapshots: SessionPersistenceSnapshot[] | undefined
  const handles = new Map<string, any>(), active = new Map<string, Entry>(), recent = new Map<string, UiImportStatus>()
  const loading = new Map<string, Promise<any>>(), scanned = new Map<string, string>()
  function changed() {
    const next = ownerOf(identity)
    if (next === owner) return
    owner = next; lifetime.abort(); lifetime = new AbortController(); cursor = 0; recoveryCursor = 0; recoverySnapshots = undefined; recent.clear(); scanned.clear()
    for (const entry of active.values()) { entry.shutdown = true; entry.controller.abort() }
  }
  function check(expected: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); changed()
    if (disposed || !expected || expected !== owner) fail('scope-changed')
  }
  async function capture(signal?: AbortSignal) {
    signal?.throwIfAborted(); if (!ownerOf(identity)) await identity.state?.(); changed()
    if (!owner || disposed) fail('unauthorized'); check(owner, signal); return owner
  }
  const markerOf = (agent: any, expected: string, id?: string): Marker => {
    const marker = events(agent).find(event => event.kind === 'ui-import' && event.owner === expected && (!id || event.operationId === id))
    if (!marker || !UUID.test(marker.operationId) || !UUID.test(marker.batchId) || !Array.isArray(marker.paths) || !marker.selection?.provider || !marker.selection?.model) fail('invalid-recovery-session')
    graphOptions(marker)
    return marker
  }
  function selectionFor(agent: any): Selection | undefined {
    changed(); const marker = events(agent).find(event => event.kind === 'ui-import')
    if (!marker) return undefined
    if (!owner || marker.owner !== owner || ctx.agents.get(agent.id) !== agent) fail('scope-changed')
    return structuredClone(markerOf(agent, owner).selection)
  }
  const progress = (agent: any, marker: Marker) => events(agent).findLast(event => event.kind === 'ui-import-progress' && event.operationId === marker.operationId) ?? { phase: 'prepared', sources: [], compiled_count: 0 }
  const control = (agent: any, marker: Marker) => events(agent).findLast(event => event.kind === 'ui-import-control' && event.operationId === marker.operationId)?.action
  function project(agent: any, marker: Marker): UiImportStatus {
    const state = progress(agent, marker), entry = active.get(marker.operationId)
    const manifest = events(agent).find(event => event.kind === 'import-batch-files' && event.batchId === marker.batchId && event.owner === marker.owner)
    const stopped = control(agent, marker) === 'stop'
    const view: UiImportStatus = { operation_id: marker.operationId, session_id: agent.id, title: marker.title, scope: marker.scope,
      model: { id: marker.selection.model, reasoning_effort: marker.selection.reasoningEffort ?? 'none' },
      phase: stopped && state.phase !== 'complete' ? entry ? 'stopping' : 'stopped' : state.phase === 'prepared' && (entry || ['start', 'resume'].includes(control(agent, marker))) ? entry ? 'importing' : 'paused' : state.phase,
      sources: state.sources ?? [], compiled_count: state.compiled_count ?? 0, ...(manifest ? { file_count: manifest.files.length } : {}),
      ...(entry ? { job_id: entry.jobId } : {}), ...(UUID.test(state.compilation_session_id ?? '') ? { compilation_session_id: state.compilation_session_id } : {}), ...(state.reason ? { reason: state.reason } : {}), updated_at: agent.session.snapshotEvents().at(-1)?.time ?? Date.now() }
    if (owner === marker.owner) { recent.set(marker.operationId, view); if (recent.size > 50) recent.delete([...recent.values()].sort((a, b) => a.updated_at - b.updated_at)[0].operation_id) }
    return structuredClone(view)
  }
  async function save(entry: Entry, patch: Record<string, unknown>) {
    const previous = progress(entry.agent, entry.marker)
    const data = { ...previous, ...patch, kind: 'ui-import-progress', owner: entry.marker.owner, operationId: entry.marker.operationId }
    if (digest(data) !== digest(previous)) await persist(ctx, entry.agent, data)
    project(entry.agent, entry.marker)
  }
  async function load(reference: any, expected: string, signal?: AbortSignal) {
    exact(reference, ['operation_id', 'session_id'])
    if (!UUID.test(reference.operation_id) || !UUID.test(reference.session_id)) fail('invalid-request')
    const key = expected + ':' + reference.session_id
    let agent = ctx.agents.get(reference.session_id)
    if (!agent) {
      let pending = loading.get(key)
      if (!pending) {
        pending = (async () => {
          const stored = await ctx.sessionPersistence.readFrom(reference.session_id, 0, signal); check(expected, signal)
          const marker = stored.events.find((event: any) => event.type === 'knowledge/workflow' && event.data.kind === 'ui-import' && event.data.owner === expected && event.data.operationId === reference.operation_id)?.data
          if (!marker?.selection) fail('invalid-recovery-session')
          const handle = await ctx.agents.resume({ resumeSessionId: reference.session_id, agentOptions: marker.selection, signal, setup(agentCtx: any) {
            agentCtx.tools.restrict({ allow: [] }); agentCtx.systemPrompt.suppressRuntimeContext()
            agentCtx.systemPrompt.section({ name: 'emate:ui-import', order: 0, complete: true, text: '本机知识导入协调任务，仅由已授权的知识工作流运行。' })
          } })
          try { check(expected, signal); handles.set(reference.session_id, handle); return handle.agent } catch (error) { await handle.dispose(); throw error }
        })().finally(() => loading.delete(key))
        loading.set(key, pending)
      }
      agent = await pending
    }
    check(expected, signal); await workflow.authorize({ agent, signal })
    return { agent, marker: markerOf(agent, expected, reference.operation_id) }
  }
  async function ownedRead(entry: Entry, endpoint: string, payload: Record<string, unknown>) {
    const exec = { agent: entry.agent, signal: entry.controller.signal, xinSubject: entry.marker.xin_subject }
    check(entry.marker.owner, exec.signal); await workflow.authorize(exec)
    const reply = await read({ endpoint, payload, exec, signal: exec.signal })
    check(entry.marker.owner, exec.signal)
    if (reply.scope_key !== entry.marker.owner) fail('scope-changed')
    return reply.result
  }
  async function sourceRows(entry: Entry): Promise<ImportSource[]> {
    const { agent, marker } = entry
    const manifest = events(agent).find(event => event.kind === 'import-batch-files' && event.batchId === marker.batchId && event.owner === marker.owner)
    if (!manifest) return []
    const rows: ImportSource[] = []
    for (const file of manifest.files) {
      const key = digest([marker.batchId, file.target_key, file.sha256])
      const row: ImportSource = { key, name: file.filename, sha256: file.sha256, status: 'unknown' }
      try {
        const result = await ownedRead(entry, 'import', marker.scope.kind === 'project' ? { sha256: file.sha256, scope: marker.scope, ...(file.graph_path ? { graph_path: file.graph_path } : {}) } : { operation_id: key, scope: marker.scope })
        if (file.graph_path) row.graph_binding_status = graphReceipt(result, file.graph_path, file.sha256).graph_binding_status
        const source = result.source
        if (source) {
          if (!UUID.test(source.id) || source.file_hash !== file.sha256) fail('source-changed')
          row.source_id = source.id; row.status = source.status === 'error' ? 'failed' : ['ready', 'parsing', 'failed', 'deleted', 'superseded'].includes(source.status) ? source.status : 'unknown'
          if (HASH.test(source.parse_revision ?? '')) row.parse_revision = source.parse_revision
          if (row.status === 'ready' && !row.parse_revision) row.status = 'unknown'
        } else row.status = result.status === 'awaiting_content' ? 'awaiting_content' : 'unknown'
      } catch (error: any) {
        check(marker.owner, entry.controller.signal)
        if (['unauthorized', 'scope-changed', 'source-changed', 'invalid-response', 'invalid-graph-path'].includes(error.code)) throw error
      }
      rows.push(row)
    }
    return rows
  }
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const off = ctx.timeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { off(); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
  async function plan(entry: Entry, rows: ImportSource[]): Promise<Plan[]> {
    const { marker, agent } = entry
    const previous: Plan[] = events(agent).filter(event => event.kind === 'ui-import-plan' && event.operationId === marker.operationId && event.owner === marker.owner).flatMap(event => event.plans)
    const ready = [...new Map(rows.filter(row => row.status === 'ready').map(row => [row.source_id!, { source_id: row.source_id!, source_version: row.sha256, parse_revision: row.parse_revision! }])).values()]
    const current = new Map(ready.map(source => [source.source_id, source]))
    const covered = new Set<string>()
    for (const task of previous) for (const source of task.sources) {
      if (current.has(source.source_id) && digest(current.get(source.source_id)) !== digest(source)) fail('source-changed')
      covered.add(source.source_id)
    }
    const additions = ready.filter(source => !covered.has(source.source_id))
    if (!additions.length) return previous
    const library: { items: any[] } = { items: [] }
    const topicKeys = new Set<string>(), revisionIds = new Set<string>()
    const sourceSet = digest(additions)
    let offset = 0, corpusRevision: string | undefined = events(agent).find(event => event.kind === 'ui-import-library-snapshot'
      && event.operationId === marker.operationId && event.owner === marker.owner && event.sourceSet === sourceSet)?.corpusRevision
    if (corpusRevision !== undefined && !HASH.test(corpusRevision)) fail('invalid-recovery-session')
    do {
      const page = await ownedRead(entry, 'revisions', { scope: marker.scope, limit: 100, offset, ...(corpusRevision ? { corpus_revision: corpusRevision } : {}) })
      if (!HASH.test(page.corpus_revision) || !Array.isArray(page.items) || page.items.length > 100
        || digest(page.scope) !== digest(marker.scope) || typeof page.truncated !== 'boolean') fail('invalid-response')
      if (corpusRevision && page.corpus_revision !== corpusRevision) fail('source-changed')
      if (!corpusRevision) {
        corpusRevision = page.corpus_revision
        await persist(ctx, agent, { kind: 'ui-import-library-snapshot', owner: marker.owner, operationId: marker.operationId, sourceSet, corpusRevision })
      }
      for (const item of page.items) {
        if (!UUID.test(item.revision_id) || typeof item.topic_key !== 'string' || !item.topic_key
          || topicKeys.has(item.topic_key) || revisionIds.has(item.revision_id)) fail('invalid-response')
        topicKeys.add(item.topic_key); revisionIds.add(item.revision_id); library.items.push(item)
      }
      if (!page.truncated) {
        if (page.next_offset != null) fail('invalid-response')
        break
      }
      if (!Number.isSafeInteger(page.next_offset) || page.items.length !== 100
        || page.next_offset !== offset + page.items.length || page.next_offset > 10000) fail('invalid-response')
      offset = page.next_offset
    } while (true)
    const topics = new Map<string, { key: string; title?: string; expected_revision_id: string | null; sources: any[] }>()
    for (const source of additions) {
      const priorId = marker.supersedes?.source_id ?? source.source_id
      const heads = library.items.filter((head: any) => Array.isArray(head.source_versions) && head.source_versions.some((item: any) => item.source_id === priorId))
      if (!heads.length) topics.set('source/' + source.source_id, { key: 'source/' + source.source_id, title: (marker.title === '导入并整理知识' ? rows.find(row => row.source_id === source.source_id)?.name ?? '知识来源' : marker.title).slice(0, 300), expected_revision_id: null, sources: [source] })
      for (const head of heads) {
        if (!UUID.test(head.revision_id) || typeof head.topic_key !== 'string') fail('invalid-response')
        const inputs = []
        for (const input of head.source_versions) {
          if (marker.supersedes && input.source_id === marker.supersedes.source_id) { inputs.push(source); continue }
          if (current.has(input.source_id)) { inputs.push(current.get(input.source_id)); continue }
          const details = await ownedRead(entry, 'source', { source_id: input.source_id, version: input.source_version, scope: marker.scope })
          const verified = sourceVersion(details.source)
          if (digest(verified) !== digest(input)) fail('source-changed')
          inputs.push(verified)
        }
        topics.set(head.topic_key, { key: head.topic_key, ...(typeof head.title === 'string' && head.title ? { title: head.title } : {}), expected_revision_id: head.revision_id, sources: inputs })
      }
    }
    const values = [...topics.values()]
    if (marker.supersedes && (ready.length !== 1 || values.length > 30)) fail('library-too-large')
    const plans: Plan[] = []
    for (let offset = 0; offset < values.length; offset += 30) {
      const group = values.slice(offset, offset + 30)
      const sources = [...new Map(group.flatMap(topic => topic.sources).map(source => [source.source_id, source])).values()]
      if (sources.length > 100) fail('library-too-large')
      plans.push({ operationId: randomUUID(), sources, topics: group.map(({ key, title, expected_revision_id }) => ({ key, ...(title ? { title } : {}), expected_revision_id })),
        ...(marker.scope.kind === 'project' && marker.supersedes ? { replacements: [{ ...marker.supersedes, replacement_source_id: ready[0].source_id }] } : {}) })
    }
    await persist(ctx, agent, { kind: 'ui-import-plan', owner: marker.owner, operationId: marker.operationId, plans })
    return [...previous, ...plans]
  }
  async function drive(entry: Entry, resume: boolean) {
    const { marker, agent, controller } = entry, exec = { agent, signal: controller.signal, xinSubject: marker.xin_subject }
    try {
      check(marker.owner, controller.signal)
      if (entry.userStop) throw new DOMException('stopped', 'AbortError')
      if (marker.scope.kind === 'project') {
        if (!HASH.test(marker.xin_subject ?? '')) fail('xin-binding-missing')
        await workflow.bindXin(exec, marker.xin_subject); check(marker.owner, controller.signal)
      }
      let rows = await sourceRows(entry)
      if (!rows.length || rows.some(row => !row.source_id)) {
        await save(entry, { phase: 'importing', reason: '', sources: rows })
        check(marker.owner, controller.signal)
        if (entry.userStop) throw new DOMException('stopped', 'AbortError')
        try { await workflow.importFiles(exec, { operationId: marker.batchId, paths: marker.paths, scope: marker.scope, ...graphOptions(marker),
          ...(marker.publicIntentId ? { publicIntentId: marker.publicIntentId } : {}), ...(marker.supersedes && marker.scope.kind !== 'project' ? { supersedes: marker.supersedes } : {}) }) }
        catch (error) { rows = await sourceRows(entry).catch(() => rows); await save(entry, { sources: rows }); throw error }
      }
      rows = await sourceRows(entry)
      if (!rows.length || rows.some(row => !row.source_id)) fail('submission-unknown')
      await save(entry, { phase: 'parsing', sources: rows })
      while (rows.some(row => row.status === 'parsing' || row.status === 'unknown')) {
        await sleep(2000, controller.signal); rows = await sourceRows(entry)
        await save(entry, { phase: 'parsing', sources: rows })
      }
      const plans = await plan(entry, rows)
      if (!plans.length) { await save(entry, { phase: 'partial', sources: rows, reason: '部分原件解析失败，尚无可整理来源。' }); return { status: 'failed', detail: '原件已保留，解析未完成。' } }
      await save(entry, { phase: 'compiling', sources: rows })
      const committedSources = new Set<string>(), committedTopics = new Set<string>()
      for (const task of plans) {
        check(marker.owner, controller.signal)
        if (entry.userStop) throw new DOMException('stopped', 'AbortError')
        let status: any
        try { status = await workflow.operationStatus(exec, task.operationId, marker.scope) } catch (error: any) { if (error.code !== 'not-found') throw error }
        if (!status) status = await workflow.start(exec, { operationId: task.operationId, sourceVersions: task.sources, topics: task.topics,
          model: { id: marker.selection.model, reasoning_effort: marker.selection.reasoningEffort ?? 'none' }, scope: marker.scope, ...(task.replacements ? { sourceReplacements: task.replacements } : {}) })
        entry.currentCompilation = status.compilation_id
        if (entry.userStop) { await workflow.stop({ agent }, status.compilation_id, marker.scope); throw new DOMException('stopped', 'AbortError') }
        await save(entry, { current_compilation: status.compilation_id, ...(status.session_id ? { compilation_session_id: status.session_id } : {}) })
        if (status.state !== 'committed' && !status.job_id) {
          if (!resume && status.state === 'paused') fail(status.checkpoint?.unknown_submission ? 'submission-unknown' : 'unavailable')
          status = await workflow.resume(exec, status.compilation_id, marker.scope, { automatic: entry.automatic })
        }
        while (status.state !== 'committed') {
          if (status.state === 'failed' || !status.job_id && status.state === 'paused') fail(status.checkpoint?.unknown_submission ? 'submission-unknown' : 'unavailable')
          await sleep(1000, controller.signal)
          status = await workflow.status(exec, entry.currentCompilation, marker.scope)
          if (status.state !== 'committed' && !status.job_id) {
            status = await workflow.status(exec, entry.currentCompilation, marker.scope)
            if (status.state !== 'committed' && !status.job_id) fail(status.checkpoint?.unknown_submission ? 'submission-unknown' : 'unavailable')
          }
        }
        if (digest(status.source_versions) !== digest(task.sources) || digest(status.topics) !== digest(task.topics)) fail('idempotency-conflict')
        for (const source of status.source_versions) committedSources.add(digest(source))
        for (const topic of status.topics) committedTopics.add(topic.key)
        await save(entry, { compiled_count: committedTopics.size })
      }
      rows = await sourceRows(entry)
      for (const row of rows.filter(row => row.status === 'ready')) {
        if (!committedSources.has(digest({ source_id: row.source_id, source_version: row.sha256, parse_revision: row.parse_revision }))) fail('source-changed')
      }
      const partial = rows.some(row => row.status !== 'ready' || row.graph_binding_status === 'pending')
      await save(entry, { phase: partial ? 'partial' : 'complete', reason: partial ? '可用来源已整理发布；仍有原件未完成，未标记为全部完成。' : '', sources: rows })
      return { status: partial ? 'failed' : 'completed', detail: partial ? '部分原件未完成。' : '原件已导入并整理发布。' }
    } catch (error: any) {
      const phase = entry.userStop ? 'stopped' : entry.shutdown || controller.signal.aborted ? 'paused' : error?.code === 'submission-unknown' ? 'unknown' : (progress(agent, marker).sources?.some((source: ImportSource) => source.source_id) || progress(agent, marker).compiled_count > 0) ? 'partial' : 'failed'
      await save(entry, { phase, reason: entry.userStop ? '用户已停止，原件及已有成果保留。' : UI_IMPORT_MESSAGES[error?.code] ?? UI_IMPORT_MESSAGES.unavailable })
      return { status: entry.userStop || controller.signal.aborted ? 'killed' : 'failed', detail: '本机知识任务已保留回执。' }
    }
  }
  async function userStop(entry: Entry) {
    if (entry.stopping) return entry.stopping
    entry.userStop = true
    entry.stopping = (async () => {
      try {
        await persist(ctx, entry.agent, { kind: 'ui-import-control', owner: entry.marker.owner, operationId: entry.marker.operationId, action: 'stop' })
        if (entry.currentCompilation) await workflow.stop({ agent: entry.agent }, entry.currentCompilation, entry.marker.scope)
      }
      finally { entry.controller.abort() }
    })()
    return entry.stopping
  }
  function launch(agent: any, marker: Marker, resume: boolean, automatic = false) {
    check(marker.owner)
    const current = active.get(marker.operationId); if (current) return project(agent, marker)
    const controller = new AbortController()
    const entry: Entry = { agent, marker, controller, jobId: '', userStop: false, shutdown: false, automatic, currentCompilation: progress(agent, marker).current_compilation }
    const epoch = lifetime.signal
    const shutdown = () => { entry.shutdown = true; controller.abort() }
    epoch.addEventListener('abort', shutdown, { once: true })
    active.set(marker.operationId, entry)
    try {
      entry.jobId = ctx.jobs.start({ kind: 'knowledge-import', label: marker.title, owner: agent, run() {
        entry.done = drive(entry, resume).finally(() => { active.delete(marker.operationId); epoch.removeEventListener('abort', shutdown); project(agent, marker) })
        return { done: entry.done, cancel(reason?: string) {
          if (disposed || reason === 'owner disposed' || reason === 'jobs service disposed') { entry.shutdown = true; controller.abort() }
          else void userStop(entry).catch(() => controller.abort())
        } }
      } })
    } catch (error) { active.delete(marker.operationId); epoch.removeEventListener('abort', shutdown); throw error }
    return project(agent, marker)
  }
  async function scan(expected: string, signal?: AbortSignal, forRecovery = false) {
    let candidate: Reference | undefined
    let snapshots = forRecovery ? recoverySnapshots : undefined
    if (!snapshots) {
      snapshots = await ctx.sessionPersistence.listSnapshots(signal) as SessionPersistenceSnapshot[]; check(expected, signal)
      snapshots.sort((a, b) => b.header.createdAt - a.header.createdAt)
      if (forRecovery) { recoverySnapshots = snapshots; recoveryCursor = 0 }
    }
    // Reading the recent-task panel must not advance background recovery.
    let offset = forRecovery ? recoveryCursor : cursor
    if (offset >= snapshots.length) offset = 0
    const batch = snapshots.slice(offset, offset + 24); offset += batch.length
    if (forRecovery) recoveryCursor = offset
    else cursor = offset
    for (const item of batch) {
      if (item.header.parentSession || !forRecovery && scanned.get(item.header.id) === item.revision) continue
      const stored = await ctx.sessionPersistence.readFrom(item.header.id, 0, signal).catch(() => undefined); check(expected, signal)
      if (stored) { scanned.set(item.header.id, item.revision); if (scanned.size > 1024) scanned.delete(scanned.keys().next().value!) }
      const marker = stored?.events.find((event: any) => event.type === 'knowledge/workflow' && event.data.kind === 'ui-import' && event.data.owner === expected)?.data
      if (!marker) continue
      const viewAgent = ctx.agents.get(item.header.id) ?? { id: item.header.id, session: { events: stored.events } }
      try {
        markerOf(viewAgent, expected)
        const view = project(viewAgent, marker)
        // Execution candidates come from this bounded physical scan, not the
        // twenty-row UI projection. Recheck unchanged records on recovery passes.
        if (forRecovery && !candidate && ['importing', 'parsing', 'compiling', 'paused'].includes(view.phase) && control(viewAgent, marker) !== 'stop') {
          candidate = { operation_id: view.operation_id, session_id: view.session_id }
        }
      } catch { /* Invalid local operation records never become successful UI rows. */ }
    }
    const hasMore = offset < snapshots.length
    if (forRecovery && !hasMore) { recoverySnapshots = undefined; recoveryCursor = 0 }
    return { list: { items: [...recent.values()].sort((a, b) => b.updated_at - a.updated_at).slice(0, 20), has_more: hasMore }, candidate }
  }
  return {
    changed, selectionFor,
    async call(endpoint: string, payload: any, signal?: AbortSignal) {
      const expected = await capture(signal)
      if (endpoint === 'ui.import.prepare') {
        exact(payload, ['paths', 'scope', 'title', 'supersedes', 'graph_files', 'graph_root'])
        let graph = graphOptions(payload)
        if (Array.isArray(payload.paths) && payload.paths.length > 100) fail('too-many-files')
        if (!Array.isArray(payload.paths) || !payload.paths.length || payload.paths.some((path: any) => typeof path !== 'string' || !path || path.length > 4096)) fail('invalid-files')
        if (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.length > 300)) fail('invalid-request')
        const scope = scopeOf(payload.scope)
        if (payload.supersedes) { exact(payload.supersedes, ['source_id', 'source_version']); if (!UUID.test(payload.supersedes.source_id) || !HASH.test(payload.supersedes.source_version)) fail('invalid-replacement') }
        const selection = await resolveSelection(); check(expected, signal)
        const agent = await workflow.openOperation(selection, signal); check(expected, signal)
        if (!graph.graph_files && !graph.graph_root && payload.paths.length === 1 && !payload.supersedes) {
          const fs = agent.ctx.get('fs'); const target = await fs.resolve(payload.paths[0], { cwd: agent.session.header.cwd, signal })
          if ((await fs.stat(target, signal))?.type === 'directory') {
            // A folder keeps its namespace across later batches; the native account and scope are part of its identity.
            const id = digest(['knowledge-folder', expected, scope, target.targetKey])
            const namespace_id = `${id.slice(0, 8)}-${id.slice(8, 12)}-5${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`
            graph = { graph_root: { path: payload.paths[0], namespace_id, layer: 'source' } }
          }
        }
        if (payload.supersedes) {
          if (payload.paths.length !== 1) fail('invalid-replacement')
          const fs = agent.ctx.get('fs'); const target = await fs.resolve(payload.paths[0], { signal })
          if ((await fs.stat(target, signal))?.type !== 'file') fail('invalid-replacement')
        }
        const xinSubject = scope.kind === 'project' ? await workflow.bindXin({ agent, signal }) : undefined
        check(expected, signal)
        const operationId = randomUUID(), batchId = randomUUID()
        const publicIntentId = scope.kind === 'public' ? await workflow.recordPublicIntent(agent, payload.paths) : undefined
        check(expected, signal)
        const marker: Marker = { kind: 'ui-import', owner: expected, operationId, batchId, paths: [...payload.paths], scope, ...graph, title: payload.title?.trim() || '导入并整理知识', selection,
          ...(xinSubject ? { xin_subject: xinSubject } : {}), ...(publicIntentId ? { publicIntentId } : {}), ...(payload.supersedes ? { supersedes: payload.supersedes } : {}) }
        await persist(ctx, agent, marker); check(expected, signal)
        return { scope_key: expected, result: project(agent, marker) }
      }
      if (endpoint === 'ui.import.recent') { exact(payload, []); return { scope_key: expected, result: (await scan(expected, signal)).list } }
      if (endpoint === 'ui.import.projects') { exact(payload, []); const result = await read({ endpoint: 'projects', payload: {}, signal }); check(expected, signal); if (result.scope_key !== expected) fail('scope-changed'); return result }
      if (!['ui.import.start', 'ui.import.status', 'ui.import.stop', 'ui.import.resume'].includes(endpoint)) fail('invalid-request')
      const { agent, marker } = await load(payload, expected, signal)
      const settling = active.get(marker.operationId)
      if (endpoint === 'ui.import.resume' && settling && !['importing', 'parsing', 'compiling'].includes(progress(agent, marker).phase)) { await settling.done; check(expected, signal) }
      if (endpoint === 'ui.import.stop') {
        const entry = active.get(marker.operationId)
        if (entry) { await userStop(entry); await entry.done }
        else {
          await persist(ctx, agent, { kind: 'ui-import-control', owner: expected, operationId: marker.operationId, action: 'stop' })
          const id = progress(agent, marker).current_compilation
          if (id) await workflow.stop({ agent, signal }, id, marker.scope)
        }
      }
      if (endpoint === 'ui.import.start' && progress(agent, marker).phase === 'prepared' && control(agent, marker) !== 'stop' || endpoint === 'ui.import.resume') {
        await persist(ctx, agent, { kind: 'ui-import-control', owner: expected, operationId: marker.operationId, action: endpoint === 'ui.import.resume' ? 'resume' : 'start' })
        check(expected, signal)
        launch(agent, marker, endpoint === 'ui.import.resume')
      }
      check(expected, signal); return { scope_key: expected, result: project(agent, marker) }
    },
    async recover(signal?: AbortSignal, restart = false) {
      if (restart) { recoverySnapshots = undefined; recoveryCursor = 0 }
      try {
        const expected = await capture(signal); const { list, candidate } = await scan(expected, signal, true)
        if (active.size) return list
        if (candidate) {
          const { agent, marker } = await load(candidate, expected, signal)
          if (control(agent, marker) !== 'stop') launch(agent, marker, true, true)
        }
        return list
      } catch (error) { recoverySnapshots = undefined; recoveryCursor = 0; throw error }
    },
    async dispose() {
      disposed = true; lifetime.abort(); recoverySnapshots = undefined; recoveryCursor = 0
      for (const entry of active.values()) { entry.shutdown = true; entry.controller.abort() }
      await Promise.allSettled([...active.values()].map(entry => entry.done))
      await Promise.allSettled([...loading.values()]); await Promise.allSettled([...handles.values()].map(handle => handle.dispose())); handles.clear(); recent.clear(); scanned.clear()
    },
  }
}
