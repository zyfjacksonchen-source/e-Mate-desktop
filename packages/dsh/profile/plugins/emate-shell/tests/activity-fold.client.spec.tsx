// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '../../../../../../upstream/deepseek-harness/packages/client/ui-slots/src/index.ts'
import { createSlotRenderer, SessionProvider, SlotAssemblyError } from '../../../../../../upstream/deepseek-harness/packages/client/web-react/src/index.ts'
import { activityFoldSummary, registerActivityFold } from '../src/client/activity-fold.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const cssSource = readFileSync(resolve('src/client/activity-fold.module.css'), 'utf8')

const location = (turn: number) => ({ kind: 'step', turn: { turn } })

function modeScope(initial: unknown = 'simple') {
  let snapshot = { status: 'ready', value: { messageFlowMode: initial }, writable: true }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async () => {},
    unset: async () => {},
    publish(value: unknown) {
      snapshot = { ...snapshot, value: { messageFlowMode: value } }
      for (const listener of listeners) listener()
    },
  }
}

describe('Codex-like process fold', () => {
  it('keeps natural assistant messages native while folding Think, Tool and GenUI detail', () => {
    const nodes = new Map<string, any>([
      ['reasoning', {
        key: 'reasoning', kind: 'assistant-step', location: location(7),
        data: { status: 'running', blocks: [{ kind: 'reasoning', text: '内部思考' }] },
      }],
      ['context', {
        key: 'context', kind: 'context', location: location(7),
        data: { content: '内部上下文' },
      }],
      ['tool', {
        key: 'tool', kind: 'tool-call', location: location(7),
        data: { root: { callId: 'call-1', name: 'render_ui' } },
      }],
      ['progress', {
        key: 'progress', kind: 'assistant-step', location: location(7),
        data: {
          status: 'running',
          blocks: [
            { kind: 'reasoning', text: '第二段内部思考' },
            { kind: 'text', text: '正在为你整理页面。' },
          ],
        },
      }],
      ['final', {
        key: 'final', kind: 'assistant-step', location: location(7),
        data: { status: 'complete', blocks: [{ kind: 'text', text: '页面已经整理完成。' }] },
      }],
    ])
    const snapshot = { chat: { order: [...nodes.keys()], nodes } }
    const useSession = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
    const entries: any[] = [
      {
        options: { key: 'assistant-step', priority: 0 },
        component: ({ node }: any) => (
          <div data-native-assistant data-streaming={node.data.status === 'running' || undefined}>
            {node.data.blocks.map((block: any, index: number) => block.kind === 'reasoning'
              ? <div data-variant="think" key={index}>{block.text}</div>
              : <p key={index}>{block.text}</p>)}
          </div>
        ),
      },
      {
        options: { key: 'tool-call', priority: 0 },
        component: ({ node, renderSlot }: any) => (
          <div data-native-tool>
            {renderSlot('tool.call.toolview', { toolName: node.data.root.name }, {
              entryKey: node.data.root.name,
              fallback: <span>原生工具回退</span>,
            })}
          </div>
        ),
      },
      {
        options: { key: 'context', priority: 0 },
        component: () => <div data-native-context>上下文</div>,
      },
    ]
    const toolViews = [{
      options: { key: 'render_ui' },
      component: ({ toolName }: any) => <span>GenUI：{toolName}</span>,
    }]
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (options: unknown, component: unknown) => {
          const entry = { options, component }
          entries.push(entry)
          return () => { entries.splice(entries.indexOf(entry), 1) }
        },
        entries: () => entries,
        entriesOfSlot: () => toolViews,
        subscribe: () => () => {}, getVersion: () => 0,
      },
    }
    registerActivityFold(ctx, modeScope() as never)
    const renderer = (key: string) => entries.find(entry =>
      entry.options.key === key && entry.options.priority === -1).component
    const Assistant = renderer('assistant-step')
    const Tool = renderer('tool-call')
    const Context = renderer('context')
    const common = { sessionId: 'session-activity-fold', useSession }

    const view = render(<>
      <Assistant {...common} node={nodes.get('reasoning')} />
      <Context {...common} node={nodes.get('context')} />
      <Tool {...common} node={nodes.get('tool')} />
      <Assistant {...common} node={nodes.get('progress')} />
      <Assistant {...common} node={nodes.get('final')} />
    </>)

    const header = screen.getByRole('button', { name: /正在运行 · 1 次工具调用，2 条思考/u })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.querySelector('[data-emate-brain-icon]')).not.toBeNull()
    expect(screen.getByText('正在为你整理页面。')).toBeTruthy()
    expect(screen.getByText('页面已经整理完成。')).toBeTruthy()
    expect(view.container.querySelector('[data-streaming="true"]')).not.toBeNull()
    expect(screen.queryByText('内部思考')).toBeNull()
    expect(screen.queryByText('上下文')).toBeNull()
    expect(screen.queryByText('GenUI：render_ui')).toBeNull()
    expect(screen.getByText('正在为你整理页面。').closest('[data-native-assistant]')?.querySelector('[data-variant="think"]')).toBeNull()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('内部思考')).toBeTruthy()
    expect(screen.queryByText('上下文')).toBeNull()
    expect(screen.getByText('第二段内部思考')).toBeTruthy()
    expect(screen.getByText('GenUI：render_ui')).toBeTruthy()
    expect(screen.getByText('正在为你整理页面。')).toBeTruthy()
    expect(screen.getByText('页面已经整理完成。')).toBeTruthy()
    expect(screen.getByText('正在为你整理页面。').closest('[data-native-assistant]')?.querySelector('[data-variant="think"]')).toBeNull()
  })

  it('removes only the fold shadows when the persisted mode changes to detailed', () => {
    const entries: any[] = (['assistant-step', 'tool-call', 'context'] as const).map(key => ({
      options: { key, priority: 0 },
      component: ({ node }: any) => <div data-native={key}>{node.key}</div>,
    }))
    const scope = modeScope('broken')
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (options: unknown, component: unknown) => {
          const entry = { options, component }
          entries.push(entry)
          return () => { entries.splice(entries.indexOf(entry), 1) }
        },
        entries: () => entries,
        entriesOfSlot: () => [],
      },
    }

    registerActivityFold(ctx, scope as never)
    expect(entries.filter(entry => entry.options.priority === -1).map(entry => entry.options.key))
      .toEqual(['assistant-step', 'tool-call', 'context'])

    scope.publish('detailed')
    expect(entries.filter(entry => entry.options.priority === -1)).toEqual([])
    expect(entries.map(entry => entry.options.key)).toEqual(['assistant-step', 'tool-call', 'context'])

    scope.publish('simple')
    expect(entries.filter(entry => entry.options.priority === -1).map(entry => entry.options.key))
      .toEqual(['assistant-step', 'tool-call', 'context'])
  })

  it('keeps one historical node sequence across restart, interrupt, multiple tools and mode switches', () => {
    const nodes = [
      { key: 'reasoning-text', kind: 'assistant-step', data: { status: 'running', blocks: [
        { kind: 'reasoning', text: '分析中' }, { kind: 'text', text: '自然文本' },
      ] } },
      { key: 'tool-one', kind: 'tool-call', data: { root: { callId: 'call-1', name: 'render_ui' } } },
      { key: 'tool-two', kind: 'tool-call', data: { root: { callId: 'call-2', name: 'bash', status: 'interrupted' } } },
    ]
    const original = structuredClone(nodes)
    const entries: any[] = (['assistant-step', 'tool-call', 'context'] as const).map(key => ({
      options: { key, priority: 0 },
      component: ({ node }: any) => node,
    }))
    const scope = modeScope('detailed') // persisted value restored before this historical Session mounts
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (options: unknown, component: unknown) => {
          const entry = { options, component }
          entries.push(entry)
          return () => { entries.splice(entries.indexOf(entry), 1) }
        },
        entries: () => entries,
        entriesOfSlot: () => [],
      },
    }

    registerActivityFold(ctx, scope as never)
    expect(entries.filter(entry => entry.options.priority === -1)).toEqual([])

    scope.publish('simple')
    scope.publish('detailed')
    expect(entries.filter(entry => entry.options.priority === -1)).toEqual([])
    expect(nodes).toEqual(original)
    expect(nodes.map(node => node.key)).toEqual(['reasoning-text', 'tool-one', 'tool-two'])
  })

  it('never discloses injected context metadata, even when process detail is expanded', () => {
    const nodes = new Map<string, any>([
      ['context', { key: 'context', kind: 'context', location: location(9), data: { content: '内部上下文' } }],
      ['tool', { key: 'tool', kind: 'tool-call', location: location(9), data: { root: { callId: 'call-9', name: 'bash' } } }],
    ])
    expect(activityFoldSummary([...nodes.keys()], nodes, nodes.get('tool'))).toMatchObject({
      headerKey: 'tool',
      toolCount: 1,
    })
  })

  it('projects one process group without rewriting DSH nodes', () => {
    const nodes = new Map<string, any>([
      ['message', { key: 'message', kind: 'assistant-step', location: location(2), data: { blocks: [{ kind: 'text', text: '进度' }] } }],
      ['context', { key: 'context', kind: 'context', location: location(2), data: {} }],
      ['tool', { key: 'tool', kind: 'tool-call', location: location(2), data: { root: { kind: 'tool-result' } } }],
    ])
    expect(activityFoldSummary([...nodes.keys()], nodes, nodes.get('context'))).toEqual({
      turn: 2,
      headerKey: 'tool',
      toolCount: 1,
      reasoningCount: 0,
      running: false,
    })
    expect(cssSource).not.toContain("[data-emate-process-collapsed] :global([data-variant='think'])")
    expect(cssSource).toContain(':has([data-emate-process-hidden])')
    expect(cssSource).toContain('.header + *')
    expect(cssSource).toContain('margin-top: 8px')
  })
})

