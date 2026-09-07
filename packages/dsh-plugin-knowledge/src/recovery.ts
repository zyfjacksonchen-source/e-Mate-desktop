import { digest, OPERATION, ownerOf, UUID, type Scope, type Execution } from './imports.ts'

const EVENT = 'knowledge/workflow'
const READ_BATCH = 24
const RECENT_LIMIT = 100
const CACHE_LIMIT = 1024

type Selection = { provider: string; model: string; reasoningEffort?: string }
type Candidate = { sessionId: string; compilationId: string; operationId?: string; owner: string; selection: Selection; scope?: Scope; time: number; stopped: boolean; unknown: boolean; committed: boolean; controlKnown: boolean; locallyPaused: boolean }
export type KnowledgeRecoveryItem = { session_id: string; compilation_id: string; operation_id?: string; scope?: Scope; state: 'pending' | 'running' | 'paused' | 'committed' | 'failed' | 'stopped' | 'unknown' | 'unavailable'; reason?: string; updated_at: number }
export type KnowledgeRecoveryResult = { items: KnowledgeRecoveryItem[]; recovered: number; has_more: boolean }
type Workflow = {
  status(exec: Execution, compilationId: string, scope?: Scope): Promise<any>
  resume(exec: Execution, compilationId: string, scope?: Scope, options?: { automatic: true }): Promise<any>
}
function scopeOf(value: any): Scope | undefined {
  if (value?.kind === 'public' || value?.kind === 'uploader-private') return { kind: value.kind }
  if (value?.kind === 'project' && Number.isSafeInteger(value.project_id) && value.project_id > 0) return { kind: 'project', project_id: value.project_id }
}
function selectionOf(value: any): Selection | undefined {
  if (typeof value?.provider !== 'string' || !value.provider || value.provider.length > 128 || typeof value?.model !== 'string' || !value.model || value.model.length > 128
    || value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort || value.reasoningEffort.length > 32)) return undefined
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
}
/** Only physical records can establish a local coordinator, stop intent or model outcome. */
function candidateOf(stored: any, owner: string): Candidate | undefined {
  if (!UUID.test(stored?.meta?.id ?? '') || stored.meta.parentSession || !Array.isArray(stored.events)) return undefined
  const records = stored.events.filter((event: any) => event.type === EVENT && event.data?.schema_version === 1 && event.data.owner === owner)
  const marker = records.find((event: any) => event.data.kind === 'compilation-session')
  const selection = selectionOf(marker?.data.selection)
  if (!UUID.test(marker?.data.compilationId ?? '') || !selection) return undefined
  const compilationId = marker.data.compilationId
  let stopped = false, unknown = false, committed = false, controlKnown = marker.data.controlVersion === 1, locallyPaused = false
  const submitted = new Set<string>()
  for (const event of records) {
    const data = event.data
    if (data.compilationId !== compilationId) continue
    if (data.kind === 'user-stop') { stopped = true; controlKnown = true }
    if (data.kind === 'user-resume') { stopped = false; controlKnown = true }
    if (data.kind === 'paused') { unknown = data.unknownSubmission === true; locallyPaused = true }
    if (data.kind === 'committed') committed = true
    if (typeof data.topicKey === 'string') {
      if (data.kind === 'model-intent' || data.kind === 'model-submission') submitted.add(data.topicKey)
      if (data.kind === 'model-result' || data.kind === 'model-not-submitted') submitted.delete(data.topicKey)
    }
  }
  return { sessionId: stored.meta.id, compilationId, owner, selection, scope: scopeOf(marker.data.scope), time: records.at(-1)?.time ?? stored.meta.createdAt,
    stopped, unknown: unknown || submitted.size > 0, committed, controlKnown, locallyPaused }
}

