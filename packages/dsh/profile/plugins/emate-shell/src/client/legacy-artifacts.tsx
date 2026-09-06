import type {
  ChatConversationViewNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { FileIcon } from '../../../../../../dsh-plugin-file-import/src/client/file-icons.tsx'
import { allowedMediaType, extensionOf } from '../../../../../../dsh-plugin-file-import/src/contract.ts'
import fileCss from '../../../../../../dsh-plugin-file-import/src/client/style.module.css'
import css from './legacy-artifacts.module.css'

const SHA256 = /^[0-9a-f]{64}$/u
const MAX_BYTES = 512 * 1024 * 1024

interface AvailableLegacyArtifact {
  readonly artifact_id: string
  readonly status: 'available'
  readonly kind: 'artifact' | 'attachment'
  readonly message_seq: string
  readonly name: string
  readonly media_type: string
  readonly size_bytes: number
  readonly sha256: string
}

interface UnavailableLegacyArtifact {
  readonly status: 'unavailable'
  readonly reason: string
  readonly kind: 'artifact' | 'attachment'
  readonly message_seq: string
  readonly name: string
}

type LegacyArtifact = AvailableLegacyArtifact | UnavailableLegacyArtifact

interface LegacyArtifactEventData {
  readonly items: readonly LegacyArtifact[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Read-only evidence for one imported e-Mate/CowAgent artifact group. */
    'emate/legacy-artifacts': LegacyArtifactEventData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Browser projection of imported read-only artifacts. */
    'legacy-artifacts': LegacyArtifactEventData
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function parseItem(value: unknown): LegacyArtifact | null {
  if (!isRecord(value)
    || !['artifact', 'attachment'].includes(String(value.kind))
    || !boundedString(value.message_seq, 256)
    || !boundedString(value.name, 240)) return null
  if (value.status === 'unavailable') {
    return boundedString(value.reason, 80) ? value as unknown as UnavailableLegacyArtifact : null
  }
  if (value.status !== 'available'
    || !boundedString(value.artifact_id, 96)
    || value.artifact_id !== `legacy-sha256:${String(value.sha256)}`
    || typeof value.sha256 !== 'string'
    || !SHA256.test(value.sha256)
    || !boundedString(value.media_type, 128)
    || typeof value.size_bytes !== 'number'
    || !Number.isSafeInteger(value.size_bytes)
    || value.size_bytes < 0
    || value.size_bytes > MAX_BYTES) return null
  return value as unknown as AvailableLegacyArtifact
}

function parseEventData(value: unknown): LegacyArtifactEventData | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 1_000) return null
  const items = value.items.map(parseItem)
  return items.some(item => item === null) ? null : { items: items as LegacyArtifact[] }
}

interface LegacyArtifactState extends LegacyArtifactEventData {
  readonly seq: number
}

export const legacyArtifactDefinition: ConversationNodeDefinition<LegacyArtifactState> = {
  kind: 'emate-legacy-artifacts',
  target: 'chat',
  match: event => event.type === 'emate/legacy-artifacts' && parseEventData(event.data) !== null
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'emate/legacy-artifacts') throw new Error('legacy artifact start requires its own event')
    const data = parseEventData(match.event.data)
    if (data === null) throw new Error('legacy artifact event is invalid')
    return { seq: match.event.seq, items: data.items }
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.state === undefined || context.start === undefined) return null
    return {
      key: context.key,
      kind: 'legacy-artifacts',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start.location,
      visibility: 'visible',
      data: { items: context.state.items },
    }
  },
}

interface LegacyArtifactsProps extends PropsRuntime<'conversation.chat.node', 'legacy-artifacts'> {
  readonly canDownload: boolean
}

function readableBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function LegacyArtifacts({ node, canDownload }: LegacyArtifactsProps) {
  return (
    <section className={css.root} aria-label="历史附件" data-emate-legacy-artifacts="">
      <div className={css.heading}>历史附件</div>
      <div className={css.list}>
        {node.data.items.map((item, index) => (
          <div className={css.item} key={`${item.message_seq}:${index}`} data-status={item.status}>
            <span className={fileCss.icon}><FileIcon name={item.name} mediaType={item.status === 'available' ? item.media_type : allowedMediaType(item.name) ?? 'application/octet-stream'} /></span>
            <div className={`${css.copy} ${fileCss.details}`}>
              <span className={fileCss.name} title={item.name}>{item.name}</span>
              <span className={fileCss.extension}>{extensionOf(item.name).toUpperCase() || 'FILE'}{item.status === 'available' ? ` · ${readableBytes(item.size_bytes)}` : ''}</span>
              {item.status === 'unavailable' && <span className={css.state}>不可用 · {item.reason}</span>}
            </div>
            {item.status === 'available' && canDownload
              ? <a className={css.download} href={`/api/e-mate/legacy-artifact.download?id=${encodeURIComponent(item.sha256)}`} download={item.name} aria-label={`下载 ${item.name}`}>下载</a>
              : item.status === 'available' ? <span className={css.unavailable}>仅可在本机下载</span> : null}
          </div>
        ))}
      </div>
    </section>
  )
}
