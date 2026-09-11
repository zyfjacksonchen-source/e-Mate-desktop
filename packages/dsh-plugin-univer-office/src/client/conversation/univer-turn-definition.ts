import type {
  ChatConversationViewNode,
  ChatSnapshot,
  TurnTailOwnerProps
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationNodeContext,
  ConversationNodeDefinition
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-tools/types'

export type UniverOperationName =
  | 'new'
  | 'status'
  | 'worktree'
  | 'unit'
  | 'import'
  | 'inspect'
  | 'execute'
  | 'export'
  | 'lint'
  | 'screenshot'
  | 'print-pdf'
  | 'compile-svg'
export type UniverOperationPhase = 'pending' | 'succeeded' | 'failed'
export type UniverTurnLifecycle = 'trunk' | 'draft' | 'ready' | 'merged' | 'discarded' | 'unchanged'

/** One durable Univer tool operation recovered from a call/result pair. */
export interface UniverTurnOperation {
  readonly callId: string
  readonly name: UniverOperationName
  readonly action: string | null
  readonly file: string
  readonly worktreeId: string | null
  readonly unitId: string | null
  readonly phase: UniverOperationPhase
  /** Durable completion order, including interleaved Code subcalls. */
  readonly seq: number
}

/** All Univer operations for one file in one Turn. */
export interface UniverTurnFile {
  readonly file: string
  readonly operations: readonly UniverTurnOperation[]
}

/** Replayable file operations carried by native hidden Chat nodes. */
export interface UniverTurnData {
  readonly files: readonly UniverTurnFile[]
}

export interface UniverTurnMatch extends UniverTurnData {
  readonly turn: number
}

/** One Client history event a Definition may match; narrower than the durable Session map. */
type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

export interface UniverTurnOutcome {
  readonly primaryWorktreeId: string | null
  readonly lifecycle: UniverTurnLifecycle
  readonly preferredUnitId: string | null
  readonly changedContent: boolean
}

interface UniverTurnState extends UniverTurnData {
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One root call's hidden, replayable Univer operations. */
    univerTurn: UniverTurnMatch
  }
}

/** 0.1.5-rc.1 owns call locations; each root and its Code children share one hidden Chat node. */
export const univerTurnDefinition = {
  kind: 'univerTurn',
  target: 'chat',
  match(event: ConversationEvent) {
    if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event))
      return { id: String(event.data.message.content[0].toolCallId), role: 'update' }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
      return { id: String(event.data.rootCallId), role: 'update' }
    return null
  },
  start(_context, match): UniverTurnState {
    if (match.event.type !== 'tool/call')
      throw new Error('univerTurn start match must be tool/call')
    return addCall({ turn: match.event.data.turn, files: [] }, match.event)
  },
  update(context, match): UniverTurnState {
    return updateOperation(context.state, match.event)
  },
  buildViewNode(context): ChatConversationViewNode | null {
    const state = context.state ?? recoverWindow(context)
    if (state === undefined || state.files.length === 0) return null
    const location = context.start?.location ?? context.matches[0]?.location
    if (location?.kind !== 'step' && location?.kind !== 'turn') return null
    return {
      key: context.key,
      kind: 'univerTurn',
      id: context.id,
      target: 'chat',
      visibility: 'hidden',
      anchorSeq: context.start?.event.seq ?? context.matches[0]!.event.seq,
      location,
      data: { turn: location.turn.turn, files: state.files } satisfies UniverTurnMatch
    }
  }
} satisfies ConversationNodeDefinition<UniverTurnState>

/** One Turn whose tail the Univer card owns. */
export interface UniverTurnClaim {
  readonly turn: number
}

/**
 * Elect the Univer card for the closing Turn.
 *
 * The 0.1.5 chain owner currency is `{ turn, seq, openFile }`: the assembled Chat
 * nodes the 0.1.4 owner carried are gone, and Location data accepts exactly one
 * publisher per Definition kind and Turn, so this Definition — one Context per
 * root call, so that nested Code subcalls fold into their root — cannot publish
 * the Turn aggregate. The election is therefore unconditional and the component
 * decides from the assembled Chat snapshot, rendering nothing when the Turn
 * holds no Univer operation.
 */
export function selectUniverTurn(owner: TurnTailOwnerProps): UniverTurnClaim {
  return { turn: owner.turn.turn }
}

/** Resolve relative files and combine call/result paths that identify the same workspace file. */
export function resolveTurnFiles(files: readonly UniverTurnFile[], cwd?: string): UniverTurnFile[] {
  const unique = new Map<string, UniverTurnFile>()
  for (const target of files) {
    const file = resolveTargetFile(target.file, cwd)
    const previous = unique.get(file)
    unique.set(file, {
      file,
      operations: [
        ...(previous?.operations ?? []),
        ...target.operations.map((operation) => ({ ...operation, file }))
      ].sort((left, right) => left.seq - right.seq)
    })
  }
  return [...unique.values()]
}

