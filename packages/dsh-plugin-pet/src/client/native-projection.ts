/** Read-only adaptation of the pinned native client Session, Conversation and
 * pending-interaction owners:
 * packages/api/session-controller/src/client/contract/snapshot.ts and
 * sessions/service.ts, packages/client/ui-session/src/client/index.ts,
 * packages/client/ui-conversation/src/client/contract/conversation.ts and
 * packages/client/ui-chat/src/client/contract/snapshot.ts at Harness
 * f9e0f1190e4021e63db579ef36b67484028e8c53. No domain is folded here.
 */
import { EMPTY_PROJECTION, type PetTaskProjection, type PetWorkFactsReader } from '../projection.ts'
export interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
/** One Turn boundary of the chat target — ui-conversation's TurnLocation. */
interface NativeTurn {
  readonly status: string
  readonly start?: { readonly time: number }
  readonly end?: { readonly data: { readonly reason: { readonly kind: string } } }
  readonly data: { get(key: string): unknown }
}
/** One running or settled Tool root — ui-conversation's ToolCallBlock. */
export interface NativeToolRoot {
  readonly kind?: string; readonly seq?: number; readonly callId?: string; readonly name?: string
  readonly call?: { readonly name: string } | null; readonly isError?: boolean; readonly meta?: unknown
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly subCalls?: readonly NativeToolRoot[]
}
/** One in-flight root Tool call folded from the log — ui-conversation's RunningToolCall. */
export interface NativeRunningCall { readonly callId: string; readonly name: string; readonly turn: number }
/** The registered chat target of one Session's Conversation binding — ui-chat's ChatSnapshot. */
export interface NativeChat {
  readonly timeline: { readonly turnOrder: readonly number[]; readonly turns: ReadonlyMap<number, NativeTurn> }
  readonly locations: { getTurn(turn: number): readonly string[] }
  readonly nodes: { get(key: string): { readonly kind: string; readonly visibility: string; readonly data?: { readonly root?: NativeToolRoot } } | undefined }
  /** The compatibility slice carries the in-flight root calls ui-chat folds. */
  readonly legacy: { readonly runningCalls: readonly NativeRunningCall[] }
}
/** Standard Session lifecycle snapshot — session-controller's SessionSnapshot under SessionFace. */
export interface NativeSessionSnapshot {
  readonly sessionId: string
  readonly queue: readonly unknown[]
  readonly running: boolean
  readonly openState: string
  readonly lastAgentError: string | null
  /** A prompt call has begun on this Session. */
  readonly promptAttempted: boolean
  /** The first accepted prompt has not reached a durable turn/start event. */
  readonly awaitingFirstTurn: boolean
}
export interface NativeSession extends Observable<NativeSessionSnapshot> {
  /** The session's host identity — ISession.sessionId. */
  readonly sessionId: string
  readonly projections: { faceOf(key: string): Observable<unknown> }
}
interface Job { readonly status: string; readonly finishedAt?: number }
/** Session list store — session-controller's SessionListState over SessionSummary rows. */
interface NativeList {
  readonly current?: string; readonly phase: string
  readonly byId: Readonly<Record<string, { readonly projectionValues?: Readonly<Record<string, unknown>> }>>
  readonly jobsBySession: Readonly<Record<string, readonly Job[]>>
}
export interface NativeSessions { readonly list: Observable<NativeList>; binding(id: string): { readonly session: NativeSession } | undefined }
/** ui-session's pending-interaction root source — the provideRoot hook behind useSessionPendingInteraction. */
export interface NativePendingInteractions { readonly pendingInteractions: Observable<ReadonlyMap<string, unknown>> }
/** ui-conversation's per-Session binding face. */
export interface NativeConversationBinding { target(target: string): Observable<NativeChat | undefined> }
export interface NativeConversationService { binding(sessionId: string): NativeConversationBinding }
/** The native client services one projection reads. */
export interface NativeProjectionServices {
  readonly sessions: NativeSessions
  /** The owner of "a person must answer this Session". */
  readonly uiSession: NativePendingInteractions
  /** The owner of running Tool calls and Turn boundaries. */
  readonly uiConversation: NativeConversationService
}
export interface Visibility { getSnapshot(): boolean; subscribe(listener: () => void): () => void }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/** Native fields become a small redacted sprite input; no new Session store or events. */
export class NativePetProjection implements Observable<PetTaskProjection> {
  private value: PetTaskProjection = EMPTY_PROJECTION
  private readonly listeners = new Set<() => void>()
  private session: NativeSession | undefined
  private chat: Observable<NativeChat | undefined> | undefined
  private current: string | undefined
  private detachSession: Array<() => void> = []
  private readonly detach: Array<() => void>
  private seenResponseTurn: number | undefined
  private signature = ''
  private revision = 0
  private disposed = false
  private enabled = true
  private readonly readWorkFacts: PetWorkFactsReader
  constructor(privateServices: NativeProjectionServices, visibility: Visibility, readWorkFacts: PetWorkFactsReader = () => ({ delivered: false })) {
    this.services = privateServices; this.visibility = visibility; this.readWorkFacts = readWorkFacts
    this.detach = [privateServices.sessions.list.subscribe(this.update),
      privateServices.uiSession.pendingInteractions.subscribe(this.update), visibility.subscribe(this.update)]
    this.update()
  }
  private readonly services: NativeProjectionServices
  private readonly visibility: Visibility
  getSnapshot = (): PetTaskProjection => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update = (): void => {
    if (this.disposed) return
    const list = this.services.sessions.list.getSnapshot()
    const current = list.current
    const visible = this.visibility.getSnapshot()
    const session = current === undefined || !visible || !this.enabled ? undefined : this.services.sessions.binding(current)?.session
    if (session !== this.session || current !== this.current) {
      for (const dispose of this.detachSession) dispose()
      this.detachSession = []; this.session = session; this.current = current; this.seenResponseTurn = undefined
      // The Conversation binding is the only owner of running calls and Turn boundaries.
      this.chat = session === undefined ? undefined : this.services.uiConversation.binding(current!).target('chat')
      if (session !== undefined && this.chat !== undefined) {
        this.detachSession = [session.subscribe(this.update), this.chat.subscribe(this.update),
          ...['goal', 'todos', 'eMateImageReceipts', 'eMateImageBatches'].map(key => session.projections.faceOf(key).subscribe(this.update))]
      }
    }
    const snapshot = session?.getSnapshot()
    const ready = current !== undefined && snapshot?.sessionId === current && snapshot.openState === 'open' && list.byId[current] !== undefined
    let candidate: Omit<PetTaskProjection, 'revision'> = { taskId: current ?? null, firstResponsePending: current !== undefined || list.phase !== 'ready', window: { visible } }
    if (ready && snapshot !== undefined && session !== undefined) {
      const chat = this.chat?.getSnapshot()
      const order = chat?.timeline.turnOrder ?? []
      const turnNumber = order[order.length - 1]
      const turn = turnNumber === undefined ? undefined : chat?.timeline.turns.get(turnNumber)
      const calls = chat?.legacy.runningCalls ?? []
      const call = calls[calls.length - 1]
      // Observe only the already-projected visibility bit, never assistant blocks.
      // Once a turn has a visible response, token-driven updates do no more scans.
      if (chat !== undefined && turnNumber !== undefined && this.seenResponseTurn !== turnNumber && (call !== undefined
        || chat.locations.getTurn(turnNumber).some(key => {
          const node = chat.nodes.get(key)
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
      const waiting = this.services.uiSession.pendingInteractions.getSnapshot().has(current!) || work.needsAttention === true
      const delivered = work.delivered
      let failedTool = false
      if (call === undefined && chat !== undefined && turnNumber !== undefined) {
        const keys = chat.locations.getTurn(turnNumber)
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const node = chat.nodes.get(keys[index]!)
          if (node?.kind !== 'tool-call') continue
          failedTool = node.data?.root?.kind === 'tool-result' && node.data.root.isError === true
          break
        }
      }
      const toolOperation = work.operation
      candidate = {
        taskId: current!, window: { visible },
        // Engaging is the Session's own first-turn gate; the reply itself needs the Turn.
        firstResponsePending: snapshot.promptAttempted && snapshot.awaitingFirstTurn
          || (snapshot.running && (turnNumber === undefined || this.seenResponseTurn !== turnNumber)),
        ...(phase === 'active' || phase === 'blocked' ? { goal: { status: phase } } : {}),
        ...(waiting ? { tool: { status: 'waiting' } } : snapshot.lastAgentError !== null || failedTool || work.failed === true ? { tool: { status: 'failed' } }
          : call !== undefined ? { tool: { status: 'running', ...(toolOperation === undefined ? {} : { operation: toolOperation }) } }
          : snapshot.running ? { tool: { status: 'running' } }
          : work.completedOperation === undefined ? {} : { tool: { status: 'completed', operation: work.completedOperation } }),
        ...(failedJob ? { job: { status: 'failed' } } : activeJob === undefined ? {} : { job: { status: 'running' } }),
        ...(todoActive ? { todo: { status: 'in_progress' } } : {}),
        queue: { pending: snapshot.queue.length },
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
