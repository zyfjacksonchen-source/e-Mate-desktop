import React from 'react'
import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '../../../upstream/deepseek-harness/packages/test-support/client-runtime/src/index.ts'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })
it('mounts native navigation, jumps to a user row and preserves manual history loading', async () => {
  document.body.innerHTML = '<main data-conversation-scroll><button id="older">加载更早</button><div data-chat-anchor-key="user:1" data-chat-flow-kind="user">first</div></main>'
  const host = document.querySelector('main')!
  const scroll = vi.fn()
  const fillRect = vi.fn(), beginPath = vi.fn()
  Object.assign(host, { scrollTo: scroll })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { left: this === host ? 0 : 100, top: 100, width: 1000, height: 600, right: 1000, bottom: 700, x: 0, y: 100, toJSON: () => ({}) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, fillRect, setTransform() {}, beginPath, moveTo() {}, lineTo() {}, closePath() {}, fill() {} } as never)
  const runtime = await SlotTestRuntime.create()
  const id = await runtime.sessions.add({ id: 'tidychat-test', snapshot: { nodes: [{ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: 'first' }] }] } } as never)
  runtime.provide('webUiSettings', { bind: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: { autoLoad: true, navAccent: 'blue' } }), subscribe: () => () => {} }) })
  const loads = vi.fn()
  document.getElementById('older')!.addEventListener('click', loads)
  try {
    await runtime.declare({ 'conversation.session.header.utilities': { kind: 'list', scope: 'session' } } as never)
    await runtime.mount({ apply, inject: [...inject] })
    const view = runtime.renderSlot('conversation.session.header.utilities' as never, { sessionId: id } as never)
    await waitFor(() => expect(view.container.querySelectorAll('canvas')).toHaveLength(1))
    const rail = within(view.container).getByRole('slider', { name: '用户消息定位' })
    expect(rail.getAttribute('tabindex')).toBe('0')
    await waitFor(() => expect(fillRect.mock.calls.some(call => call[2] === 22 && call[3] === 3)).toBe(true))
    expect(beginPath).not.toHaveBeenCalled() // No triangular pointer.
    expect(document.documentElement.style.getPropertyValue('--tidychat-nav-color-hot')).toBe('#242424')
    fireEvent.keyDown(rail, { key: 'End' })
    fireEvent.keyDown(rail, { key: 'Enter' })
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('.tidychat-nav-tip')?.textContent).toContain('first')
    fireEvent.blur(rail)
    scroll.mockClear()
    fireEvent.pointerUp(view.container.querySelector('canvas')!, { clientY: 105 })
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(loads).not.toHaveBeenCalled()
    fireEvent.click(document.getElementById('older')!)
    expect(loads).toHaveBeenCalledTimes(1)
  } finally { await runtime.dispose() }
})

it('mounts the keyed native settings slot with fold/navigation controls but no automatic-loading control', async () => {
  const runtime = await SlotTestRuntime.create()
  const set = vi.fn(async () => {})
  runtime.provide('webUiSettings', { bind: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: { autoLoad: true } }), subscribe: () => () => {}, set }) })
  try {
    await runtime.root.declare({ 'settings.plugin.item': { kind: 'keyed' } } as never,
      (({ renderSlot }: any) => <>{renderSlot('settings.plugin.item', {}, { entryKey: 'tidychat' })}</>) as never)
    await runtime.mount({ apply, inject: [...inject] })
    const view = runtime.renderRoot()
    fireEvent.click(view.getByText('会话整理'))
    await waitFor(() => expect(view.getAllByRole('switch')).toHaveLength(3))
    expect(view.queryByText('智能加载更早历史')).toBeNull()
    fireEvent.click(view.getAllByRole('switch')[2])
    expect(set).toHaveBeenCalledWith('navigator', false)
  } finally { await runtime.dispose() }
})


it('draws compact quiet ticks with stable 12px spacing and progressively longer neighbours', async () => {
  document.body.innerHTML = '<main data-conversation-scroll>' + Array.from({ length: 6 }, (_, i) => `<div data-chat-anchor-key="user:${i + 1}" data-chat-flow-kind="user">message ${i + 1}</div>`).join('') + '</main>'
  const host = document.querySelector('main')!
  Object.assign(host, { scrollTo: vi.fn() })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const seq = Number(this.getAttribute('data-chat-anchor-key')?.split(':')[1] ?? 1)
    const top = 100 + (seq - 1) * 200
    return { left: this === host ? 0 : 100, top, width: 1000, height: 600, right: 1000, bottom: top + 600, x: 0, y: top, toJSON: () => ({}) }
  })
  const draw = vi.fn(), triangle = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, fillRect: draw, setTransform() {}, beginPath: triangle } as never)
  const runtime = await SlotTestRuntime.create()
  const id = await runtime.sessions.add({ id: 'tidychat-ticks', snapshot: { nodes: Array.from({ length: 6 }, (_, i) => ({ kind: 'user', seq: i + 1, time: 1, content: [{ type: 'text', text: `message ${i + 1}` }] })) } } as never)
  runtime.provide('webUiSettings', { bind: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: {} }), subscribe: () => () => {} }) })
  try {
    await runtime.declare({ 'conversation.session.header.utilities': { kind: 'list', scope: 'session' } } as never)
    await runtime.mount({ apply, inject: [...inject] })
    const view = runtime.renderSlot('conversation.session.header.utilities' as never, { sessionId: id } as never)
    await waitFor(() => expect(draw.mock.calls.slice(-6).map(call => call[2])[0]).toBe(22))
    const ticks = draw.mock.calls.slice(-6)
    expect(ticks.every(call => call[3] === 3)).toBe(true)
    expect(ticks.slice(1).map((call, i) => call[1] - ticks[i][1])).toEqual([12, 12, 12, 12, 12])
    expect(ticks.slice(-2).map(call => call[2])).toEqual([14, 14])
    expect(ticks[0][2]).toBeGreaterThan(ticks[1][2])
    expect(ticks[1][2]).toBeGreaterThan(ticks[2][2])
    expect(ticks[2][2]).toBeGreaterThan(ticks[3][2])
    expect(triangle).not.toHaveBeenCalled()
    const rail = within(view.container).getByRole('slider')
    fireEvent.keyDown(rail, { key: 'End' })
    expect(rail.getAttribute('aria-valuenow')).toBe('6')
    fireEvent.keyDown(rail, { key: ' ' })
    expect(host.scrollTo).toHaveBeenCalledTimes(1)
  } finally { await runtime.dispose() }
})