/** A bounded reader/adapter over native SessionPersistence, Agents and the workflow's native Jobs. */
export function createKnowledgeRecovery(ctx: any, { workflow }: { workflow: Workflow }) {
  const identity = ctx.get?.('emateIdentity') ?? ctx.emateIdentity
  let owner = ownerOf(identity), lifetime = new AbortController(), disposed = false, cursor = 0
  let pending: { owner: string; promise: Promise<KnowledgeRecoveryResult> } | undefined
  const revisions = new Map<string, string>()
  const candidates = new Map<string, Candidate>()
  const requests = new Map<string, { operationId: string; scope: Scope; selection: Selection }>()
  const items = new Map<string, KnowledgeRecoveryItem>()
  const handles = new Map<string, any>()
  const attempted = new Set<string>()
  const checked = new Map<string, number>()
  let checkOrder = 0
  const recent = (): KnowledgeRecoveryItem[] => {
    changed()
    return owner && !disposed ? [...items.values()].sort((a, b) => b.updated_at - a.updated_at).slice(0, RECENT_LIMIT).map(item => structuredClone(item)) : []
  }
  function changed() {
    const next = ownerOf(identity)
    if (next === owner) return
    owner = next; lifetime.abort(); lifetime = new AbortController(); cursor = 0
    revisions.clear(); candidates.clear(); requests.clear(); items.clear(); attempted.clear(); checked.clear()
    for (const handle of handles.values()) void handle.dispose().catch(() => {})
    handles.clear()
  }
  function check(expected: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (disposed || ownerOf(identity) !== expected || owner !== expected) throw Object.assign(Error('Knowledge recovery cancelled'), { code: 'scope-changed' })
  }
  const item = (candidate: Candidate, state: KnowledgeRecoveryItem['state'], reason?: string) => {
    const value: KnowledgeRecoveryItem = { session_id: candidate.sessionId, compilation_id: candidate.compilationId, ...(candidate.operationId ? { operation_id: candidate.operationId } : {}), ...(candidate.scope ? { scope: candidate.scope } : {}), state, ...(reason ? { reason } : {}), updated_at: candidate.time }
    items.set(candidate.compilationId, value)
    while (items.size > RECENT_LIMIT) {
      const oldest = [...items].sort((a, b) => a[1].updated_at - b[1].updated_at)[0]
      items.delete(oldest[0])
    }
  }
  const record = (stored: any, expected: string) => {
    // Legacy coordinators did not carry scope. Bind it through the local request+receipt, never infer a project.
    const records = stored.events.filter((event: any) => event.type === EVENT && event.data?.schema_version === 1 && event.data.owner === expected)
    for (const event of records) {
      if (event.data.kind !== 'compilation-receipt' || !UUID.test(event.data.compilationId ?? '') || !OPERATION.test(event.data.operationId ?? '')) continue
      const request = records.find((other: any) => other.data.kind === 'compilation-request' && other.data.operationId === event.data.operationId)?.data
      const scope = scopeOf(request?.request?.scope), selection = selectionOf(request?.selection)
      if (scope && selection) requests.set(event.data.compilationId, { operationId: event.data.operationId, scope, selection })
    }
    const candidate = candidateOf(stored, expected)
    if (candidate) {
      const previous = candidates.get(candidate.compilationId)
      if (!previous || previous.time <= candidate.time) candidates.set(candidate.compilationId, candidate)
    }
  }
  const busy = (expected: string) => ctx.agents.list().some((agent: any) => {
    const own = agent.session.events.some((event: any) => event.type === EVENT && event.data?.kind === 'compilation-session' && event.data.owner === expected)
    return own && ctx.jobs.list(agent).some((job: any) => job.kind === 'knowledge' && ['running', 'stopping'].includes(job.status))
  })
  async function run(expected: string, signal: AbortSignal): Promise<KnowledgeRecoveryResult> {
    const snapshots = await ctx.sessionPersistence.listSnapshots(signal); check(expected, signal)
    snapshots.sort((a: any, b: any) => b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id))
    const known = new Set(snapshots.map((entry: any) => entry.header.id))
    for (const [id, candidate] of candidates) if (!known.has(candidate.sessionId)) { candidates.delete(id); items.delete(id) }
    if (cursor >= snapshots.length) cursor = 0
    const batch = snapshots.slice(cursor, cursor + READ_BATCH); cursor += batch.length
    for (const snapshot of batch) {
      check(expected, signal)
      if (snapshot.header.parentSession || revisions.get(snapshot.header.id) === snapshot.revision) continue
      try {
        const stored = await ctx.sessionPersistence.readFrom(snapshot.header.id, 0, signal); check(expected, signal)
        record(stored, expected); revisions.set(snapshot.header.id, snapshot.revision)
        while (revisions.size > CACHE_LIMIT) revisions.delete(revisions.keys().next().value!)
      } catch (error) { check(expected, signal) /* Corrupt/unsupported native logs remain unread, never repaired by discovery. */ }
    }
    let recovered = 0, checkedThisScan = 0
    for (const cached of [...candidates.values()].sort((a, b) => (checked.get(a.compilationId) ?? 0) - (checked.get(b.compilationId) ?? 0) || b.time - a.time)) {
      check(expected, signal)
      const binding = requests.get(cached.compilationId)
      if (!cached.scope && binding && digest(binding.selection) === digest(cached.selection)) { cached.scope = binding.scope; cached.operationId = binding.operationId }
      if (cached.committed) { item(cached, 'committed'); continue }
      if (cached.stopped) { item(cached, 'stopped', 'user-stop'); continue }
      if (cached.locallyPaused && !cached.controlKnown) { item(cached, 'unknown', 'legacy-pause-unknown'); continue }
      if (cached.unknown) { item(cached, 'unknown', 'model-submission'); continue }
      if (!cached.scope) { item(cached, 'unavailable', 'missing-local-scope'); continue }
      if (attempted.has(cached.compilationId)) continue
      item(cached, 'pending', 'awaiting-status')
      if (recovered || checkedThisScan >= 4 || busy(expected)) continue
      checked.set(cached.compilationId, ++checkOrder); checkedThisScan++
      let handle: any
      try {
        // Fresh canonical stop/outcome check is required even when the revision cache was unchanged.
        const stored = await ctx.sessionPersistence.readFrom(cached.sessionId, 0, signal); check(expected, signal)
        const fresh = candidateOf(stored, expected)
        if (!fresh || fresh.compilationId !== cached.compilationId || digest(fresh.selection) !== digest(cached.selection)) { item(cached, 'unavailable', 'local-receipt-changed'); continue }
        if (fresh.stopped || fresh.unknown || fresh.committed || fresh.locallyPaused && !fresh.controlKnown) {
          candidates.set(fresh.compilationId, { ...fresh, scope: cached.scope, operationId: cached.operationId })
          item({ ...fresh, scope: cached.scope, operationId: cached.operationId }, fresh.committed ? 'committed' : fresh.stopped ? 'stopped' : 'unknown'); continue
        }
        const live = ctx.agents.get(cached.sessionId)
        if (!live) {
          handle = await ctx.agents.resume({ resumeSessionId: cached.sessionId, agentOptions: cached.selection, signal, setup(agentCtx: any) {
            agentCtx.systemPrompt.section({ name: 'emate:knowledge-recovery', order: 0, text: '知识编译恢复协调任务。仅通过现有知识工作流处理已冻结输入。', complete: true })
            agentCtx.systemPrompt.suppressRuntimeContext(); agentCtx.tools.restrict({ allow: [] })
          } })
          check(expected, signal); handles.set(cached.sessionId, handle)
        }
        const agent = live ?? handle.agent
        const exec = { agent, signal: lifetime.signal }
        const status = await workflow.status({ agent, signal }, cached.compilationId, cached.scope); check(expected, signal)
        if (status.compilation_id !== cached.compilationId || digest(status.scope) !== digest(cached.scope) || status.model?.id !== cached.selection.model) throw Error('Unexpected compilation receipt')
        if (status.state === 'committed' || status.state === 'failed') { item(cached, status.state); attempted.add(cached.compilationId); continue }
        if (status.state === 'paused' && !fresh.controlKnown) { item(cached, 'unknown', 'legacy-pause-unknown'); continue }
        if (status.checkpoint?.unknown_submission) { item(cached, 'unknown', 'model-submission'); continue }
        if (status.checkpoint?.session_id && status.checkpoint.session_id !== cached.sessionId) { item(cached, 'unavailable', 'different-coordinator'); continue }
        if (status.job_id || busy(expected)) { item(cached, 'running'); continue }
        // Status may have awaited the network while the user stopped this task.
        const beforeResume = candidateOf(await ctx.sessionPersistence.readFrom(cached.sessionId, 0, signal), expected); check(expected, signal)
        if (!beforeResume || beforeResume.compilationId !== cached.compilationId || beforeResume.stopped || beforeResume.unknown || beforeResume.committed || beforeResume.locallyPaused && !beforeResume.controlKnown) {
          item(cached, beforeResume?.committed ? 'committed' : beforeResume?.stopped ? 'stopped' : 'unknown', 'local-state-changed'); continue
        }
        // No independent queue: native workflow admission owns the Job and its completion.
        attempted.add(cached.compilationId)
        const resumed = await workflow.resume(exec, cached.compilationId, cached.scope, { automatic: true }); check(expected, signal)
        item(cached, resumed.state === 'committed' ? 'committed' : 'running'); recovered++
      } catch (error) {
        check(expected, signal)
        item(cached, 'unavailable', 'recovery-unavailable')
      } finally {
        if (handle && !ctx.jobs.list(handle.agent).some((job: any) => job.kind === 'knowledge' && ['running', 'stopping'].includes(job.status))) {
          if (handles.get(cached.sessionId) === handle) handles.delete(cached.sessionId)
          await handle.dispose().catch(() => {})
        }
      }
    }
    return { items: recent(), recovered, has_more: cursor < snapshots.length }
  }
  return {
    recent, changed,
    scan(signal?: AbortSignal): Promise<KnowledgeRecoveryResult> {
      changed()
      if (disposed || !owner) return Promise.resolve({ items: [], recovered: 0, has_more: false })
      if (pending?.owner === owner) return pending.promise
      const expected = owner, combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
      const promise = run(expected, combined).catch(() => ({ items: recent(), recovered: 0, has_more: false })).finally(() => { if (pending?.promise === promise) pending = undefined })
      pending = { owner: expected, promise }; return promise
    },
    async dispose() {
      disposed = true; lifetime.abort(); await pending?.promise
      await Promise.allSettled([...handles.values()].map(handle => handle.dispose())); handles.clear(); items.clear(); candidates.clear(); requests.clear(); revisions.clear(); attempted.clear(); checked.clear()
    },
  }
}
