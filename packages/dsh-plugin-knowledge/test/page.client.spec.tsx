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
  fireEvent.click(screen.getByRole('button', { name: '知识图谱' }))
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

it.each(['基于此提问', '加入方案/报表', '纠错'])('prepares %s with actual versions and query snapshot', async (label) => {
  const queryId = 'd'.repeat(36), original = fixture([one]), prepareDraft = vi.fn(async (_text: string, _signal: AbortSignal) => {})
  const call = vi.fn(async (endpoint: string, body: any) => endpoint === 'search'
    ? answer({ query_id: queryId, data: [{ source_id: one.source_id, text: '检索原文' }], sources: [{ id: one.source_id, file_hash: one.source_version, title: one.title }] }) : original(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} prepareDraft={prepareDraft} />)
  await screen.findByRole('list')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索知识' }), { target: { value: '查询条件' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '检索原文' })))
  fireEvent.click(within(screen.getByRole('list')).getByRole('button'))
  await screen.findByText(/原文内容：接口夹具/)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: label })))
  const draft = prepareDraft.mock.calls[0]![0]
  for (const value of [one.source_id, one.source_version, revision, scope, queryId, '查询条件', '区分原文事实、模型整理、推断和冲突']) expect(draft).toContain(value)
  expect(draft).not.toContain('<script>')
  expect(call.mock.calls.every(([endpoint]) => ['catalog', 'graph', 'search', 'node'].includes(endpoint))).toBe(true)
})

it('keeps compiled revision identity and all exact original versions in the draft', async () => {
  const compiled = { ...one, revision_id: 'c'.repeat(36), source_version: 'f'.repeat(64) }
  const sourceVersions = [one, two].map(node => ({ source_id: node.source_id, source_version: node.source_version, parse_revision: 'e'.repeat(64) }))
  const original = fixture([compiled]), prepareDraft = vi.fn(async (_text: string, _signal: AbortSignal) => {})
  const call = vi.fn(async (endpoint: string, body: any) => endpoint === 'node'
    ? answer({ ...compiled, untrusted: true, content: '编译引用', source_versions: sourceVersions }) : original(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} prepareDraft={prepareDraft} />)
  fireEvent.click(within(await screen.findByRole('list')).getByRole('button'))
  await screen.findByText('编译引用')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '加入方案/报表' })))
  const draft = prepareDraft.mock.calls[0]![0]
  expect(draft).toContain(`"revision_id": "${compiled.revision_id}"`)
  expect(draft).toContain(`"revision_version": "${compiled.source_version}"`)
  for (const source of sourceVersions) for (const value of Object.values(source)) expect(draft).toContain(value)
  expect(draft).not.toContain('query_id')
})

it('refuses changed corpus and cancels late draft preparation on identity change', async () => {
  const original = fixture([one]), prepareDraft = vi.fn(async (_text: string, _signal: AbortSignal) => {})
  let later: (() => Promise<any>) | undefined
  const call = vi.fn(async (endpoint: string, body: any) => endpoint === 'catalog' && later ? later() : original(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} prepareDraft={prepareDraft} />)
  fireEvent.click(within(await screen.findByRole('list')).getByRole('button'))
  await screen.findByText(/原文内容：接口夹具/)
  later = async () => answer({ corpus_revision: 'f'.repeat(64) })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '基于此提问' })))
  expect(screen.getByRole('alert').textContent).toContain('资料快照已变化')
  expect(prepareDraft).not.toHaveBeenCalled()
  let release!: (value: any) => void
  later = () => new Promise(resolve => { release = resolve })
  fireEvent.click(screen.getByRole('button', { name: '基于此提问' }))
  act(() => dispatchEvent(new Event('emate:identity-changed')))
  await act(async () => release(answer({ source_count: 1 })))
  expect(prepareDraft).not.toHaveBeenCalled()
})

it('supplement opens existing private importer without uploading', async () => {
  const original = fixture([one])
  const call = vi.fn(async (endpoint: string, body: any) => endpoint === 'ui.import.recent' ? answer({ items: [], has_more: false }) : original(endpoint, body))
  render(<KnowledgePage callKnowledge={call} loadGraph={vi.fn()} />)
  fireEvent.click(within(await screen.findByRole('list')).getByRole('button'))
  await screen.findByText(/原文内容：接口夹具/)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '补充资料' })))
  expect(screen.getByRole('button', { name: '选择文件' })).toBe(document.activeElement)
  expect((screen.getByRole('combobox', { name: '资料范围' }) as HTMLSelectElement).value).toBe('uploader-private')
  expect(call.mock.calls.some(([endpoint]) => endpoint === 'ui.import.prepare' || endpoint === 'ui.import.start')).toBe(false)
})

