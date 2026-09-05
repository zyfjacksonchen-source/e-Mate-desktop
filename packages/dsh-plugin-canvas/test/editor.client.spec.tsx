import React, { useEffect, useRef, useState } from 'react'
import { webcrypto } from 'node:crypto'
import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyProject } from '../src/contract.ts'
import { htmlDocument, pagesFromHtml } from '../src/client/model.ts'
import { createBridge } from '../src/client/bridge.ts'
vi.mock('@excalidraw/excalidraw', () => {
  const MainMenu: any = ({ children }: any) => <div>{children}</div>
  MainMenu.DefaultItems = { ClearCanvas: () => null, ToggleTheme: () => null }
  return { MainMenu, exportToBlob: vi.fn(async () => new Blob(['png'])), Excalidraw: (props: any) => {
    const elements = useRef(props.initialData.elements); const [, refresh] = useState(0)
    useEffect(() => { props.excalidrawAPI({ getSceneElementsIncludingDeleted: () => elements.current,
      updateScene: ({ elements: next }: any) => { elements.current = next; refresh(value => value + 1) }, addFiles: () => {}, scrollToContent: () => {},
    }) }, [])
    return <div data-testid="scene"><span>{elements.current.length} elements</span><button onClick={() => {
      elements.current = [...elements.current, { id: 'mark', type: 'rectangle', x: 1, y: 1 }]
      props.onChange(elements.current, { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff', selectedElementIds: {} })
    }}>Draw mark</button></div>
  } }
})
import { CanvasPanel } from '../src/client/editor.tsx'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function harness(initial = emptyProject('main')) {
  let document = structuredClone(initial), revision = 'a'.repeat(64), leave = async () => {}
  const calls: any[] = []
  const bridge = { sessionId: 'parent', close: vi.fn(), submit: vi.fn(async () => {}), stageImages: vi.fn(async () => []),
    beforeLeave: (handler: () => Promise<void>) => { leave = handler; return () => {} }, subscribe: () => () => {},
    call: vi.fn(async (endpoint: string, payload: any = {}) => {
      calls.push([endpoint, payload])
      if (endpoint === 'load') return { project: structuredClone(document), revision, recovered: false }
      if (endpoint === 'list') return [{ id: 'main', title: document.title, recovered: false }]
      if (endpoint === 'outputs') return { kind: 'images', assets: [] }
      if (endpoint !== 'save') throw new Error('unexpected endpoint ' + endpoint)
      if (payload.expected_revision !== revision) throw Object.assign(new Error('another window changed the project'), { code: 'conflict' })
      document = structuredClone(payload.project); revision = (revision[0] === 'a' ? 'b' : 'a').repeat(64)
      return { project: structuredClone(document), revision, recovered: false }
    }) }
  return { bridge, calls, read: () => document, leave: () => leave(), conflict: () => { revision = 'f'.repeat(64) } }
}
it('edits and page ordering save through revision-bound bridge; close flushes pending changes', async () => {
  const h = harness(); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); fireEvent.click(screen.getByText('Draw mark'))
  fireEvent.click(screen.getByRole('button', { name: '新增页面' })); fireEvent.click(screen.getByTitle('向前排序'))
  await act(async () => { await h.leave() })
  expect(h.read().pages).toHaveLength(2); expect(h.read().pages[1].elements).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'named project' } }); fireEvent.click(screen.getByText('关闭'))
  await waitFor(() => expect(h.bridge.close).toHaveBeenCalledOnce()); expect(h.read().title).toBe('named project')
})
it('conflict keeps local edits and refuses silent replacement', async () => {
  const h = harness(); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); h.conflict(); fireEvent.click(screen.getByText('Draw mark')); fireEvent.click(screen.getByText('保存'))
  await screen.findByRole('alert'); expect(screen.getByTestId('scene').textContent).toContain('1 elements')
  expect(h.read().pages[0].elements).toHaveLength(0); expect(h.bridge.close).not.toHaveBeenCalled()
})
it('AI saves an identity binding then submits once without fabricating a Job status', async () => {
  const h = harness(); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); fireEvent.change(screen.getByLabelText('画布生成需求'), { target: { value: '画一片森林' } })
  fireEvent.click(screen.getByText('交给当前会话')); await waitFor(() => expect(h.bridge.submit).toHaveBeenCalledOnce())
  expect(h.read().intents[0].sessionId).toBe('parent'); expect(h.read().intents[0].imported).toEqual([])
  expect(h.read().intents[0]).not.toHaveProperty('status'); expect(screen.queryByText('生成成功')).toBeNull()
})
it('HTML uses opaque sandbox; slide extraction never attaches project markup to the host', async () => {
  const project = emptyProject('main'); project.pages[0].html = '<script>window.hostAttacked=true</script><a href="https://example.test">link</a>'
  const h = harness(project); render(<CanvasPanel sessionId="parent" bridge={h.bridge} initialProjectId="main" />)
  await screen.findByTestId('scene'); fireEvent.click(screen.getByText('HTML 预览'))
  const iframe = screen.getByTitle('画布 1') as HTMLIFrameElement
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts'); expect(iframe.srcdoc).toContain("default-src 'none'")
  expect(iframe.srcdoc).toContain('srcdoc='); expect(iframe.srcdoc).not.toContain('<script>window.hostAttacked')
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
