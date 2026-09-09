import React from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '../../../upstream/deepseek-harness/packages/test-support/client-runtime/src/index.ts'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })
it('mounts native navigation, jumps to a user row and preserves manual history loading', async () => {
  document.body.innerHTML = '<main data-conversation-scroll><button id="older">加载更早</button><div data-chat-anchor-key="user:1" data-chat-flow-kind="user">first</div></main>'
  const host = document.querySelector('main')!
  const scroll = vi.fn()
  Object.assign(host, { scrollTo: scroll })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { left: this === host ? 0 : 100, top: 100, width: 1000, height: 600, right: 1000, bottom: 700, x: 0, y: 100, toJSON: () => ({}) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, fillRect() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {} } as never)
  const runtime = await SlotTestRuntime.create()
  const id = await runtime.sessions.add({ id: 'tidychat-test', snapshot: { nodes: [{ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: 'first' }] }] } } as never)
  runtime.provide('webUiSettings', { bind: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: { autoLoad: true } }), subscribe: () => () => {} }) })
  const loads = vi.fn()
  document.getElementById('older')!.addEventListener('click', loads)
  try {
    await runtime.declare({ 'conversation.session.header.utilities': { kind: 'list', scope: 'session' } } as never)
    await runtime.mount({ apply, inject: [...inject] })
    const view = runtime.renderSlot('conversation.session.header.utilities' as never, { sessionId: id } as never)
    await waitFor(() => expect(view.container.querySelectorAll('canvas')).toHaveLength(1))
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
