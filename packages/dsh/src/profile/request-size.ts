const MiB = 1024 * 1024
export const MAX_RESPONSES_BYTES = 48 * MiB
const MAX_REGION_BYTES = 32 * MiB
// Reserve framing/system instruction bytes; encoded image bodies are counted exactly.
const ENVELOPE_RESERVE = MiB
export const REQUEST_TOO_LARGE_MESSAGE = '本次请求超过企业服务 48 MiB 的容量限制。历史记录和附件原件已保留；请将当前图片或文件分批发送，或新建任务只带本次需要的资料。请求未自动重试。'

function imageBytes(blocks) {
  let bytes = 0
  for (const block of blocks ?? []) {
    if (block.type === 'image') {
      const size = block.attachment?.bytes
      if (!Number.isSafeInteger(size) || size < 0) return Infinity
      bytes += 4 * Math.ceil(size / 3)
    } else if (block.type === 'tool-result') bytes += imageBytes(block.content)
  }
  return bytes
}

function messageBytes(message) {
  // pi-ai expands native messages/tools into wire records and may replay provider
  // state. Twice the serialized metadata bounds that framing without reading CAS.
  return 2 * Buffer.byteLength(JSON.stringify(message)) + imageBytes(message.content)
}

export function estimateRequestBytes(options) {
  const { messages = [], system, tools, provider, model, temperature, maxTokens } = options
  return ENVELOPE_RESERVE
    + 2 * Buffer.byteLength(JSON.stringify({ system, tools, provider, model, temperature, maxTokens }))
    + messages.reduce((total, message) => total + messageBytes(message), 0)
}

export function requestSizeFailure(options, failure) {
  if (options.provider !== 'e-mate-enterprise') return undefined
  if (failure === undefined && estimateRequestBytes(options) <= MAX_RESPONSES_BYTES) return undefined
  if (failure !== undefined && failure.status !== 413
    && !/(?:API error \(413\)|413 Request Entity Too Large)/u.test(failure.message ?? '')
    && failure.code !== 'REQUEST_TOO_LARGE' && failure.code !== 'UPSTREAM_REQUEST_TOO_LARGE') return undefined
  return { code: 'REQUEST_TOO_LARGE', status: 413, message: REQUEST_TOO_LARGE_MESSAGE }
}

function surfaceRange(session, header, pairing) {
  const nodes = session.surface.nodes
  const entries = nodes.map(seq => {
    const event = session.events[seq]
    const message = session.deriveEventMessage(event)
    return { seq, event, message, bytes: message ? messageBytes(message) : 0 }
  })
  const lastUser = entries.findLastIndex(entry => entry.event.type === 'user/message')
  const lastToolImage = entries.findLastIndex(entry => entry.event.type === 'tool/result' && imageBytes(entry.message?.content) > 0)
  const budget = MAX_REGION_BYTES - estimateRequestBytes({ ...header, messages: [] })
  let start = -1
  let bytes = 0
  let best
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const protectedNode = index === lastUser || index === lastToolImage || index >= entries.length - 2
      || (entry.event.type === 'user/message' && imageBytes(entry.message?.content) > 0)
    if (protectedNode) { start = -1; bytes = 0; continue }
    if (start < 0 && pairing.toolPairingBalancedBefore(session, entry.seq)) start = index
    if (start < 0) continue
    bytes += entry.bytes
    if (bytes > budget) { start = -1; bytes = 0; continue }
    if (pairing.toolPairingBalancedAfter(session, entry.seq) && bytes > (best?.bytes ?? 0)) {
      best = { start: entries[start].seq, end: entry.seq, bytes }
    }
  }
  return best
}

/** Proactive byte pressure only: native compaction owns durable rewrites and calls.
 * No retry follows a submitted model failure, and neither Session nor CAS is erased.
 */
export async function compactRequestHistory(ctx, payload, pairing) {
  const { agent, signal, messages = [] } = payload
  const session = agent.session
  const header = session.requestHeader() ?? { config: agent.options }
  const options = { ...header.config, system: header.system, tools: header.tools }
  if (options.provider !== 'e-mate-enterprise') return
  const measure = () => estimateRequestBytes({ ...options, messages: [...session.deriveMessages(), ...messages] })
  if (measure() <= MAX_RESPONSES_BYTES) return
  const principal = () => {
    const value = ctx.emateIdentity.localAccountPrincipal()
    return value && JSON.stringify([value.tenantId, value.userId])
  }
  const owner = principal()
  if (!owner) return
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  const assertOwner = () => {
    if (principal() !== owner) controller.abort(new Error('e-Mate account changed during context compaction'))
    combined.throwIfAborted()
  }
  const stop = ctx.on('credentials/updated', () => {
    if (principal() !== owner) controller.abort(new Error('e-Mate account changed during context compaction'))
  })
  try {
    assertOwner()
    const pruner = ctx.get?.('toolResultPruner')
    pruner?.pruneSession(session)
    const compaction = ctx.get?.('compaction')
    if (!compaction) return
    for (let count = 0; count < 3; count++) {
      assertOwner()
      const before = measure()
      if (before <= MAX_RESPONSES_BYTES) return
      const range = surfaceRange(session, options, pairing)
      if (!range) return
      try {
        await compaction.compactRegion(range.start, range.end, agent, combined)
      } catch {
        assertOwner()
        // The summarizer may already have been submitted. Never repeat it here;
        // the unchanged oversized main request will fail the stream preflight.
        ctx.logger?.warn?.('e-Mate byte-pressure compaction did not complete; request remains size-checked')
        return
      }
      assertOwner()
      if (measure() >= before) return
    }
  } finally { stop() }
}
