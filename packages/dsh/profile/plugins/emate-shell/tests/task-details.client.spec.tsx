// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '../../../../../../upstream/deepseek-harness/packages/test-support/client-runtime/lib/index.js'
import {
  apply as applySidebarRight,
  inject as sidebarRightInject,
} from '../../../../../../upstream/deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts'
import { TaskDetails, registerPetTaskDetails } from '../src/client/task-details.tsx'

afterEach(cleanup)

/** The shares every task-details render site provides; a test overrides what it asserts on. */
function props(overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: 'task', taskId: 'task', close: vi.fn(),
    useSessionPendingInteraction: () => false,
    useSession: (read: any) => read({ running: false, lastAgentError: null, queue: [] }),
    useSessions: (read: any) => read({ byId: {}, jobsBySession: {} }),
    useProjection: () => undefined,
    ...overrides,
  }
}

/** A feature ctx for the register path: the native faces the panel registers through, plus the owners it reads. */
function featureContext(overrides: Record<string, unknown> = {}): any {
  const ctx = {
    get: () => undefined,
    sessions: {
      list: { getSnapshot: () => ({ current: 'task' }) },
      binding: () => ({ session: {} }),
      open: vi.fn(),
    },
    sidebarRight: { openTab: vi.fn(), close: vi.fn() },
    sidebarRightTabs: { register: vi.fn(() => vi.fn()) },
    slots: { inject: (_name: string, contribute: () => void) => contribute(), register: vi.fn(() => vi.fn()) },
    reflect: { provide: (_name: string, value: unknown) => { ctx.service = value; return vi.fn() } },
    effect: (install: () => () => void) => install(),
    service: undefined as any,
    ...overrides,
  }
  return ctx
}

it('shows native task facts and never invents completion from an idle session', () => {
  const view = render(<TaskDetails {...props({
    useSession: (read: any) => read({ running: false, lastAgentError: null, queue: [{ id: 1 }] }),
    useSessions: (read: any) => read({ byId: { task: { title: '整理报告' } }, jobsBySession: { task: [{ jobId: 'j', status: 'running' }] } }),
    useProjection: (key: string) => key === 'goal' ? { goal: { objective: '完成报告', phase: 'active' } }
      : [{ content: '核对数据', status: 'in_progress' }],
  })} />)
  expect(screen.getByRole('heading', { name: '整理报告' })).toBeTruthy()
  expect(screen.getByText('后台作业进行中')).toBeTruthy()
  expect(screen.getByText('完成报告')).toBeTruthy()
  expect(screen.getByText('核对数据')).toBeTruthy()
  expect(screen.queryByText('已完成')).toBeNull()
  view.rerender(<TaskDetails {...props({ sessionId: 'another' })} />)
  expect(screen.queryByText('完成报告')).toBeNull()
  expect(screen.getByText('已切换任务，请点击小芯查看当前任务。')).toBeTruthy()
})

it('reports a waiting interaction from the native pending-interaction owner', () => {
  render(<TaskDetails {...props({
    useSession: (read: any) => read({ running: true, lastAgentError: null, queue: [] }),
    useSessionPendingInteraction: (read: any) => read(new Map([['task', { key: 'ask', kind: 'ask-user', sessionId: 'task' }]])),
  })} />)
  expect(screen.getByRole('status').textContent).toBe('等待处理')
  expect(screen.getByText('等待处理事项').nextElementSibling?.textContent).toBe('1')
})

it('preserves the canvas on save failure and opens the native page only once the save succeeded', async () => {
  let failSave = true
  const disposeType = vi.fn()
  const panelRegistrations = [vi.fn(), vi.fn()]
  const leave = vi.fn(async () => { if (failSave) throw Error('conflict') })
  const notify = vi.fn()
  const ctx = featureContext({
    get: () => ({ beforeNavigate: leave }),
    sidebarRightTabs: { register: vi.fn(() => disposeType) },
    slots: { inject: (_name: string, contribute: () => void) => contribute(),
      register: vi.fn().mockReturnValueOnce(panelRegistrations[0]).mockReturnValueOnce(panelRegistrations[1]) },
  })
  let disposeEffect: any
  ctx.effect = (install: any) => { disposeEffect = install() }

  registerPetTaskDetails(ctx, notify)
  await act(async () => { ctx.service.openTaskDetails('task') })
  expect(notify).toHaveBeenCalledOnce()
  expect(ctx.sidebarRight.openTab).not.toHaveBeenCalled()
  expect(ctx.sessions.open).not.toHaveBeenCalled()
  expect(ctx.sidebarRightTabs.register).toHaveBeenCalledWith(expect.objectContaining({
    id: 'e-mate.task-details', kind: 'e-mate-task-details',
  }))
  expect(vi.mocked(ctx.slots.register).mock.calls.map(([entry]: any[]) => entry))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sidebar.right.pane.tab', key: 'e-mate.task-details' }),
      expect.objectContaining({ name: 'sidebar.right.pane.tab.title', key: 'e-mate.task-details' }),
    ]))

  failSave = false
  await act(async () => { ctx.service.openTaskDetails('task') })
  expect(ctx.sessions.open).toHaveBeenCalledWith('task')
  expect(ctx.sidebarRight.openTab).toHaveBeenCalledWith('e-mate-task-details', { params: { taskId: 'task' } })

  disposeEffect()
  for (const dispose of [...panelRegistrations, disposeType]) expect(dispose).toHaveBeenCalledOnce()
})

