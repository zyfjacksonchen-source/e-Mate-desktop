import { useEffect, useRef, useState } from 'react'
import { FileIcon } from '../../../dsh-plugin-file-import/src/client/file-icons.tsx'
import { HASH, type CallKnowledge } from '../contract.ts'
import type { UiImportStatus } from '../ui-operations.ts'
import css from './imports.module.css'
type Picked = { path: string; name: string; mediaType: string }
export interface KnowledgeImportsProps { openRequest?: number; callKnowledge: CallKnowledge; pickDirectory?: (signal?: AbortSignal) => Promise<string | null>; openTask?: (sessionId: string) => void; replacement?: { source_id: string; source_version: string; title: string } }
const labels = { prepared: '尚未开始', importing: '导入中', parsing: '解析中', compiling: '整理中', complete: '已完成', partial: '部分未完成', paused: '已暂停', stopping: '正在停止', stopped: '已停止', unknown: '回执待确认', failed: '未完成' }
const sourceLabels: Record<string, string> = { ready: '已解析', parsing: '解析中', failed: '解析失败', deleted: '已删除', superseded: '已有新版本', awaiting_content: '等待原件', unknown: '回执待确认' }
export function diskFiles(files: File[], bridge = (window as any).__DSH_DESKTOP_FILE_PATH__): Picked[] {
  if (!bridge || typeof bridge.getPathForFile !== 'function') throw Error('请在桌面应用中选择磁盘原件。')
  if (!files.length || files.length > 100) throw Error('一次最多选择100份原件；大目录自动分批尚未完成。')
  return files.map(file => {
    if (!(file instanceof File)) throw Error('请选择真实磁盘文件。')
    const path = bridge.getPathForFile(file)
    if (typeof path !== 'string' || !path || path.length > 4096) throw Error('无法读取该文件的磁盘位置，请重新选择原件。')
    return { path, name: file.name, mediaType: file.type }
  })
}
export function KnowledgeImports({ callKnowledge, pickDirectory, openTask, replacement, openRequest }: KnowledgeImportsProps) {
  const chooseButton = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false), [files, setFiles] = useState<Picked[]>([]), [title, setTitle] = useState('')
  useEffect(() => { if (openRequest) setOpen(true) }, [openRequest])
  useEffect(() => { if (open && openRequest) { chooseButton.current?.scrollIntoView?.({ block: 'nearest' }); chooseButton.current?.focus() } }, [open, openRequest])
  const [kind, setKind] = useState<'uploader-private' | 'public' | 'project'>('uploader-private'), [projectId, setProjectId] = useState('')
  const [replace, setReplace] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<string>()
  const [items, setItems] = useState<UiImportStatus[]>([]), [more, setMore] = useState(false)
  const [projects, setProjects] = useState<{ items: { id: number; title: string; can_import?: boolean }[]; complete: boolean }>()
  const chooser = useRef<HTMLInputElement>(null), generation = useRef(0), owner = useRef(''), action = useRef(false)
  const refreshRead = useRef<(() => void) | undefined>(undefined), taskUpdates = useRef(0)
  const requests = useRef(new Set<AbortController>()), call = useRef(callKnowledge); call.current = callKnowledge
  const run = async (endpoint: string, payload: Record<string, unknown>, controller = new AbortController()) => {
    const epoch = generation.current; requests.current.add(controller)
    try {
      const reply = await call.current(endpoint, payload, controller.signal)
      if (epoch !== generation.current || controller.signal.aborted) throw new DOMException('cancelled', 'AbortError')
      if (!HASH.test(reply.scope_key) || owner.current && owner.current !== reply.scope_key) throw Object.assign(Error('登录状态已变化，请重新打开知识导入。'), { code: 'scope-changed' })
      owner.current = reply.scope_key; return reply.result
    } finally { requests.current.delete(controller) }
  }
  const report = (reason: any) => { if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '操作未完成，请查看最近任务。') }
  const refresh = () => refreshRead.current?.()
  useEffect(() => {
    const clear = () => {
      generation.current++; requests.current.forEach(controller => controller.abort()); requests.current.clear(); owner.current = ''; action.current = false
      taskUpdates.current++; setItems([]); setMore(false); setFiles([]); setProjects(undefined); setKind('uploader-private'); setProjectId(''); setReplace(false); setTitle(''); setBusy(false); setPending(undefined); setError('登录状态已变化，请重新选择资料。')
    }
    addEventListener('emate:identity-changed', clear)
    return () => { generation.current++; requests.current.forEach(controller => controller.abort()); requests.current.clear(); removeEventListener('emate:identity-changed', clear) }
  }, [])
  useEffect(() => {
    if (!open) return
    let disposed = false, running = false, rerun = false, controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const enabled = () => !disposed && document.visibilityState !== 'hidden' && navigator.onLine !== false
    const poll = async () => {
      if (timer) clearTimeout(timer)
      if (!enabled()) return
      if (running) { rerun = true; return }
      running = true; controller = new AbortController()
      const updates = taskUpdates.current
      try {
        const result = await run('ui.import.recent', {}, controller)
        if (!enabled() || controller.signal.aborted) return
        if (!Array.isArray(result.items)) throw Error('任务回执无效。')
        // A completed user action owns its newer receipt; catch up with a fresh read.
        if (updates !== taskUpdates.current) { rerun = true; return }
        setItems(result.items); setMore(result.has_more === true)
      } catch (reason) { if (!disposed && !controller.signal.aborted) report(reason) }
      finally {
        running = false; controller = undefined
        if (enabled()) {
          if (rerun) { rerun = false; void poll() }
          else timer = setTimeout(() => void poll(), 2000)
        }
      }
    }
    const lifecycle = () => {
      if (timer) clearTimeout(timer)
      if (!enabled()) { rerun = false; controller?.abort() }
      else void poll()
    }
    refreshRead.current = () => void poll()
    document.addEventListener('visibilitychange', lifecycle)
    addEventListener('online', lifecycle); addEventListener('offline', lifecycle); addEventListener('emate:identity-changed', lifecycle)
    void poll()
    return () => {
      disposed = true; refreshRead.current = undefined; if (timer) clearTimeout(timer); controller?.abort()
      document.removeEventListener('visibilitychange', lifecycle)
      removeEventListener('online', lifecycle); removeEventListener('offline', lifecycle); removeEventListener('emate:identity-changed', lifecycle)
    }
  }, [open])
  useEffect(() => { setReplace(false) }, [replacement?.source_id, replacement?.source_version])
  useEffect(() => {
    if (!open || kind !== 'project') return
    let active = true
    void run('ui.import.projects', {}).then(result => { if (!active) return; if (!Array.isArray(result.items) || typeof result.complete !== 'boolean' || result.items.some((item: any) => !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.title !== 'string')) throw Error('项目目录返回无效。'); setProjects(result) }).catch(reason => { if (active) report(reason) })
    return () => { active = false }
  }, [open, kind])
  const addFiles = (next: Picked[]) => { if (busy || action.current) return; setFiles(previous => { const result = [...new Map([...previous, ...next].map(file => [file.path, file])).values()]; if (result.length > 100) { setError('一次最多选择100份原件；大目录自动分批尚未完成。'); return previous }; return result }) }
  const prepareAndStart = async () => {
    if (action.current || !files.length) return
    action.current = true; setBusy(true); setError(''); const epoch = generation.current
    let reference: { operation_id: string; session_id: string } | undefined
    try {
      const scope = kind === 'project' ? { kind, project_id: Number(projectId) } : { kind }
      if (kind === 'project' && !projects?.items.some(item => item.id === Number(projectId) && item.can_import === true)) throw Error('请选择有导入权限的项目。')
      const prepared = await run('ui.import.prepare', { paths: files.map(file => file.path), scope, ...(title.trim() ? { title: title.trim() } : {}), ...(replace && replacement ? { supersedes: { source_id: replacement.source_id, source_version: replacement.source_version } } : {}) })
      reference = { operation_id: prepared.operation_id, session_id: prepared.session_id }
      taskUpdates.current++; setItems(previous => [prepared, ...previous.filter(item => item.operation_id !== prepared.operation_id)])
      const started = await run('ui.import.start', reference)
      taskUpdates.current++; setItems(previous => [started, ...previous.filter(item => item.operation_id !== started.operation_id)]); setFiles([]); setTitle(''); setReplace(false)
    } catch (reason) {
      if (epoch === generation.current) { report(reason); if (reference) { try { const status = await run('ui.import.status', reference); taskUpdates.current++; setItems(previous => [status, ...previous.filter(item => item.operation_id !== status.operation_id)]) } catch { /* Keep the issued reference for explicit retry. */ } } else void refresh() }
    } finally { if (epoch === generation.current) { action.current = false; setBusy(false) } }
  }
  const changeTask = async (item: UiImportStatus, actionName: 'stop' | 'resume' | 'start') => {
    if (pending) return
    setPending(item.operation_id); setError(''); const epoch = generation.current
    try { const status = await run('ui.import.' + actionName, { operation_id: item.operation_id, session_id: item.session_id }); taskUpdates.current++; setItems(previous => previous.map(value => value.operation_id === item.operation_id ? status : value)) }
    catch (reason) { if (epoch === generation.current) report(reason) }
    finally { if (epoch === generation.current) setPending(undefined) }
  }
  return <section className={css.root} aria-label="导入并整理知识"><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>导入并整理</button>
    {open && <div className={css.panel}>
      <div className={css.top}><div><strong>导入并整理知识</strong><p>导入原件，解析后自动整理发布。离开页面任务会继续。</p></div><button type="button" onClick={() => setOpen(false)} aria-label="收起知识导入">收起</button></div>
      <div className={css.drop} aria-disabled={busy} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (busy || action.current) return; try { addFiles(diskFiles(Array.from(event.dataTransfer.files))) } catch (reason) { report(reason) } }}>
        <input ref={chooser} type="file" multiple hidden disabled={busy} aria-label="选择知识原件" onChange={event => { if (busy || action.current) { event.currentTarget.value = ''; return }; try { addFiles(diskFiles(Array.from(event.currentTarget.files ?? []))) } catch (reason) { report(reason) }; event.currentTarget.value = '' }} />
        <span>拖入磁盘文件，或</span><button ref={chooseButton} type="button" disabled={busy} onClick={() => { if (!action.current) chooser.current?.click() }}>选择文件</button>
        <button type="button" disabled={!pickDirectory || busy} onClick={async () => { const epoch = generation.current; const controller = new AbortController(); requests.current.add(controller); try { const path = await pickDirectory?.(controller.signal); if (path && epoch === generation.current) addFiles([{ path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, mediaType: 'inode/directory' }]) } catch (reason) { if (epoch === generation.current) report(reason) } finally { requests.current.delete(controller) } }}>选择文件夹</button>
      </div>
      {!!files.length && <ul className={css.files} aria-label="待导入原件">{files.map(file => <li key={file.path}><FileIcon name={file.name} mediaType={file.mediaType} /><span>{file.name}</span><button type="button" aria-label={'移除 ' + file.name} disabled={busy} onClick={() => setFiles(previous => previous.filter(value => value.path !== file.path))}>×</button></li>)}</ul>}
      <div className={css.fields}><label>整理主题（可选）<input value={title} maxLength={300} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="例如：投放复盘方法" /></label><label>资料范围<select aria-label="资料范围" value={kind} disabled={busy || replace} onChange={event => { setKind(event.target.value as typeof kind); setProjectId('') }}><option value="uploader-private">仅自己可见</option><option value="public">公司公共知识库</option><option value="project">芯助手项目资料</option></select></label>
        {kind === 'project' && <label>目标项目<select aria-label="目标项目" value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}><option value="">选择有导入权限的项目</option>{projects?.items.map(project => <option key={project.id} value={project.id} disabled={project.can_import !== true}>{project.title}{project.can_import === false ? '（只读）' : project.can_import === undefined ? '（权限待确认）' : ''}</option>)}</select></label>}</div>
      {kind === 'public' && <p className={css.notice}>这些原件及整理结果将进入公司公共知识库，请仅选择可公开复用的资料。</p>}
      {kind === 'project' && projects?.complete === false && <p className={css.notice}>当前项目目录为部分结果，未列出的项目不代表没有权限。</p>}
      {replacement && <label className={css.replace}><input type="checkbox" checked={replace} disabled={busy} onChange={event => { setReplace(event.target.checked); if (event.target.checked) setKind('public') }} />作为“{replacement.title}”的新原件版本，保留历史记录</label>}
      <div className={css.submit}><span>单份最多20 MiB，一次最多100份；超量目录需拆分选择。</span><button type="button" disabled={busy || !files.length || kind === 'project' && !projectId} onClick={() => void prepareAndStart()}>{busy ? '正在建立任务…' : '导入并整理所选资料'}</button></div>
      {error && <p role="alert" className={css.error}>{error}</p>}
      <div className={css.recentHeader}><strong>最近任务（最多20条）</strong><button type="button" onClick={() => void refresh()}>刷新</button></div>{!items.length && <p className={css.notice}>暂无本账号的导入任务。</p>}
      <ul className={css.tasks} aria-label="知识导入任务">{items.map(item => <li key={item.operation_id}><div className={css.taskTitle}><strong>{item.title}</strong><span data-phase={item.phase}>{labels[item.phase]}</span></div><p>{item.scope.kind === 'public' ? '公共知识' : item.scope.kind === 'project' ? '项目资料' : '仅自己可见'} · {item.model.id} · {item.file_count === undefined ? '原件数量待核对' : `${item.file_count}份原件`} · 已发布{item.compiled_count}个主题</p>
        {!!item.sources.length && <details><summary>查看原件回执</summary><ul className={css.sourceRows}>{item.sources.map(source => <li key={source.key}><FileIcon name={source.name} mediaType="" /><span>{source.name}</span><small>{sourceLabels[source.status] ?? '回执待确认'}</small></li>)}</ul></details>}
        {item.reason && <p className={css.notice}>{item.reason}</p>}<div className={css.actions}>{openTask && <button type="button" onClick={() => openTask(item.compilation_session_id ?? item.session_id)}>查看任务</button>}{['importing', 'parsing', 'compiling', 'stopping'].includes(item.phase) ? <button type="button" disabled={!!pending || item.phase === 'stopping'} onClick={() => void changeTask(item, 'stop')}>停止</button> : item.phase !== 'complete' && <button type="button" disabled={!!pending} onClick={() => void changeTask(item, item.phase === 'prepared' ? 'start' : 'resume')}>{item.phase === 'prepared' ? '开始' : item.phase === 'unknown' ? '回查并继续' : '继续'}</button>}</div></li>)}</ul>
      {more && <button type="button" onClick={() => void refresh()}>继续加载任务</button>}
    </div>}
  </section>
}
