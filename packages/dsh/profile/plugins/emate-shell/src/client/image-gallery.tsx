import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type {
  ChatConversationViewNode,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationSnapshot,
  SessionListState,
  UseProjection,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MessageImage } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DESKTOP_RESOURCE_BRIDGE,
  type DesktopResourceAction,
  type DesktopResourceBridgeWindow,
  type DesktopResourceRequest,
} from '../../../../../../../desktop/e-mate-desktop/src/desktop-resource-bridge-contract.ts'
import { normalizedAbsolute } from '../../../../../../../desktop/e-mate-desktop/src/client/resource-context.ts'
import {
  imageReceiptRole,
  parseImageOutputReceipt,
  type ImageGalleryItem,
} from './image-gallery-contract.ts'
import {
  useImageBatchProjection,
  type ImageBatchClientBatch,
  type ImageBatchClientView,
} from './image-batch-client.ts'
import {
  ImageBatchProgress,
  type ImageBatchRetryCall,
  type ImageBatchRetryResult,
  type ImageBatchRetryTask,
} from './image-batch-progress.tsx'
import { FileIcon } from '../../../../../../dsh-plugin-file-import/src/client/file-icons.tsx'
import { allowedMediaType, extensionOf } from '../../../../../../dsh-plugin-file-import/src/contract.ts'
import fileCss from '../../../../../../dsh-plugin-file-import/src/client/style.module.css'
import css from './image-gallery.module.css'

interface ToolImagesData {
  readonly item: ImageGalleryItem
}

interface ToolImagesState extends ToolImagesData {
  readonly sourceSeq: number
}

interface ImageCallsTurnData {
  readonly calls: readonly { readonly callId: string; readonly seq: number }[]
  readonly foregroundSubagents: readonly { readonly seq: number; readonly label: string }[]
  readonly batchCalls?: readonly {
    readonly callId: string
    readonly seq: number
    readonly retryTasks?: readonly ImageBatchRetryTask[]
  }[]
}

const IMAGE_BATCH_ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u

function imageBatchRetryTasks(value: string): readonly ImageBatchRetryTask[] | undefined {
  let args: unknown
  try { args = JSON.parse(value) } catch { return undefined }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  const keys = Object.keys(input)
  if (!Array.isArray(input.tasks) || input.tasks.length < 2 || input.tasks.length > 8
    || keys.some(key => key !== 'tasks' && key !== 'concurrency')
    || input.concurrency !== undefined && (!Number.isSafeInteger(input.concurrency)
      || Number(input.concurrency) < 1 || Number(input.concurrency) > 4)) return undefined
  const tasks: ImageBatchRetryTask[] = []
  for (const [index, value] of input.tasks.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const task = value as Record<string, unknown>
    if (Object.keys(task).some(key => key !== 'prompt' && key !== 'image_url')
      || typeof task.prompt !== 'string') return undefined
    const prompt = task.prompt.trim()
    const rawIds = task.image_url === undefined ? [] : Array.isArray(task.image_url) ? task.image_url : [task.image_url]
    if (prompt.length === 0 || prompt.length > 20_000 || prompt.includes('\0') || rawIds.length > 16
      || rawIds.some(id => typeof id !== 'string' || !IMAGE_BATCH_ATTACHMENT_ID.test(id))) return undefined
    tasks.push(Object.freeze({ ordinal: index + 1, prompt, imageIds: Object.freeze([...new Set(rawIds as string[])]) }))
  }
  return Object.freeze(tasks)
}

interface ImageCallsState extends ImageCallsTurnData {
  readonly turn: number
}

interface SubagentSettledData {
  readonly sessionId: string
}

interface SubagentSettledState extends SubagentSettledData {
  readonly sourceSeq: number
}

type ImageOutputEventData = Record<string, unknown>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Human-visible generated image kept outside model-visible message history. */
    'emate/image-output': ImageOutputEventData
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    /** Ordered direct ImageGen call identities for this engine-owned Turn. */
    'e-mate-image-calls': ImageCallsTurnData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Strict terminal ImageGen receipt; hidden and read only by the Turn tail. */
    'e-mate-tool-images': ToolImagesData
    /** Native background-child settlement identity, hidden and read only by its Turn tail. */
    'e-mate-subagent-settled': SubagentSettledData
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function receipt(event: Parameters<ConversationNodeDefinition<ToolImagesState>['match']>[0]): ImageGalleryItem | null {
  if (event.type !== 'emate/image-output') return null
  const item = parseImageOutputReceipt(event.data)
  return item === null ? null : { ...item, createdAt: event.time }
}

/** Persist only the strict receipt; presentation is owned by the completed Turn tail. */
export const toolImagesDefinition: ConversationNodeDefinition<ToolImagesState> = {
  kind: 'e-mate-tool-images',
  target: 'chat',
  match: event => {
    const item = receipt(event)
    return item === null ? null : { id: `tool-images:${item.callId}`, role: imageReceiptRole(item) }
  },
  start: (_context, match) => {
    const item = receipt(match.event)
    if (item === null) throw new Error('e-Mate image receipt start requires a terminal receipt')
    return { item, sourceSeq: match.event.seq }
  },
  update: (context, match) => {
    const item = receipt(match.event)
    return item === null || item.revision < context.state.item.revision
      ? context.state
      : { ...context.state, item: { ...item, createdAt: context.state.item.createdAt } }
  },
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'e-mate-tool-images',
    id: context.id,
    target: 'chat',
    anchorSeq: context.state.sourceSeq + 0.02,
    location: locationOf(context),
    visibility: 'hidden',
    data: { item: context.state.item },
  }),
}

