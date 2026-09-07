// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeEntry, KnowledgePage } from '../src/client/page.tsx'
const scope = 'c'.repeat(64), revision = 'a'.repeat(64)
const one = { id: '1'.repeat(64), title: '接口夹具：搜索方法', source_id: 'a'.repeat(36), source_version: 'b'.repeat(64), layer: 'expert' }
const two = { id: '2'.repeat(64), title: '接口夹具：案例方法', source_id: 'b'.repeat(36), source_version: 'd'.repeat(64), layer: 'case' }
const base = { schema_version: 1, scope: { kind: 'public' }, corpus_revision: revision }
const answer = (result: any) => ({ scope_key: scope, result: { ...base, ...result } })
function fixture(nodes = [one, two]) {
  return vi.fn(async (endpoint: string, body: any) => {
    if (endpoint === 'catalog') return answer({ source_count: nodes.length })
    if (endpoint === 'graph') return answer({ nodes, edges: [], truncated: false })
    if (endpoint === 'node') { const node = nodes.find(value => value.id === body.node_id)!; return answer({ id: node.id, source_id: node.source_id, source_version: node.source_version, untrusted: true, content: `原文内容：${node.title}\n<script>unsafe()</script>` }) }
    throw Error('Unexpected endpoint')
  })
}
beforeEach(() => {
  history.replaceState(null, '', '/knowledge')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(() => { cleanup(); document.body.replaceChildren(); history.replaceState(null, '', '/') })
it('uses the native route and never makes fake nodes for an empty corpus', async () => {
  history.replaceState(null, '', '/')
  render(<KnowledgeEntry wide KnowledgeIcon={() => <svg />} />)
  fireEvent.click(screen.getByRole('button', { name: '企业知识图谱' }))
  expect(location.pathname).toBe('/knowledge')
  const loadGraph = vi.fn()
  render(<KnowledgePage callKnowledge={fixture([])} loadGraph={loadGraph} />)
  await screen.findByText('当前没有可读取的公共知识。')
  expect(loadGraph).not.toHaveBeenCalled()
  expect(screen.queryByRole('list')).toBeNull()
})
it('keeps a complete reduced-motion list and reads exact versions without HTML execution', async () => {
  const call = fixture(), loadGraph = vi.fn()
  render(<KnowledgePage callKnowledge={call} loadGraph={loadGraph} />)
  const list = await screen.findByRole('list', { name: '知识条目列表' })
  expect(within(list).getAllByRole('button')).toHaveLength(2)
  fireEvent.change(screen.getByRole('combobox', { name: '知识类型' }), { target: { value: 'expert' } })
  expect(within(list).getAllByRole('button')).toHaveLength(1)
  fireEvent.click(within(list).getByRole('button'))
  await screen.findByText(/原文内容：接口夹具：搜索方法/)
  expect(call).toHaveBeenCalledWith('node', { node_id: one.id, version: one.source_version }, expect.any(AbortSignal))
  expect(document.querySelector('script')).toBeNull()
  expect(loadGraph).not.toHaveBeenCalled()
})
it('falls back to the same full list when WebGL is unavailable', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  render(<KnowledgePage callKnowledge={fixture()} loadGraph={async () => { throw Error('No WebGL') }} />)
  await screen.findByText(/当前环境无法显示三维图谱/)
  expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2)
  fireEvent.click(within(screen.getByRole('list')).getAllByRole('button')[1]!)
  await screen.findByText(/原文内容：接口夹具：案例方法/)
})
it('drops stale detail replies and clears immediately on the existing identity event', async () => {
  let release!: (value: any) => void
  const other = fixture()
  const call = vi.fn((endpoint: string, body: any) => endpoint === 'node' && body.node_id === one.id ? new Promise<any>(resolve => { release = resolve }) : other(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} />)
  const list = await screen.findByRole('list')
  fireEvent.click(within(list).getAllByRole('button')[0]!)
  fireEvent.click(within(list).getAllByRole('button')[1]!)
  await screen.findByText(/原文内容：接口夹具：案例方法/)
  await act(async () => release(answer({ id: one.id, source_id: one.source_id, source_version: one.source_version, untrusted: true, content: '过期回复' })))
  expect(screen.queryByText('过期回复')).toBeNull()
  act(() => dispatchEvent(new Event('emate:identity-changed')))
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByRole('complementary', { name: '知识原文' })).toBeNull()
})
it('does not restore a canceled page after navigation away', async () => {
  let release!: (value: any) => void
  const call = vi.fn((endpoint: string) => endpoint === 'catalog' ? Promise.resolve(answer({ source_count: 1 })) : new Promise<any>(resolve => { release = resolve }))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} />)
  act(() => { history.pushState(null, '', '/chat/task'); dispatchEvent(new PopStateEvent('popstate')) })
  await act(async () => release(answer({ nodes: [one], edges: [], truncated: false })))
  expect(screen.queryByRole('main')).toBeNull()
})
it('uses the same filtered items for graph and list and disposes on context loss', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  let unavailable!: () => void
  const controller = { update: vi.fn(), focus: vi.fn(), resize: vi.fn(), reset: vi.fn(), dispose: vi.fn() }
  const loadGraph = vi.fn(async () => ({ createGraph: (_element: any, _select: any, failed: () => void) => { unavailable = failed; return controller } }))
  render(<KnowledgePage callKnowledge={fixture()} loadGraph={loadGraph} />)
  await screen.findByRole('list')
  await act(async () => {})
  expect(controller.update.mock.calls.at(-1)?.[0]).toHaveLength(2)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'case' } })
  expect(controller.update.mock.calls.at(-1)?.[0]).toHaveLength(1)
  expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1)
  act(() => unavailable())
  expect(controller.dispose).toHaveBeenCalledOnce()
  expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1)
})

