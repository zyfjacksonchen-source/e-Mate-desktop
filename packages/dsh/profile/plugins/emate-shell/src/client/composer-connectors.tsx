import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { CONNECTIONS, CONNECTION_LABELS, type ConnectionItem, type XinConnection } from './connection-status.ts'
import css from './composer-connectors.module.css'

interface ConnectorsProps {
  LinkIcon: ComponentType<{ size?: number }>
  sessionId: string
  loadConnections: (signal: AbortSignal) => Promise<ConnectionItem[]>
  prepareDraft: (prompt: string) => void
  loadXin?: (signal: AbortSignal) => Promise<XinConnection>
  ensureXin?: (signal: AbortSignal) => Promise<XinConnection>
  disconnectXin?: (signal: AbortSignal) => Promise<XinConnection>
  subscribeIdentity?: (listener: () => void) => () => void
}

interface MentionsProps {
  openMentions: (selection: { start: number; end: number }) => void
  input?: { phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' }
}

export const COMPOSER_PLACEHOLDER = '给小芯发送消息，支持粘贴图片或文件'

export function ComposerMentions({ openMentions, input }: MentionsProps) {
  const control = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const busy = input?.phase === 'adjudicating' || input?.phase === 'submitting'

  useLayoutEffect(() => {
    const textarea = control.current?.closest('[data-composer-card]')?.querySelector('textarea')
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.disabled) return undefined
    const previous = textarea.placeholder
    textarea.placeholder = COMPOSER_PLACEHOLDER
    return () => {
      if (textarea.placeholder === COMPOSER_PLACEHOLDER) textarea.placeholder = previous
    }
  })

  return <div className={css.root}>
    <button
      ref={control}
      data-emate-composer-mentions=""
      type="button"
      title="插入引用"
      aria-label="插入引用"
      aria-haspopup="listbox"
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={() => {
        const textarea = control.current?.closest('[data-composer-card]')?.querySelector('textarea')
        if (!(textarea instanceof HTMLTextAreaElement)) return
        setError('')
        try {
          openMentions({ start: textarea.selectionStart, end: textarea.selectionEnd })
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : '暂时无法插入引用。')
        } finally {
          textarea.focus()
        }
      }}
    ><span aria-hidden="true">@</span></button>
    {error !== '' && <span className={css.error} role="alert">{error}</span>}
  </div>
}

