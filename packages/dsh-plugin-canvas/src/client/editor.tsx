import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, MainMenu, exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, BinaryFiles } from '@excalidraw/excalidraw/types'
import { ASSET_PATH, emptyPage, emptyProject, type CanvasAsset, type CanvasIntent, type CanvasProject, type ProjectReceipt } from '../contract.ts'
import type { CanvasBridge } from './bridge.ts'
import { base64, bytesOf, digest, duplicatePage, externalLinks, htmlDocument, insertAsset, pagesFromHtml, reorderPage, scenePage } from './model.ts'
import css from './style.module.css'

(window as any).EXCALIDRAW_ASSET_PATH = new URL(ASSET_PATH, location.origin).href
// The large editor and its stylesheet are only reached from the lazy native factory.
if (!document.querySelector('link[data-emate-canvas-css]')) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ASSET_PATH + 'editor.css'; link.dataset.emateCanvasCss = 'true'; document.head.append(link)
}
const fresh = () => crypto.randomUUID()
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function HtmlPreview({ html, title }: { html: string; title: string }) {
  return <div className={css.htmlPreview}>
    <iframe title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={htmlDocument(html)} />
    <details><summary>外部链接</summary>{externalLinks(html).map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{url}</a>)}</details>
  </div>
}
export interface CanvasPanelProps { sessionId?: string; bridge: CanvasBridge; initialProjectId: string; initialAsset?: CanvasAsset }
export function CanvasPanel({ sessionId, bridge, initialProjectId, initialAsset }: CanvasPanelProps) {
  const [project, setProject] = useState<CanvasProject | null>(null)
  const [pageId, setPageId] = useState('page-1')
  const [projects, setProjects] = useState<any[]>([])
  const [files, setFiles] = useState<BinaryFiles>({})
  const [notice, setNotice] = useState('正在恢复项目…')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [kind, setKind] = useState<CanvasIntent['kind']>('image')
  const [presenting, setPresenting] = useState(false)
  const [previewMode, setPreviewMode] = useState<'canvas' | 'html'>('canvas')
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const state = useRef<{ project: CanvasProject | null; revision: string | null; dirty: boolean; blocked: boolean }>({ project: null, revision: null, dirty: false, blocked: false })
  const lane = useRef(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const selected = useRef<string[]>([])
  const syncLane = useRef(false)
  const imageInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const page = project?.pages.find(item => item.id === pageId)

  const refreshList = useCallback(async () => { const value = await bridge.call('list'); if (alive.current) setProjects(value) }, [bridge])
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    const save = lane.current.then(async () => {
      const current = state.current
      if (!current.project || !current.dirty) return
      if (current.blocked) throw new Error('项目发生保存冲突。请重新载入或导出当前编辑。')
      const snapshot = current.project
      setSaving(true)
      try {
        const result: ProjectReceipt = await bridge.call('save', { project_id: snapshot.id, project: snapshot, expected_revision: current.revision })
        current.revision = result.revision
        if (current.project === snapshot) current.dirty = false
        if (alive.current) { setNotice('已保存到项目'); setRecovered(false); setError(null) }
      } catch (error) {
        current.blocked = true
        if (alive.current) setError((error as Error).message)
        throw error
      } finally { if (alive.current) setSaving(false) }
    })
    lane.current = save.catch(() => {})
    return save
  }, [bridge])
  useEffect(() => bridge.beforeLeave(flush), [bridge, flush])
  const update = useCallback((next: CanvasProject) => {
    state.current.project = next; state.current.dirty = true; setProject(next); setNotice('尚未保存')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { if (!state.current.blocked) void flush().catch(() => {}) }, 400)
  }, [flush])
  const imageFiles = useCallback(async (document: CanvasProject): Promise<BinaryFiles> => {
    const loaded: BinaryFiles = {}
    // Native CAS is the byte owner. Limit concurrent hydration reads; no model scheduling here.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, document.assets.length) }, async () => {
      while (next < document.assets.length) {
        const asset = document.assets[next++]!
        const result = await bridge.call('image', { project_id: document.id, attachment_id: asset.ref.attachmentId })
        const bytes = bytesOf(result.bytes_base64)
        if (`sha256:${await digest(bytes)}` !== asset.ref.attachmentId || bytes.byteLength !== asset.ref.bytes) throw new Error('素材已损坏，未在画布显示。')
        const id = asset.ref.attachmentId.slice(7)
        loaded[id] = { id: id as any, mimeType: asset.ref.mediaType as any, dataURL: `data:${asset.ref.mediaType};base64,${base64(bytes)}` as any, created: 0 }
      }
    }))
    return loaded
  }, [bridge])
  const openProject = useCallback(async (id: string, asset?: CanvasAsset) => {
    await flush()
    const token = ++generation.current
    const result: ProjectReceipt | null = await bridge.call('load', { project_id: id })
    if (!alive.current || token !== generation.current) return
    let next = result?.project ?? emptyProject(id)
    state.current = { project: next, revision: result?.revision ?? null, dirty: false, blocked: false }
    if (!result) { update(next); await flush() }
    if (asset) { next = insertAsset(next, next.pages[0]!.id, asset); update(next); await flush() }
    const loaded = await imageFiles(next)
    if (!alive.current || token !== generation.current) return
    api.current = null; setFiles(loaded); setProject(next); setPageId(next.pages[0]!.id); setRecovered(result?.recovered ?? false)
    setNotice(result?.recovered ? '已恢复上一份完整保存，损坏原件保留。请检查后保存。' : '已恢复项目')
    setError(null); void refreshList()
  }, [bridge, flush, imageFiles, refreshList, update])
  useEffect(() => {
    alive.current = true
    void openProject(initialProjectId, initialAsset).catch(error => { if (alive.current) setError(error.message) })
    const unload = (event: BeforeUnloadEvent) => { if (state.current.dirty) { event.preventDefault(); event.returnValue = '' } }
    addEventListener('beforeunload', unload)
    return () => { alive.current = false; generation.current += 1; if (timer.current) clearTimeout(timer.current); removeEventListener('beforeunload', unload); void flush().catch(() => {}) }
  }, [initialProjectId, initialAsset, openProject, flush])

  const syncOutputs = useCallback(async () => {
    if (syncLane.current || state.current.blocked || !state.current.project) return
    syncLane.current = true
    try {
      await flush()
      const original = state.current.project
      for (const pending of original.intents.filter(intent => intent.sessionId === bridge.sessionId)) {
        const result = await bridge.call('outputs', { project_id: original.id, intent_id: pending.id })
        let next = state.current.project
        if (!next || next.id !== original.id) return
        const intent = next.intents.find(item => item.id === pending.id)
        if (!intent) continue
        if (result.kind === 'images') {
          for (const asset of result.assets as CanvasAsset[]) {
            const hash = asset.ref.attachmentId.slice(7)
            if (intent.imported.includes(hash)) continue
            next = insertAsset(next, intent.pageId, asset)
            next.intents.find(item => item.id === intent.id)!.imported.push(hash)
            update(next)
          }
        } else if (typeof result.html === 'string' && typeof result.sha256 === 'string' && !intent.imported.includes(result.sha256)) {
          next = structuredClone(next)
          const target = next.pages.find(item => item.id === intent.pageId)
          if (!target) continue
          if (intent.kind === 'slides') {
            const incoming = pagesFromHtml(result.html, `slide-${intent.id.slice(0, 30)}`)
            const index = next.pages.findIndex(item => item.id === target.id)
            // Keep the request's target page identity so future requests and recovery keep their binding.
            incoming[0]!.id = target.id
            next.pages.splice(index, 1, ...incoming)
          } else target.html = result.html
          next.intents.find(item => item.id === intent.id)!.imported.push(result.sha256)
          update(next); setPreviewMode('html')
        }
      }
      if (state.current.dirty && state.current.project) {
        await flush(); const loaded = await imageFiles(state.current.project)
        if (alive.current) { setFiles(loaded); api.current?.addFiles(Object.values(loaded)); setNotice('原生任务的成功产物已插入，已有素材已去重。') }
      }
    } catch (error) { if (alive.current) setError((error as Error).message) }
    finally { syncLane.current = false }
  }, [bridge, flush, imageFiles, update])
  useEffect(() => {
    let syncTimer: ReturnType<typeof setTimeout> | undefined
    const off = bridge.subscribe(() => { if (syncTimer) clearTimeout(syncTimer); syncTimer = setTimeout(() => { void syncOutputs() }, 150) })
    void syncOutputs()
    return () => { off(); if (syncTimer) clearTimeout(syncTimer) }
  }, [bridge, syncOutputs])
  useEffect(() => { if (project?.id) void syncOutputs() }, [project?.id, syncOutputs])
  useEffect(() => {
    if (!presenting) return
    const key = (event: KeyboardEvent) => {
      if (!['ArrowRight', 'ArrowLeft', 'Escape'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Escape') { setPresenting(false); return }
      const pages = state.current.project?.pages.filter(item => item.slide) ?? []
      const index = pages.findIndex(item => item.id === pageId)
      const next = pages[index + (event.key === 'ArrowRight' ? 1 : -1)]
      if (next) setPageId(next.id)
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [presenting, pageId])

  useEffect(() => {
    if (!page || !api.current) return
    if (JSON.stringify(api.current.getSceneElementsIncludingDeleted()) !== JSON.stringify(page.elements)) {
      api.current.updateScene({ elements: page.elements as any })
    }
  }, [page])

  const submit = async () => {
    const current = state.current.project
    if (!current || !instruction.trim()) return
    const selectedIds = selected.current
    if (kind === 'edit' && selectedIds.length === 0) { setError('先在画布选中要修改的图片。'); return }
    setBusy(true); setError(null)
    try {
      const intent: CanvasIntent = { id: fresh(), kind, pageId, sessionId: bridge.sessionId, sourceIds: kind === 'image' ? [] : selectedIds, imported: [] }
      const next = { ...current, intents: [...current.intents, intent] }
      update(next); await flush()
      await bridge.submit(next, intent, instruction)
      setInstruction(''); setNotice('请求已交给当前会话。运行状态和取消操作见原生会话。')
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const addImages = async (incoming: File[]) => {
    const document = state.current.project
    if (!document) return
    const targetPage = pageId
    const assets = await bridge.stageImages(incoming)
    let next = state.current.project
    if (!next || next.id !== document.id || !next.pages.some(page => page.id === targetPage)) throw new Error('项目或目标页面已变化，图片仍保留在会话中。')
    for (const asset of assets) next = insertAsset(next, targetPage, asset)
    update(next); await flush()
    const loaded = await imageFiles(next); setFiles(loaded); api.current?.addFiles(Object.values(loaded))
    api.current?.scrollToContent(undefined, { fitToViewport: true })
  }
  const exportImages = async (slides: boolean) => {
    if (!state.current.project) return
    await flush()
    const pages = slides ? state.current.project.pages.filter(item => item.slide) : [state.current.project.pages.find(item => item.id === pageId)!]
    if (slides) {
      const rendered = await Promise.all(pages.map(async item => {
        const visible = item.elements.filter(element => !element.isDeleted)
        const blob = visible.length ? await exportToBlob({ elements: visible as any, appState: { viewBackgroundColor: item.view.background, exportBackground: true }, files, mimeType: 'image/png' }) : null
        const data = blob ? base64(new Uint8Array(await blob.arrayBuffer())) : null
        return `<section><h2>${item.title.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)}</h2>${item.html ? `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${htmlDocument(item.html).replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)}"></iframe>` : ''}${data ? `<img alt="幻灯片画布" src="data:image/png;base64,${data}">` : ''}</section>`
      }))
      download(`${state.current.project.id}-slides.html`, new Blob([`<!doctype html><meta charset="utf-8"><title>e-Mate 幻灯片</title><style>body{margin:0;background:#15181e;color:white;font:16px system-ui}section{min-height:100vh;box-sizing:border-box;padding:32px;display:grid;place-items:center;break-after:page}img{max-width:90vw;max-height:85vh}iframe{width:90vw;height:80vh;border:0;background:white}@media print{body{background:white;color:black}section{height:100vh}}</style>${rendered.join('')}`], { type: 'text/html' }))
    } else {
      const item = pages[0]!
      const blob = await exportToBlob({ elements: item.elements as any, appState: { viewBackgroundColor: item.view.background, exportBackground: true }, files, mimeType: 'image/png' })
      download(`${state.current.project.id}-${item.id}.png`, blob)
    }
  }
  const act = (action: () => Promise<void> | void) => { void Promise.resolve().then(action).catch(error => setError(error.message)) }
  if (sessionId && sessionId !== bridge.sessionId) return <div className={css.empty}>此画布属于先前会话。<button onClick={() => act(async () => { await flush(); bridge.close() })}>保存并关闭</button></div>
  return <div ref={root} className={`${css.panel} ${presenting ? css.presenting : ''}`} data-emate-canvas>
    {!presenting && <header className={css.header}>
      <strong>项目画布</strong><button type="button" onClick={() => act(async () => { await flush(); bridge.close() })}>关闭</button>
    </header>}
    {error && <div role="alert" className={css.error}>{error}<div>
      <button onClick={() => { if (state.current.project) download(`${state.current.project.id}-unsaved.json`, new Blob([JSON.stringify(state.current.project)], { type: 'application/json' })) }}>导出当前编辑</button>
      <button onClick={() => act(async () => { const id = state.current.project?.id ?? initialProjectId; state.current.dirty = false; state.current.blocked = false; await openProject(id) })}>放弃未保存编辑并重载</button>
    </div></div>}
    {!project || !page ? <div className={css.empty}>{error ? '项目原件保留。可重新载入或选择其他项目。' : notice}</div> : <>
      {!presenting && <>
        <div className={css.projectBar}>
          <select aria-label="选择项目" value={project.id} onChange={event => act(() => openProject(event.target.value))}>
            {!projects.some(item => item.id === project.id) && <option value={project.id}>{project.title}</option>}
            {projects.map(item => <option key={item.id} value={item.id}>{item.title}{item.error ? ' · 损坏' : ''}</option>)}
          </select>
          <button onClick={() => act(() => openProject(fresh()))}>新项目</button>
          <button disabled={saving} onClick={() => act(async () => { state.current.blocked = false; state.current.dirty = true; await flush(); await refreshList() })}>{saving ? '保存中…' : recovered ? '保存恢复副本' : '保存'}</button>
        </div>
        <input className={css.title} aria-label="项目名称" value={project.title} maxLength={120} onChange={event => { if (event.target.value.trim()) update({ ...project, title: event.target.value }) }} />
        <nav className={css.pages} aria-label="画布页面">
          {project.pages.map((item, index) => <button key={item.id} aria-pressed={pageId === item.id} draggable
            onDragStart={event => event.dataTransfer.setData('application/x-emate-canvas-page', item.id)}
            onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-emate-canvas-page'); const from = project.pages.findIndex(page => page.id === id); if (from >= 0) update(reorderPage(project, id, index - from)) }}
            onClick={() => setPageId(item.id)}>{index + 1}. {item.title}</button>)}
          <button aria-label="新增页面" disabled={project.pages.length >= 64} onClick={() => { const id = fresh(); update({ ...project, pages: [...project.pages, emptyPage(id, `画布 ${project.pages.length + 1}`)] }); setPageId(id) }}>＋</button>
        </nav>
        <div className={css.toolbar}>
          <input aria-label="页面名称" value={page.title} maxLength={120} onChange={event => { if (event.target.value.trim()) update({ ...project, pages: project.pages.map(item => item.id === pageId ? { ...item, title: event.target.value } : item) }) }} />
          <button onClick={() => imageInput.current?.click()}>添加图片</button>
          <input hidden ref={imageInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
            const incoming = Array.from(event.target.files ?? []); event.target.value = ''
            if (!incoming.length) return
            act(() => addImages(incoming))
          }} />
          <button title="向前排序" onClick={() => update(reorderPage(project, pageId, -1))}>←</button><button title="向后排序" onClick={() => update(reorderPage(project, pageId, 1))}>→</button>
          <button disabled={project.pages.length >= 64} onClick={() => { const id = fresh(); update(duplicatePage(project, pageId, id)); setPageId(id) }}>复制页</button>
          <button disabled={project.pages.length === 1} onClick={() => { const pages = project.pages.filter(item => item.id !== pageId); update({ ...project, pages, intents: project.intents.filter(intent => intent.pageId !== pageId) }); setPageId(pages[0]!.id) }}>删除页</button>
          <label><input type="checkbox" checked={page.slide} onChange={event => update({ ...project, pages: project.pages.map(item => item.id === pageId ? { ...item, slide: event.target.checked } : item) })} />幻灯片</label>
          {page.html && <button onClick={() => setPreviewMode(previewMode === 'canvas' ? 'html' : 'canvas')}>{previewMode === 'canvas' ? 'HTML 预览' : '画布标注'}</button>}
        </div>
      </>}
      <div className={css.stage} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDropCapture={event => {
        if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); act(() => addImages(Array.from(event.dataTransfer.files))) }
      }}>
        {page.html && (previewMode === 'html' || presenting) ? <HtmlPreview html={page.html} title={page.title} /> : <Excalidraw key={`${project.id}:${page.id}`}
          excalidrawAPI={value => { api.current = value }}
          initialData={{ elements: page.elements as any, files, appState: { scrollX: page.view.scrollX, scrollY: page.view.scrollY, zoom: { value: page.view.zoom as any }, viewBackgroundColor: page.view.background } }}
          viewModeEnabled={presenting} langCode="zh-CN" validateEmbeddable={() => false}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false }, tools: { image: false } }}
          onLinkOpen={(element, event) => { event.preventDefault(); if (element.link && /^https?:\/\//u.test(element.link)) window.open(element.link, '_blank', 'noopener,noreferrer') }}
          onPaste={() => false}
          onChange={(elements, appState) => {
            selected.current = elements.filter(item => item.type === 'image' && appState.selectedElementIds[item.id]).map(item => `sha256:${(item as any).fileId}`)
            if (presenting) return
            const current = state.current.project
            const existing = current?.pages.find(item => item.id === page.id)
            if (!current || !existing || current.id !== project.id) return
            const next = scenePage(existing, elements as any, appState)
            if (JSON.stringify(next) !== JSON.stringify(existing)) update({ ...current, pages: current.pages.map(item => item.id === page.id ? next : item) })
          }}><MainMenu><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ToggleTheme /></MainMenu></Excalidraw>}
      </div>
      {!presenting && <>
        <details className={css.htmlEditor}><summary>HTML 页面内容</summary><textarea aria-label="HTML 页面内容" value={page.html ?? ''} maxLength={512 * 1024}
          onChange={event => update({ ...project, pages: project.pages.map(item => item.id === pageId ? { ...item, html: event.target.value || null } : item) })} placeholder="可粘贴 HTML；预览始终位于隔离沙箱中。" /></details>
        <div className={css.ai}>
          <select aria-label="AI 操作" value={kind} onChange={event => setKind(event.target.value as CanvasIntent['kind'])}><option value="image">生成图片</option><option value="edit">修改选中图片</option><option value="html">生成 HTML</option><option value="slides">生成幻灯片</option></select>
          <textarea aria-label="画布生成需求" placeholder="描述需求，交给当前会话执行…" value={instruction} maxLength={20000} onChange={event => setInstruction(event.target.value)} />
          <button disabled={busy || !instruction.trim() || !!error} onClick={() => act(submit)}>{busy ? '提交中…' : '交给当前会话'}</button><button onClick={() => act(syncOutputs)}>同步成功产物</button>
        </div>
      </>}
      <footer className={css.footer}>
        <span role="status">{notice}</span>
        {presenting ? <><button onClick={() => { const pages = project.pages.filter(item => item.slide); const index = pages.findIndex(item => item.id === pageId); if (index > 0) setPageId(pages[index - 1]!.id) }}>上一页</button><button onClick={() => { const pages = project.pages.filter(item => item.slide); const index = pages.findIndex(item => item.id === pageId); if (index < pages.length - 1) setPageId(pages[index + 1]!.id) }}>下一页</button><button onClick={() => { setPresenting(false); if (document.fullscreenElement) void document.exitFullscreen() }}>退出播放</button></>
          : <>
            <button onClick={() => act(async () => { await flush(); const first = project.pages.find(item => item.slide); if (!first) throw new Error('请先勾选幻灯片页面。'); setPageId(first.id); setPresenting(true); await root.current?.requestFullscreen?.() })}>全屏播放</button>
            <button onClick={() => act(() => exportImages(false))}>导出 PNG</button><button onClick={() => act(() => exportImages(true))}>导出幻灯片</button>
            <button onClick={() => act(async () => { await flush(); const result = await bridge.call('export', { project_id: project.id }); download(result.name, new Blob([bytesOf(result.archive_base64).slice().buffer], { type: 'application/zip' })) })}>导出项目与素材</button>
            <button onClick={() => importInput.current?.click()}>导入项目</button>
            <input hidden ref={importInput} type="file" accept=".zip" onChange={event => { const file = event.target.files?.[0]; if (!file) return; act(async () => { if (file.size > 100 * 1024 * 1024) throw new Error('项目压缩包超过 100 MiB。'); await flush(); const id = fresh(); const result = await bridge.call('import', { project_id: id, archive_base64: base64(new Uint8Array(await file.arrayBuffer())) }); await openProject(result.project.id) }); event.target.value = '' }} />
          </>}
      </footer>
    </>}
  </div>
}
