import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { CONNECTIONS, CONNECTION_LABELS, type ConnectionItem } from './connection-status.ts'
import css from './composer-connectors.module.css'

interface ConnectorsProps {
  LinkIcon: ComponentType<{ size?: number }>
  sessionId: string
  loadConnections: (signal: AbortSignal) => Promise<ConnectionItem[]>
  prepareDraft: (prompt: string) => void
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

export function ComposerConnectors({ LinkIcon, sessionId, loadConnections, prepareDraft }: ConnectorsProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const loader = useRef(loadConnections)
  loader.current = loadConnections
  const [open, setOpen] = useState(false)
  const [reload, setReload] = useState(0)
  const [items, setItems] = useState<ConnectionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [position, setPosition] = useState({ left: 8, bottom: 8 })
  useEffect(() => { setOpen(false); setItems([]); setError('') }, [sessionId])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.right - 280, innerWidth - 288)), bottom: Math.max(8, innerHeight - rect.top + 8) })
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
    const controller = new AbortController()
    let sequence = 0
    const refresh = async () => {
      const request = ++sequence
      setLoading(true)
      try {
        const next = await loader.current(controller.signal)
        if (!controller.signal.aborted && request === sequence) setItems(next)
      } catch {
        if (!controller.signal.aborted && request === sequence) setItems(CONNECTIONS.map(({ id }) => ({ id, state: 'failed' })))
      } finally { if (!controller.signal.aborted && request === sequence) setLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 15_000)
    return () => { controller.abort(); clearInterval(timer) }
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
      onClick={() => { setError(''); setOpen(value => !value) }}
    >
      <LinkIcon size={14} />
      <span>外部连接</span>
    </button>
    {open && createPortal(<div ref={panel} className={css.panel} role="dialog" aria-label="外部连接状态" style={position}>
      <header><strong>外部连接</strong><button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>刷新</button></header>
      <p>选择后填入连接草稿，由小芯继续处理。</p>
      {CONNECTIONS.map(connection => {
        const state = items.find(item => item.id === connection.id)?.state
        return <button key={connection.id} data-connection-choice type="button" className={css.connection} onClick={() => {
          try { prepareDraft(connection.draft); setOpen(false); trigger.current?.closest('[data-composer-card]')?.querySelector('textarea')?.focus() }
          catch (reason) { setError(reason instanceof Error ? reason.message : '连接草稿暂不可用。') }
        }}><span>{connection.title}</span><small data-state={loading ? 'checking' : state}>{loading ? '检查中' : state ? CONNECTION_LABELS[state] : '状态异常'}</small></button>
      })}
      {error && <p role="alert">{error}</p>}
    </div>, document.body)}
  </div>
}