/** Turn-local direct ImageGen provenance; it publishes no presentation node. */
export const imageCallsDefinition: ConversationNodeDefinition<ImageCallsState> = {
  kind: 'e-mate-image-calls',
  match: event => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call'
      && (event.data.name === 'imagegen' || event.data.name === 'image_batch' || event.data.name === 'subagent')) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('image call marker start requires turn/start')
    return { turn: match.event.data.turn, calls: [], foregroundSubagents: [] }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/call') return context.state
    if (match.event.data.name === 'image_batch') {
      const callId = String(match.event.data.callId)
      const retryTasks = imageBatchRetryTasks(match.event.data.arguments)
      return context.state.batchCalls?.some(call => call.callId === callId)
        ? context.state
        : {
            ...context.state,
            batchCalls: [...context.state.batchCalls ?? [], {
              callId, seq: match.event.seq, ...retryTasks === undefined ? {} : { retryTasks },
            }],
          }
    }
    if (match.event.data.name === 'subagent') {
      let args: unknown
      try { args = JSON.parse(match.event.data.arguments) } catch { return context.state }
      if (args === null || typeof args !== 'object' || Array.isArray(args)
        || (args as { run_in_background?: unknown }).run_in_background !== false
        || typeof (args as { description?: unknown }).description !== 'string'
        || (args as { description: string }).description === ''
        || context.state.foregroundSubagents.some(call => call.seq === match.event.seq)) return context.state
      return {
        ...context.state,
        foregroundSubagents: [...context.state.foregroundSubagents, {
          seq: match.event.seq,
          label: (args as { description: string }).description,
        }],
      }
    }
    if (match.event.data.name !== 'imagegen') return context.state
    const callId = String(match.event.data.callId)
    return context.state.calls.some(call => call.callId === callId)
      ? context.state
      : { ...context.state, calls: [...context.state.calls, { callId, seq: match.event.seq }] }
  },
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined
    ? null
    : {
      kind: 'turn',
      turn: context.state.turn,
      key: 'e-mate-image-calls',
      value: {
        calls: context.state.calls,
        foregroundSubagents: context.state.foregroundSubagents,
        ...context.state.batchCalls === undefined ? {} : { batchCalls: context.state.batchCalls },
      },
    },
}

function settledSessionId(event: Parameters<ConversationNodeDefinition<SubagentSettledState>['match']>[0]): string | null {
  if (event.type !== 'user/message') return null
  const source = event.data.source as { readonly kind?: unknown; readonly senderSessionId?: unknown }
  return source.kind === 'subagent-settled' && typeof source.senderSessionId === 'string' && source.senderSessionId !== ''
    ? source.senderSessionId
    : null
}

/** Keep native background settlement ownership attached to the exact receiving Turn. */
export const subagentSettledDefinition: ConversationNodeDefinition<SubagentSettledState> = {
  kind: 'e-mate-subagent-settled',
  target: 'chat',
  match: event => {
    const sessionId = settledSessionId(event)
    return sessionId === null ? null : { id: `${sessionId}:${event.seq}`, role: 'start' }
  },
  start: (_context, match) => {
    const sessionId = settledSessionId(match.event)
    if (sessionId === null) throw new Error('subagent settlement marker requires a native sender Session')
    return { sessionId, sourceSeq: match.event.seq }
  },
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'e-mate-subagent-settled',
    id: context.id,
    target: 'chat',
    anchorSeq: context.state.sourceSeq,
    location: locationOf(context),
    visibility: 'hidden',
    data: { sessionId: context.state.sessionId },
  }),
}

interface ProducedData {
  readonly produced: readonly { readonly seq: number; readonly path: string }[]
}

export interface ArtifactTerminalMatch {
  readonly callIds: readonly string[]
  readonly batchCallIds?: readonly string[]
  readonly batchRetryCalls?: readonly ImageBatchRetryCall[]
  readonly paths: readonly string[]
  readonly childSessionIds: readonly string[]
  readonly foregroundWindow?: {
    readonly startTime: number
    readonly endTime: number
    readonly labels: readonly string[]
  }
}

/** Claim one live batch tail, or the legacy artifact terminal after its Turn closes. */
export function selectArtifactTerminal(owner: TurnTailOwnerProps): ArtifactTerminalMatch | null {
  const imageData = owner.turn.data.get('e-mate-image-calls')
  const batchCalls = (imageData?.batchCalls ?? [])
    .filter(call => call.seq <= owner.seq)
    .sort((left, right) => left.seq - right.seq)
  const batchCallIds = [...new Set(batchCalls.map(call => call.callId))]
  const batchRetryCalls = batchCalls.flatMap(call => call.retryTasks === undefined
    ? []
    : [{ parentCallId: call.callId, tasks: call.retryTasks }])
  if (owner.turn.status !== 'closed') {
    return batchCallIds.length === 0
      ? null
      : {
          callIds: [], batchCallIds,
          ...batchRetryCalls.length === 0 ? {} : { batchRetryCalls },
          paths: [], childSessionIds: [],
        }
  }
  const candidates = (imageData?.calls ?? []).filter(call => call.seq <= owner.seq)
  const produced = (owner.turn.data as { get(key: string): unknown }).get('deliverables') as ProducedData | undefined
  const paths: string[] = []
  const seenPaths = new Set<string>()
  for (const item of produced?.produced ?? []) {
    if (item.seq > owner.seq || seenPaths.has(item.path)) continue
    seenPaths.add(item.path)
    paths.push(item.path)
  }
  const callIds = [...new Set(candidates
    .sort((left, right) => left.seq - right.seq)
    .map(call => call.callId))]
  const childSessionIds = [...new Set((owner.nodes ?? []).flatMap(node => node.kind === 'e-mate-subagent-settled'
    ? [(node.data as SubagentSettledData).sessionId]
    : []))]
  const foregroundLabels = (imageData?.foregroundSubagents ?? [])
    .filter(call => call.seq <= owner.seq)
    .sort((left, right) => left.seq - right.seq)
    .map(call => call.label)
  const foregroundWindow = foregroundLabels.length > 0 && owner.turn.start !== undefined && owner.turn.end !== undefined
    ? { startTime: owner.turn.start.time, endTime: owner.turn.end.time, labels: foregroundLabels }
    : undefined
  return callIds.length === 0 && batchCallIds.length === 0 && paths.length === 0
    && childSessionIds.length === 0 && foregroundWindow === undefined
    ? null
    : {
        callIds,
        ...batchCallIds.length === 0 ? {} : { batchCallIds },
        ...batchRetryCalls.length === 0 ? {} : { batchRetryCalls },
        paths,
        childSessionIds,
        ...foregroundWindow === undefined ? {} : { foregroundWindow },
      }
}