function streamingFoldHarness(register = registerActivityFold) {
  const first = { key: 'think', kind: 'assistant-step', location: location(1), data: { status: 'running', blocks: [{ kind: 'reasoning', text: 'first thought' }] } }
  let snapshot = { chat: { order: ['think'], nodes: new Map<string, any>([['think', first]]) } }
  const entries: any[] = ['assistant-step', 'tool-call', 'context'].map(key => ({ options: { key, priority: 0 },
    component: ({ node }: any) => <div>{node.data.blocks?.map((block: any) => block.text).join('') ?? node.key}</div> }))
  register({ slots: {
    inject: (_name: string, callback: () => unknown) => callback(),
    register: (options: any, component: any) => { const entry = { options, component }; entries.push(entry); return () => { entries.splice(entries.indexOf(entry), 1) } },
    entries: () => entries, entriesOfSlot: () => [],
  } }, modeScope() as never)
  return {
    update(nodes: any[]) { snapshot = { chat: { order: nodes.map(node => node.key), nodes: new Map(nodes.map(node => [node.key, node])) } } },
    rows(sessionId: string) { return <>{snapshot.chat.order.map(key => {
      const node = snapshot.chat.nodes.get(key)!
      const Component = entries.find(entry => entry.options.key === node.kind && entry.options.priority === -1).component
      return <Component key={key} node={node} sessionId={sessionId} useSession={(selector: any) => selector(snapshot)} />
    })}</> }, first,
  }
}
it('keeps manual running collapse through streaming, new steps, completion, turns and same-runtime remount', () => {
  const h = streamingFoldHarness(), id = 'stream-fold-lifecycle'
  let view = render(h.rows(id))
  let header = screen.getByRole('button', { name: /正在运行 · 1 条思考/ })
  fireEvent.click(header); expect(screen.getByText('first thought')).toBeTruthy()
  fireEvent.click(header); expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('first thought')).toBeNull()
  const streamed = { ...h.first, data: { ...h.first.data, blocks: [{ kind: 'reasoning', text: 'updated thought' }] } }
  const tool = { key: 'tool-first', kind: 'tool-call', location: location(1), data: { root: { callId: 'call-first' } } }
  h.update([streamed, tool]); view.rerender(h.rows(id))
  header = screen.getByRole('button', { name: /正在运行 · 1 次工具调用，1 条思考/ })
  expect(header.getAttribute('aria-expanded')).toBe('false'); expect(screen.queryByText('updated thought')).toBeNull(); expect(screen.queryByText('tool-first')).toBeNull()
  const finished = { ...streamed, data: { ...streamed.data, status: 'complete' } }
  const result = { ...tool, data: { root: { kind: 'tool-result' } } }
  h.update([finished, result]); view.rerender(h.rows(id))
  header = screen.getByRole('button', { name: /运行过程 · 1 次工具调用，1 条思考/ })
  expect(header.getAttribute('aria-expanded')).toBe('false')
  fireEvent.keyDown(header, { key: 'Enter' }); expect(screen.getByText('updated thought')).toBeTruthy()
  fireEvent.keyDown(header, { key: ' ' }); expect(screen.queryByText('updated thought')).toBeNull()
  view.unmount(); view = render(h.rows(id)); expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('button')); view.unmount(); view = render(h.rows(id))
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  h.update([finished, result, { ...h.first, key: 'next-think', location: location(2) }]); view.rerender(h.rows(id))
  expect(screen.getByRole('button', { name: /正在运行 · 1 条思考/ }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: /运行过程 · 1 次工具调用/ }).getAttribute('aria-expanded')).toBe('true')
  view.unmount()
})
it('starts process folds collapsed after a fresh module runtime without rewriting restored nodes', async () => {
  const id = 'fold-fresh-runtime', old = streamingFoldHarness()
  const first = render(old.rows(id)); fireEvent.click(screen.getByRole('button')); expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true'); first.unmount()
  vi.resetModules()
  const { registerActivityFold: restoredRegister } = await import('../src/client/activity-fold.tsx')
  const restored = streamingFoldHarness(restoredRegister)
  const view = render(restored.rows(id))
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  expect(restored.first.data.blocks[0].text).toBe('first thought')
  view.unmount()
})