it('does not return to an old task when a canvas save finishes after navigation', async () => {
  let current = 'task-a'
  let finishSave!: () => void
  const saving = new Promise<void>(resolve => { finishSave = resolve })
  const notify = vi.fn()
  const ctx = featureContext({
    get: () => ({ beforeNavigate: () => saving }),
    sessions: { list: { getSnapshot: () => ({ current }) }, binding: () => ({ session: {} }), open: vi.fn() },
  })
  registerPetTaskDetails(ctx, notify)
  ctx.service.openTaskDetails('task-a')
  current = 'task-b'
  await act(async () => { finishSave(); await saving })
  expect(ctx.sessions.open).not.toHaveBeenCalled()
  expect(ctx.sidebarRight.openTab).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('opens the existing pet settings section only after canvas save succeeds', async () => {
  let fail = true
  const notify = vi.fn()
  const sectionClick = vi.fn()
  const trigger = document.createElement('button')
  trigger.dataset.emateSettingsTrigger = ''
  trigger.onclick = () => {
    const section = document.createElement('button')
    section.dataset.settingsSectionId = 'appearance-motion'
    section.onclick = sectionClick
    document.body.append(section)
  }
  document.body.append(trigger)
  const ctx = featureContext({ get: () => ({ beforeNavigate: async () => { if (fail) throw Error('conflict') } }) })
  try {
    registerPetTaskDetails(ctx, notify)
    await act(async () => { ctx.service.openPetSettings() })
    expect(notify).toHaveBeenCalledOnce()
    expect(sectionClick).not.toHaveBeenCalled()
    fail = false
    await act(async () => { ctx.service.openPetSettings() })
    expect(sectionClick).toHaveBeenCalledOnce()
  } finally { document.body.replaceChildren() }
})

it('opens the panel as a native right-column page and renders the task it was opened for', async () => {
  const runtime = await SlotTestRuntime.create()
  try {
    const frame = { openRightbar: vi.fn(), closeRightbar: vi.fn() }
    const locale = {
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
      register: () => () => {},
      bind: () => (key: string) => key,
    }
    runtime.ctx.provide('layout', frame as never)
    runtime.ctx.provide('resources', { pin: vi.fn() } as never)
    runtime.ctx.provide('locale', locale as never)
    runtime.slots.installLocale(locale as never)
    await runtime.declare({ rightbar: { kind: 'single', scope: 'root' } } as never)
    await runtime.sessions.add({ id: 'task', summary: { title: '整理报告' } })
    runtime.sessions.behavior('task').projections.set('goal', { goal: { objective: '完成报告', phase: 'active' } })
    runtime.sessions.behavior('task').projections.set('todos', [{ content: '核对数据', status: 'in_progress' }])
    // The real native right-column owner: its registry, tab domain, store, and seat.
    await runtime.mount({ inject: [...sidebarRightInject], apply: applySidebarRight })
    await runtime.mount({
      inject: ['slots', 'sessions', 'sidebarRight', 'sidebarRightTabs'],
      apply: (ctx: any) => { registerPetTaskDetails(ctx, vi.fn()) },
    })
    const rightbar = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true } as never)
    const view = rightbar.view

    expect(view.queryByLabelText('任务详情')).toBeNull()
    await act(async () => { runtime.ctx.get('ematePetDetails')!.openTaskDetails('task') })
    await runtime.flush()

    expect(frame.openRightbar).toHaveBeenCalled()
    expect(runtime.ctx.sidebarRight.active()?.kind).toBe('e-mate-task-details')
    expect(view.getByLabelText('任务详情')).not.toBeNull()
    expect(view.getByRole('heading', { name: '整理报告' })).not.toBeNull()
    expect(view.getByText('完成报告')).not.toBeNull()
    expect(view.getByText('核对数据')).not.toBeNull()
    expect(view.getByRole('status').textContent).toBe('目标进行中')

    // The panel's own close control goes through the native controller.
    act(() => { view.getByRole('button', { name: '关闭' }).click() })
    await runtime.flush()
    expect(runtime.ctx.sidebarRight.active()?.kind).not.toBe('e-mate-task-details')
  } finally {
    await runtime.dispose()
  }
})

it('labels native killed Jobs as cancelled while preserving completed and failed states', () => {
  render(<TaskDetails {...props({
    useSession: (read: any) => read({ running: false, lastAgentError: null, queue: [] }),
    useSessions: (read: any) => read({ byId: { task: { title: '任务状态' } }, jobsBySession: { task: [
      { id: 'killed-job', status: 'killed' }, { id: 'completed-job', status: 'completed' }, { id: 'failed-job', status: 'failed' },
    ] } }),
  })} />)
  expect(screen.getByText('作业 1 · 已取消')).toBeTruthy()
  expect(screen.getByText('作业 2 · 已完成')).toBeTruthy()
  expect(screen.getByText('作业 3 · 失败')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('当前未执行')
  expect(screen.queryByText(/状态待同步/)).toBeNull()
})
