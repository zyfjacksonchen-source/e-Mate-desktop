import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createHash, webcrypto } from 'node:crypto'
import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyPage, emptyProject, validateProject } from '../src/contract.ts'
import { arrowImageTarget, htmlDocument, insertAsset, pagesFromHtml, sameSceneElements, scenePage, selectedAnnotationElements } from '../src/client/model.ts'
import { createBridge } from '../src/client/bridge.ts'
const native = vi.hoisted(() => ({ props: null as any, api: null as any, scroll: vi.fn(), deferReady: false, reportCommits: false, commits: 0, emit: null as any }))
vi.mock('@excalidraw/excalidraw', () => {
  const MainMenu: any = ({ children }: any) => <div>{children}</div>
  MainMenu.DefaultItems = { ClearCanvas: () => null, ToggleTheme: () => null }
  return { MainMenu, exportToBlob: vi.fn(async () => new Blob(['png'])), Excalidraw: (props: any) => {
    native.props = props
    const elements = useRef(props.initialData.elements); const [, refresh] = useState(0)
    const view = useRef({ ...props.initialData.appState, width: 1280, height: 800, isLoading: true, selectedElementIds: {}, activeTool: { type: 'selection' } })
    useEffect(() => {
      native.emit = (next: any, nextElements = elements.current) => {
        view.current = { ...view.current, ...next }; elements.current = nextElements
        if (!view.current.isLoading) props.onChange(elements.current, view.current)
      }
      props.excalidrawAPI(native.api = { getAppState: () => view.current, getSceneElementsIncludingDeleted: () => elements.current,
      updateScene: ({ elements: next }: any) => { if (next) elements.current = next; refresh(value => value + 1) }, addFiles: vi.fn(), scrollToContent: native.scroll, setActiveTool: ({ type }: any) => props.onChange(elements.current, { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff', selectedElementIds: {}, activeTool: { type } }),
      })
      if (!native.deferReady) native.emit({ isLoading: false })
    }, [])
    useLayoutEffect(() => {
      if (native.reportCommits && !view.current.isLoading) {
        native.commits += 1
        // 0.18.1 componentDidUpdate reports the imperative scene, not initialData.
        if (native.commits > 60) throw new Error('native scene commit loop')
        props.onChange(elements.current, view.current)
      }
    })
    return <div data-testid="scene" data-theme={props.theme}><span>{elements.current.length} elements</span><button onClick={() => {
      elements.current = [...elements.current, { id: 'mark', type: 'arrow', x: 1, y: 1, points: [[0, 0], [10, 10]] }]
      props.onChange(elements.current, { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff', selectedElementIds: {} })
    }}>Draw mark</button><button onClick={() => props.onChange(elements.current, { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff', selectedElementIds: Object.fromEntries(elements.current.filter((item: any) => item.type === 'image').slice(0, 1).map((item: any) => [item.id, true])) })}>Select image</button></div>
  } }
})
import { CanvasPanel } from '../src/client/editor.tsx'
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); native.scroll.mockClear(); native.deferReady = false; native.reportCommits = false; native.commits = 0 })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const imageAsset = { ownerSessionId: 'parent', ref: { attachmentId: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`, mediaType: 'image/png', bytes: imageBytes.length, width: 100, height: 100 } }
function harness(initial = emptyProject('main')) {
  let document = structuredClone(initial), revision = 'a'.repeat(64), leave = async () => {}
  const calls: any[] = []
  const bridge = { sessionId: 'parent', close: vi.fn(), submit: vi.fn(async () => {}), stageImages: vi.fn(async () => []),
    beforeLeave: (handler: () => Promise<void>) => { leave = handler; return () => {} }, subscribe: () => () => {},
    call: vi.fn(async (endpoint: string, payload: any = {}) => {
      calls.push([endpoint, payload])
      if (endpoint === 'load') return { project: structuredClone(document), revision, recovered: false }
      if (endpoint === 'list') return [{ id: 'main', title: document.title, recovered: false }]
      if (endpoint === 'image') return { bytes_base64: imageBytes.toString('base64'), ref: imageAsset.ref }
      if (endpoint === 'outputs') return { kind: 'images', assets: [] }
      if (endpoint !== 'save') throw new Error('unexpected endpoint ' + endpoint)
      if (payload.expected_revision !== revision) throw Object.assign(new Error('another window changed the project'), { code: 'conflict' })
      document = structuredClone(payload.project); revision = (revision[0] === 'a' ? 'b' : 'a').repeat(64)
      return { project: structuredClone(document), revision, recovered: false }
    }) }
  return { bridge, calls, read: () => document, leave: () => leave(), conflict: () => { revision = 'f'.repeat(64) } }
}
it('MVP marks save without changing hidden pages, slides or HTML', async () => {
  const initial = emptyProject('main')
  initial.pages.push({ ...emptyPage('old-page', 'Existing page'), html: '<h1>preserve me</h1>', slide: true })
  const h = harness(initial); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); fireEvent.click(screen.getByText('Draw mark'))
  await act(async () => { await h.leave() })
  expect(h.read().pages).toHaveLength(2); expect(h.read().pages[0].elements).toHaveLength(1)
  expect(h.read().pages[1]).toEqual(initial.pages[1])
  expect(screen.queryByRole('button', { name: '新增页面' })).toBeNull()
  expect(screen.queryByRole('button', { name: '导出幻灯片' })).toBeNull()
  expect(screen.queryByLabelText('HTML 页面内容')).toBeNull()
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Updated' } })
  await act(async () => { await h.leave() })
  expect(h.read().title).toBe('Updated')
  expect(h.read().pages[1]).toEqual(initial.pages[1])
})
it('conflict keeps local edits and refuses silent replacement', async () => {
  const h = harness(); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); h.conflict(); fireEvent.click(screen.getByText('Draw mark')); fireEvent.click(screen.getByText('保存'))
  await screen.findByRole('alert'); expect(screen.getByTestId('scene').textContent).toContain('1 elements')
  expect(h.read().pages[0].elements).toHaveLength(0); expect(h.bridge.close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('放弃未保存编辑并重载'))
  await waitFor(() => expect(screen.getByTestId('scene').textContent).toContain('0 elements'))
  fireEvent.click(screen.getByText('Draw mark'))
  await act(async () => { await h.leave() })
  expect(h.read().pages[0].elements).toHaveLength(1)
})
it('image modification saves the exact source binding then submits once', async () => {
  const h = harness(insertAsset(emptyProject('main'), 'page-1', imageAsset))
  render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); fireEvent.click(screen.getByText('Select image'))
  fireEvent.change(screen.getByLabelText('图片修改需求'), { target: { value: '换成蓝色背景' } })
  fireEvent.click(screen.getByRole('button', { name: '修改图片' }))
  await waitFor(() => expect(h.bridge.submit).toHaveBeenCalledOnce())
  expect(h.read().intents[0]).toMatchObject({ kind: 'edit', sourceIds: [imageAsset.ref.attachmentId], sessionId: 'parent', imported: [] })
  expect(h.read().intents[0]).not.toHaveProperty('status')
  expect(screen.queryByText('生成成功')).toBeNull()
})
it('MVP never mounts legacy HTML while preserving the saved contents', async () => {
  const project = emptyProject('main'); project.pages[0].html = '<script>window.hostAttacked=true</script><a href="https://example.test">link</a>'
  const h = harness(project); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  expect(document.querySelector('iframe')).toBeNull()
  expect(screen.queryByRole('button', { name: 'HTML 预览' })).toBeNull()
  fireEvent.click(screen.getByText('Draw mark'))
  await act(async () => { await h.leave() })
  expect(h.read().pages[0].html).toBe(project.pages[0].html)
  expect((window as any).hostAttacked).toBeUndefined()
  const pages = pagesFromHtml('<style>h1{color:red}</style><section data-slide data-title="A">A</section><section data-slide>B</section>', 'slides')
  expect(pages).toHaveLength(2); expect(pages[0].title).toBe('A'); expect(document.querySelector('section[data-slide]')).toBeNull()
  expect(htmlDocument('</head><script>alert(1)</script>')).not.toContain('allow-same-origin')
})
it('native bridge leaves composer draft intact and uses Session.prompt queue', async () => {
  const prompt = vi.fn(async (..._args: any[]) => ({ ok: true, value: { accepted: true } }))
  const input = { draft: 'existing draft' }
  const ctx = { sessions: { binding: () => ({ session: { prompt, subscribe: () => () => {} } }), list: { subscribe: () => () => {} } }, connection: { rpc: { call: vi.fn() } }, conversation: { input } }
  const bridge = createBridge(ctx, 'parent', () => {}, () => () => {})
  await bridge.submit(emptyProject('main'), { id: 'request', pageId: 'page-1', kind: 'image', sessionId: 'parent', sourceIds: [], imported: [] }, 'draw')
  expect(prompt).toHaveBeenCalledOnce(); expect(prompt.mock.calls[0][1]).toBe('queue'); expect(input.draft).toBe('existing draft'); expect(ctx.connection.rpc.call).not.toHaveBeenCalled()
})
it('accepts native nanoid element IDs without loosening project filename validation', () => {
  const project = emptyProject('main')
  project.pages[0].elements = [{ id: '_native-id', type: 'rectangle' }, { id: '-native-id', type: 'text' }]
  expect(validateProject(project).pages[0].elements).toHaveLength(2)
  for (const id of ['../escape', '', 'a'.repeat(65), 'has space']) {
    expect(() => validateProject({ ...project, pages: [{ ...project.pages[0], elements: [{ id, type: 'rectangle' }] }] })).toThrow()
  }
  expect(() => validateProject({ ...project, id: '_filename' })).toThrow()
})
it('readding a deleted image restores its native element identity and remains deduplicated', () => {
  const asset = { ownerSessionId: 'parent', ref: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  const original = insertAsset(emptyProject('main'), 'page-1', asset)
  const tombstone = original.pages[0].elements[0]
  tombstone.isDeleted = true; tombstone.x = 420
  const restored = insertAsset(original, 'page-1', asset)
  expect(restored.pages[0].elements).toHaveLength(1)
  expect(restored.pages[0].elements[0]).toMatchObject({ id: tombstone.id, isDeleted: false, x: 420, version: 2 })
  expect(original.pages[0].elements[0].isDeleted).toBe(true)
  expect(insertAsset(restored, 'page-1', asset)).toEqual(restored)
})
it('flushes outgoing edits and blocks late editor callbacks while the next project loads', async () => {
  const h = harness()
  const originalCall = h.bridge.call.getMockImplementation()!
  let resolveLoad!: (value: any) => void
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'list') return [{ id: 'main', title: 'Main' }, { id: 'other', title: 'Other' }]
    if (endpoint === 'load' && payload.project_id === 'other') return await new Promise(resolve => { resolveLoad = resolve })
    return await originalCall(endpoint, payload)
  })
  render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  fireEvent.click(screen.getByText('Draw mark'))
  fireEvent.change(screen.getByLabelText('选择项目'), { target: { value: 'other' } })
  await waitFor(() => expect(resolveLoad).toBeDefined())
  expect(h.read().pages[0].elements).toHaveLength(1)
  expect(screen.getByLabelText('项目名称').closest('fieldset')?.disabled).toBe(true)
  // Simulate an already queued Excalidraw callback, even though the controls are now disabled.
  fireEvent.click(screen.getByText('Draw mark'))
  await act(async () => { resolveLoad({ project: emptyProject('other'), revision: 'c'.repeat(64), recovered: false }) })
  await waitFor(() => expect((screen.getByLabelText('选择项目') as HTMLSelectElement).value).toBe('other'))
  expect(screen.getByTestId('scene').textContent).toContain('0 elements')
  expect(h.read().pages[0].elements).toHaveLength(1)
})
it('keeps the outgoing document and revision usable when next-project image hydration fails', async () => {
  const h = harness(), originalCall = h.bridge.call.getMockImplementation()!
  const asset = { ownerSessionId: 'parent', ref: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'list') return [{ id: 'main', title: 'Main' }, { id: 'other', title: 'Other' }]
    if (endpoint === 'load' && payload.project_id === 'other') return { project: insertAsset(emptyProject('other'), 'page-1', asset), revision: 'c'.repeat(64), recovered: false }
    if (endpoint === 'image') throw new Error('image unavailable')
    return await originalCall(endpoint, payload)
  })
  render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  fireEvent.change(screen.getByLabelText('选择项目'), { target: { value: 'other' } })
  await screen.findByRole('alert')
  expect((screen.getByLabelText('选择项目') as HTMLSelectElement).value).toBe('main')
  fireEvent.click(screen.getByText('Draw mark'))
  await act(async () => { await h.leave() })
  expect(h.read().id).toBe('main'); expect(h.read().pages[0].elements).toHaveLength(1)
})
it('annotation preview includes only selected images and their associated marks without touching the project', () => {
  const selected = { id: 'selected', type: 'image', fileId: 'a'.repeat(64), x: 0, y: 0, width: 100, height: 100, angle: 0 }
  const other = { id: 'other', type: 'image', fileId: 'b'.repeat(64), x: 300, y: 0, width: 100, height: 100, angle: 0 }
  const arrow = { id: 'arrow', type: 'arrow', x: -50, y: 30, points: [[0, 0], [100, 0]], startBinding: { elementId: 'other' }, endBinding: { elementId: 'selected' } }
  const elements: any[] = [selected, other, arrow,
    { id: 'label', type: 'text', containerId: 'arrow', x: -40, y: 20, width: 40, height: 20 },
    { id: 'on-image', type: 'text', x: 10, y: 10, width: 20, height: 20 },
    { id: 'other-text', type: 'text', x: 310, y: 10, width: 20, height: 20 },
    { id: 'other-arrow', type: 'arrow', x: 300, y: 20, points: [[0, 0], [20, 0]] },
    { ...selected, id: 'unselected-copy', x: 600 },
    { id: 'removed', type: 'text', x: 1, y: 1, width: 20, height: 20, isDeleted: true }]
  const before = JSON.stringify(elements)
  const preview = selectedAnnotationElements(elements, ['selected'])
  expect(preview.map(item => item.id)).toEqual(['selected', 'arrow', 'label', 'on-image'])
  expect(preview.find(item => item.id === 'arrow')?.startBinding).toBeNull()
  expect(JSON.stringify(elements)).toBe(before)
})
it('MVP follows the native theme and keeps only the four annotation tools', async () => {
  document.body.removeAttribute('data-ds-dark-theme')
  const h = harness(); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  const scene = await screen.findByTestId('scene')
  expect(scene.getAttribute('data-theme')).toBe('light')
  await act(async () => { document.body.setAttribute('data-ds-dark-theme', '') })
  expect(scene.getAttribute('data-theme')).toBe('dark')
  const toolbar = screen.getByRole('toolbar', { name: '图片标注工具' })
  expect([...toolbar.querySelectorAll('button')].map(button => button.textContent)).toEqual(['选择', '平移', '箭头', '文字'])
  fireEvent.click(screen.getByRole('button', { name: '箭头', exact: true }))
  expect(screen.getByRole('button', { name: '箭头', exact: true }).getAttribute('aria-pressed')).toBe('true')
  document.body.removeAttribute('data-ds-dark-theme')
})
it('marked edits stage a preview then submit originals and annotation with explicit roles only once', async () => {
  const project = insertAsset(emptyProject('main'), 'page-1', imageAsset)
  project.pages[0].elements.push({ id: 'arrow', type: 'arrow', x: 5, y: 5, points: [[0, 0], [10, 10]] })
  const h = harness(project)
  const preview = { ...imageAsset, ref: { ...imageAsset.ref, attachmentId: `sha256:${'c'.repeat(64)}`, name: '标注参考.png' } }
  h.bridge.stageImages.mockResolvedValue([preview] as never)
  render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); fireEvent.click(screen.getByText('Select image'))
  fireEvent.change(screen.getByLabelText('图片修改需求'), { target: { value: '把箭头位置改为蓝色' } })
  const submit = screen.getByRole('button', { name: '修改图片', exact: true })
  fireEvent.click(submit); fireEvent.click(submit)
  await waitFor(() => expect(h.bridge.submit).toHaveBeenCalledOnce())
  expect(h.bridge.stageImages).toHaveBeenCalledOnce()
  expect(h.read().assets).toHaveLength(2)
  expect(h.read().pages[0].elements).toEqual(project.pages[0].elements)
  const args = h.bridge.submit.mock.calls[0] as unknown as any[]
  expect(args[1].sourceIds).toEqual([imageAsset.ref.attachmentId, preview.ref.attachmentId])
  expect(args[2]).toContain('最后一张为这些原图的箭头和文字标注参考')
  expect(args[2]).toContain('不要把标注添加到成品')
})

it('fits the initial viewport once without changing pixels or resetting later user zoom', async () => {
  const project = insertAsset(emptyProject('main'), 'page-1', imageAsset)
  project.pages[0].view.zoom = 0.1
  const h = harness(project); render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  await waitFor(() => expect(native.scroll).toHaveBeenCalledOnce())
  expect(native.scroll).toHaveBeenCalledWith(undefined, { fitToViewport: true, viewportZoomFactor: 0.68, maxZoom: 1, animate: false })
  expect(native.props.initialData.appState.currentItemStrokeColor).toBe('#eb5b16')
  fireEvent.click(screen.getByText('Draw mark'))
  await act(async () => { await h.leave() })
  expect(native.scroll).toHaveBeenCalledOnce()
  expect(h.read().pages[0].elements[0]).toEqual(project.pages[0].elements[0])
})
it('finishing one new arrow selects its exact image and focuses the existing edit input once', async () => {
  const project = insertAsset(emptyProject('main'), 'page-1', imageAsset)
  const h = harness(project); render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  const arrow = { id: 'new-arrow', type: 'arrow', x: -20, y: 20, width: 40, height: 0, points: [[0, 0], [40, 0]] }
  const scene = [...project.pages[0].elements, arrow]
  const state = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff', selectedElementIds: { 'new-arrow': true }, activeTool: { type: 'arrow' }, newElement: arrow, multiElement: null }
  act(() => { native.api.updateScene({ elements: scene }); native.props.onPointerDown({ type: 'arrow' }, { originalElements: new Map(project.pages[0].elements.map(item => [item.id, item])) }); native.props.onChange(scene, state); native.props.onPointerUp() })
  expect(document.activeElement).not.toBe(screen.getByLabelText('图片修改需求'))
  act(() => native.props.onChange(scene, { ...state, newElement: null, multiElement: arrow }))
  expect(document.activeElement).not.toBe(screen.getByLabelText('图片修改需求'))
  act(() => native.props.onChange(scene, { ...state, newElement: null }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('图片修改需求')))
  fireEvent.change(screen.getByLabelText('图片修改需求'), { target: { value: '改成橙色' } })
  expect((screen.getByRole('button', { name: '修改图片', exact: true }) as HTMLButtonElement).disabled).toBe(false)
  const preview = { ...imageAsset, ref: { ...imageAsset.ref, attachmentId: `sha256:${'c'.repeat(64)}` } }
  h.bridge.stageImages.mockResolvedValue([preview] as never)
  fireEvent.click(screen.getByRole('button', { name: '修改图片', exact: true }))
  await waitFor(() => expect(h.bridge.submit).toHaveBeenCalledOnce())
  expect(h.read().intents[0].sourceIds).toEqual([imageAsset.ref.attachmentId, preview.ref.attachmentId])
  screen.getByRole('button', { name: '选择', exact: true }).focus()
  act(() => { native.props.onPointerDown({ type: 'selection' }, { originalElements: new Map(scene.map(item => [item.id, item])) }); native.props.onPointerUp(); native.props.onChange(scene, { ...state, newElement: null }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  expect(document.activeElement).not.toBe(screen.getByLabelText('图片修改需求'))
})
it('arrow targeting handles overlap, rotated images, bindings and cancelled empty arrows conservatively', () => {
  const first = { id: 'first', type: 'image', x: 0, y: 0, width: 100, height: 100 }
  const second = { ...first, id: 'second', x: 200 }
  const arrow = { id: 'arrow', type: 'arrow', x: 50, y: 50, width: 200, height: 0, points: [[0, 0], [200, 0]] }
  expect(arrowImageTarget([first, second], arrow)?.id).toBe('second')
  expect(arrowImageTarget([first, { ...first, id: 'overlap' }], { ...arrow, width: 10, points: [[0, 0], [10, 0]] })).toBeUndefined()
  expect(arrowImageTarget([first, { ...first, id: 'overlap' }], { ...arrow, endBinding: { elementId: 'first' } })?.id).toBe('first')
  expect(arrowImageTarget([first], { ...arrow, points: [[0, 0], [0, 0]] })).toBeUndefined()
  expect(arrowImageTarget([first], { ...arrow, isDeleted: true })).toBeUndefined()
  const rotated = { ...second, x: 100, y: 100, width: 100, height: 20, angle: Math.PI / 2 }
  expect(arrowImageTarget([rotated], { ...arrow, x: 150, y: 50, width: 0, height: 40, points: [[0, 0], [0, 40]] })?.id).toBe('second')
})

it('Escape cancels the pending arrow-to-instruction focus transition', async () => {
  const project = insertAsset(emptyProject('main'), 'page-1', imageAsset)
  const h = harness(project); render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  const sceneNode = await screen.findByTestId('scene')
  const arrow = { id: 'cancelled-arrow', type: 'arrow', x: 10, y: 10, points: [[0, 0], [20, 20]] }
  act(() => native.props.onPointerDown({ type: 'arrow' }, { originalElements: new Map(project.pages[0].elements.map(item => [item.id, item])) }))
  fireEvent.keyDown(sceneNode, { key: 'Escape' })
  act(() => { native.props.onPointerUp(); native.props.onChange([...project.pages[0].elements, arrow], { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#fff', selectedElementIds: {}, newElement: null, multiElement: null }) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  expect(document.activeElement).not.toBe(screen.getByLabelText('图片修改需求'))
})

it('selection and hover preserve the page, while view changes reuse the saved scene', () => {
  const page = insertAsset(emptyProject('main'), 'page-1', imageAsset).pages[0]
  const live = structuredClone(page.elements)
  const state = { scrollX: page.view.scrollX, scrollY: page.view.scrollY, zoom: { value: page.view.zoom }, viewBackgroundColor: page.view.background }
  const stringify = vi.spyOn(JSON, 'stringify')
  expect(scenePage(page, live, { ...state, selectedElementIds: { [live[0].id as string]: true } })).toBe(page)
  expect(scenePage(page, live, { ...state, hoveredElementIds: { [live[0].id as string]: true } })).toBe(page)
  const moved = scenePage(page, live, { ...state, scrollX: 50, zoom: { value: .7 } })
  expect(moved).not.toBe(page); expect(moved.elements).toBe(page.elements)
  expect(moved.view).toEqual({ ...page.view, scrollX: 50, zoom: .7 })
  expect(sameSceneElements(live, moved.elements)).toBe(true)
  expect(stringify).not.toHaveBeenCalled()
})
it('scene snapshots retain in-place native edits, deletion, undo, replacement and ordering', () => {
  const original = insertAsset(emptyProject('main'), 'page-1', imageAsset).pages[0]
  const live = structuredClone(original.elements)
  const state = { scrollX: original.view.scrollX, scrollY: original.view.scrollY, zoom: { value: original.view.zoom }, viewBackgroundColor: original.view.background }
  const first = live[0]
  first.x = 123; first.version = 2; first.versionNonce = 10
  const edited = scenePage(original, live, state)
  expect(edited.elements[0].x).toBe(123); expect(edited.elements).not.toBe(live)
  expect(original.elements[0].x).toBe(0)
  first.isDeleted = true; first.version = 3; first.versionNonce = 11
  const deleted = scenePage(edited, live, state)
  expect(deleted.elements[0].isDeleted).toBe(true); expect(edited.elements[0].isDeleted).toBe(false)
  first.isDeleted = false; first.x = 0; first.version = 4; first.versionNonce = 12
  const undone = scenePage(deleted, live, state)
  expect(undone.elements[0]).toMatchObject({ isDeleted: false, x: 0, version: 4 })
  const inserted = scenePage(undone, [...live, { ...first, id: 'image-second', version: 1, versionNonce: 13 }], state)
  expect(inserted.elements).toHaveLength(2)
  const reordered = scenePage(inserted, [...inserted.elements].reverse(), state)
  expect(reordered.elements[0].id).toBe('image-second')
  expect(sameSceneElements(inserted.elements, reordered.elements)).toBe(false)
  const replaced = scenePage(undone, [{ ...first, versionNonce: 14, x: 42 }], state)
  expect(replaced.elements[0].x).toBe(42)
  const legacy = { ...original, elements: [{ id: 'legacy', type: 'text', text: 'before' }] }
  expect(scenePage(legacy, [{ ...legacy.elements[0], text: 'after' }], state).elements[0].text).toBe('after')
})
it('selection causes no save and the latest pan/zoom persists on leaving', async () => {
  const h = harness(insertAsset(emptyProject('main'), 'page-1', imageAsset))
  render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  fireEvent.click(screen.getByText('Select image'))
  await act(async () => { await h.leave() })
  expect(h.calls.filter(([name]) => name === 'save')).toHaveLength(0)
  const elements = structuredClone(native.api.getSceneElementsIncludingDeleted())
  await act(async () => {
    for (let index = 1; index <= 30; index++) native.props.onChange(elements, { scrollX: index, scrollY: -index, zoom: { value: .5 + index / 100 }, viewBackgroundColor: '#ffffff', selectedElementIds: {} })
    await h.leave()
  })
  expect(h.calls.filter(([name]) => name === 'save')).toHaveLength(1)
  expect(h.read().pages[0].view).toEqual({ scrollX: 30, scrollY: -30, zoom: .8, background: '#ffffff' })
  expect(h.read().pages[0].elements).toEqual(elements)
})

function hydrationHarness(count = 10) {
  const fixtures = Array.from({ length: count + 1 }, (_, index) => {
    const bytes = Buffer.concat([imageBytes, Buffer.from(String(index))])
    return { bytes, asset: { ...imageAsset, ref: { ...imageAsset.ref, attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length, name: `image-${index}.png` } } }
  })
  let project = emptyProject('main')
  for (const { asset } of fixtures.slice(0, count)) project = insertAsset(project, 'page-1', asset)
  const h = harness(project), fallback = h.bridge.call.getMockImplementation()!
  const reads: { projectId: string; attachmentId: string; bytes: number }[] = []
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'image') {
      const fixture = fixtures.find(item => item.asset.ref.attachmentId === payload.attachment_id)!
      reads.push({ projectId: payload.project_id, attachmentId: payload.attachment_id, bytes: fixture.bytes.length })
      return { ref: fixture.asset.ref, bytes_base64: fixture.bytes.toString('base64') }
    }
    return fallback(endpoint, payload)
  })
  h.bridge.stageImages.mockResolvedValue([fixtures[count].asset] as never)
  return { ...h, fixtures, reads }
}
function selectHydrationImage(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"][multiple]')!, { target: { files: [new File([imageBytes], 'new.png', { type: 'image/png' })] } })
}
it('hydrates only the new image while retaining all ten verified project assets', async () => {
  const h = hydrationHarness()
  const { container } = render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  expect(h.reads).toHaveLength(10)
  const initialBytes = h.reads.reduce((sum, item) => sum + item.bytes, 0)
  h.reads.length = 0
  selectHydrationImage(container)
  await waitFor(() => expect(native.api.addFiles).toHaveBeenCalledOnce())
  expect(initialBytes).toBe(690)
  expect(h.reads.reduce((sum, item) => sum + item.bytes, 0)).toBe(70)
  expect(h.reads.map(item => item.attachmentId)).toEqual([h.fixtures[10].asset.ref.attachmentId])
  expect(native.api.addFiles.mock.calls[0][0]).toHaveLength(11)
  expect(h.read().assets).toHaveLength(11)
})
it('does not reuse verified images for another project that denies the image read', async () => {
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'list') return [{ id: 'main', title: 'Main' }, { id: 'other', title: 'Other' }]
    if (endpoint === 'load' && payload.project_id === 'other') return { project: { ...h.read(), id: 'other' }, revision: 'c'.repeat(64), recovered: false }
    if (endpoint === 'image' && payload.project_id === 'other') throw new Error('permission denied')
    return fallback(endpoint, payload)
  })
  render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  fireEvent.change(screen.getByLabelText('选择项目'), { target: { value: 'other' } })
  expect((await screen.findByRole('alert')).textContent).toContain('permission denied')
  expect(h.bridge.call).toHaveBeenCalledWith('image', { project_id: 'other', attachment_id: h.fixtures[0].asset.ref.attachmentId })
  expect((screen.getByLabelText('选择项目') as HTMLSelectElement).value).toBe('main')
})
it('revalidates files after identity changes and rejects a changed attachment receipt', async () => {
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  let changed = false
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'image' && changed && payload.attachment_id === h.fixtures[0].asset.ref.attachmentId) throw new Error('account access denied')
    return fallback(endpoint, payload)
  })
  const { container } = render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); h.bridge.call.mockClear(); changed = true
  act(() => { dispatchEvent(new Event('emate:identity-changed')) })
  selectHydrationImage(container)
  expect((await screen.findByRole('alert')).textContent).toContain('account access denied')
  expect(h.bridge.call).toHaveBeenCalledWith('image', { project_id: 'main', attachment_id: h.fixtures[0].asset.ref.attachmentId })
  expect(native.api.addFiles).not.toHaveBeenCalled()
})
it('new files still require exact hash and byte length before reaching Excalidraw', async () => {
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'image' && payload.attachment_id === h.fixtures[1].asset.ref.attachmentId) return { ref: h.fixtures[1].asset.ref, bytes_base64: h.fixtures[0].bytes.toString('base64') }
    return fallback(endpoint, payload)
  })
  const { container } = render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); selectHydrationImage(container)
  expect((await screen.findByRole('alert')).textContent).toContain('素材已损坏')
  expect(native.api.addFiles).not.toHaveBeenCalled()
})
it('same-project reload validates changed asset metadata instead of using its cached bytes', async () => {
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  let changed = false
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    const result = await fallback(endpoint, payload)
    if (endpoint === 'load' && changed) { const next = structuredClone(result); next.project.assets[0].ref.bytes += 1; return next }
    return result
  })
  const { rerender } = render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); changed = true; h.reads.length = 0
  rerender(<CanvasPanel bridge={h.bridge} initialProjectId="main" initialAsset={h.fixtures[0].asset} />)
  expect((await screen.findByRole('alert')).textContent).toContain('素材已损坏')
  expect(h.reads).toHaveLength(1)
})
it('discards late hydration on unmount and reads all assets again after remount', async () => {
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  let resolve!: (value: unknown) => void
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'image' && payload.attachment_id === h.fixtures[1].asset.ref.attachmentId) return new Promise(done => { resolve = done })
    return fallback(endpoint, payload)
  })
  const view = render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); selectHydrationImage(view.container)
  await waitFor(() => expect(resolve).toBeDefined())
  const oldApi = native.api
  view.unmount()
  await act(async () => { resolve({ ref: h.fixtures[1].asset.ref, bytes_base64: h.fixtures[1].bytes.toString('base64') }) })
  expect(oldApi.addFiles).not.toHaveBeenCalled()
  h.reads.length = 0; h.bridge.call.mockImplementation(fallback)
  render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); expect(h.reads).toHaveLength(2)
})


it('waits for native scene initialization and nonzero viewport before fitting a restored 10 percent view', async () => {
  native.deferReady = true
  const project = insertAsset(emptyProject('main'), 'page-1', imageAsset)
  project.pages[0].view.zoom = 0.1
  project.pages[0].elements[0] = { ...project.pages[0].elements[0], width: 1000, height: 1000 }
  const h = harness(project); render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  await act(async () => { await new Promise(requestAnimationFrame) })
  expect(native.scroll).not.toHaveBeenCalled()
  act(() => native.emit({ isLoading: false, width: 0, height: 0 }))
  await act(async () => { await new Promise(requestAnimationFrame) })
  expect(native.scroll).not.toHaveBeenCalled()
  act(() => native.emit({ width: 1000, height: 800 }))
  await waitFor(() => expect(native.scroll).toHaveBeenCalledOnce())
  expect(native.api.getAppState()).toMatchObject({ isLoading: false, width: 1000, height: 800 })
  expect(native.api.getSceneElementsIncludingDeleted()).toEqual(project.pages[0].elements)
  const options = native.scroll.mock.calls[0][1]
  expect(options).toMatchObject({ viewportZoomFactor: 0.68, maxZoom: 1, fitToViewport: true })
  // This viewport can fit a 1000px square above 50%; a saved 10% must not cap it.
  expect(Math.min(1000 / 1000, 800 / 1000) * options.viewportZoomFactor).toBeGreaterThan(0.5)
  act(() => native.emit({ zoom: { value: 0.3 }, scrollX: 15, scrollY: 20 }))
  await act(async () => { await new Promise(requestAnimationFrame) })
  expect(native.scroll).toHaveBeenCalledOnce()
  await act(async () => { await h.leave() })
  expect(h.read().pages[0].view.zoom).toBe(0.3)
})

it('does not fit a ready scene after its identity was invalidated', async () => {
  native.deferReady = true
  const h = harness(insertAsset(emptyProject('main'), 'page-1', imageAsset))
  const view = render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  act(() => { native.emit({ isLoading: false }); window.dispatchEvent(new Event('emate:identity-changed')) })
  await act(async () => { await new Promise(requestAnimationFrame) })
  expect(native.scroll).not.toHaveBeenCalled()
  view.unmount()
})


it('focuses the edit input for a new arrow dragged from the top overlapping image without selecting it first', async () => {
  const secondBytes = Buffer.concat([imageBytes, Buffer.from([0])])
  const secondAsset = { ...imageAsset, ref: { ...imageAsset.ref, bytes: secondBytes.length, attachmentId: `sha256:${createHash('sha256').update(secondBytes).digest('hex')}` } }
  const project = insertAsset(insertAsset(emptyProject('main'), 'page-1', imageAsset), 'page-1', secondAsset)
  // Both rendered image bounds cover (70,70), as native 40px insertion offsets do.
  const h = harness(project)
  const originalCall = h.bridge.call.getMockImplementation()!
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => endpoint === 'image' && payload.attachment_id === secondAsset.ref.attachmentId
    ? { bytes_base64: secondBytes.toString('base64'), ref: secondAsset.ref } as any : originalCall(endpoint, payload))
  render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  const input = screen.getByLabelText('图片修改需求')
  screen.getByTestId('scene').setAttribute('tabindex', '0'); screen.getByTestId('scene').focus()
  const arrow = { id: 'overlap-arrow', type: 'arrow', x: 70, y: 70, width: 150, height: -40, points: [[0, 0], [150, -40]] }
  const elements = [...project.pages[0].elements, arrow]
  const state = { scrollX: 0, scrollY: 0, zoom: { value: 0.3 }, viewBackgroundColor: '#ffffff', selectedElementIds: { 'overlap-arrow': true }, activeTool: { type: 'arrow' }, newElement: arrow, multiElement: null }
  act(() => {
    native.props.onPointerDown({ type: 'arrow' }, { originalElements: new Map(project.pages[0].elements.map(item => [item.id, item])), hit: { element: null } })
    native.api.updateScene({ elements }); native.props.onChange(elements, state)
    native.props.onPointerUp({ type: 'arrow' })
    native.props.onChange(elements, { ...state, activeTool: { type: 'selection' }, newElement: null })
  })
  await waitFor(() => expect(document.activeElement).toBe(input))
  fireEvent.change(input, { target: { value: '修改上层图片的文字' } })
  const preview = { ...imageAsset, ref: { ...imageAsset.ref, attachmentId: `sha256:${'c'.repeat(64)}` } }
  h.bridge.stageImages.mockResolvedValue([preview] as never)
  fireEvent.click(screen.getByRole('button', { name: '修改图片', exact: true }))
  await waitFor(() => expect(h.bridge.submit).toHaveBeenCalledOnce())
  expect(h.read().intents[0].sourceIds).toEqual([secondAsset.ref.attachmentId, preview.ref.attachmentId])
})

it('does not focus or choose either overlapping image for a new arrow entirely in blank space', async () => {
  const project = insertAsset(emptyProject('main'), 'page-1', imageAsset)
  project.pages[0].elements.push({ ...project.pages[0].elements[0], id: 'overlapping-copy', x: 40, y: 40 })
  const h = harness(project); render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  const arrow = { id: 'blank-arrow', type: 'arrow', x: 500, y: 500, points: [[0, 0], [100, 100]] }
  const elements = [...project.pages[0].elements, arrow]
  act(() => {
    native.props.onPointerDown({ type: 'arrow' }, { originalElements: new Map(project.pages[0].elements.map(item => [item.id, item])), hit: { element: null } })
    native.props.onPointerUp()
    native.props.onChange(elements, { scrollX: 0, scrollY: 0, zoom: { value: 0.3 }, viewBackgroundColor: '#ffffff', selectedElementIds: { 'blank-arrow': true }, activeTool: { type: 'selection' }, newElement: null, multiElement: null })
  })
  await act(async () => { await new Promise(requestAnimationFrame) })
  expect(document.activeElement).not.toBe(screen.getByLabelText('图片修改需求'))
  expect((screen.getByRole('button', { name: '修改图片', exact: true }) as HTMLButtonElement).disabled).toBe(true)
})

it.each(['page-1', 'other'])('keeps native commit callbacks and imported output consistent while viewing %s', async (viewedPage) => {
  native.reportCommits = true
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  let resolveOutput!: (value: any) => void
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'outputs') return await new Promise(resolve => { resolveOutput = resolve })
    return fallback(endpoint, payload)
  })
  h.read().pages.push(emptyPage('other', 'Other page'))
  h.read().intents.push({ id: 'pending', pageId: 'page-1', kind: 'edit', sessionId: 'parent', sourceIds: [h.fixtures[0].asset.ref.attachmentId], imported: [] })
  render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  await waitFor(() => expect(resolveOutput).toBeTypeOf('function'))
  if (viewedPage === 'other') fireEvent.change(screen.getByLabelText('选择画布页'), { target: { value: 'other' } })
  await act(async () => { resolveOutput({ kind: 'images', assets: [h.fixtures[1].asset] }) })
  await waitFor(() => expect(native.api.addFiles).toHaveBeenCalledOnce())
  await act(async () => { await h.leave() })
  expect(screen.getByRole('toolbar', { name: '图片标注工具' })).toBeTruthy()
  expect(native.api.getSceneElementsIncludingDeleted()).toHaveLength(viewedPage === 'page-1' ? 2 : 0)
  expect(h.read().pages[0].elements).toHaveLength(2)
  expect(h.read().pages[1].elements).toHaveLength(0)
  expect(h.read().intents[0].imported).toEqual([h.fixtures[1].asset.ref.attachmentId.slice(7)])
  expect(native.commits).toBeLessThan(15)
})
it('does not announce an output when only the viewport changes while outputs are pending', async () => {
  const h = hydrationHarness(1), fallback = h.bridge.call.getMockImplementation()!
  let resolveOutput!: (value: any) => void
  h.bridge.call.mockImplementation(async (endpoint, payload = {}) => {
    if (endpoint === 'outputs') return await new Promise(resolve => { resolveOutput = resolve })
    return fallback(endpoint, payload)
  })
  h.read().intents.push({ id: 'pending', pageId: 'page-1', kind: 'edit', sessionId: 'parent', sourceIds: [], imported: [] })
  render(<CanvasPanel bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene')
  await waitFor(() => expect(resolveOutput).toBeTypeOf('function'))
  await act(async () => {
    native.emit({ scrollX: 30, zoom: { value: .5 } })
    resolveOutput({ kind: 'images', assets: [] })
  })
  await act(async () => { await h.leave() })
  expect(screen.queryByText('原生任务的成功产物已插入，已有素材已去重。')).toBeNull()
  expect(native.api.addFiles).not.toHaveBeenCalled()
  expect(h.read().pages[0].view).toMatchObject({ scrollX: 30, zoom: .5 })
  expect(h.read().intents[0].imported).toEqual([])
})