/** Select only exact background notices or terminal foreground receipts inside this parent Turn. */
export function terminalChildImageItems(
  items: readonly ImageGalleryItem[],
  childSessionIds: readonly string[],
  foregroundWindow?: {
    readonly startTime: number
    readonly endTime: number
    readonly labels: readonly string[]
  },
  settledChildSessionIds: ReadonlySet<string> = new Set(),
): readonly ImageGalleryItem[] {
  const exact = new Set(childSessionIds)
  const labels = new Map<string, number>()
  for (const label of foregroundWindow?.labels ?? []) labels.set(label, (labels.get(label) ?? 0) + 1)
  return items.filter(item => {
    const source = item.source
    if (source === undefined) return false
    const childSessionId = source.sessionId
    if (exact.has(childSessionId)) return true
    const createdAt = item.createdAt
    const remaining = labels.get(source.label) ?? 0
    if (remaining === 0 || settledChildSessionIds.has(childSessionId)
      || foregroundWindow === undefined || createdAt === undefined
      || createdAt < foregroundWindow.startTime || createdAt > foregroundWindow.endTime) return false
    labels.set(source.label, remaining - 1)
    return true
  })
}

function settledChildSessions(nodes: Iterable<ChatConversationViewNode>): ReadonlySet<string> {
  return new Set([...nodes].flatMap(node => node.kind === 'e-mate-subagent-settled'
    ? [(node.data as SubagentSettledData).sessionId]
    : []))
}

/** Read only hidden receipts named by the current Turn, latest revision wins. */
export function terminalImageItems(
  nodes: Iterable<ChatConversationViewNode>,
  callIds: readonly string[],
  turn: number,
  title?: string,
): readonly ImageGalleryItem[] {
  const allNodes = [...nodes]
  const named = title === undefined
    ? undefined
    : new Map(galleryImageItems(allNodes, title).map(item => [item.callId, item]))
  const allowed = new Set(callIds)
  const latest = new Map<string, ImageGalleryItem>()
  for (const node of allNodes) {
    if (node.kind !== 'e-mate-tool-images' || node.visibility !== 'hidden') continue
    if ((node.location.kind !== 'turn' && node.location.kind !== 'step') || node.location.turn.turn !== turn) continue
    const item = (node.data as ToolImagesData).item
    if (!allowed.has(item.callId) || (latest.get(item.callId)?.revision ?? -1) > item.revision) continue
    latest.set(item.callId, named?.get(item.callId) ?? item)
  }
  return callIds.flatMap(callId => latest.get(callId) ?? [])
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const IMAGE_TOPIC_MAX_BYTES = 120

function truncateUtf8(value: string, maximum: number): string {
  const encoder = new TextEncoder()
  let result = ''
  let bytes = 0
  for (const character of value) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > maximum) break
    result += character
    bytes += size
  }
  return result
}

function safeImageTopic(value: string | undefined): string {
  const cleaned = (value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/-+/gu, '-')
    .trim()
    .replace(/^[ .-]+|[ .-]+$/gu, '')
  const limited = truncateUtf8(cleaned, IMAGE_TOPIC_MAX_BYTES).replace(/[ .-]+$/gu, '')
  return limited === '' || WINDOWS_RESERVED_NAME.test(limited) ? 'e-Mate-图片' : limited
}

