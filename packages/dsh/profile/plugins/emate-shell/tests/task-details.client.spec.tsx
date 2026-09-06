// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskDetails, registerPetTaskDetails } from '../src/client/task-details.tsx'

afterEach(cleanup)

it('shows native task facts and never invents completion from an idle session', () => {
  const props: any = {
    sessionId: 'task', taskId: 'task', close: vi.fn(),
    useSession: (read: any) => read({ running: false, lastAgentError: null, pending: [], runningCalls: [], queue: [{ id: 1 }] }),
    useSessions: (read: any) => read({ byId: { task: { title: '整理报告' } }, jobsBySession: { task: [{ jobId: 'j', status: 'running' }] } }),
    useProjection: (key: string) => key === 'goal' ? { goal: { objective: '完成报告', phase: 'active' } }
      : [{ content: '核对数据', status: 'in_progress' }],
  }
  const view = render(<TaskDetails {...props} />)
  expect(screen.getByRole('heading', { name: '整理报告' })).toBeTruthy()
  expect(screen.getByText('后台作业进行中')).toBeTruthy()
  expect(screen.getByText('完成报告')).toBeTruthy()
  expect(screen.getByText('核对数据')).toBeTruthy()
  expect(screen.queryByText('已完成')).toBeNull()
  view.rerender(<TaskDetails {...props} sessionId="another" />)
  expect(screen.queryByText('完成报告')).toBeNull()
  expect(screen.getByText('已切换任务，请点击小芯查看当前任务。')).toBeTruthy()
})

it('preserves the canvas on save failure and releases each shared details seat once', async () => {
  let service: any
  let disposeEffect: any
  let failSave = true
  const panelDispose = vi.fn()
  const register = vi.fn(() => panelDispose)
  const leave = vi.fn(async () => { if (failSave) throw Error('conflict') })
  const notify = vi.fn()
  const ctx = {
    get: () => ({ beforeNavigate: leave }), sessions: { list: { getSnapshot: () => ({ current: 'task' }) }, binding: () => ({ session: {} }), open: vi.fn() },
    layout: { openDetails: vi.fn(), closeDetails: vi.fn() }, slots: { register },
    reflect: { provide: (_: string, value: any) => { service = value; return vi.fn() } },
    effect: (install: any) => { disposeEffect = install() },
  }
  registerPetTaskDetails(ctx, notify)
  await act(async () => { service.openTaskDetails('task') })
  expect(notify).toHaveBeenCalledOnce()
  expect(register).not.toHaveBeenCalled()
  expect(ctx.sessions.open).not.toHaveBeenCalled()
  failSave = false
  await act(async () => { service.openTaskDetails('task') })
  expect(ctx.sessions.open).toHaveBeenCalledWith('task')
  expect(ctx.layout.openDetails).toHaveBeenCalledOnce()
  service.release()
  disposeEffect()
  expect(panelDispose).toHaveBeenCalledOnce()
})

it('does not return to an old task when a canvas save finishes after navigation', async () => {
  let service: any
  let current = 'task-a'
  let finishSave!: () => void
  const saving = new Promise<void>(resolve => { finishSave = resolve })
  const ctx = {
    get: () => ({ beforeNavigate: () => saving }),
    sessions: { list: { getSnapshot: () => ({ current }) }, binding: () => ({ session: {} }), open: vi.fn() },
    layout: { openDetails: vi.fn(), closeDetails: vi.fn() }, slots: { register: vi.fn() },
    reflect: { provide: (_: string, value: any) => { service = value; return vi.fn() } },
    effect: (install: any) => install(),
  }
  const notify = vi.fn()
  registerPetTaskDetails(ctx, notify)
  service.openTaskDetails('task-a')
  current = 'task-b'
  await act(async () => { finishSave(); await saving })
  expect(ctx.sessions.open).not.toHaveBeenCalled()
  expect(ctx.slots.register).not.toHaveBeenCalled()
  expect(ctx.layout.openDetails).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('opens the existing pet settings section only after canvas save succeeds', async () => {
  let service: any
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
  const ctx = {
    get: () => ({ beforeNavigate: async () => { if (fail) throw Error('conflict') } }),
    sessions: { list: { getSnapshot: () => ({ current: 'task' }) } },
    reflect: { provide: (_: string, value: any) => { service = value; return vi.fn() } },
    effect: (install: any) => install(),
  }
  try {
    registerPetTaskDetails(ctx, notify)
    await act(async () => { service.openPetSettings() })
    expect(notify).toHaveBeenCalledOnce()
    expect(sectionClick).not.toHaveBeenCalled()
    fail = false
    await act(async () => { service.openPetSettings() })
    expect(sectionClick).toHaveBeenCalledOnce()
  } finally { document.body.replaceChildren() }
})
