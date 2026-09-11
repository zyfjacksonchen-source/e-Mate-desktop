import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { RpcResult } from './identity.tsx'
import { formatTokenCount } from './token-format.ts'
import css from './usage-heatmap.module.css'

const DECIMAL = /^(0|[1-9][0-9]{0,127})$/u
const DATE = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u
const DAY_MS = 86_400_000

export interface UsageActivityDay {
  date: string
  total: string
  input: string
  output: string
  cache_read: string
  cache_write: string
}

export interface UsageActivity {
  schema_version: 1
  timezone: string
  start_date: string
  end_date: string
  days: UsageActivityDay[]
  period_total: string
  calculated_at: string
}

interface Query {
  timezone: string
  start_date: string
  end_date: string
}

interface Props {
  callIdentity: (endpoint: string, payload: Record<string, unknown>) => Promise<RpcResult>
}

type Mode = 'day' | 'week' | 'total'

function dateMs(value: string): number {
  if (!DATE.test(value)) return Number.NaN
  const [year, month, day] = value.split('-').map(Number)
  const result = Date.UTC(year!, month! - 1, day)
  return new Date(result).toISOString().slice(0, 10) === value ? result : Number.NaN
}

function dateString(value: number): string {
  return new Date(value).toISOString().slice(0, 10)
}