function imageTimestamp(value: number): string {
  const date = new Date(value)
  const safe = Number.isFinite(date.getTime()) ? date : new Date(0)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${safe.getFullYear()}${pad(safe.getMonth() + 1)}${pad(safe.getDate())}-${pad(safe.getHours())}${pad(safe.getMinutes())}${pad(safe.getSeconds())}`
}

function imageExtension(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
}

/** Project one stable display name used by Gallery, download, preview, and draft attachment flows. */
export function namedGalleryImageItems(
  items: readonly ImageGalleryItem[],
  title: string | undefined,
): readonly ImageGalleryItem[] {
  const topic = safeImageTopic(title)
  const prepared = items.map(item => {
    if (item.attachment === undefined || item.createdAt === undefined) return { item }
    const operation = item.operation === 'generate' || item.operation === 'unknown' ? '生成' : '改图'
    const source = item.source === undefined ? '' : `-子任务${String(item.source.ordinal).padStart(2, '0')}`
    return {
      item,
      base: `${topic}${source}-${operation}-${imageTimestamp(item.createdAt)}`,
      extension: imageExtension(item.attachment.mediaType),
    }
  })
  const totals = new Map<string, number>()
  for (const entry of prepared) {
    if (entry.base !== undefined) totals.set(entry.base, (totals.get(entry.base) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return prepared.map(entry => {
    if (entry.base === undefined || entry.extension === undefined || entry.item.attachment === undefined) return entry.item
    const index = (seen.get(entry.base) ?? 0) + 1
    seen.set(entry.base, index)
    const suffix = (totals.get(entry.base) ?? 0) > 1 ? `-${String(index).padStart(2, '0')}` : ''
    return {
      ...entry.item,
      attachment: { ...entry.item.attachment, name: `${entry.base}${suffix}.${entry.extension}` },
    }
  })
}

/** Project the active Session's strict receipts into one latest-first Gallery list. */
export function galleryImageItems(
  nodes: Iterable<ChatConversationViewNode>,
  title?: string,
): readonly ImageGalleryItem[] {
  const latest = new Map<string, { readonly item: ImageGalleryItem; readonly anchorSeq: number }>()
  for (const node of nodes) {
    if (node.kind !== 'e-mate-tool-images' || node.visibility !== 'hidden') continue
    const item = (node.data as ToolImagesData).item
    const current = latest.get(item.callId)
    if (current !== undefined
      && (current.item.revision > item.revision
        || current.item.revision === item.revision && current.anchorSeq >= node.anchorSeq)) continue
    latest.set(item.callId, { item, anchorSeq: node.anchorSeq })
  }
  const items = [...latest.values()]
    .sort((left, right) => right.anchorSeq - left.anchorSeq)
    .map(value => value.item)
  return title === undefined ? items : namedGalleryImageItems(items, title)
}

const IMAGE_RECEIPTS_PROJECTION = 'eMateImageReceipts'

interface ProjectedImageReceipt {
  readonly seq: number
  readonly createdAt: number
  readonly receipt: Record<string, unknown>
}

function projectedImageReceipts(value: unknown): readonly ProjectedImageReceipt[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is ProjectedImageReceipt => row !== null && typeof row === 'object'
    && Number.isSafeInteger((row as ProjectedImageReceipt).seq)
    && Number.isFinite((row as ProjectedImageReceipt).createdAt)
    && (row as ProjectedImageReceipt).receipt !== null
    && typeof (row as ProjectedImageReceipt).receipt === 'object'
    && !Array.isArray((row as ProjectedImageReceipt).receipt))
}

/** Project direct child receipts from rc.7's native Session list; child ownership stays unchanged. */
export function childGalleryImageItems(
  sessions: Pick<SessionListState, 'byId' | 'subagentsByParent'>,
  parentSessionId: string,
): readonly ImageGalleryItem[] {
  const candidates: Array<{
    readonly item: ImageGalleryItem
    readonly seq: number
    readonly ordinal: number
  }> = []
  const entries = sessions.subagentsByParent?.[parentSessionId]?.entries ?? []
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'child') continue
    const summary = sessions.byId[entry.id]
    const projection = (summary?.projectionValues as Readonly<Record<string, unknown>> | undefined)
      ?.[IMAGE_RECEIPTS_PROJECTION]
    const ordinal = index + 1
    const label = entry.label?.trim() || summary?.displayTitle?.trim() || `子任务 ${ordinal}`
    for (const row of projectedImageReceipts(projection)) {
      if (row.receipt.parent_session_id !== entry.id || row.receipt.child_session_id !== undefined) continue
      const item = parseImageOutputReceipt(row.receipt)
      if (item === null) continue
      candidates.push({
        item: {
          ...item,
          createdAt: row.createdAt,
          source: {
            kind: 'subagent', sessionId: entry.id, label, ordinal, mode: entry.mode, receiptEventSeq: row.seq,
          } as ImageGalleryItem['source'] & { readonly receiptEventSeq: number },
        },
        seq: row.seq,
        ordinal,
      })
    }
  }
  const latest = new Map<string, typeof candidates[number]>()
  for (const candidate of candidates) {
    const key = `${candidate.item.source!.sessionId}\0${candidate.item.callId}`
    const current = latest.get(key)
    if (current !== undefined
      && (current.item.revision > candidate.item.revision
        || current.item.revision === candidate.item.revision && current.seq >= candidate.seq)) continue
    latest.set(key, candidate)
  }
  return [...latest.values()]
    .sort((left, right) => (left.item.createdAt ?? 0) - (right.item.createdAt ?? 0)
      || left.seq - right.seq || left.ordinal - right.ordinal)
    .map(value => value.item)
}

function batchReceiptKey(sessionId: string, callId: string, revision: number, eventSeq: number): string {
  return [sessionId, callId, revision, eventSeq].join('\0')
}

function exactBatches(view: readonly ImageBatchClientBatch[], callIds: readonly string[]): readonly ImageBatchClientBatch[] {
  const byCall = new Map(view.map(batch => [batch.parentCallId, batch]))
  return callIds.flatMap(callId => byCall.get(callId) ?? [])
}

/** Use legacy child discovery unless exact batch state or a logged image_batch call owns the Session. */
export function schemaAwareChildGalleryImageItems(
  sessions: Pick<SessionListState, 'byId' | 'subagentsByParent'>,
  parentSessionId: string,
  batchView: ImageBatchClientView,
  hasLoggedBatchCall = false,
): readonly ImageGalleryItem[] {
  const items = childGalleryImageItems(sessions, parentSessionId)
  if (batchView.batches.length === 0) return hasLoggedBatchCall ? [] : items
  const childIds = new Set(batchView.batches.flatMap(batch => batch.tasks.flatMap(task => task.childSessionId ?? [])))
  const pointers = new Set(batchView.batches.flatMap(batch => batch.tasks.flatMap(task => {
    const child = task.childSessionId
    const receipt = task.receipt
    return child === undefined || receipt === undefined
      ? []
      : [batchReceiptKey(child, receipt.callId, receipt.revision, receipt.eventSeq)]
  })))
  return items.filter(item => {
    const source = item.source as (ImageGalleryItem['source'] & { readonly receiptEventSeq?: number })
    if (source === undefined || !childIds.has(source.sessionId)) return true
    return source.receiptEventSeq !== undefined
      && pointers.has(batchReceiptKey(source.sessionId, item.callId, item.revision, source.receiptEventSeq))
  })
}

function snapshotHasImageBatchCall(snapshot: ConversationSnapshot): boolean {
  const current = snapshot.chat.timeline.turnOrder.at(-1)
  if (current === undefined) return false
  const data = snapshot.chat.timeline.turns.get(current)?.data.get('e-mate-image-calls')
  return (data?.batchCalls?.length ?? 0) > 0
}

const imageLabels = {
  image: '图像',
  open: '查看原图',
  openNamed: (label: string) => `查看原图：${label}`,
  loading: '正在加载图像…',
  loadFailed: '图像加载失败，点击重试',
  lightbox: { dialog: '原图预览', close: '关闭原图预览' },
}

type MenuTarget =
  | { readonly kind: 'image'; readonly item: ImageGalleryItem }
  | { readonly kind: 'file'; readonly path: string }

interface MenuState {
  readonly target: MenuTarget
  readonly left: number
  readonly top: number
}

interface InputSnapshot {
  readonly imageIds: readonly string[]
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

interface ArtifactTerminalProps extends TurnTailOwnerProps {
  readonly addImageToCanvas?: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<void>
  readonly matched: ArtifactTerminalMatch
  readonly sessionId: string
  readonly useSession: <T>(selector: (snapshot: ConversationSnapshot) => T) => T
  readonly useSessions: <T>(
    selector: (snapshot: SessionListState) => T, equal?: (left: T, right: T) => boolean
  ) => T
  readonly useInput: <T>(selector: (input: InputSnapshot) => T) => T
  readonly useProjection: UseProjection
  readonly loadImage: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<string>
  readonly prepareImageRetry?: (task: ImageBatchRetryTask) => Promise<ImageBatchRetryResult>
  readonly addImageToDraft: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<void>
  readonly draftBytes: (ids: readonly string[]) => number
  readonly notify: (level: 'info' | 'error', text: string) => void
  readonly runResource: (request: DesktopResourceRequest) => Promise<void>
}

interface ImageGalleryViewProps {
  readonly addImageToCanvas?: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<void>
  readonly sessionId: string
  readonly useSession: <T>(selector: (snapshot: ConversationSnapshot) => T) => T
  readonly useSessions: <T>(
    selector: (snapshot: SessionListState) => T, equal?: (left: T, right: T) => boolean
  ) => T
  readonly useInput: <T>(selector: (input: InputSnapshot) => T) => T
  readonly useProjection: UseProjection
  readonly loadImage: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<string>
  readonly addImageToDraft: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<void>
  readonly draftBytes: (ids: readonly string[]) => number
  readonly notify: (level: 'info' | 'error', text: string) => void
  readonly runResource: (request: DesktopResourceRequest) => Promise<void>
}

function fileName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? path : path.slice(at + 1)
}

export function galleryAttachmentName(attachment: ImageAttachmentRef): string {
  return attachment.name?.trim() || 'e-Mate-图片.png'
}

export function draftImageAdmissionError(
  attachment: ImageAttachmentRef,
  input: InputSnapshot,
  limits: ImageAttachmentLimits | undefined,
  existingBytes: number,
): string | undefined {
  if (input.phase === 'adjudicating' || input.phase === 'submitting') return '当前正在发送消息，请稍后再添加图片。'
  if (limits === undefined) return '当前会话未启用图片附件。'
  if (!limits.mediaTypes.includes(attachment.mediaType)) return '当前会话不支持这种图片格式。'
  if (input.imageIds.length + 1 > limits.maxImagesPerMessage) return `最多可添加 ${limits.maxImagesPerMessage} 张图片。`
  if (attachment.bytes > limits.maxImageBytes) return '这张图片超过单张附件大小上限。'
  if (existingBytes + attachment.bytes > limits.maxMessageImageBytes) return '图片附件总大小超过当前消息上限。'
  if (attachment.width * attachment.height > limits.maxImagePixels) return '这张图片的像素尺寸超过上限。'
  return undefined
}

function admissionError(
  item: ImageGalleryItem,
  input: InputSnapshot,
  limits: ImageAttachmentLimits | undefined,
  existingBytes: number,
): string | undefined {
  if (item.status === 'review-required') return '待确认图片不能添加到聊天。'
  if (item.attachment === undefined) return '这张图片没有可用附件。'
  return draftImageAdmissionError(item.attachment, input, limits, existingBytes)
}

const galleryStatus = {
  all: '全部状态',
  completed: '已完成',
  'review-required': '待确认',
  failed: '失败',
} as const

const galleryOperation = {
  all: '全部类型',
  generate: '生成',
  edit: '改图',
  fusion: '融合',
  unknown: '未知',
} as const

const GALLERY_PAGE_SIZE = 24

function galleryItemIdentity(item: ImageGalleryItem): string {
  return `${item.source?.sessionId ?? 'self'}:${item.callId}`
}

/** Native conversation.view reader over the same durable receipts used by the Turn tail. */
export function ImageGalleryView({
  sessionId, useSession, useSessions, useInput, useProjection, loadImage, addImageToDraft, addImageToCanvas, draftBytes, notify, runResource,
}: ImageGalleryViewProps) {
  const snapshot = useSession(value => value)
  const sessions = useSessions(value => value)
  const title = sessions.byId[sessionId]?.title
  const input = useInput(value => value)
  const limits = useProjection('imageLimits')
  const batchView = useImageBatchProjection(useProjection, sessionId)
  const items = namedGalleryImageItems([
    ...schemaAwareChildGalleryImageItems(sessions, sessionId, batchView, snapshotHasImageBatchCall(snapshot)),
    ...galleryImageItems(snapshot.chat.nodes.values()),
  ], title ?? '')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<keyof typeof galleryStatus>('all')
  const [operation, setOperation] = useState<keyof typeof galleryOperation>('all')
  const [page, setPage] = useState(0)
  const datasetKey = items.map(item => [
    item.callId,
    item.revision,
    item.status,
    item.attachment?.attachmentId ?? item.failureCode ?? '',
    item.source?.sessionId ?? '',
  ].join(':')).join('|')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = items.filter(item => {
    if (status !== 'all' && item.status !== status) return false
    if (operation !== 'all' && item.operation !== operation) return false
    if (normalizedQuery === '') return true
    return [
      item.attachment?.name,
      item.callId,
      item.failureCode,
      item.source?.label,
      galleryStatus[item.status],
      galleryOperation[item.operation],
    ].some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
  })
  const pages = Math.max(1, Math.ceil(filtered.length / GALLERY_PAGE_SIZE))
  const shown = filtered.slice(page * GALLERY_PAGE_SIZE, (page + 1) * GALLERY_PAGE_SIZE)
  const existingBytes = draftBytes(input.imageIds)

  useEffect(() => { setPage(0) }, [sessionId, query, status, operation, datasetKey])

  const imageAction = (item: ImageGalleryItem, action: 'copy-image' | 'save-as'): void => {
    const attachment = item.attachment
    if (attachment === undefined) return
    const ownerSessionId = item.source?.sessionId ?? sessionId
    void loadImage(attachment, ownerSessionId).then(src => runResource({
      action,
      resource: {
        kind: 'image',
        sessionId: ownerSessionId,
        name: galleryAttachmentName(attachment),
        src,
      },
    })).catch(() => { notify('error', '图片操作失败，请确认图片仍可用。') })
  }

  const addToDraft = (item: ImageGalleryItem): void => {
    const error = admissionError(item, input, limits, existingBytes)
    if (error !== undefined) { notify('error', error); return }
    const addition = item.source === undefined
      ? addImageToDraft(item.attachment!)
      : addImageToDraft(item.attachment!, item.source.sessionId)
    void addition.catch(() => {
      notify('error', '图片未能添加到聊天，请重试。')
    })
  }

  return <section className={css.galleryView} aria-label="画廊">
    <div className={css.galleryToolbar}>
      <input
        type="search"
        value={query}
        placeholder="搜索文件名或结果编号"
        onChange={event => { setQuery(event.currentTarget.value) }}
      />
      <select aria-label="筛选状态" value={status} onChange={event => {
        setStatus(event.currentTarget.value as keyof typeof galleryStatus)
      }}>
        {Object.entries(galleryStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <select aria-label="筛选类型" value={operation} onChange={event => {
        setOperation(event.currentTarget.value as keyof typeof galleryOperation)
      }}>
        {Object.entries(galleryOperation).filter(([value]) => value !== 'unknown')
          .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>

    {shown.length === 0
      ? <div className={css.galleryEmpty}>暂无图片结果</div>
      : <div className={css.galleryGrid}>
        {shown.map(item => {
          const attachment = item.attachment
          const label = attachment === undefined ? item.callId : galleryAttachmentName(attachment)
          const addError = admissionError(item, input, limits, existingBytes)
          return <article key={`${galleryItemIdentity(item)}:${item.revision}`} className={css.galleryCard} aria-label={label}>
            {attachment === undefined
              ? <div className={css.galleryFailure} role="status">
                <strong>{item.callId}</strong>
                {item.source !== undefined && <span>来自子任务：{item.source.label}</span>}
                <span>错误：{item.failureCode ?? 'unknown'}</span>
              </div>
              : <>
                <div className={css.galleryPreview}>
                  <MessageImage attachment={attachment}
                    load={value => loadImage(value, item.source?.sessionId)} variant="tile" labels={imageLabels} />
                  {item.status === 'review-required' && <span className={css.status}>待确认</span>}
                </div>
                <div className={css.galleryMeta}>
                  <strong title={label}>{label}</strong>
                  <span>{item.source === undefined ? '' : `来自子任务：${item.source.label} · `}{galleryOperation[item.operation]} · {galleryStatus[item.status]}</span>
                </div>
                <div className={css.galleryActions}>
                  {addImageToCanvas && <button type="button" className={css.canvasAction}
                    aria-label={`加入画布：${label}`} title="加入画布" disabled={item.status === 'review-required'}
                    onClick={() => { void addImageToCanvas(attachment, item.source?.sessionId).catch(() => {
                      notify('error', '图片未能加入画布，请确认附件仍可用。')
                    }) }}>加入画布</button>}
                  <button type="button" aria-label={`复制图像：${label}`} title="复制图像"
                    onClick={() => { imageAction(item, 'copy-image') }}><IconCopyOutline16 /></button>
                  <button type="button" aria-label={`下载副本：${label}`} title="下载副本"
                    onClick={() => { imageAction(item, 'save-as') }}><IconDownloadOutline16 /></button>
                  <button type="button" aria-label={`添加到聊天：${label}`} title={addError ?? '添加到聊天'}
                    disabled={addError !== undefined} onClick={() => { addToDraft(item) }}><IconPlusOutline16 /></button>
                </div>
              </>}
          </article>
        })}
      </div>}

    {filtered.length > 0 && <div className={css.galleryPager}>
      <button type="button" aria-label="画廊上一页" disabled={page === 0}
        onClick={() => { setPage(value => Math.max(0, value - 1)) }}><IconChevronLeftOutline14 /></button>
      <span>第 {page + 1} / {pages} 页</span>
      <button type="button" aria-label="画廊下一页" disabled={page + 1 >= pages}
        onClick={() => { setPage(value => Math.min(pages - 1, value + 1)) }}><IconChevronRightOutline14 /></button>
    </div>}
  </section>
}

function Menu({ state, menuRef, buttonRefs, close, activate }: {
  readonly state: MenuState
  readonly menuRef: RefObject<HTMLDivElement | null>
  readonly buttonRefs: MutableRefObject<Array<HTMLButtonElement | null>>
  readonly close: () => void
  readonly activate: (action: string) => void
}) {
  const image = state.target.kind === 'image'
  const review = image && state.target.item.status === 'review-required'
  const actions = image
    ? [
      ['add-image', '添加到聊天', review],
      ['copy-image', '复制图像', false],
      ['reveal', navigator.platform.includes('Win') ? '在资源管理器中显示' : '在 Finder 中显示', false],
      ['save-as', '下载副本', false],
    ] as const
    : [
      ['default-open', '在默认应用中打开', false],
      ['open-with', '打开方式 > 选择应用…', false],
      ['save-as', '另存为…', false],
      ['copy-path', '复制路径', false],
      ['copy-file', '复制文件内容', false],
      ['reveal', navigator.platform.includes('Win') ? '在资源管理器中显示' : '在 Finder 中显示', false],
    ] as const
  const move = (from: number, offset: number): void => {
    const enabled = buttonRefs.current.filter((button): button is HTMLButtonElement => button !== null && !button.disabled)
    const at = Math.max(0, enabled.indexOf(buttonRefs.current[from]!))
    enabled[(at + offset + enabled.length) % enabled.length]?.focus()
  }
  return <div
    ref={menuRef}
    className={css.menu}
    role="menu"
    aria-label={image ? '图片操作' : '文件操作'}
    style={{ left: state.left, top: state.top }}
    onKeyDown={event => {
      const index = buttonRefs.current.indexOf(event.target as HTMLButtonElement)
      if (event.key === 'Escape') { event.preventDefault(); close() }
      else if (event.key === 'ArrowDown') { event.preventDefault(); move(index, 1) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(index, -1) }
    }}
  >
    {actions.map(([action, label, disabled], index) => <button
      key={action}
      ref={button => { buttonRefs.current[index] = button }}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => { activate(action) }}
    >{label}</button>)}
  </div>
}

function ImageTerminal({ items, loadImage, openMenu, addToCanvas }: {
  readonly addToCanvas?: (item: ImageGalleryItem) => void
  readonly items: readonly ImageGalleryItem[]
  readonly loadImage: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<string>
  readonly openMenu: (target: MenuTarget, source: HTMLElement | { clientX: number; clientY: number }) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const images = items.filter((item): item is ImageGalleryItem & { attachment: ImageAttachmentRef } => item.attachment !== undefined)
  const sync = (): void => {
    const rail = railRef.current
    if (rail === null) return
    setCanBack(rail.scrollLeft > 2)
    setCanForward(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2)
  }
  useLayoutEffect(sync, [images.length])
  const step = (direction: -1 | 1): void => {
    const rail = railRef.current
    if (rail === null) return
    rail.scrollBy({ left: direction * rail.clientWidth, behavior: 'smooth' })
  }
  if (images.length === 0) return null
  return <section className={css.images} aria-label="图片结果">
    {images.length > 0 && <div className={css.railWrap}>
      <div ref={railRef} className={css.rail} onScroll={sync}>
        {images.map(item => <div
          key={`${galleryItemIdentity(item)}:${item.revision}`}
          className={css.imageItem}
          data-status={item.status}
          onContextMenu={event => { event.preventDefault(); openMenu({ kind: 'image', item }, event) }}
        >
          <MessageImage attachment={item.attachment}
            load={value => loadImage(value, item.source?.sessionId)} variant="tile" labels={imageLabels} />
          {item.status === 'review-required' && <span className={css.status}>待确认</span>}
          {addToCanvas && <button type="button" className={`${css.imageAction} ${css.imageCanvasAction}`}
            disabled={item.status === 'review-required'} aria-label={`加入画布：${galleryAttachmentName(item.attachment)}`}
            onClick={() => { addToCanvas(item) }}>加入画布</button>}
          <button
            type="button"
            className={css.imageAction}
            aria-label={`图片操作：${galleryAttachmentName(item.attachment)}`}
            onClick={event => { openMenu({ kind: 'image', item }, event.currentTarget) }}
          ><i aria-hidden="true" /><span>1</span></button>
        </div>)}
      </div>
      {images.length > 1 && <div className={css.arrows}>
        <button type="button" aria-label="上一组图片" disabled={!canBack} onClick={() => { step(-1) }}>
          <IconChevronLeftOutline14 />
        </button>
        <button type="button" aria-label="下一组图片" disabled={!canForward} onClick={() => { step(1) }}>
          <IconChevronRightOutline14 />
        </button>
      </div>}
    </div>}
  </section>
}

function FileTerminal({ paths, openFile, openMenu }: {
  readonly paths: readonly string[]
  readonly openFile: (path: string) => void
  readonly openMenu: (target: MenuTarget, source: HTMLElement | { clientX: number; clientY: number }) => void
}) {
  if (paths.length === 0) return null
  const shown = paths.slice(0, 6)
  const hidden = paths.length - shown.length
  return <section className={css.files} aria-label="产物文件">
    {shown.map((path, index) => {
      const name = fileName(path)
      const extension = extensionOf(name).toUpperCase() || 'FILE'
      return <div className={css.fileRow} key={`${path}:${index}`} onContextMenu={event => {
        event.preventDefault()
        openMenu({ kind: 'file', path }, event)
      }}>
        <button type="button" className={css.fileOpen} title={name} aria-label={`打开 ${name}`} onClick={() => { openFile(path) }}>
          <span className={fileCss.icon}><FileIcon name={name} mediaType={allowedMediaType(name) ?? 'application/octet-stream'} /></span>
          <span className={fileCss.details}><span className={fileCss.name} title={name}>{name}</span><span className={fileCss.extension}>{extension}</span></span>
        </button>
        <button
          type="button"
          className={css.fileMenu}
          aria-label={`打开方式：${name}`}
          onClick={event => { openMenu({ kind: 'file', path }, event.currentTarget) }}
        ><IconEllipsisOutline16 /></button>
      </div>
    })}
    {hidden > 0 && <button type="button" className={css.moreFiles} onClick={() => { openFile('.') }}>
      其余 {hidden} 项，在文件夹中查看
    </button>}
  </section>
}

const NO_BATCHES: readonly ImageBatchClientBatch[] = []
const NO_BATCH_CHILD_IDS: ReadonlySet<string> = new Set()

interface ArtifactTerminalBodyProps extends ArtifactTerminalProps {
  readonly batches: readonly ImageBatchClientBatch[]
  readonly batchChildIds: ReadonlySet<string>
}

function BatchArtifactTerminal(props: ArtifactTerminalProps & { readonly batchCallIds: readonly string[] }) {
  const batchView = useImageBatchProjection(props.useProjection, props.sessionId)
  const batches = useMemo(
    () => exactBatches(batchView.batches, props.batchCallIds),
    [batchView, props.batchCallIds],
  )
  const batchChildIds = useMemo(() => new Set(batches.flatMap(
    batch => batch.tasks.flatMap(task => task.childSessionId ?? []),
  )), [batches])
  return <ArtifactTerminalBody {...props} batches={batches} batchChildIds={batchChildIds} />
}

/** Select the batch-aware tail without subscribing legacy artifact terminals to batch state. */
export function ArtifactTerminal(props: ArtifactTerminalProps) {
  const batchCallIds = props.matched.batchCallIds
  return batchCallIds === undefined || batchCallIds.length === 0
    ? <ArtifactTerminalBody
        {...props} batches={NO_BATCHES} batchChildIds={NO_BATCH_CHILD_IDS}
      />
    : <BatchArtifactTerminal {...props} batchCallIds={batchCallIds} />
}

/** Render hidden image receipts, native deliverables, and optional exact batch progress. */
function ArtifactTerminalBody({
  matched, sessionId, turn, useSession, useSessions, useInput, useProjection,
  openFile, loadImage, prepareImageRetry, addImageToDraft, addImageToCanvas, draftBytes, notify, runResource,
  batches, batchChildIds,
}: ArtifactTerminalBodyProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtons = useRef<Array<HTMLButtonElement | null>>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const snapshot = useSession(value => value)
  const input = useInput(value => value)
  const limits = useProjection('imageLimits')
  const sessions = useSessions(value => value)
  const summary = sessions.byId[sessionId]
  const ambiguousBatch = (matched.batchCallIds?.length ?? 0) > 0 && batches.length === 0
  const root = summary?.cwd
  const items = useMemo(
    () => {
      const nodes = [...snapshot.chat.nodes.values()]
      return namedGalleryImageItems([
        ...terminalImageItems(nodes, matched.callIds, turn.turn),
        ...ambiguousBatch ? [] : terminalChildImageItems(
          childGalleryImageItems(sessions, sessionId).filter(
            item => item.source === undefined || !batchChildIds.has(item.source.sessionId),
          ),
          matched.childSessionIds, matched.foregroundWindow, settledChildSessions(nodes),
        ),
      ], summary?.title ?? '')
    },
    [ambiguousBatch, batchChildIds, matched.callIds, matched.childSessionIds, matched.foregroundWindow, sessionId, sessions, snapshot, summary?.title, turn.turn],
  )
  const seenFailures = useRef(new Set<string>())
  const existingBytes = draftBytes(input.imageIds)
  const closeMenu = (): void => { setMenu(null); menuButtons.current = [] }

  useEffect(() => {
    const failures = items.filter(item => item.status === 'failed' && !seenFailures.current.has(item.callId))
    if (failures.length === 0) return
    for (const item of failures) seenFailures.current.add(item.callId)
    notify('error', failures.length === 1
      ? '图片生成失败，可在画廊的「失败」筛选中查看详情。'
      : `${failures.length} 张图片生成失败，可在画廊的「失败」筛选中查看详情。`)
  }, [items, notify])

  useEffect(() => {
    if (menu === null) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closeMenu()
    }
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('pointerdown', outside) }
  }, [menu])

  const openMenu = (target: MenuTarget, source: HTMLElement | { clientX: number; clientY: number }): void => {
    const bounds = rootRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const point = source instanceof HTMLElement
      ? source.getBoundingClientRect()
      : { left: source.clientX, bottom: source.clientY }
    setMenu({
      target,
      left: Math.max(8, Math.min(point.left - bounds.left, bounds.width - 236)),
      top: Math.max(8, point.bottom - bounds.top + 6),
    })
    queueMicrotask(() => { menuButtons.current.find(button => button !== null && !button.disabled)?.focus() })
  }

  const resource = (target: MenuTarget, action: DesktopResourceAction): Promise<void> => {
    if (target.kind === 'image') {
      const attachment = target.item.attachment
      if (attachment === undefined) return Promise.reject(new Error('图片附件不可用'))
      const ownerSessionId = target.item.source?.sessionId ?? sessionId
      return loadImage(attachment, ownerSessionId).then(src => runResource({ action, resource: {
        kind: 'image', sessionId: ownerSessionId, name: galleryAttachmentName(attachment), src,
      } }))
    }
    if (root === undefined) return Promise.reject(new Error('当前工作区不可用'))
    const path = normalizedAbsolute(root, target.path)
    if (path === undefined) return Promise.reject(new Error('文件路径不可用'))
    return runResource({ action, resource: { kind: 'file', sessionId, root, path } })
  }

  const activate = (action: string): void => {
    const target = menu?.target
    closeMenu()
    if (target === undefined) return
    if (action === 'default-open' && target.kind === 'file') { openFile(target.path); return }
    if (action === 'add-image' && target.kind === 'image') {
      const error = admissionError(target.item, input, limits, existingBytes)
      if (error !== undefined) { notify('error', error); return }
      const ownerSessionId = target.item.source?.sessionId
      void (ownerSessionId === undefined
        ? addImageToDraft(target.item.attachment!)
        : addImageToDraft(target.item.attachment!, ownerSessionId))
        .catch(() => { notify('error', '图片未能添加到聊天，请重试。') })
      return
    }
    void resource(target, action as DesktopResourceAction).catch(() => {
      notify('error', '系统文件操作失败，请确认资源仍存在且属于当前工作区。')
    })
  }

  if (!items.some(item => item.attachment !== undefined) && matched.paths.length === 0
    && batches.length === 0) return null

  return <div ref={rootRef} className={css.terminal} data-emate-artifact-terminal="">
    {batches.length > 0 && <ImageBatchProgress
      batches={batches}
      {...matched.batchRetryCalls === undefined ? {} : { retryCalls: matched.batchRetryCalls }}
      {...prepareImageRetry === undefined ? {} : { prepareRetry: prepareImageRetry }}
      useSessions={useSessions}
      loadImage={loadImage}
    />}
    <ImageTerminal items={items} loadImage={loadImage} openMenu={openMenu}
      {...addImageToCanvas ? { addToCanvas: (item: ImageGalleryItem) => {
        if (!item.attachment || item.status === 'review-required') return
        void addImageToCanvas(item.attachment, item.source?.sessionId).catch(() => {
          notify('error', '图片未能加入画布，请确认附件仍可用。')
        })
      } } : {}} />
    <FileTerminal paths={matched.paths} openFile={openFile} openMenu={openMenu} />
    {menu !== null && <Menu
      state={menu}
      menuRef={menuRef}
      buttonRefs={menuButtons}
      close={closeMenu}
      activate={activate}
    />}
  </div>
}

/** Resolve the preload bridge lazily so idle chat has zero IPC. */
export function desktopResourceRun(request: DesktopResourceRequest): Promise<void> {
  const bridge = (window as DesktopResourceBridgeWindow)[DESKTOP_RESOURCE_BRIDGE]
  return bridge === undefined
    ? Promise.reject(new Error('系统文件操作不可用，请使用桌面版 e-Mate。'))
    : bridge.run(request)
}