// Load only the exported client bridge, retaining the production body. Slot/UI
// imports are not required for these native input boundary tests.
async function draftBridge() {
  const { readFileSync } = await import('node:fs')
  const { stripTypeScriptTypes } = await import('node:module')
  const source = readFileSync('src/client/index.ts', 'utf8')
  const body = source.slice(source.indexOf('export async function prepareKnowledgeDraft'), source.indexOf('export function apply'))
  return new Function(stripTypeScriptTypes(body).replace('export async function', 'async function') + '; return prepareKnowledgeDraft')()
}
async function nativeDraftFixture(initial: string | undefined = 'session-one') {
  const { InputMachine } = await import('../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/input/machine.ts')
  const machine = new InputMachine()
  machine.dispatch({ type: 'draft-changed', draft: '已有文字 @document.txt' })
  const fileRefs = [{ relative_path: 'document.txt', stored_name: 'document.txt' }], imageIds = ['existing-image']
  const input = { state: { getSnapshot: () => ({ ...machine.state, fileRefs, imageIds }) }, setDraft: vi.fn((draft: string) => { machine.dispatch({ type: 'draft-changed', draft }) }), submit: vi.fn() }
  const state = { current: initial }, actions = { setView: vi.fn() }, beforeNavigate = vi.fn(async () => {})
  const ctx = { get: () => ({ beforeNavigate }), conversation: { input: { for: vi.fn(() => input) } },
    sessions: { list: { getSnapshot: () => state }, scope: vi.fn((id: string) => ({ id })), open: vi.fn((id: string) => { state.current = id }) },
    workspaces: { list: { getSnapshot: () => ({ baselinesReady: true, recentWorkspaceId: 'native-default' }) }, connectWorkspace: vi.fn(async () => 'new-native-session') } }
  return { prepare: await draftBridge(), ctx, input, state, actions, beforeNavigate, machine, fileRefs, imageIds }
}
it('appends through native input without losing text/files/images, saves canvas and opens chat without sending', async () => {
  const f = await nativeDraftFixture()
  await f.prepare(f.ctx, '核验引用草稿', new AbortController().signal, () => f.actions)
  expect(f.machine.state.draft).toBe('已有文字 @document.txt\n\n核验引用草稿')
  expect(f.input.state.getSnapshot().fileRefs).toBe(f.fileRefs)
  expect(f.input.state.getSnapshot().imageIds).toBe(f.imageIds)
  expect(f.input.submit).not.toHaveBeenCalled()
  expect(f.beforeNavigate).toHaveBeenCalledOnce()
  expect(f.actions.setView).toHaveBeenCalledWith('chat')
  expect(location.pathname).toBe('/chat/session-one')
})
it('uses native Workspace default only when no Session exists', async () => {
  const f = await nativeDraftFixture()
  f.state.current = undefined
  await f.prepare(f.ctx, '引用', new AbortController().signal, () => undefined)
  expect(f.ctx.workspaces.connectWorkspace).toHaveBeenCalledWith('native-default')
  expect(f.ctx.sessions.open).toHaveBeenCalledWith('new-native-session')
  expect(f.input.submit).not.toHaveBeenCalled()
})
it('preserves page and draft on canvas save failure and rejects late identity changes', async () => {
  const f = await nativeDraftFixture()
  f.beforeNavigate.mockRejectedValueOnce(Error('画布保存失败'))
  await expect(f.prepare(f.ctx, '引用', new AbortController().signal, () => f.actions)).rejects.toThrow('画布保存失败')
  expect(f.input.setDraft).not.toHaveBeenCalled()
  expect(location.pathname).toBe('/knowledge')
  let release!: () => void
  f.beforeNavigate.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const pending = f.prepare(f.ctx, '旧账号引用', new AbortController().signal, () => f.actions)
  dispatchEvent(new Event('emate:identity-changed')); release()
  await expect(pending).rejects.toThrow()
  expect(f.input.setDraft).not.toHaveBeenCalled()
  expect(f.ctx.sessions.open).not.toHaveBeenCalled()
})
it('refuses a submitting composer without changing its pending draft', async () => {
  const f = await nativeDraftFixture()
  f.machine.dispatch({ type: 'draft-changed', draft: '/goal 已有文字' })
  f.machine.dispatch({ type: 'enter', mode: 'queue' })
  await expect(f.prepare(f.ctx, '引用', new AbortController().signal, () => f.actions)).rejects.toThrow('输入框正在提交')
  expect(f.input.setDraft).not.toHaveBeenCalled()
})
