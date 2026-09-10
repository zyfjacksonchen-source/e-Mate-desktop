/** Read-only adaptation of pinned dsh-pet's Session/Conversation host.
 * Runtime sources: sessions/service.ts, sessions/conversation.ts and
 * sessions/projection-store.ts at Harness 78a2b9856218. No domain is folded here.
 */
import { EMPTY_PROJECTION, type PetTaskProjection, type PetWorkFactsReader } from '../projection.ts'
import type { OfficeScene } from '../scenes.ts'
export interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface NativeTurn { readonly status: string; readonly start?: { readonly time: number }; readonly end?: { readonly data: { readonly reason: { readonly kind: string } } }; readonly data: { get(key: string): unknown } }
interface NativeToolRoot {
  readonly kind?: string; readonly seq?: number; readonly callId?: string; readonly name?: string
  readonly call?: { readonly name: string } | null; readonly isError?: boolean; readonly meta?: unknown
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly subCalls?: readonly NativeToolRoot[]
}
interface NativeConversation {
  readonly sessionId: string; readonly openState: string; readonly composerPhase: string
  readonly running: boolean; readonly lastAgentError: string | null
  readonly runningCalls: readonly { readonly callId: string; readonly name: string; readonly turn: number; readonly callView: { readonly card: string; readonly kind?: string; readonly locations?: readonly { readonly path: string }[] } | null }[]
  readonly pending: readonly { readonly kind: string }[]; readonly queue: readonly unknown[]
  readonly chat: {
    readonly timeline: { readonly turnOrder: readonly number[]; readonly turns: ReadonlyMap<number, NativeTurn> }
    readonly locations: { getTurn(turn: number): readonly string[] }
    readonly nodes: { get(key: string): { readonly kind: string; readonly visibility: string; readonly data?: { readonly root?: NativeToolRoot } } | undefined }
  }
}
export interface NativeSession extends Observable<NativeConversation> { readonly projections: { faceOf(key: string): Observable<unknown> } }
interface Job { readonly status: string; readonly finishedAt?: number }
interface NativeList {
  readonly current?: string; readonly phase: string
  readonly byId: Readonly<Record<string, { readonly pendingInteraction?: string; readonly running: boolean; readonly projectionValues?: Readonly<Record<string, unknown>> }>>
  readonly jobsBySession: Readonly<Record<string, readonly Job[]>>
}
export interface NativeSessions { readonly list: Observable<NativeList>; binding(id: string): { readonly session: NativeSession } | undefined }
export interface Visibility { getSnapshot(): boolean; subscribe(listener: () => void): () => void }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function presentedOperation(view: { readonly card: string; readonly kind?: string } | null | undefined): OfficeScene | undefined {
  if (view?.card === 'terminal') return 'terminal'
  // Generic file/category presentation cannot prove a code/document/media subtype.
  return undefined
}
/** Native fields become a small redacted sprite input; no new Session store or events. */
export class NativePetProjection implements Observable<PetTaskProjection> {
  private value: PetTaskProjection = EMPTY_PROJECTION
  private readonly listeners = new Set<() => void>()
  private session: NativeSession | undefined
  private current: string | undefined
  private detachSession: Array<() => void> = []
  private readonly detach: Array<() => void>
  private seenResponseTurn: number | undefined
  private signature = ''
  private revision = 0
  private disposed = false
  private enabled = true
  private readonly readWorkFacts: PetWorkFactsReader
  constructor(privateSessions: NativeSessions, visibility: Visibility, readWorkFacts: PetWorkFactsReader = () => ({ delivered: false })) {
    this.sessions = privateSessions; this.visibility = visibility; this.readWorkFacts = readWorkFacts
    this.detach = [privateSessions.list.subscribe(this.update), visibility.subscribe(this.update)]
    this.update()
  }
  private readonly sessions: NativeSessions
  private readonly visibility: Visibility
  getSnapshot = (): PetTaskProjection => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update = (): void => {
    if (this.disposed) return
    const list = this.sessions.list.getSnapshot()
    const current = list.current
    const visible = this.visibility.getSnapshot()
    const session = current === undefined || !visible || !this.enabled ? undefined : this.sessions.binding(current)?.session
    if (session !== this.session || current !== this.current) {
      for (const dispose of this.detachSession) dispose()
      this.detachSession = []; this.session = session; this.current = current; this.seenResponseTurn = undefined
      if (session !== undefined) this.detachSession = [session.subscribe(this.update), ...['goal', 'todos', 'eMateImageReceipts', 'eMateImageBatches'].map(key => session.projections.faceOf(key).subscribe(this.update))]
    }
    const conversation = session?.getSnapshot()
    const ready = current !== undefined && conversation?.sessionId === current && conversation.openState === 'open' && list.byId[current] !== undefined
    let candidate: Omit<PetTaskProjection, 'revision'> = { taskId: current ?? null, firstResponsePending: current !== undefined || list.phase !== 'ready', window: { visible } }
    if (ready && conversation !== undefined && session !== undefined) {
      const order = conversation.chat.timeline.turnOrder
      const turnNumber = order[order.length - 1]
      const turn = turnNumber === undefined ? undefined : conversation.chat.timeline.turns.get(turnNumber)
      const call = conversation.runningCalls[conversation.runningCalls.length - 1]
      // Observe only the already-projected visibility bit, never assistant blocks.
      // Once a turn has a visible response, token-driven updates do no more scans.
      if (turnNumber !== undefined && this.seenResponseTurn !== turnNumber && (call !== undefined
        || conversation.chat.locations.getTurn(turnNumber).some(key => {
          const node = conversation.chat.nodes.get(key)
          return node?.kind === 'assistant-step' && node.visibility === 'visible'
        }))) this.seenResponseTurn = turnNumber
      const goal = session.projections.faceOf('goal').getSnapshot()
      const phase = object(goal) && object(goal.goal) ? goal.goal.phase : undefined
      const todos = session.projections.faceOf('todos').getSnapshot()
      const todoActive = Array.isArray(todos) && todos.some(item => object(item) && item.status === 'in_progress')
      const jobs = list.jobsBySession[current!] ?? []
      const activeJob = jobs.find(job => job.status === 'running' || job.status === 'stopping')
      const failedJob = jobs.some(job => job.status === 'failed' && turn?.start !== undefined && job.finishedAt !== undefined && job.finishedAt >= turn.start.time)
      const work = this.readWorkFacts(current!)
      const waiting = conversation.pending.length > 0 || list.byId[current!]?.pendingInteraction !== undefined || work.needsAttention === true
      const delivered = work.delivered
      let failedTool = false
      if (call === undefined && turnNumber !== undefined) {
        const keys = conversation.chat.locations.getTurn(turnNumber)
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const node = conversation.chat.nodes.get(keys[index]!)
          if (node?.kind !== 'tool-call') continue
          failedTool = node.data?.root?.kind === 'tool-result' && node.data.root.isError === true
          break
        }
      }
      const toolOperation = work.operation ?? presentedOperation(call?.callView)
      candidate = {
        taskId: current!, window: { visible },
        firstResponsePending: conversation.composerPhase === 'engaging' || (conversation.running && (turnNumber === undefined || this.seenResponseTurn !== turnNumber)),
        ...(phase === 'active' || phase === 'blocked' ? { goal: { status: phase } } : {}),
        ...(waiting ? { tool: { status: 'waiting' } } : conversation.lastAgentError !== null || failedTool || work.failed === true ? { tool: { status: 'failed' } }
          : call !== undefined ? { tool: { status: 'running', ...(toolOperation === undefined ? {} : { operation: toolOperation }) } }
          : conversation.running ? { tool: { status: 'running' } }
          : work.completedOperation === undefined ? {} : { tool: { status: 'completed', operation: work.completedOperation } }),
        ...(failedJob ? { job: { status: 'failed' } } : activeJob === undefined ? {} : { job: { status: 'running' } }),
        ...(todoActive ? { todo: { status: 'in_progress' } } : {}),
        queue: { pending: conversation.queue.length },
        ...(delivered ? { deliverable: { status: 'completed' } } : {}),
      }
    }
    const signature = JSON.stringify(candidate)
    if (signature === this.signature) return
    this.signature = signature; this.value = { ...candidate, revision: ++this.revision }
    for (const listener of this.listeners) listener()
  }
  setEnabled(enabled: boolean): void { if (this.enabled === enabled) return; this.enabled = enabled; this.update() }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const stop of [...this.detachSession, ...this.detach]) stop(); this.listeners.clear() }
}
/** Browser-owned visibility/focus pauses background and minimized windows without DOM inference. */
export function documentVisibility(doc: Document = document): Visibility {
  return {
    getSnapshot: () => doc.visibilityState === 'visible' && doc.hasFocus(),
    subscribe(listener) {
      doc.addEventListener('visibilitychange', listener)
      doc.defaultView?.addEventListener('focus', listener)
      doc.defaultView?.addEventListener('blur', listener)
      return () => { doc.removeEventListener('visibilitychange', listener); doc.defaultView?.removeEventListener('focus', listener); doc.defaultView?.removeEventListener('blur', listener) }
    },
  }
}