export function ComposerConnectors({ LinkIcon, sessionId, loadConnections, prepareDraft, loadXin, ensureXin, disconnectXin, subscribeIdentity }: ConnectorsProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const loader = useRef(loadConnections)
  loader.current = loadConnections
  const [open, setOpen] = useState(false)
  const [reload, setReload] = useState(0)
  const lastConnectionsReload = useRef(0)
  const lastXinReload = useRef(0)
  const [items, setItems] = useState<ConnectionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 8, bottom: 8, maxHeight: 400 })
  const [xin, setXin] = useState<XinConnection>()
  const [xinReload, setXinReload] = useState(0)
  const [xinBusy, setXinBusy] = useState<'ensure' | 'disconnect' | null>(null)
  const [xinChecking, setXinChecking] = useState(false)
  const [xinNotice, setXinNotice] = useState('')
  const [xinError, setXinError] = useState('')
  const xinLoader = useRef(loadXin)
  xinLoader.current = loadXin
  const session = useRef(sessionId)
  session.current = sessionId
  const identityRevision = useRef(0)
  const xinRevision = useRef(0)
  const operation = useRef<{ controller: AbortController; revision: number; sessionId: string } | null>(null)
  const invalidateXin = () => {
    xinRevision.current++
    operation.current?.controller.abort(); operation.current = null
    setXin(undefined); setXinBusy(null); setXinChecking(false); setXinNotice(''); setXinError('')
  }
  useLayoutEffect(() => { invalidateXin() }, [sessionId])
  useEffect(() => subscribeIdentity?.(() => { identityRevision.current++; invalidateXin(); setOpen(false); setItems([]); setLoading(false); setError('') }), [subscribeIdentity])
  useEffect(() => () => { xinRevision.current++; operation.current?.controller.abort(); operation.current = null }, [])
  const runXin = (action: 'ensure' | 'disconnect') => {
    const invoke = action === 'ensure' ? ensureXin : disconnectXin
    if (!invoke || operation.current) return
    const pending = { controller: new AbortController(), revision: ++xinRevision.current, sessionId }
    operation.current = pending
    setXinBusy(action); setXinChecking(false); setXinError(''); setXinNotice('')
    const current = () => operation.current === pending && !pending.controller.signal.aborted && pending.revision === xinRevision.current && pending.sessionId === session.current
    void invoke(pending.controller.signal).then(value => {
      if (!current()) return
      setXin(value)
      setXinNotice(value.state === 'ready' ? '芯助手已连接，账号和权限已验证。' : value.state === 'cancelled' ? '连接已取消。' : action === 'disconnect' && value.state === 'authorization-required' ? '已断开当前账号的芯助手连接。' : '')
      if (value.state === 'unavailable' && !value.disconnection) setXinError('芯助手暂不可用，请重新检查连接。')
    }, () => { if (current()) { setXin(undefined); setXinError('芯助手连接未完成，请检查最新状态后重试。') } }).finally(() => {
      if (!current()) return
      operation.current = null; setXinBusy(null); setXinReload(value => value + 1)
    })
  }
  const cancelXin = () => {
    if (!operation.current) return
    operation.current.controller.abort(); operation.current = null; xinRevision.current++
    setXinBusy(null); setXin(undefined); setXinError(''); setXinNotice('已取消等待，正在核对实际连接状态。'); setXinReload(value => value + 1)
  }
  useEffect(() => {
    if (!open || !xinLoader.current) return
    const manual = lastXinReload.current !== reload
    lastXinReload.current = reload
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const visible = () => document.visibilityState !== 'hidden' && navigator.onLine !== false
    const refresh = async (manual = false) => {
      if (controller.signal.aborted || running || !manual && !visible() || operation.current) return
      running = true
      const revision = ++xinRevision.current
      setXinChecking(true)
      try {
        const next = await xinLoader.current!(controller.signal)
        if (!controller.signal.aborted && revision === xinRevision.current) { setXin(next); setXinNotice(''); setXinError(next.state === 'unavailable' && !next.disconnection ? '芯助手暂不可用，请重新检查连接。' : '') }
      } catch {
        if (!controller.signal.aborted && revision === xinRevision.current) { setXin(undefined); setXinError('芯助手状态暂不可用，请重试。') }
      } finally {
        running = false
        if (!controller.signal.aborted) {
          if (revision === xinRevision.current) setXinChecking(false)
          if (visible()) timer = setTimeout(() => { void refresh() }, 15_000)
        }
      }
    }
    const wake = () => { clearTimeout(timer); if (visible()) void refresh() }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('offline', wake)
    // Only automatic status polling pauses; explicit refresh and Host operations remain available.
    void refresh(manual)
    return () => {
      controller.abort(); clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake); window.removeEventListener('offline', wake)
    }
  }, [open, reload, xinReload, sessionId])
  useEffect(() => { setOpen(false); setItems([]); setError('') }, [sessionId])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) {
        const left = Math.max(8, Math.min(rect.right - 280, innerWidth - 288))
        const above = rect.top - 16; const below = innerHeight - rect.bottom - 16
        setPosition(above >= below
          ? { left, bottom: Math.max(8, innerHeight - rect.top + 8), maxHeight: Math.max(80, above) }
          : { left, top: Math.max(8, rect.bottom + 8), maxHeight: Math.max(80, below) })
      }
    }
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    place()
    panel.current?.querySelector<HTMLButtonElement>('[data-connection-choice]')?.focus()
    addEventListener('resize', place)
    addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      removeEventListener('resize', place); removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const manual = lastConnectionsReload.current !== reload
    lastConnectionsReload.current = reload
    const controller = new AbortController()
    const identity = identityRevision.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const visible = () => document.visibilityState !== 'hidden' && navigator.onLine !== false
    const current = () => !controller.signal.aborted && identity === identityRevision.current
    const refresh = async (manual = false) => {
      if (!current() || running || !manual && !visible()) return
      running = true
      setLoading(true)
      try {
        const next = await loader.current(controller.signal)
        if (current()) setItems(next)
      } catch {
        if (current()) setItems(CONNECTIONS.map(({ id }) => ({ id, state: 'failed' })))
      } finally {
        running = false
        if (current()) {
          setLoading(false)
          if (visible()) timer = setTimeout(() => { void refresh() }, 15_000)
        }
      }
    }
    const wake = () => { clearTimeout(timer); if (visible()) void refresh() }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('offline', wake)
    // Only automatic status polling pauses; explicit refresh and Host operations remain available.
    void refresh(manual)
    return () => {
      controller.abort(); clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake); window.removeEventListener('offline', wake)
    }
  }, [open, reload, sessionId])
  return <div className={css.root}>
    <button
      ref={trigger}
      data-emate-composer-connectors=""
      type="button"
      title="外部连接"
      aria-label="外部连接"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={xinBusy !== null || undefined}
      onClick={() => { setError(''); setOpen(value => !value) }}
    >
      <LinkIcon size={14} />
      <span>外部连接</span>
    </button>
    {open && createPortal(<div ref={panel} className={css.panel} role="dialog" aria-label="外部连接状态" style={position}>
      <header><strong>外部连接</strong><button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>刷新</button></header>
      <p>飞书、钉钉和腾讯文档填入草稿；芯助手在此直接连接。</p>
      {CONNECTIONS.map(connection => {
        const state = items.find(item => item.id === connection.id)?.state
        return <button key={connection.id} data-connection-choice type="button" className={css.connection} onClick={() => {
          try { prepareDraft(connection.draft); setOpen(false); trigger.current?.closest('[data-composer-card]')?.querySelector('textarea')?.focus() }
          catch (reason) { setError(reason instanceof Error ? reason.message : '连接草稿暂不可用。') }
        }}><span>{connection.title}</span><small data-state={loading ? 'checking' : state}>{loading ? '检查中' : state ? CONNECTION_LABELS[state] : '状态异常'}</small></button>
      })}
      <section className={css.xin} aria-label="芯助手连接">
        <div className={css.xinHeading}><strong>芯助手</strong><small data-state={xinBusy ? 'connecting' : xin?.state}>{xinBusy ? '连接处理中' : xinChecking ? '检查中' : xin?.state === 'ready' ? '已连接' : xin?.state === 'authorization-required' ? (xin.binding ? '授权失效' : '待授权') : xin?.state === 'connecting' ? '连接中' : xin?.state === 'cancelled' ? '已取消' : '暂不可用'}</small></div>
        <p>使用本人授权查询企业数据、资料与知识。</p>
        {xin?.binding && xin.permissions && xin.verified_at && <div className={css.xinProof}>
          <span>{xin.state === 'ready' && xinBusy === null && !xinChecking ? '当前绑定' : '上次验证的账号与权限'}</span>
          <strong className={css.xinAccount} title={`${xin.binding.tenant_id} / 用户 ${xin.binding.user_id}`}>{xin.binding.tenant_id} / 用户 {xin.binding.user_id}</strong>
          <span>经营项目 {xin.permissions.project_count} · 知识项目 {xin.permissions.knowledge_project_count} · 可维护项目 {xin.permissions.writable_project_count}</span>
          <details><summary>授权能力（{xin.permissions.tools.length}）</summary><ul>{xin.permissions.tools.map(tool => <li key={tool}>{tool}</li>)}</ul></details>
          <time dateTime={xin.verified_at} title={xin.verified_at}>最近验证：{new Date(xin.verified_at).toLocaleString('zh-CN', { hour12: false })}</time>
        </div>}
        <div className={css.xinActions}>
          <button type="button" disabled={!ensureXin || xinBusy !== null || xin?.state === 'connecting'} onClick={() => runXin('ensure')}>{xin?.state === 'ready' || xin?.state === 'unavailable' ? '重新连接芯助手' : '连接芯助手'}</button>
          {xinBusy ? <button type="button" onClick={cancelXin}>取消等待</button> : <button type="button" disabled={!disconnectXin || xin === undefined || xin.state === 'authorization-required' && !xin.binding} onClick={() => runXin('disconnect')}>断开并忘记芯助手</button>}
        </div>
        {xin?.disconnection && <p role={xin.disconnection.local_forgotten && xin.disconnection.remote_revocation !== 'unknown' ? 'status' : 'alert'}>
          {!xin.disconnection.local_forgotten ? '本机调用已停用，但凭据清理未完成。请重试断开，完成前请勿关闭或重启应用。'
            : xin.disconnection.remote_revocation === 'unknown' ? '本机已停用并清除凭据；服务端授权撤销未确认。'
              : xin.disconnection.remote_revocation === 'revoked' ? '本机凭据已清除，服务端授权已撤销。' : '本机已清除连接信息，没有可撤销的凭据。'}
        </p>}
        {xin?.authorization_unknown && <p role="alert">此前授权的服务端结果尚未确认；重新连接不代表旧授权已撤销。</p>}
        {xinNotice && <p role="status">{xinNotice}</p>}
        {xinError && <p role="alert">{xinError}</p>}
      </section>
      {error && <p role="alert">{error}</p>}
    </div>, document.body)}
  </div>
}
