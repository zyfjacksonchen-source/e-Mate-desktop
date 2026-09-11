import { basename } from 'node:path'
import {
  decodeScheduleChange,
  foldScheduleEvents,
  resolveEveryOccurrence,
  scheduleView,
} from '@deepseek-ai/dsh-schedule'

export const name = 'emate-schedules'
export const inject = [
  'webServer','connection', 'sessionPersistence']
export const SCHEDULES_CHANNEL = '/emate.schedules'
const RECENT_RUN_LIMIT = 20

function projectHistory(events, seedLength) {
  const active = new Map()
  const completed = []
  const recentRuns = []
  for (const event of events.slice(seedLength)) {
    if (event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    if (change.operation === 'create') {
      active.set(change.schedule.id, change.schedule)
      continue
    }
    const record = active.get(change.id)
    if (change.operation === 'delete') {
      active.delete(change.id)
      continue
    }
    if ('acceptedAt' in change) {
      const occurrence = resolveEveryOccurrence(record, Date.parse(change.acceptedAt))
      recentRuns.push({ ...record, scheduledAt: occurrence.occurrenceAt, ranAt: change.acceptedAt })
      if (occurrence.nextScheduledAt === undefined) {
        active.delete(change.id)
        completed.push({ ...record, state: 'completed', deliveryMode: 'session-local', completedAt: change.acceptedAt })
      } else {
        active.set(change.id, { ...record, scheduledAt: occurrence.nextScheduledAt })
      }
    } else {
      const ranAt = new Date(event.time).toISOString()
      recentRuns.push({ ...record, scheduledAt: record.scheduledAt, ranAt })
      active.delete(change.id)
      completed.push({ ...record, state: 'completed', deliveryMode: 'session-local', completedAt: ranAt })
    }
  }
  return { completed, recentRuns }
}

export function apply(ctx) {
  const cached = new Map()
  ctx.effect(() => ctx.connection.rpc.handle(SCHEDULES_CHANNEL, async (endpoint, payload) => {
    if (endpoint !== 'list' || payload === null || typeof payload !== 'object'
      || Array.isArray(payload) || Object.keys(payload).length !== 0) {
      return { ok: false, error: { code: 'bad-request', message: 'unknown e-Mate schedules endpoint', details: { issues: [] } } }
    }
    try {
      const snapshots = await ctx.sessionPersistence.listSnapshots()
      const currentIds = new Set(snapshots.map(snapshot => String(snapshot.header.id)))
      for (const id of cached.keys()) if (!currentIds.has(id)) cached.delete(id)
      const now = Date.now()
      const project = value => value.error === undefined ? {
        items: value.active.map(record => ({
          session_id: value.sessionId,
          session_title: value.title,
          ...scheduleView(record, now),
        })),
        completed: value.completed.map(record => ({
          session_id: value.sessionId,
          session_title: value.title,
          ...record,
        })),
        recent_runs: value.recentRuns.map(record => ({
          session_id: value.sessionId,
          session_title: value.title,
          ...record,
        })),
      } : value
      const results = await Promise.all(snapshots.map(async snapshot => {
        const id = String(snapshot.header.id)
        const hit = cached.get(id)
        if (hit?.revision === snapshot.revision) return project(hit.value)
        try {
          const inspection = await ctx.sessionPersistence.inspect(snapshot.header.id)
          const folded = foldScheduleEvents(inspection.events, inspection.meta.seedLength ?? 0)
          const history = projectHistory(inspection.events, inspection.meta.seedLength ?? 0)
          const titleEvent = inspection.events.findLast(event => event.type === 'session/title')
          const title = typeof titleEvent?.data?.title === 'string' && titleEvent.data.title.trim() !== ''
            ? titleEvent.data.title.trim()
            : basename(inspection.meta.cwd || '') || id
          const value = { sessionId: id, title, active: folded.active, ...history }
          cached.set(id, { revision: snapshot.revision, value })
          return project(value)
        } catch {
          const value = { items: [], error: { session_id: id, message: '该会话的定时任务日志无法读取。' } }
          return value
        }
      }))
      return {
        ok: true,
        value: {
          schema_version: 1,
          items: results.flatMap(result => result.items ?? []).sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt)),
          completed: results.flatMap(result => result.completed ?? [])
            .sort((left, right) => right.completedAt.localeCompare(left.completedAt)),
          recent_runs: results.flatMap(result => result.recent_runs ?? [])
            .sort((left, right) => right.ranAt.localeCompare(left.ranAt))
            .slice(0, RECENT_RUN_LIMIT),
          errors: results.flatMap(result => result.error === undefined ? [] : [result.error]),
        },
      }
    } catch {
      return { ok: false, error: { code: 'internal', message: '定时任务暂时无法读取。', details: {} } }
    }
  }, { authority: 'loopback' }), 'emate.schedules: native Schedule projection')
}
