// Read-only projection of saved image events. Generation is owned by dsh-imagegen.
import { join } from 'node:path'
import { loadTargetStorageDomain } from './target-runtime.js'
import { imageBatchProjectionDefinition } from './image-batch-events.ts'

export const name = 'emate-image-history'
export const inject = ['sessionProjections', 'sessionProjectionCache', 'sessionPersistence']
const IMAGE_RECEIPTS_PROJECTION = 'eMateImageReceipts'
const COLD_READ_CONCURRENCY = 4
const TERMINAL_IMAGE_STATUSES = new Set(['completed', 'needs-review', 'failed', 'cancelled', 'unknown'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Owned image lifecycle receipts projected through rc.7's native Session projection feed. */
export function imageReceiptsProjectionDefinition(z) {
  const row = z.object({
    seq: z.number().int().nonnegative(),
    createdAt: z.number().finite(),
    receipt: z.record(z.string(), z.unknown()),
  }).strict()
  return {
    key: IMAGE_RECEIPTS_PROJECTION,
    schema: z.array(row),
    stateVersion: 3,
    init: () => [],
    apply(state, event) {
      if (event.type !== 'emate/image-output' || !isRecord(event.data)) return state
      const data = event.data
      if (![2, 3].includes(data.schema_version)
        || typeof data.call_id !== 'string' || data.call_id === ''
        || !Number.isSafeInteger(data.revision) || data.revision < 1
        || data.status !== 'running' && !TERMINAL_IMAGE_STATUSES.has(String(data.status))) return state
      const currentIndex = state.findIndex(item => item.receipt.call_id === data.call_id)
      const current = state[currentIndex]
      if (current !== undefined && TERMINAL_IMAGE_STATUSES.has(String(current.receipt.status)) && data.status === 'running') return state
      if (current !== undefined
        && (Number(current.receipt.revision) > data.revision
          || Number(current.receipt.revision) === data.revision && current.seq >= event.seq)) return state
      const next = {
        seq: event.seq,
        createdAt: current?.createdAt ?? event.time,
        receipt: data,
      }
      return currentIndex === -1
        ? [...state, next]
        : state.map((item, index) => index === currentIndex ? next : item)
    },
    view: state => [...state].sort((left, right) => left.createdAt - right.createdAt || left.seq - right.seq),
  }
}

/** Backfill a newly introduced projection through rc.7's native cold-read ladder. */
export async function hydrateImageReceiptProjections(ctx) {
  const queue = (await ctx.sessionPersistence.list()).filter(header => header.origin === 'subagent')
  await Promise.all(Array.from(
    { length: Math.min(COLD_READ_CONCURRENCY, queue.length) },
    async () => {
      for (let header = queue.shift(); header !== undefined; header = queue.shift()) {
        try {
          const cached = ctx.sessionProjectionCache.cachedSnapshot(header)
          if (Object.hasOwn(cached?.values ?? {}, IMAGE_RECEIPTS_PROJECTION)) continue
          await ctx.sessionProjectionCache.coldSnapshot(header.id)
        } catch (error) {
          ctx.logger.warn(`e-Mate image projection hydration for "${header.id}" failed: ${String(error)}`)
        }
      }
    },
  ))
}


export async function apply(ctx, config = {}) {
  const { z } = await loadTargetStorageDomain(config.bindingPath ?? join(import.meta.dirname, 'runtime-binding.json'))
  ctx.sessionProjections.register(imageReceiptsProjectionDefinition(z))
  ctx.sessionProjections.register(imageBatchProjectionDefinition(z))
  await hydrateImageReceiptProjections(ctx)
}
