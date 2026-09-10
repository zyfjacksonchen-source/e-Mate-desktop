import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, MainMenu, exportToBlob, convertToExcalidrawElements, newElementWith, sceneCoordsToViewportCoords, CaptureUpdateAction } from '@excalidraw/excalidraw'
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
  const visiblePageId = useRef(pageId)
  visiblePageId.current = pageId
  const [projects, setProjects] = useState<any[]>([])
  const [legacyProjects, setLegacyProjects] = useState<any[] | null>(null)
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
  const [arrowColor, setArrowColor] = useState('#1e1e1e')
  const [selectionCount, setSelectionCount] = useState(0)
  const submitting = useRef(false)
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const applyingScene = useRef(false)
  const state = useRef<{ project: CanvasProject | null; revision: string | null; dirty: boolean; blocked: boolean }>({ project: null, revision: null, dirty: false, blocked: false })
  const lane = useRef(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const generation = useRef(0)
  const selected = useRef<string[]>([])
  const selectedElements = useRef<string[]>([])
  const syncLane = useRef(false)
  // Output receipt deduplication must not discard a failed image hydration retry.
  const pendingHydration = useRef(false)
  const hydrated = useRef<{ bridge: CanvasBridge; projectId: string; generation: number; entries: Map<string, BinaryFiles[string]> } | undefined>(undefined)
  const instructionInput = useRef<HTMLTextAreaElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [annotation, setAnnotation] = useState<{ arrowId: string; textId: string; x: number; y: number; left: number; top: number; value: string; error?: string } | null>(null)
  const annotationInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (annotation) annotationInput.current?.focus({ preventScroll: true }) }, [annotation?.arrowId])
  useEffect(() => { setAnnotation(null); setArrowColor('#1e1e1e') }, [pageId, project?.id])
  const arrowGesture = useRef<{ previous: Set<string>; released: boolean; imageOrder: string[]; preferredImageId: string | undefined } | null>(null)
  const focusFrame = useRef<number | undefined>(undefined)
  const fitFrame = useRef<number | undefined>(undefined)
  const pendingFit = useRef<{ api: ExcalidrawImperativeAPI; generation: number } | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const page = project?.pages.find(item => item.id === pageId)

  const scheduleFit = () => {
    const pending = pendingFit.current
    if (!pending || fitFrame.current !== undefined) return
    const ready = () => {
      const view = pending.api.getAppState()
      return alive.current && api.current === pending.api && generation.current === pending.generation
        && view.isLoading === false && view.width > 0 && view.height > 0
    }
    if (!ready()) return
    fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = undefined
      if (pendingFit.current !== pending || !ready()) return
      pendingFit.current = null
      // Fit the current viewport, not a previous (possibly broken) saved zoom cap.
      pending.api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.82, maxZoom: 1, animate: false })
    })
  }
  const fitScene = (value: ExcalidrawImperativeAPI, waitForInitialChange = false) => {
    if (fitFrame.current !== undefined) cancelAnimationFrame(fitFrame.current)
    fitFrame.current = undefined
    pendingFit.current = { api: value, generation: generation.current }
    // 0.18.1 exposes its API in the constructor, before updateDOMRect/initializeScene.
    // Its first non-loading onChange is the native initial scene readiness signal.
    if (!waitForInitialChange) scheduleFit()
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
    const incoming = next.pages.find(item => item.id === visiblePageId.current)
    // Native componentDidUpdate reports its imperative scene before parent effects.
    // Publish external inserts to that scene first, so an old callback cannot undo
    // the insert and start an old/new scene feedback loop on the next commit.
    if (incoming && api.current && !sameSceneElements(api.current.getSceneElementsIncludingDeleted(), incoming.elements)) {
      applyingScene.current = true
      try { api.current.updateScene({ elements: incoming.elements as any }) }
      finally { applyingScene.current = false }
    }
    state.current.project = next; state.current.dirty = true; setProject(next); setNotice('尚未保存')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { if (!state.current.blocked) void flush().catch(() => {}) }, 400)
  }, [flush])
  const imageFiles = useCallback(async (document: CanvasProject): Promise<BinaryFiles> => {
    const epoch = generation.current
    let cache = hydrated.current
    if (!cache || cache.bridge !== bridge || cache.projectId !== document.id || cache.generation !== epoch) {
      cache = { bridge, projectId: document.id, generation: epoch, entries: new Map() }
      hydrated.current = cache
    }
    const currentCache = cache
    const check = () => {
      if (!alive.current || generation.current !== epoch || hydrated.current !== currentCache) throw new Error('画布已切换，未显示迟到的素材。')
    }
    const loaded: BinaryFiles = {}
    const keys = new Set<string>()
    // Reuse only this mounted project's verified files. Reloads, project/account
    // changes and unmount discard them; the Host still authorizes every new read.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, document.assets.length) }, async () => {
      while (next < document.assets.length) {
        check()
        const asset = document.assets[next++]!
        const key = JSON.stringify([asset.ownerSessionId, asset.ref.attachmentId, asset.ref.mediaType, asset.ref.bytes, asset.ref.width, asset.ref.height, asset.ref.name])
        keys.add(key)
        const id = asset.ref.attachmentId.slice(7)
        const known = currentCache.entries.get(key)
        if (known) { loaded[id] = known; continue }
        const result = await bridge.call('image', { project_id: document.id, attachment_id: asset.ref.attachmentId })
        check()
        const bytes = bytesOf(result.bytes_base64)
        if (`sha256:${await digest(bytes)}` !== asset.ref.attachmentId || bytes.byteLength !== asset.ref.bytes) throw new Error('素材已损坏，未在画布显示。')
        check()
        const file = { id: id as any, mimeType: asset.ref.mediaType as any, dataURL: `data:${asset.ref.mediaType};base64,${base64(bytes)}` as any, created: 0 }
        currentCache.entries.set(key, file); loaded[id] = file
      }
    }))
    check()
    for (const key of currentCache.entries.keys()) if (!keys.has(key)) currentCache.entries.delete(key)
    return loaded
  }, [bridge])
  const openProject = useCallback(async (id: string, asset?: CanvasAsset) => {
    if (transitioning.current) return
    transitioning.current = true; setSwitching(true)
    try {
      await flush()
      const token = ++generation.current
      hydrated.current = undefined
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
      pendingHydration.current = false
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
    const identity = () => { pendingHydration.current = false; hydrated.current = undefined; pendingFit.current = null; arrowGesture.current = null; generation.current += 1 }
    addEventListener('beforeunload', unload); addEventListener('emate:identity-changed', identity)
    return () => { alive.current = false; hydrated.current = undefined; pendingFit.current = null; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current); if (fitFrame.current !== undefined) cancelAnimationFrame(fitFrame.current); generation.current += 1; if (timer.current) clearTimeout(timer.current); removeEventListener('beforeunload', unload); removeEventListener('emate:identity-changed', identity); void flush().catch(() => {}) }
  }, [initialProjectId, initialAsset, openProject, flush])

  const syncOutputs = useCallback(async () => {
    if (transitioning.current || syncLane.current || state.current.blocked || !state.current.project) return
    syncLane.current = true
    try {
      await flush()
      const original = state.current.project
      let imported = false
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
            next = insertAsset(next, intent.pageId, asset, intent.kind === 'edit' ? intent.sourceIds[0] : undefined)
            next.intents.find(item => item.id === intent.id)!.imported.push(hash)
            update(next); imported = true; pendingHydration.current = true
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
          update(next); imported = true; pendingHydration.current = true
        }
      }
      if ((imported || pendingHydration.current) && state.current.project) {
        await flush(); const token = generation.current; const loaded = await imageFiles(state.current.project)
        if (alive.current && generation.current === token && state.current.project?.id === original.id) { setFiles(loaded); api.current?.addFiles(Object.values(loaded)); pendingHydration.current = false; setNotice('原生任务的成功产物已插入，已有素材已去重。') }
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

  const submit = async () => {
    const current = state.current.project
    if (submitting.current || transitioning.current || !current) return
    const target = current.pages.find(item => item.id === pageId)
    const selectedIds = [...selected.current]
    if (!target || selectedIds.length !== 1) { setError('请只选中一张要修改的图片。'); return }
    const marks = selectedAnnotationElements(target.elements, selectedElements.current)
    const labelText = marks.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => typeof item.originalText === 'string' ? item.originalText : item.text).join('\n').trim()
    const request = instruction.trim() || labelText
    if (!request) { setNotice('请在箭头旁填写修改要求，或补充文字说明。'); return }
    setAnnotation(null)
    submitting.current = true; setBusy(true); setError(null)
    try {
      let next = structuredClone(current)
      const sourceIds = [...selectedIds]
      const elements = selectedAnnotationElements(target.elements, selectedElements.current)
      const annotated = elements.some(item => item.type === 'arrow' || item.type === 'text')
      if (annotated) {
        setNotice('正在导出标注参考…')
        const blob = await exportToBlob({ elements: elements as any, appState: { viewBackgroundColor: '#ffffff', exportBackground: true }, files, mimeType: 'image/png' })
        setNotice('正在将标注参考加入会话…')
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
      setNotice('正在提交修改…')
      await bridge.submit(next, intent, roles + request)
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
    const token = generation.current
    const loaded = await imageFiles(next)
    if (!alive.current || generation.current !== token || transitioning.current || state.current.project?.id !== document.id) return
    setFiles(loaded); api.current?.addFiles(Object.values(loaded))
    if (api.current) fitScene(api.current)
  }
  const exportImage = async () => {
    if (!state.current.project) return
    await flush()
    const item = state.current.project.pages.find(item => item.id === pageId)!
    const blob = await exportToBlob({ elements: item.elements as any, appState: { viewBackgroundColor: item.view.background, exportBackground: true }, files, mimeType: 'image/png' })
    download(`${state.current.project.id}-${item.id}.png`, blob)
  }
  const writeAnnotation = (value: string) => {
    if (!annotation || !api.current || !state.current.project || transitioning.current) return
    const current = state.current.project
    const target = current.pages.find(item => item.id === pageId)
    if (!target) return
    const arrow = target.elements.find(item => item.id === annotation.arrowId)
    const image = arrow && arrowImageTarget(target.elements, arrow)
    if (!image) return
    const zoom = api.current.getAppState().zoom.value
    const padding = Math.min(12 / zoom, Number(image.width) / 10)
    const width = Math.min(240 / zoom, Number(image.width) - padding * 2)
    const boxId = `${annotation.textId}-box`
    const generated = convertToExcalidrawElements([{ type: 'rectangle', id: boxId,
      x: annotation.x, y: annotation.y, width, height: 40 / zoom,
      backgroundColor: '#ffffff', fillStyle: 'solid', strokeColor: '#1e1e1e', strokeWidth: 1,
      roughness: 0, roundness: { type: 3 },
      label: { text: value || ' ', fontSize: 20 / zoom, fontFamily: 2,
        strokeColor: '#1e1e1e', textAlign: 'left', verticalAlign: 'middle',
        customData: { emateAnnotationArrowId: annotation.arrowId } },
    }], { regenerateIds: false })
    const box = generated.find(item => item.id === boxId)!
    if (value.trim() && (box.width > Number(image.width) - padding * 2 || box.height > Number(image.height) - padding * 2)) {
      setAnnotation({ ...annotation, value, error: '图片内放不下此标注。请缩短标注，或复制完整文字到下方修改需求。按 Esc 取消本次输入并保留上次标注。' })
      return
    }
    const x = Math.max(Number(image.x) + padding, Math.min(annotation.x, Number(image.x) + Number(image.width) - box.width - padding))
    const y = Math.max(Number(image.y) + padding, Math.min(annotation.y, Number(image.y) + Number(image.height) - box.height - padding))
    const labels = generated.map(generatedItem => {
      const item = generatedItem.type === 'text'
        ? { ...generatedItem, id: annotation.textId }
        : { ...generatedItem, boundElements: [{ id: annotation.textId, type: 'text' as const }] }
      const prior = target.elements.find(element => element.id === item.id)
      const changes = { ...item, x: item.x + x - box.x, y: item.y + y - box.y, isDeleted: !value.trim() }
      return prior ? newElementWith(prior as any, changes as any) : changes
    })
    const ids = new Set(labels.map(item => item.id))
    const elements = [...target.elements.filter(item => !ids.has(String(item.id))), ...labels]
    update({ ...current, pages: current.pages.map(item => item.id === pageId ? { ...item, elements: elements as any } : item) })
    api.current.updateScene({ elements: elements as any, captureUpdate: CaptureUpdateAction.EVENTUALLY })
    setAnnotation({ ...annotation, value, error: undefined })
  }
  const chooseTool = (tool: 'selection' | 'hand' | 'arrow' | 'text') => {
    if (annotation?.error) { annotationInput.current?.focus(); return }
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
    arrowGesture.current = null
    setAnnotation(null)
    if (tool === 'arrow') api.current?.updateScene({ appState: { currentItemStrokeColor: arrowColor, currentItemStrokeWidth: 4 } })
    api.current?.setActiveTool({ type: tool }); setActiveTool(tool)
  }
  const act = (action: () => Promise<void> | void) => { void Promise.resolve().then(action).catch(error => { if (alive.current) setError(error.message) }) }
  if (sessionId && sessionId !== bridge.sessionId) return <div className={css.empty}>此画布属于先前会话。<button onClick={() => act(async () => { await flush(); bridge.close() })}>保存并关闭</button></div>
  return <div className={css.panel} data-emate-canvas data-theme={theme}>
    {annotation?.error && <div role="alert" className={css.error}>{annotation.error}</div>}
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
          <button onClick={() => act(async () => { setLegacyProjects(await bridge.call('legacy-list')) })}>从旧工作区画布导入</button>
          {legacyProjects?.length === 0 && <span>没有旧工作区画布。</span>}
          {legacyProjects?.map(item => <button key={item.id} disabled={Boolean(item.error)} onClick={() => act(async () => {
            await flush()
            const id = fresh()
            await bridge.call('import-legacy', { legacy_project_id: item.id, project_id: id })
            await openProject(id)
            setLegacyProjects(null)
          })}>导入「{item.title}」副本</button>)}
        </div></details>
      </header>
      <input hidden ref={imageInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
        const incoming = Array.from(event.target.files ?? []); event.target.value = ''
        if (incoming.length) act(() => addImages(incoming))
      }} />
      <input hidden ref={importInput} type="file" accept=".zip" onChange={event => { const file = event.target.files?.[0]; if (!file) return; act(async () => { if (file.size > 100 * 1024 * 1024) throw new Error('项目压缩包超过 100 MiB。'); await flush(); const id = fresh(); const result = await bridge.call('import', { project_id: id, archive_base64: base64(new Uint8Array(await file.arrayBuffer())) }); await openProject(result.project.id) }); event.target.value = '' }} />
      <div ref={stageRef} className={css.stage} onPointerCancelCapture={() => { arrowGesture.current = null; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current) }} onContextMenuCapture={event => { event.preventDefault(); event.stopPropagation() }}
        onKeyDownCapture={event => {
          if (event.key === 'Escape') { setAnnotation(null); arrowGesture.current = null; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current) }
          if ((event.target as HTMLElement).closest('input,textarea,[contenteditable=true]') || event.ctrlKey || event.metaKey || event.altKey) return
          if (['r', 'd', 'o', 'l', 'p', 'f', 'e', '2', '3', '4', '6', '7', '9', '0'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation() }
        }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDropCapture={event => {
          if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); act(() => addImages(Array.from(event.dataTransfer.files))) }
        }}>
        <div className={css.tools} role="toolbar" aria-label="图片标注工具">
          {([['selection', '选择'], ['hand', '平移'], ['arrow', '箭头'], ['text', '文字']] as const).map(([tool, title]) => <button key={tool} aria-pressed={activeTool === tool} onClick={() => chooseTool(tool)}>{title}</button>)}
          <label className={css.arrowColor} title="箭头颜色"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M5 19 19 5M7 5h12v12" /></svg><input type="color" aria-label="箭头颜色" title="箭头颜色" value={arrowColor} onChange={event => {
            const color = event.target.value
            setArrowColor(color)
            const editor = api.current
            if (!editor) return
            const elements = editor.getSceneElementsIncludingDeleted().map(item => item.type === 'arrow' && editor.getAppState().selectedElementIds[item.id]
              ? newElementWith(item, { strokeColor: color }) : item)
            editor.updateScene({ elements, appState: { currentItemStrokeColor: color }, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
          }} /></label>
        </div>
        {annotation && <textarea ref={annotationInput} className={css.annotation} aria-label="箭头标注要求" placeholder="输入修改要求…" maxLength={2000}
          style={{ left: annotation.left, top: annotation.top }} value={annotation.value} aria-invalid={!!annotation.error}
          onChange={event => writeAnnotation(event.target.value)}
          onBlur={() => { if (!annotation.error) setAnnotation(null) }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!annotation.error) setAnnotation(null) } }} />}
        {page.elements.every(item => item.isDeleted) && <div className={css.stageHint}>添加图片，或从画廊加入图片</div>}
        <Excalidraw key={`${project.id}:${page.id}:${sceneLoad}`} theme={theme}
          excalidrawAPI={value => { api.current = value; fitScene(value, true) }}
          initialData={{ elements: page.elements as any, files, appState: { scrollX: page.view.scrollX, scrollY: page.view.scrollY, zoom: { value: page.view.zoom as any }, viewBackgroundColor: page.view.background, currentItemFontFamily: 2, currentItemFontSize: 16, currentItemRoughness: 0, currentItemStrokeColor: '#1e1e1e', currentItemStrokeWidth: 4 } }}
          viewModeEnabled={switching || busy} langCode="zh-CN" validateEmbeddable={() => false}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, changeViewBackgroundColor: false }, tools: { image: false } }}
          onLinkOpen={(element, event) => { event.preventDefault(); if (element.link && /^https?:\/\//u.test(element.link)) window.open(element.link, '_blank', 'noopener,noreferrer') }}
          onPaste={() => false}
          onPointerDown={(tool, pointer) => {
            if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
            if (tool.type === 'arrow' && !arrowGesture.current) arrowGesture.current = {
              previous: new Set(pointer.originalElements.keys()), released: false,
              imageOrder: [...pointer.originalElements.values()].filter(item => item.type === 'image' && !item.isDeleted).map(item => item.id).reverse(),
              preferredImageId: pointer.hit?.element?.type === 'image' ? pointer.hit.element.id
                : selectedElements.current.length === 1 ? selectedElements.current[0] : undefined,
            }
            else if (tool.type !== 'arrow') arrowGesture.current = null
            if (arrowGesture.current) arrowGesture.current.released = false
          }}
          onPointerUp={() => { if (arrowGesture.current) arrowGesture.current.released = true }}
          onChange={(elements, appState) => {
            if (applyingScene.current) return
            scheduleFit()
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
              let image = arrow && arrowImageTarget(elements as any, arrow as any)
              if (arrow && !image) {
                // Overlapping imported images are drawn in scene order. Resolve only
                // endpoint hits, preferring the gesture's explicit image then its topmost layer.
                const candidates = [gesture.preferredImageId, ...gesture.imageOrder]
                for (const id of candidates) {
                  const candidate = elements.find(item => item.id === id && item.type === 'image' && !item.isDeleted)
                  if (candidate && arrowImageTarget([candidate] as any, arrow as any)) { image = candidate as any; break }
                }
              }
              if (image && arrow) {
                const value = api.current
                const epoch = generation.current
                focusFrame.current = requestAnimationFrame(() => {
                  if (!alive.current || transitioning.current || generation.current !== epoch || api.current !== value || !value) return
                  value.updateScene({ appState: { selectedElementIds: { [String(image.id)]: true } } })
                  selectedElements.current = [String(image.id)]; selected.current = [`sha256:${image.fileId}`]; setSelectionCount(1)
                  const points = (arrow as any).points as number[][]
                  const first = points[0]!, last = points.at(-1)!
                  const dx = last[0]! - first[0]!, dy = last[1]! - first[1]!, length = Math.hypot(dx, dy)
                  if (length * appState.zoom.value < 8) return
                  const bend = Math.min(48, Math.max(16, length * .12))
                  const curved = newElementWith(arrow as any, { points: [first, [(first[0]! + last[0]!) / 2 - dy / length * bend, (first[1]! + last[1]!) / 2 + dx / length * bend], last], roundness: { type: 2 }, strokeColor: arrow.strokeColor ?? arrowColor, strokeWidth: Math.max(4, 3 / appState.zoom.value) } as any)
                  value.updateScene({ elements: value.getSceneElementsIncludingDeleted().map(item => item.id === arrow.id ? curved : item), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
                  const x = arrow.x + first[0]!, y = arrow.y + first[1]! - 48 / value.getAppState().zoom.value
                  const point = sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, value.getAppState())
                  const rect = stageRef.current?.getBoundingClientRect()
                  setAnnotation({ arrowId: arrow.id, textId: fresh(), x, y, left: Math.max(8, Math.min(point.x - (rect?.left ?? 0), (rect?.width ?? 400) - 248)), top: Math.max(8, point.y - (rect?.top ?? 0)), value: '' })
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
        <textarea ref={instructionInput} aria-label="图片修改需求" placeholder={selectionCount === 1 ? '补充修改要求（已有标注时可不填）…' : '选中一张图片后，描述修改要求…'} value={instruction} maxLength={18000} onChange={event => setInstruction(event.target.value)} />
        <button disabled={busy || !!annotation?.error || selectionCount !== 1 || (!instruction.trim() && !selectedAnnotationElements(page.elements, selectedElements.current).some(item => item.type === 'text' && String(item.text ?? '').trim())) || !!error} onClick={() => act(submit)}>{busy ? '提交中…' : '按标注修改'}</button>
      </div>
    </fieldset>}
  </div>
}