it.each(['fallback', 'dry', 'assembly'] as const)('keeps the process fold elected after a faulty atomic ToolView: %s', async (mode) => {
  const core = new SlotCore(), errors: { key: string; error: unknown }[] = []
  const crash = mode === 'assembly' ? new SlotAssemblyError('missing native provider') : new Error('atomic view failed'), reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  const nodes = new Map<string, any>([
    ['reasoning', { key: 'reasoning', kind: 'assistant-step', location: location(61), data: { status: 'running', blocks: [{ kind: 'reasoning', text: 'live reasoning' }, { kind: 'text', text: 'PPTX 已成功导出，五页预览也已逐页检查。现在做最后文件核验。' }] } }],
    ['tool-one', { key: 'tool-one', kind: 'tool-call', location: location(61), data: { root: { callId: 'one', name: 'broken' } } }],
    ['tool-two', { key: 'tool-two', kind: 'tool-call', location: location(61), data: { root: { callId: 'two', name: 'working' } } }],
    ['progress', { key: 'progress', kind: 'assistant-step', location: location(61), data: { status: 'complete', blocks: [{ kind: 'text', text: '文件已完成，请查看最终结果。' }] } }],
  ])
  const snapshot = { chat: { order: [...nodes.keys()], nodes } }, info = { sessionId: `real-fold-crash-${mode}`, hooks: {}, props: {} }, localeSnapshot = { revision: 0 }
  const host: any = {
    subscribe: (key: string, fn: () => void) => core.subscribe(key, fn), getVersion: (key: string) => core.getVersion(key),
    entriesOf: (key: string) => core.entries(key), entriesOfSlot: (key: string) => core.entriesOfSlot(key),
    reportEntryError: (key: string, entry: any, error: unknown, value: any) => { errors.push({ key, error }); core.reportEntryError(key, entry, error, value) },
    specOf: (key: string) => core.specDynamic(key), isLive: (entry: any) => core.isLive(entry), storeOf: () => undefined,
    locale: { getSnapshot: () => localeSnapshot, subscribe: () => () => {}, bind: () => (key: string) => key },
    sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} }, provideInfo: { getSnapshot: () => info, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
  }
  core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } } as any,
    (({ renderSlot }: any) => <SessionProvider>{() => <>{snapshot.chat.order.map(key => <div key={key}>{renderSlot('conversation.chat.node', {
      node: nodes.get(key), useSession: (selector: any) => selector(snapshot),
    }, { entryKey: nodes.get(key).kind })}</div>)}</>}</SessionProvider>) as any)
  core.register({ name: 'conversation.chat.node', key: 'assistant-step', locale: 'conversation' } as any,
    (({ node }: any) => <p>{node.data.blocks[0].text}</p>) as any)
  core.register({ name: 'conversation.chat.node', key: 'context' } as any, (() => null) as any)
  core.register({ name: 'conversation.chat.node', key: 'tool-call', locale: 'conversation', children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as any,
    (({ node, renderSlot }: any) => <div>{renderSlot('tool.call.toolview', { callId: node.data.root.callId }, { entryKey: node.data.root.name, fallback: <span>native generic fallback</span> })}</div>) as any)
  const bad = core.register({ name: 'tool.call.toolview', key: 'broken', priority: -1 } as any, (() => { throw crash }) as any)
  if (mode === 'fallback') core.register({ name: 'tool.call.toolview', key: 'broken' } as any, (() => <span>native broken fallback</span>) as any)
  core.register({ name: 'tool.call.toolview', key: 'working' } as any, (() => <span>working tool</span>) as any)
  registerActivityFold({ slots: {
    register: (options: any, component: any) => core.register(options, component), entries: (key: string) => core.entries(key),
    entriesOfSlot: host.entriesOfSlot, subscribe: host.subscribe, getVersion: host.getVersion, reportEntryError: host.reportEntryError,
    inject: (_key: string, callback: () => void) => callback(),
  } }, modeScope() as never)
  const mount = () => render(<>{createSlotRenderer().renderRoot(host, {})}</>)
  let view = mount()
  expect(screen.getByText('PPTX 已成功导出，五页预览也已逐页检查。现在做最后文件核验。')).toBeTruthy()
  expect(screen.getByText('文件已完成，请查看最终结果。')).toBeTruthy()
  if (mode === 'assembly') {
    await expect(act(async () => fireEvent.click(screen.getByRole('button', { name: /正在运行 · 2 次工具调用/ })))).rejects.toBe(crash)
    expect(errors).toEqual([])
    return
  }
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /正在运行 · 2 次工具调用/ })))
  expect(core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'tool-call')?.options.priority).toBe(-1)
  expect(errors).toEqual([{ key: 'tool.call.toolview', error: crash }])
  if (mode === 'fallback') expect(screen.getByText('native broken fallback')).toBeTruthy()
  else {
    expect(view.container.querySelector('[data-slot-error="tool.call.toolview"]')).not.toBeNull()
    expect(screen.queryByText('native generic fallback')).toBeNull()
  }
  expect(screen.getByText('working tool')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /正在运行 · 2 次工具调用/ })))
  expect(screen.queryByText('native broken fallback')).toBeNull(); expect(screen.queryByText('working tool')).toBeNull()
  expect(screen.getByText('PPTX 已成功导出，五页预览也已逐页检查。现在做最后文件核验。')).toBeTruthy()
  expect(screen.getByText('文件已完成，请查看最终结果。')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /正在运行 · 2 次工具调用/ })))
  if (mode === 'fallback') expect(screen.getByText('native broken fallback')).toBeTruthy()
  else expect(view.container.querySelector('[data-slot-error="tool.call.toolview"]')).not.toBeNull()
  expect(errors).toHaveLength(1)
  view.unmount(); await act(async () => bad())
  const replacement = core.register({ name: 'tool.call.toolview', key: 'broken', priority: -1 } as any, (() => <span>reinstalled view</span>) as any)
  view = mount(); expect(screen.getByText('reinstalled view')).toBeTruthy()
  view.unmount(); replacement(); reported.mockRestore()
})
