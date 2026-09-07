import { createElement, useEffect, useRef, useState } from 'react'
import css from './preview.module.css'

const CHANNEL = '/emate.officePreview'
export const inject = ['slots', 'sessions', 'connection', 'layout']

export function PreviewPanel({ ctx, preview, sessionId, close }: any) {
  const root = useRef<HTMLElement>(null)
  const [pages, setPages] = useState<string[]>([])
  const [page, setPage] = useState('')
  const [snapshot, setSnapshot] = useState<any>()
  const [elementId, setElementId] = useState('')
  const [kind, setKind] = useState('annotation')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [instruction, setInstruction] = useState('')
  const current = useRef({ snapshot, value, busy })
  current.current = { snapshot, value, busy }
  const lane = useRef<Promise<unknown>>(Promise.resolve())
  const mutation = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { mutation.current?.abort() }, [preview.preview_id, sessionId])
  const rpc = (action: string, payload: any = {}, signal?: AbortSignal) => ctx.connection.rpc.call(CHANNEL, action,
    { ...payload, preview_id: preview.preview_id, session_id: preview.session_id }, signal).then((result: any) => {
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message ?? '预览暂不可用。'), { code: result?.error?.code })
    if (result.value?.error) throw Object.assign(new Error(result.value.error.message ?? '预览暂不可用。'), { code: result.value.error.code })
    return result.value
  })
  const call = (action: string, payload: any = {}, signal?: AbortSignal): Promise<any> => {
    if (action === 'close') return rpc(action, payload, signal)
    const result = lane.current.catch(() => {}).then(() => { signal?.throwIfAborted(); return rpc(action, payload, signal) })
    lane.current = result
    return result
  }
  useEffect(() => {
    if (sessionId !== preview.session_id) { void call('close').catch(() => {}); return }
    let stopped = false, visible = true, running = false, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: AbortController | undefined
    const available = () => !stopped && visible && document.visibilityState !== 'hidden' && navigator.onLine !== false
    const stopRead = () => { generation++; pending?.abort(); if (timer) clearTimeout(timer); void call('close').catch(() => {}) }
    const tick = async () => {
      if (!available() || running) return
      running = true
      const token = generation
      const controller = new AbortController(); pending = controller
      try {
        if (!current.current.busy) {
          const roster = await call('roster', {}, controller.signal)
          if (stopped || token !== generation) return
          setPages(roster.pages)
          if (!page && roster.pages.length) { setPage(roster.pages[0]); return }
          if (page && roster.pages.includes(page)) {
            const result = await call('page', { page, known_revision: current.current.snapshot?.revision }, controller.signal)
            if (stopped || token !== generation) return
            if (current.current.value && current.current.snapshot?.revision !== result.revision) setNotice('源页面已有更新。当前输入和旧版预览已保留，请先重新载入再保存。')
            else if (!current.current.value) setSnapshot((old: any) => ({ ...result, png: result.png ?? old?.png }))
          } else if (page) setNotice('当前页面已移除，旧版预览和输入已保留。')
          setError('')
        }
      } catch (cause) { if (!stopped && !controller.signal.aborted) {
        if ((cause as { code?: string }).code === 'preview-unauthorized') { stopped = true; stopRead(); setSnapshot(undefined); setValue(''); setInstruction(''); close() }
        else if ((cause as { code?: string }).code === 'preview-expired') { stopped = true; stopRead(); setError((cause as Error).message) }
        else setError((cause as Error).message)
      } }
      finally { running = false; if (available()) timer = setTimeout(() => { void tick() }, 2000) }
    }
    const resume = () => { if (timer) clearTimeout(timer); if (available()) void tick(); else stopRead() }
    const identity = () => { stopped = true; stopRead(); setSnapshot(undefined); setValue(''); setInstruction(''); close() }
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; resume() })
    if (root.current) observer.observe(root.current)
    addEventListener('online', resume); addEventListener('offline', resume); document.addEventListener('visibilitychange', resume); addEventListener('emate:identity-changed', identity)
    void tick()
    return () => { stopped = true; stopRead(); observer.disconnect(); removeEventListener('online', resume); removeEventListener('offline', resume); document.removeEventListener('visibilitychange', resume); removeEventListener('emate:identity-changed', identity) }
  }, [page, sessionId, preview.preview_id])
  if (sessionId !== preview.session_id) return <p>已切换任务，请重新打开 PPT 预览。</p>
  const save = async () => {
    if (busy || !snapshot || !elementId || !value.trim()) return
    setBusy(true); setError('')
    const controller = new AbortController(); mutation.current = controller
    try {
      const result = await call('save', { page, expected_revision: snapshot.revision, change: { kind, element_id: elementId, value } }, controller.signal)
      if (controller.signal.aborted) return
      setInstruction(result.instruction); setValue(''); setNotice('源文件已保存。请交给助手检查并重新导出；当前 PPTX 尚未更新。')
    } catch (cause) {
      if ((cause as { code?: string }).code === 'preview-unauthorized') { setSnapshot(undefined); setValue(''); setInstruction(''); close() }
      else setError((cause as Error).message)
    }
    finally { setBusy(false) }
  }
  const send = async () => {
    if (!instruction || busy) return
    setBusy(true)
    try {
      if (ctx.sessions.list.getSnapshot().current !== preview.session_id) throw new Error('当前任务已变化。')
      const result = await ctx.sessions.binding(preview.session_id)?.session.prompt([{ type: 'text', text: instruction }], 'queue')
      if (!result?.ok) throw new Error('原生任务未接受请求，已保存的源文件仍保留。')
      setInstruction(''); setNotice('已提交原生任务，等待真实检查和导出结果。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <section ref={root} className={css.root} aria-label="PPT 持续预览">
    <header><strong>PPT 预览</strong><button type="button" onClick={close}>关闭</button></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!pages.length ? <p role="status">项目已打开，正在等待第一页。生成过程中将自动更新。</p> : <>
      <label>页面<select value={page} disabled={busy || !!value} onChange={event => { setPage(event.target.value); setSnapshot(undefined); setElementId(''); setNotice('') }}>{pages.map(name => <option key={name}>{name}</option>)}</select></label>
      {snapshot?.png && <img className={css.preview} src={`data:image/png;base64,${snapshot.png}`} alt={`${page} · 源页面预览`} />}
      <button type="button" disabled={busy} onClick={() => { setValue(''); setSnapshot(undefined); setNotice('已放弃未保存输入，正在重新载入。') }}>放弃输入并重新载入</button>
      <label>元素<select value={elementId} disabled={busy} onChange={event => { setElementId(event.target.value); const target = snapshot?.elements.find((item: any) => item.id === event.target.value); setValue(kind === 'text' ? target?.text ?? '' : target?.annotation ?? '') }}>
        <option value="">选择要修改的元素</option>{snapshot?.elements.filter((item: any) => kind !== 'text' || item.editable).map((item: any) => <option key={item.id} value={item.id}>{item.tag} · {item.text.slice(0, 35) || item.id}</option>)}
      </select></label>
      <label>操作<select value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setElementId(''); setValue('') }}><option value="annotation">元素批注</option><option value="text">修改文字</option></select></label>
      <textarea aria-label="修改内容" value={value} disabled={busy} onChange={event => setValue(event.target.value)} placeholder="选中元素后填写。首次导出完成后可保存修改。" />
      <button type="button" disabled={busy || !elementId || !value.trim()} onClick={() => { void save() }}>保存源文件修改</button>
    </>}
    {instruction && <div><p>修改已保存，尚未重新导出。</p><button type="button" disabled={busy} onClick={() => { void send() }}>交给助手检查并导出</button></div>}
  </section>
}

export function apply(ctx: any) {
  let disposePanel: (() => void) | undefined
  const close = () => { disposePanel?.(); disposePanel = undefined; ctx.layout.closeDetails() }
  function ToolView({ block, sessionId }: any) {
    const preview = block.meta?.preview
    if (!preview) return createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, (block.content ?? []).map((item: any) => item.text ?? '').join('\n') || '正在读取 Office 文件…')
    return <button type="button" onClick={() => {
      if (sessionId !== preview.session_id || ctx.sessions.list.getSnapshot().current !== sessionId) return
      disposePanel?.()
      disposePanel = ctx.slots.register({ name: 'details', id: 'e-mate-ppt-preview', priority: -2,
        inject: () => ({ ctx, preview, close }) }, PreviewPanel)
      ctx.layout.openDetails()
    }}>打开 PPT 持续预览</button>
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'office_read' }, ToolView))
  ctx.effect(() => () => { disposePanel?.(); disposePanel = undefined })
}