/** Reduce operation semantics without allowing later reads to erase lifecycle transitions. */
export function outcomeOfTurnFile(target: UniverTurnFile): UniverTurnOutcome {
  let primaryWorktreeId: string | null = null
  let lifecycle: UniverTurnLifecycle = 'unchanged'
  let preferredUnitId: string | null = null
  let changedContent = false
  for (const operation of target.operations) {
    if (operation.phase !== 'succeeded') continue
    if (operation.unitId !== null) preferredUnitId = operation.unitId
    if (operation.name === 'new') {
      lifecycle = 'trunk'
      primaryWorktreeId = null
      changedContent = true
      continue
    }
    if (operation.name === 'worktree') {
      if (operation.action === 'create' || operation.action === 'reopen') {
        primaryWorktreeId = operation.worktreeId
        lifecycle = 'draft'
      } else if (operation.action === 'ready') {
        primaryWorktreeId = operation.worktreeId
        lifecycle = 'ready'
      } else if (operation.action === 'merge') {
        primaryWorktreeId = operation.worktreeId
        lifecycle = 'merged'
      } else if (operation.action === 'discard') {
        primaryWorktreeId = operation.worktreeId
        lifecycle = 'discarded'
      }
      continue
    }
    if (isWrite(operation)) {
      changedContent = true
      if (lifecycle === 'unchanged' || lifecycle === 'trunk' || lifecycle === 'draft') {
        primaryWorktreeId = operation.worktreeId
        lifecycle = 'draft'
      }
      continue
    }
    if (primaryWorktreeId === null && operation.worktreeId !== null)
      primaryWorktreeId = operation.worktreeId
  }
  return { primaryWorktreeId, lifecycle, preferredUnitId, changedContent }
}

/** Targets referenced anywhere in a timeline, used to restore deliberate floating-window intent. */
export function turnFilesOfChat(chat: ChatSnapshot | undefined, cwd?: string): UniverTurnFile[] {
  return chat === undefined ? [] : resolveTurnFiles(filesOfNodes(chat.nodes.values()), cwd)
}

/** Aggregate native hidden nodes while preserving durable operation order across roots. */
export function filesOfNodes(
  nodes: readonly ChatConversationViewNode[],
  turn?: number
): UniverTurnFile[] {
  const files: UniverTurnFile[] = []
  for (const node of nodes) {
    if (node.kind !== 'univerTurn') continue
    const data = node.data as UniverTurnMatch
    if (turn === undefined || data.turn === turn) files.push(...data.files)
  }
  return resolveTurnFiles(files)
}

/** Whether an operation may deliberately open or restore the live Univer window. */
export function opensFloatingWindow(operation: UniverTurnOperation): boolean {
  if (operation.name === 'new') return true
  if (operation.name === 'worktree') {
    return (
      operation.action === 'create' || operation.action === 'reopen' || operation.action === 'ready'
    )
  }
  return isWrite(operation)
}

function addCall(
  state: UniverTurnState,
  event: SessionEvent<'tool/call' | 'tool/ptc-dispatch-start' | 'tool/ptc-dispatch'>
): UniverTurnState {
  const data = event.data
  const name = operationName(data.name)
  if (name === null) return state
  const args = typeof data.arguments === 'string' ? parseRecord(data.arguments) : data.arguments
  if (!isRecord(args) || typeof args.file !== 'string') return state
  const operation: UniverTurnOperation = {
    callId: 'callId' in data ? data.callId : data.subCallId,
    name,
    action: typeof args.action === 'string' ? args.action : null,
    file: args.file,
    worktreeId: typeof args.worktreeId === 'string' ? args.worktreeId : null,
    unitId: typeof args.unitId === 'string' ? args.unitId : null,
    phase: 'pending',
    seq: event.seq
  }
  if (
    state.files.some((file) => file.operations.some((entry) => entry.callId === operation.callId))
  )
    return state
  return { ...state, files: appendOperation(state.files, operation) }
}