it('keeps compiled revision identity separate from each cited original for search and downloads', async () => {
  const compiled = { ...one, id: '3'.repeat(64), title: '接口夹具：编译知识', source_version: 'f'.repeat(64), revision_id: 'c'.repeat(36) }
  const sourceVersions = [one, two].map(node => ({ source_id: node.source_id, source_version: node.source_version, parse_revision: 'e'.repeat(64) }))
  const original = fixture([one, two, compiled])
  const call = vi.fn(async (endpoint: string, body: any) => {
    if (endpoint === 'node' && body.node_id === compiled.id) return answer({ ...compiled, untrusted: true, content: '已标注的编译内容', source_versions: sourceVersions })
    if (endpoint === 'original') return { scope_key: scope, result: { url: '/emate-knowledge-downloads/' + 'd'.repeat(36), sha256: body.version, bytes: 10 } }
    if (endpoint === 'search') return answer({ data: [{ source_id: one.source_id, text: '真实来源命中' }], sources: [{ id: one.source_id, file_hash: one.source_version, title: one.title }] })
    return original(endpoint, body)
  })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} />)
    const list = await screen.findByRole('list')
    fireEvent.click(within(list).getByRole('button', { name: /接口夹具：编译知识/ }))
    await screen.findByText('已标注的编译内容')
    expect(screen.getByText('编译内容')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '下载原件：接口夹具：搜索方法' })))
    expect(call).toHaveBeenCalledWith('original', { source_id: one.source_id, version: one.source_version }, expect.any(AbortSignal))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '下载原件：接口夹具：案例方法' })))
    expect(call).toHaveBeenCalledWith('original', { source_id: two.source_id, version: two.source_version }, expect.any(AbortSignal))
    expect(click).toHaveBeenCalledTimes(2)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识' }), { target: { value: '原文查询' } })
    fireEvent.click(screen.getByRole('button', { name: '检索原文' }))
    await screen.findByRole('button', { name: /接口夹具：搜索方法/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1)
  } finally { click.mockRestore() }
})

it('retains server-filtered search hits outside the initial graph instead of filtering their source rows away', async () => {
  const other = { id: 'd'.repeat(36), file_hash: 'e'.repeat(64), title: '首屏外的专家知识来源' }
  const original = fixture([two])
  const call = vi.fn(async (endpoint: string, body: any) => endpoint === 'search'
    ? answer({ data: [{ source_id: other.id, text: '真实匹配内容' }], sources: [other] }) : original(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} />)
  await screen.findByRole('list')
  fireEvent.change(screen.getByRole('combobox', { name: '知识类型' }), { target: { value: 'expert' } })
  fireEvent.change(screen.getByRole('textbox', { name: '搜索知识' }), { target: { value: '行业方法' } })
  fireEvent.click(screen.getByRole('button', { name: '检索原文' }))
  await screen.findByRole('button', { name: /首屏外的专家知识来源/ })
  expect(call).toHaveBeenCalledWith('search', { question: '行业方法', limit: 20, layer: 'expert', corpus_revision: revision }, expect.any(AbortSignal))
  expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(1)
})

it('does not expose original download actions for a mismatched or incomplete compiled revision receipt', async () => {
  const compiled = { ...one, revision_id: 'c'.repeat(36) }
  const original = fixture([compiled])
  const call = vi.fn(async (endpoint: string, body: any) => endpoint === 'node' ? answer({ ...compiled, revision_id: 'd'.repeat(36), untrusted: true, content: '错误修订', source_versions: [] }) : original(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} />)
  const list = await screen.findByRole('list')
  fireEvent.click(within(list).getAllByRole('button')[0]!)
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: /下载原件/ })).toBeNull()
  expect(screen.queryByText('错误修订')).toBeNull()
})
