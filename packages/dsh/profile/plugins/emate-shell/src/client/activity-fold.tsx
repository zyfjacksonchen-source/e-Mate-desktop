import { Component, createElement, Fragment, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { SlotAssemblyError } from '@deepseek-ai/dsh-client-web-react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import { currentMessageFlowMode, type MessageFlowSettings } from './message-mode-settings.tsx'
import css from './activity-fold.module.css'

type ChatNode = {
  key: string
  kind: string
  location?: { kind?: string; turn?: { turn?: number } }
  data?: {
    status?: string
    blocks?: readonly { kind?: string; text?: string }[]
    root?: Record<string, unknown>
  }
}

export interface ActivityFoldSummary {
  turn: number
  headerKey: string
  toolCount: number
  reasoningCount: number
  running: boolean
}

const expandedTurns = new Set<string>()
const listeners = new Set<() => void>()

function turnOf(node: ChatNode): number | undefined {
  const location = node.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn?.turn : undefined
}

function hasReasoning(node: ChatNode): boolean {
  return node.kind === 'assistant-step'
    && node.data?.blocks?.some(block => block.kind === 'reasoning') === true
}

function reasoningBlocks(node: ChatNode): number {
  return node.kind === 'assistant-step'
    ? node.data?.blocks?.filter(block => block.kind === 'reasoning').length ?? 0
    : 0
}

function hasNaturalMessage(node: ChatNode): boolean {
  if (node.kind !== 'assistant-step') return false
  if (node.data?.status === 'interrupted') return true
  return node.data?.blocks?.some((block) => {
    if (block.kind === 'text') return (block.text ?? '').trim().length > 0
    return block.kind !== 'reasoning' && block.kind !== 'tool-call'
  }) === true
}

function isProcessNode(node: ChatNode): boolean {
  return node.kind === 'tool-call' || hasReasoning(node)
}

function isRunning(node: ChatNode): boolean {
  if (node.kind === 'assistant-step') return node.data?.status === 'running'
  return node.kind === 'tool-call' && node.data?.root !== undefined && !('kind' in node.data.root)
}

/** Project one turn's process-only nodes without rewriting any DSH event. */
export function activityFoldSummary(
  order: readonly string[],
  nodes: ReadonlyMap<string, ChatNode>,
  node: ChatNode,
): ActivityFoldSummary | null {
  const turn = turnOf(node)
  if (turn === undefined) return null
  const process = order
    .map(key => nodes.get(key))
    .filter((candidate): candidate is ChatNode => candidate !== undefined
      && turnOf(candidate) === turn
      && isProcessNode(candidate))
  const header = process[0]
  if (header === undefined) return null
  return {
    turn,
    headerKey: header.key,
    toolCount: process.filter(candidate => candidate.kind === 'tool-call').length,
    reasoningCount: process.reduce((count, candidate) => count + reasoningBlocks(candidate), 0),
    running: process.some(isRunning),
  }
}

function stateKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function setExpanded(sessionId: string, turn: number, expanded: boolean): void {
  const key = stateKey(sessionId, turn)
  const changed = expanded ? !expandedTurns.has(key) : expandedTurns.has(key)
  if (!changed) return
  if (expanded) expandedTurns.add(key)
  else expandedTurns.delete(key)
  for (const listener of listeners) listener()
}

function useExpanded(sessionId: string, turn: number | undefined): boolean {
  return useSyncExternalStore(subscribe, () => turn !== undefined && expandedTurns.has(stateKey(sessionId, turn)))
}

function label(summary: ActivityFoldSummary): string {
  const counts: string[] = []
  if (summary.toolCount > 0) counts.push(`${summary.toolCount} 次工具调用`)
  if (summary.reasoningCount > 0) counts.push(`${summary.reasoningCount} 条思考`)
  return `${summary.running ? '正在运行' : '运行过程'}${counts.length > 0 ? ` · ${counts.join('，')}` : ''}`
}

function BrainIcon() {
  return (
    <svg
      data-emate-brain-icon
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  )
}

function ActivityHeader({ summary, sessionId, expanded, children }: {
  summary: ActivityFoldSummary
  sessionId: string
  expanded: boolean
  children?: ReactNode
}) {
  return (
    <div className={css.group} data-emate-activity-fold data-running={summary.running || undefined}>
      <DisclosureRow
        rowClassName={css.header}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<BrainIcon />}
        title={label(summary)}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(sessionId, summary.turn, !expanded) }}
      >
        {children}
      </DisclosureRow>
    </div>
  )
}

function nativeComponent(ctx: any, kind: string): any {
  const entry = ctx.slots.entries('conversation.chat.node')
    .find((candidate: any) => candidate.options?.key === kind && (candidate.options?.priority ?? 0) === 0)
  if (entry?.component === undefined) throw new Error(`native DSH renderer "${kind}" is unavailable`)
  return entry.component
}

// Native SlotCore owns election and retirement; this boundary isolates only
// the atomic view invoked by the existing conversation renderer bridge.
class ToolViewBoundary extends Component<{
  entry: any
  report: (error: unknown) => void
  children: ReactNode
}, { entry: any; failed: boolean }> {
  override state = { entry: this.props.entry, failed: false }
  static getDerivedStateFromProps(props: { entry: any }, state: { entry: any; failed: boolean }) {
    return props.entry === state.entry ? null : { entry: props.entry, failed: false }
  }
  static getDerivedStateFromError(error: unknown) {
    if (error instanceof SlotAssemblyError) throw error
    return { failed: true }
  }
  override componentDidCatch(error: unknown) {
    console.error("slot entry crashed in 'tool.call.toolview':", error)
    this.props.report(error)
  }
  override render() {
    return this.state.failed ? <div data-slot-error="tool.call.toolview" /> : this.props.children
  }
}