function applyResult(
  state: UniverTurnState,
  callId: string,
  content: readonly ContentBlock[],
  isError: boolean,
  seq: number
): UniverTurnState {
  let matched: UniverTurnOperation | undefined
  for (const file of state.files) {
    const operation = file.operations.find((entry) => entry.callId === callId)
    if (operation !== undefined) matched = operation
  }
  // An unrelated root (including run_code stdout) cannot claim an Univer result.
  if (matched === undefined) return state
  const structured = structuredResult(content, matched.name)
  const result = structured === null || !isRecord(structured.result) ? null : structured.result
  const name = matched.name
  const file = typeof structured?.file === 'string' ? structured.file : matched.file
  const operation: UniverTurnOperation = {
    callId,
    name,
    action: typeof result?.action === 'string' ? result.action : matched.action,
    file,
    worktreeId: typeof result?.worktreeId === 'string' ? result.worktreeId : matched.worktreeId,
    unitId: typeof result?.unitId === 'string' ? result.unitId : matched.unitId,
    phase: !isError && structured !== null ? 'succeeded' : 'failed',
    seq
  }
  const withoutCall = state.files.flatMap((entry) => {
    const operations = entry.operations.filter((candidate) => candidate.callId !== callId)
    return operations.length === 0 ? [] : [{ ...entry, operations }]
  })
  return { ...state, files: appendOperation(withoutCall, operation) }
}

function appendOperation(
  files: readonly UniverTurnFile[],
  operation: UniverTurnOperation
): UniverTurnFile[] {
  const next = [...files]
  const index = next.findIndex((entry) => entry.file === operation.file)
  if (index === -1) next.push({ file: operation.file, operations: [operation] })
  else {
    const previous = next[index]
    if (previous !== undefined)
      next[index] = { ...previous, operations: [...previous.operations, operation] }
  }
  return next
}

function structuredResult(
  content: readonly ContentBlock[],
  name: UniverOperationName
): Record<string, unknown> | null {
  for (const block of content) {
    if (block.type !== 'text') continue
    const value = parseRecord(block.text)
    if (
      value?.ok === true &&
      value.operation === name &&
      typeof value.file === 'string' &&
      Object.hasOwn(value, 'result')
    )
      return value
  }
  return null
}

function updateOperation(state: UniverTurnState, event: ConversationEvent): UniverTurnState {
  if (event.type === 'tool/ptc-dispatch-start') return addCall(state, event)
  if (event.type === 'tool/ptc-dispatch') {
    const pending = addCall(state, event)
    return applyResult(
      pending,
      event.data.subCallId,
      event.data.content,
      event.data.isError,
      event.seq
    )
  }
  if (event.type === 'tool/result') {
    const result = event.data.message.content[0]
    return applyResult(
      state,
      result.toolCallId,
      result.content,
      result.isError === true || event.data.error !== undefined,
      event.seq
    )
  }
  return state
}

/** A paged window may contain child receipts before its root call is loaded. */
function recoverWindow(
  context: ConversationNodeContext<UniverTurnState>
): UniverTurnState | undefined {
  const location = context.matches[0]?.location
  if (location?.kind !== 'step' && location?.kind !== 'turn') return undefined
  let state: UniverTurnState = { turn: location.turn.turn, files: [] }
  for (const match of context.matches) state = updateOperation(state, match.event)
  return state
}

function operationName(name: string): UniverOperationName | null {
  if (!name.startsWith('univer_')) return null
  const operation = name.slice('univer_'.length).replaceAll('_', '-')
  if (
    operation === 'new' ||
    operation === 'status' ||
    operation === 'worktree' ||
    operation === 'unit' ||
    operation === 'import' ||
    operation === 'inspect' ||
    operation === 'execute' ||
    operation === 'export' ||
    operation === 'lint' ||
    operation === 'screenshot' ||
    operation === 'print-pdf' ||
    operation === 'compile-svg'
  )
    return operation
  return null
}

function isWrite(operation: UniverTurnOperation): boolean {
  return (
    operation.name === 'execute' ||
    operation.name === 'import' ||
    operation.name === 'unit' ||
    operation.name === 'compile-svg'
  )
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function resolveTargetFile(file: string, cwd?: string): string {
  const windows = isWindowsPath(file) || (cwd !== undefined && isWindowsPath(cwd))
  if (isAbsolute(file) || cwd === undefined || cwd === '') return normalizeSeparators(file, windows)
  const separator = windows ? '\\' : '/'
  const resolved = `${cwd.replace(/[\\/]+$/, '')}${separator}${file.replace(/^\.[\\/]/, '')}`
  return normalizeSeparators(resolved, windows)
}

function isAbsolute(file: string): boolean {
  return file.startsWith('/') || file.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(file)
}

function isWindowsPath(file: string): boolean {
  return file.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(file)
}

function normalizeSeparators(file: string, windows: boolean): string {
  return windows ? file.replaceAll('/', '\\') : file
}

export function basename(file: string): string {
  const at = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return at === -1 ? file : file.slice(at + 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