function localDate(timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function usageActivityQuery(timezone: string, today = localDate(timezone)): Query {
  const end = dateMs(today)
  if (!Number.isFinite(end)) throw new Error('invalid local date')
  const current = new Date(end)
  const year = current.getUTCFullYear() - 1
  const month = current.getUTCMonth()
  const day = Math.min(current.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return { timezone, start_date: dateString(Date.UTC(year, month, day) + DAY_MS), end_date: today }
}

function validDay(value: unknown, expectedDate: string): value is UsageActivityDay {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const day = value as Partial<UsageActivityDay>
  if (Object.keys(day).sort().join(',') !== 'cache_read,cache_write,date,input,output,total'
    || day.date !== expectedDate
    || !DECIMAL.test(day.total ?? '')
    || !DECIMAL.test(day.input ?? '')
    || !DECIMAL.test(day.output ?? '')
    || !DECIMAL.test(day.cache_read ?? '')
    || !DECIMAL.test(day.cache_write ?? '')) return false
  return BigInt(day.total!) === BigInt(day.input!) + BigInt(day.output!) + BigInt(day.cache_read!) + BigInt(day.cache_write!)
}

export function validUsageActivity(value: unknown, query: Query): value is UsageActivity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const activity = value as Partial<UsageActivity>
  const start = dateMs(query.start_date)
  const end = dateMs(query.end_date)
  const length = (end - start) / DAY_MS + 1
  if (Object.keys(activity).sort().join(',') !== 'calculated_at,days,end_date,period_total,schema_version,start_date,timezone'
    || activity.schema_version !== 1
    || activity.timezone !== query.timezone
    || activity.start_date !== query.start_date
    || activity.end_date !== query.end_date
    || !Number.isInteger(length)
    || length < 1
    || length > 366
    || !Array.isArray(activity.days)
    || activity.days.length !== length
    || !DECIMAL.test(activity.period_total ?? '')
    || typeof activity.calculated_at !== 'string'
    || !Number.isFinite(Date.parse(activity.calculated_at))
    || new Date(activity.calculated_at).toISOString() !== activity.calculated_at) return false
  const periodTotal = activity.period_total
  if (periodTotal === undefined) return false
  let total = 0n
  for (let index = 0; index < activity.days.length; index += 1) {
    const day = activity.days[index]
    if (!validDay(day, dateString(start + index * DAY_MS))) return false
    total += BigInt(day.total)
  }
  return total === BigInt(periodTotal)
}

function exact(value: bigint): string {
  return value.toLocaleString('zh-CN')
}

function tooltip(day: UsageActivityDay): string {
  return `${day.date}：${exact(BigInt(day.total))} Token（输入 ${exact(BigInt(day.input))}，输出 ${exact(BigInt(day.output))}，缓存读取 ${exact(BigInt(day.cache_read))}，缓存写入 ${exact(BigInt(day.cache_write))}）`
}

export function heatLevel(value: string, maximum: bigint): 0 | 1 | 2 | 3 | 4 {
  const count = BigInt(value)
  if (count === 0n || maximum === 0n) return 0
  return Math.min(4, Number((count * 4n + maximum - 1n) / maximum)) as 1 | 2 | 3 | 4
}

function sum(days: readonly UsageActivityDay[]): UsageActivityDay {
  const total = (key: keyof Omit<UsageActivityDay, 'date'>) => days.reduce((amount, day) => amount + BigInt(day[key]), 0n).toString()
  return {
    date: '',
    total: total('total'),
    input: total('input'),
    output: total('output'),
    cache_read: total('cache_read'),
    cache_write: total('cache_write'),
  }
}

function weekBounds(date: string): [number, number] {
  const value = dateMs(date)
  const weekday = (new Date(value).getUTCDay() + 6) % 7
  const start = value - weekday * DAY_MS
  return [start, start + 6 * DAY_MS]
}

export function UsageHeatmap({ callIdentity }: Props) {
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', [])
  const query = useMemo(() => usageActivityQuery(timezone), [timezone])
  const [revision, setRevision] = useState(0)
  const [activity, setActivity] = useState<UsageActivity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('day')
  const [selected, setSelected] = useState(query.end_date)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void callIdentity('identity.usage.activity', { ...query }).then(result => {
      if (!current) return
      if (!result.ok) throw new Error(result.error?.message ?? 'Token 使用数据暂时不可用，请稍后重试。')
      if (!validUsageActivity(result.value, query)) throw new Error('Token 使用服务返回了无效数据。')
      setActivity(result.value)
    }).catch(failure => {
      if (!current) return
      setActivity(null)
      setError(failure instanceof Error ? failure.message : 'Token 使用数据暂时不可用，请稍后重试。')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [callIdentity, query, revision])

  const maximum = useMemo(() => activity?.days.reduce((value, day) => {
    const count = BigInt(day.total)
    return count > value ? count : value
  }, 0n) ?? 0n, [activity])
  const padding = activity === null ? 0 : (new Date(dateMs(activity.start_date)).getUTCDay() + 6) % 7
  const cells = activity === null ? [] : [...Array<null>(padding).fill(null), ...activity.days]
  const selectedDays = useMemo(() => {
    if (activity === null) return []
    if (mode === 'total') return activity.days
    if (mode === 'day') return activity.days.filter(day => day.date === selected)
    const [start, end] = weekBounds(selected)
    return activity.days.filter(day => {
      const date = dateMs(day.date)
      return date >= start && date <= end
    })
  }, [activity, mode, selected])
  const summary = useMemo(() => sum(selectedDays), [selectedDays])
  const summaryTitle = mode === 'total'
    ? '近 12 个月累计'
    : mode === 'week'
      ? `${dateString(weekBounds(selected)[0])} 至 ${dateString(weekBounds(selected)[1])}`
      : selected
  const months = activity === null ? [] : activity.days.filter((day, index, days) => index === 0 || day.date.slice(0, 7) !== days[index - 1]?.date.slice(0, 7))

  return (
    <section className={css.usagePanel} aria-labelledby="emate-token-activity-title">
      <header>
        <div><h2 id="emate-token-activity-title">Token 使用情况</h2><p>来自企业账户审计日桶，不包含提示词、文件或会话内容。</p></div>
        <div className={css.tabs} role="group" aria-label="Token 汇总范围">
          {([['day', '每日'], ['week', '每周'], ['total', '累计']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => { setMode(value) }}>{label}</button>
          ))}
        </div>
      </header>
      {loading ? <p className={css.state} role="status">正在同步 Token 使用数据…</p> : null}
      {!loading && error ? (
        <div className={css.state} role="alert"><p>{error}</p><button type="button" onClick={() => { setRevision(value => value + 1) }}>重试</button></div>
      ) : null}
      {!loading && activity ? <>
        <div className={css.summary} aria-live="polite">
          <div><small>{summaryTitle}</small><strong>{formatTokenCount(BigInt(summary.total))}</strong><span>Token</span></div>
          <dl>
            <div><dt>输入</dt><dd>{formatTokenCount(BigInt(summary.input))}</dd></div>
            <div><dt>输出</dt><dd>{formatTokenCount(BigInt(summary.output))}</dd></div>
            <div><dt>缓存读取</dt><dd>{formatTokenCount(BigInt(summary.cache_read))}</dd></div>
            <div><dt>缓存写入</dt><dd>{formatTokenCount(BigInt(summary.cache_write))}</dd></div>
          </dl>
        </div>
        <div className={css.heatmapRegion} role="region" aria-label={`Token 活动热力图，${activity.start_date} 至 ${activity.end_date}`} tabIndex={0}>
          <div className={css.months} aria-hidden="true">{months.map(day => <span key={day.date}>{Number(day.date.slice(5, 7))}月</span>)}</div>
          <div className={css.heatmapLayout}>
            <div className={css.weekdays} aria-hidden="true"><span>一</span><span>三</span><span>五</span><span>日</span></div>
            <div className={css.grid} style={{ '--emate-heatmap-weeks': Math.ceil(cells.length / 7) } as CSSProperties}>
              {cells.map((day, index) => day === null
                ? <span key={`empty-${index}`} />
                : <button
                    key={day.date}
                    type="button"
                    data-level={heatLevel(day.total, maximum)}
                    aria-pressed={selected === day.date}
                    aria-label={tooltip(day)}
                    title={tooltip(day)}
                    onClick={() => { setSelected(day.date); if (mode === 'total') setMode('day') }}
                  />)}
            </div>
          </div>
          <footer><span>少</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} aria-hidden="true" />)}<span>多</span></footer>
        </div>
      </> : null}
    </section>
  )
}