function AtomicToolView({ ctx, props, owner, options }: {
  ctx: any
  props: any
  owner: Record<string, unknown>
  options: { entryKey?: string; fallback?: ReactNode }
}) {
  const key = 'tool.call.toolview'
  useSyncExternalStore(
    listener => ctx.slots.subscribe(key, listener),
    () => ctx.slots.getVersion(key),
  )
  const entry = ctx.slots.entriesOfSlot(key)
    .find((candidate: any) => candidate.options?.key === options.entryKey)
  if (entry?.component === undefined) {
    // A retired cell keeps the native crash face, rather than implying the
    // failed renderer never existed. Unregistered cells use the native fallback.
    return ctx.slots.entries(key).some((candidate: any) => candidate.options?.key === options.entryKey)
      ? <div data-slot-error={key} /> : options.fallback ?? null
  }
  // Assembly errors stay outside the entry boundary. The rc.7 atomic bridge
  // accepts only the standard session kit and the native owner's props.
  if (entry.inject !== undefined || entry.store !== undefined || entry.children !== undefined
    || (entry.locale !== undefined && entry.locale !== 'conversation')) {
    throw new Error(`tool view "${options.entryKey ?? ''}" requires an unsupported injected face`)
  }
  return <ToolViewBoundary entry={entry}
    report={error => ctx.slots.reportEntryError(key, entry, error, { abdicate: true })}>
    {createElement(entry.component, { ...props, ...owner })}
  </ToolViewBoundary>
}

function renderNative(ctx: any, kind: string, props: any): ReactNode {
  const Native = nativeComponent(ctx, kind)
  if (kind !== 'tool-call') return createElement(Native, props)
  const renderSlot = (key: string, owner: Record<string, unknown>, options: { entryKey?: string; fallback?: ReactNode }) =>
    key === 'tool.call.toolview' ? <AtomicToolView ctx={ctx} props={props} owner={owner} options={options} /> : options.fallback ?? null
  return createElement(Native, { ...props, renderSlot })
}

function hiddenMarker(): ReactNode {
  return <span data-emate-process-hidden aria-hidden style={{ display: 'none' }} />
}

function assistantNodeWith(node: ChatNode, keep: (block: { kind?: string; text?: string }) => boolean): ChatNode {
  return { ...node, data: { ...node.data, blocks: node.data?.blocks?.filter(keep) ?? [] } }
}

function createProcessRenderer(ctx: any, kind: 'assistant-step' | 'tool-call' | 'context') {
  return function ProcessRenderer(props: any) {
    const { node, sessionId, useSession } = props as { node: ChatNode; sessionId: string; useSession: (selector: any) => any }
    const order = useSession((snapshot: any) => snapshot.chat.order) as readonly string[]
    const nodes = useSession((snapshot: any) => snapshot.chat.nodes) as ReadonlyMap<string, ChatNode>
    const summary = useMemo(() => activityFoldSummary(order, nodes, node), [node, nodes, order])
    const expanded = useExpanded(sessionId, summary?.turn)

    if (kind === 'context') return hiddenMarker()
    if (summary === null || !isProcessNode(node)) return renderNative(ctx, kind, props)
    const header = node.key === summary.headerKey
    if (kind === 'assistant-step' && hasNaturalMessage(node)) {
      const naturalProps = {
        ...props,
        node: assistantNodeWith(node, block => block.kind !== 'reasoning' && block.kind !== 'tool-call'),
      }
      const processProps = { ...props, node: assistantNodeWith(node, block => block.kind === 'reasoning') }
      return createElement(Fragment, null,
        header
          ? <ActivityHeader summary={summary} sessionId={sessionId} expanded={expanded}>
              {expanded ? renderNative(ctx, kind, processProps) : null}
            </ActivityHeader>
          : expanded ? renderNative(ctx, kind, processProps) : null,
        renderNative(ctx, kind, naturalProps),
      )
    }

    if (!header) return expanded ? renderNative(ctx, kind, props) : hiddenMarker()
    return (
      <ActivityHeader summary={summary} sessionId={sessionId} expanded={expanded}>
        {expanded ? renderNative(ctx, kind, props) : null}
      </ActivityHeader>
    )
  }
}

/** Fold only DSH process nodes; assistant prose remains owned by its native renderer. */
export function registerActivityFold(ctx: any, scope: SettingsScope<MessageFlowSettings>): void {
  ctx.slots.inject('conversation.chat.node', () => {
    let disposeFold: (() => void) | undefined
    const sync = () => {
      const simple = currentMessageFlowMode(scope) === 'simple'
      if (simple === (disposeFold !== undefined)) return
      if (!simple) {
        disposeFold?.()
        disposeFold = undefined
        return
      }
      const disposers = (['assistant-step', 'tool-call', 'context'] as const).map(kind => ctx.slots.register({
        name: 'conversation.chat.node',
        key: kind,
        priority: -1,
        locale: 'conversation',
      }, createProcessRenderer(ctx, kind)))
      disposeFold = () => {
        for (const dispose of disposers) dispose()
      }
    }
    const unsubscribe = scope.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      disposeFold?.()
    }
  })
}
