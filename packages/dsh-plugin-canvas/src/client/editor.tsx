import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, MainMenu, exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, BinaryFiles } from '@excalidraw/excalidraw/types'
import { ASSET_PATH, emptyProject, type CanvasAsset, type CanvasIntent, type CanvasProject, type ProjectReceipt } from '../contract.ts'
import type { CanvasBridge } from './bridge.ts'
import { arrowImageTarget, base64, bytesOf, digest, insertAsset, pagesFromHtml, scenePage, sameSceneElements, selectedAnnotationElements } from './model.ts'
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
function useNativeTheme() {
  const current = () => document.body.hasAttribute('data-ds-dark-theme') ? 'dark' as const : 'light' as const
  const [theme, setTheme] = useState(current)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
export interface CanvasPanelProps { sessionId?: string; bridge: CanvasBridge; initialProjectId: string; initialAsset?: CanvasAsset; onInitialAssetConsumed?: () => void }
export function CanvasPanel({ sessionId, bridge, initialProjectId, initialAsset, onInitialAssetConsumed }: CanvasPanelProps) {
  const consumed = useRef(onInitialAssetConsumed)
  consumed.current = onInitialAssetConsumed
  const [project, setProject] = useState<CanvasProject | null>(null)
  const [pageId, setPageId] = useState('page-1')
  const [projects, setProjects] = useState<any[]>([])
  const [files, setFiles] = useState<BinaryFiles>({})
  const [notice, setNotice] = useState('正在恢复项目…')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [sceneLoad, setSceneLoad] = useState(0)
  const transitioning = useRef(false)
  const [recovered, setRecovered] = useState(false)
  const [instruction, setInstruction] = useState('')
  const theme = useNativeTheme()
  const [activeTool, setActiveTool] = useState('selection')
  const [selectionCount, setSelectionCount] = useState(0)
  const submitting = useRef(false)
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const state = useRef<{ project: CanvasProject | null; revision: string | null; dirty: boolean; blocked: boolean }>({ project: null, revision: null, dirty: false, blocked: false })
  const lane = useRef(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const generation = useRef(0)
  const selected = useRef<string[]>([])
  const selectedElements = useRef<string[]>([])
  const syncLane = useRef(false)
  const instructionInput = useRef<HTMLTextAreaElement>(null)
  const arrowGesture = useRef<{ previous: Set<string>; released: boolean } | null>(null)
  const focusFrame = useRef<number | undefined>(undefined)
  const fitFrame = useRef<number | undefined>(undefined)
  const imageInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const page = project?.pages.find(item => item.id === pageId)

  // Leave space for the floating tools and footer; never upscale small images.
  const fitScene = (value: ExcalidrawImperativeAPI, maxZoom = 1) => {
    if (fitFrame.current !== undefined) cancelAnimationFrame(fitFrame.current)
    fitFrame.current = requestAnimationFrame(() => {
      if (alive.current && api.current === value) value.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.68, maxZoom: Math.min(1, maxZoom), animate: false })
    })
  }
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
    if (transitioning.current) return
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
    if (transitioning.current) return
    transitioning.current = true; setSwitching(true)
    try {
      await flush()
      const token = ++generation.current
      const result: ProjectReceipt | null = await bridge.call('load', { project_id: id })
      if (!alive.current || token !== generation.current) return
      let next = result?.project ?? emptyProject(id)
      let revision = result?.revision ?? null
      if (asset) next = insertAsset(next, next.pages[0]!.id, asset)
      if (!result || asset) {
        const saved: ProjectReceipt = await bridge.call('save', { project_id: id, project: next, expected_revision: revision })
        revision = saved.revision
      }
      const loaded = await imageFiles(next)
      if (!alive.current || token !== generation.current) return
      // Keep the outgoing document/revision intact until the complete next project can be shown.
      state.current = { project: next, revision, dirty: false, blocked: false }
      setSceneLoad(value => value + 1)
      api.current = null; arrowGesture.current = null; selected.current = []; selectedElements.current = []; setSelectionCount(0); setActiveTool('selection'); setFiles(loaded); setProject(next); setPageId(next.pages[0]!.id); setRecovered(result?.recovered ?? false)
      setNotice(result?.recovered ? '已恢复上一份完整保存，损坏原件保留。请检查后保存。' : '已恢复项目')
      setError(null); if (asset) consumed.current?.(); void refreshList().catch(error => { if (alive.current) setError(error.message) })
    } finally { transitioning.current = false; if (alive.current) setSwitching(false) }
  }, [bridge, flush, imageFiles, refreshList])
  useEffect(() => {
    alive.current = true
    void openProject(initialProjectId, initialAsset).catch(error => { if (alive.current) setError(error.message) })
    const unload = (event: BeforeUnloadEvent) => { if (state.current.dirty) { event.preventDefault(); event.returnValue = '' } }
    addEventListener('beforeunload', unload)
    return () => { alive.current = false; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current); if (fitFrame.current !== undefined) cancelAnimationFrame(fitFrame.current); generation.current += 1; if (timer.current) clearTimeout(timer.current); removeEventListener('beforeunload', unload); void flush().catch(() => {}) }
  }, [initialProjectId, initialAsset, openProject, flush])

  const syncOutputs = useCallback(async () => {
    if (transitioning.current || syncLane.current || state.current.blocked || !state.current.project) return
    syncLane.current = true
    try {
      await flush()
      const original = state.current.project
      for (const pending of original.intents.filter(intent => intent.sessionId === bridge.sessionId)) {
        const result = await bridge.call('outputs', { project_id: original.id, intent_id: pending.id })
        let next = state.current.project
        if (transitioning.current || !next || next.id !== original.id) return
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
          update(next)
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
  useEffect(() => { if (project?.id && !switching) void syncOutputs() }, [project?.id, switching, syncOutputs])
  useEffect(() => {
    if (!page || !api.current) return
    if (!sameSceneElements(api.current.getSceneElementsIncludingDeleted(), page.elements)) {
      api.current.updateScene({ elements: page.elements as any })
    }
  }, [page])

  const submit = async () => {
    const current = state.current.project
    if (submitting.current || transitioning.current || !current || !instruction.trim()) return
    const target = current.pages.find(item => item.id === pageId)
    const selectedIds = [...selected.current]
    if (!target || selectedIds.length !== 1) { setError('请只选中一张要修改的图片。'); return }
    submitting.current = true; setBusy(true); setError(null)
    try {
      let next = structuredClone(current)
      const sourceIds = [...selectedIds]
      const elements = selectedAnnotationElements(target.elements, selectedElements.current)
      const annotated = elements.some(item => item.type === 'arrow' || item.type === 'text')
      if (annotated) {
        const blob = await exportToBlob({ elements: elements as any, appState: { viewBackgroundColor: '#ffffff', exportBackground: true }, files, mimeType: 'image/png' })
        const [preview] = await bridge.stageImages([new File([blob], '标注参考.png', { type: 'image/png' })])
        if (!preview) throw new Error('标注参考未保存，请重试。')
        if (state.current.project !== current || transitioning.current) throw new Error('画布已变化，请重新提交修改。')
        if (!next.assets.some(item => item.ref.attachmentId === preview.ref.attachmentId)) next.assets.push(preview)
        if (!sourceIds.includes(preview.ref.attachmentId)) sourceIds.push(preview.ref.attachmentId)
      }
      const intent: CanvasIntent = { id: fresh(), kind: 'edit', pageId, sessionId: bridge.sessionId, sourceIds, imported: [] }
      next.intents.push(intent)
      update(next); await flush()
      const roles = annotated
        ? `前 ${selectedIds.length} 张为待修改原图；最后一张为这些原图的箭头和文字标注参考。标注仅用于说明修改位置和要求，不要把标注添加到成品。未选中的图片不属于本次修改。\n`
        : '所附图片为待修改原图。\n'
      await bridge.submit(next, intent, roles + instruction.trim())
      setInstruction(''); setNotice('修改已提交')
    } catch (error) { setError((error as Error).message) }
    finally { submitting.current = false; setBusy(false) }
  }
  const addImages = async (incoming: File[]) => {
    const document = state.current.project
    if (transitioning.current || !document) return
    const targetPage = pageId
    const assets = await bridge.stageImages(incoming)
    let next = state.current.project
    if (transitioning.current || !next || next.id !== document.id || !next.pages.some(page => page.id === targetPage)) throw new Error('项目或目标页面已变化，图片仍保留在会话中。')
    for (const asset of assets) next = insertAsset(next, targetPage, asset)
    update(next); await flush()
    const loaded = await imageFiles(next); setFiles(loaded); api.current?.addFiles(Object.values(loaded))
    if (api.current) fitScene(api.current)
  }
  const exportImage = async () => {
    if (!state.current.project) return
    await flush()
    const item = state.current.project.pages.find(item => item.id === pageId)!
    const blob = await exportToBlob({ elements: item.elements as any, appState: { viewBackgroundColor: item.view.background, exportBackground: true }, files, mimeType: 'image/png' })
    download(`${state.current.project.id}-${item.id}.png`, blob)
  }
  const chooseTool = (tool: 'selection' | 'hand' | 'arrow' | 'text') => {
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
    arrowGesture.current = null
    if (tool === 'arrow') api.current?.updateScene({ appState: { currentItemStrokeColor: '#eb5b16' } })
    api.current?.setActiveTool({ type: tool }); setActiveTool(tool)
  }
  const act = (action: () => Promise<void> | void) => { void Promise.resolve().then(action).catch(error => setError(error.message)) }
  if (sessionId && sessionId !== bridge.sessionId) return <div className={css.empty}>此画布属于先前会话。<button onClick={() => act(async () => { await flush(); bridge.close() })}>保存并关闭</button></div>
  return <div className={css.panel} data-emate-canvas data-theme={theme}>
    {error && <div role="alert" className={css.error}>{error}<div>
      <button onClick={() => { if (state.current.project) download(`${state.current.project.id}-unsaved.json`, new Blob([JSON.stringify(state.current.project)], { type: 'application/json' })) }}>导出当前编辑</button>
      <button onClick={() => act(async () => { const id = state.current.project?.id ?? initialProjectId; state.current.dirty = false; state.current.blocked = false; await openProject(id) })}>放弃未保存编辑并重载</button>
    </div></div>}
    {!project || !page ? <div className={css.empty}>{error ? '项目原件保留，可重新载入。' : notice}</div> : <fieldset disabled={switching || busy} className={css.content}>
      <header className={css.header}>
        <select aria-label="选择项目" value={project.id} onChange={event => { const id = event.target.value; act(() => openProject(id)) }}>
          {!projects.some(item => item.id === project.id) && <option value={project.id}>{project.title}</option>}
          {projects.map(item => <option key={item.id} value={item.id}>{item.title}{item.error ? ' · 无法载入' : ''}</option>)}
        </select>
        {project.pages.length > 1 && <select aria-label="选择画布页" value={pageId} onChange={event => { arrowGesture.current = null; selected.current = []; selectedElements.current = []; setSelectionCount(0); setPageId(event.target.value) }}>
          {project.pages.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>}
        <span className={css.saveState} role="status">{switching ? '正在载入…' : saving ? '保存中…' : recovered ? '已恢复备份' : notice}</span>
        <button onClick={() => imageInput.current?.click()}>添加图片</button>
        <button onClick={() => act(exportImage)}>导出 PNG</button>
        <details className={css.more}><summary aria-label="更多画布操作">更多</summary><div className={css.moreMenu}>
          <label>名称<input aria-label="项目名称" value={project.title} maxLength={120} onChange={event => { if (event.target.value.trim()) update({ ...project, title: event.target.value }) }} /></label>
          <button onClick={() => act(() => openProject(fresh()))}>新项目</button>
          <button disabled={saving} onClick={() => act(async () => { state.current.blocked = false; state.current.dirty = true; await flush(); await refreshList() })}>{recovered ? '保存恢复副本' : '保存'}</button>
          <button onClick={() => act(async () => { await flush(); const result = await bridge.call('export', { project_id: project.id }); download(result.name, new Blob([bytesOf(result.archive_base64).slice().buffer], { type: 'application/zip' })) })}>导出项目与素材</button>
          <button onClick={() => importInput.current?.click()}>导入项目</button>
        </div></details>
      </header>
      <input hidden ref={imageInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
        const incoming = Array.from(event.target.files ?? []); event.target.value = ''
        if (incoming.length) act(() => addImages(incoming))
      }} />
      <input hidden ref={importInput} type="file" accept=".zip" onChange={event => { const file = event.target.files?.[0]; if (!file) return; act(async () => { if (file.size > 100 * 1024 * 1024) throw new Error('项目压缩包超过 100 MiB。'); await flush(); const id = fresh(); const result = await bridge.call('import', { project_id: id, archive_base64: base64(new Uint8Array(await file.arrayBuffer())) }); await openProject(result.project.id) }); event.target.value = '' }} />
      <div className={css.stage} onPointerCancelCapture={() => { arrowGesture.current = null; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current) }} onContextMenuCapture={event => { event.preventDefault(); event.stopPropagation() }}
        onKeyDownCapture={event => {
          if (event.key === 'Escape') { arrowGesture.current = null; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current) }
          if ((event.target as HTMLElement).closest('input,textarea,[contenteditable=true]') || event.ctrlKey || event.metaKey || event.altKey) return
          if (['r', 'd', 'o', 'l', 'p', 'f', 'e', '2', '3', '4', '6', '7', '9', '0'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation() }
        }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDropCapture={event => {
          if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); act(() => addImages(Array.from(event.dataTransfer.files))) }
        }}>
        <div className={css.tools} role="toolbar" aria-label="图片标注工具">
          {([['selection', '选择'], ['hand', '平移'], ['arrow', '箭头'], ['text', '文字']] as const).map(([tool, title]) => <button key={tool} aria-pressed={activeTool === tool} onClick={() => chooseTool(tool)}>{title}</button>)}
        </div>
        {page.elements.every(item => item.isDeleted) && <div className={css.stageHint}>添加图片，或从画廊加入图片</div>}
        <Excalidraw key={`${project.id}:${page.id}:${sceneLoad}`} theme={theme}
          excalidrawAPI={value => { api.current = value; fitScene(value, page.view.zoom) }}
          initialData={{ elements: page.elements as any, files, appState: { scrollX: page.view.scrollX, scrollY: page.view.scrollY, zoom: { value: page.view.zoom as any }, viewBackgroundColor: page.view.background, currentItemFontFamily: 2, currentItemFontSize: 16, currentItemRoughness: 0, currentItemStrokeColor: '#eb5b16' } }}
          viewModeEnabled={switching || busy} langCode="zh-CN" validateEmbeddable={() => false}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, changeViewBackgroundColor: false }, tools: { image: false } }}
          onLinkOpen={(element, event) => { event.preventDefault(); if (element.link && /^https?:\/\//u.test(element.link)) window.open(element.link, '_blank', 'noopener,noreferrer') }}
          onPaste={() => false}
          onPointerDown={(tool, pointer) => {
            if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
            if (tool.type === 'arrow' && !arrowGesture.current) arrowGesture.current = { previous: new Set(pointer.originalElements.keys()), released: false }
            else if (tool.type !== 'arrow') arrowGesture.current = null
            if (arrowGesture.current) arrowGesture.current.released = false
          }}
          onPointerUp={() => { if (arrowGesture.current) arrowGesture.current.released = true }}
          onChange={(elements, appState) => {
            const chosen = elements.filter(item => item.type === 'image' && !item.isDeleted && appState.selectedElementIds[item.id])
            selectedElements.current = chosen.map(item => item.id)
            selected.current = chosen.map(item => `sha256:${(item as any).fileId}`)
            setSelectionCount(selected.current.length)
            if (['selection', 'hand', 'arrow', 'text'].includes(appState.activeTool?.type)) setActiveTool(appState.activeTool.type)
            if (transitioning.current || busy) return
            const gesture = arrowGesture.current
            if (gesture?.released && !appState.newElement && !appState.multiElement) {
              arrowGesture.current = null
              const arrows = elements.filter(item => item.type === 'arrow' && !item.isDeleted && !gesture.previous.has(item.id))
              const arrow = arrows.length === 1 ? arrows[0] : undefined
              const image = arrow && arrowImageTarget(elements as any, arrow as any)
              if (image && arrow) {
                const value = api.current
                focusFrame.current = requestAnimationFrame(() => {
                  if (!alive.current || transitioning.current || api.current !== value || !value) return
                  value.updateScene({ appState: { selectedElementIds: { [String(image.id)]: true, [arrow.id]: true } } })
                  selectedElements.current = [String(image.id)]; selected.current = [`sha256:${image.fileId}`]; setSelectionCount(1)
                  instructionInput.current?.focus({ preventScroll: true })
                })
              }
            }
            const current = state.current.project
            const existing = current?.pages.find(item => item.id === page.id)
            if (!current || !existing || current.id !== project.id) return
            const next = scenePage(existing, elements as any, appState)
            if (next !== existing) update({ ...current, pages: current.pages.map(item => item.id === page.id ? next : item) })
          }}><MainMenu /></Excalidraw>
      </div>
      <div className={css.ai}>
        <textarea ref={instructionInput} aria-label="图片修改需求" placeholder={selectionCount === 1 ? '描述如何修改选中的图片…' : '选中一张图片后，描述修改要求…'} value={instruction} maxLength={18000} onChange={event => setInstruction(event.target.value)} />
        <button disabled={busy || selectionCount !== 1 || !instruction.trim() || !!error} onClick={() => act(submit)}>{busy ? '提交中…' : '修改图片'}</button>
      </div>
    </fieldset>}
  </div>
}
