import React, { useEffect } from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

vi.mock('http://localhost:3000/emate-canvas-assets/editor.js', () => ({}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function deferred() {
  let resolve!: (value: any) => void
  return { promise: new Promise<any>(done => { resolve = done }), resolve: (value: any) => resolve(value) }
}
function harness() {
  vi.stubGlobal('location', { origin: 'http://localhost:3000' })
  const module = deferred(), attachment = deferred(), nativeStore = {}
  const actions = { setView: vi.fn() }
  let current = 'a', service: any, Page: any
  const ctx = {
    modules: { import: vi.fn(() => module.promise) },
    sessions: { list: { getSnapshot: () => ({ current }) }, binding: () => ({ session: {} }), open: vi.fn() },
    connection: { rpc: { call: vi.fn(() => attachment.promise) } },
    slots: { entries: () => [{ store: nativeStore }],
      register: vi.fn((options: any, component: any) => {
        if (options.name === 'conversation.view') Page = component
        if (options.id === 'e-mate-canvas-navigation') options.inject('a', actions)
        return () => {}
      }), inject: (_name: string, callback: () => unknown) => callback() },
    layout: { openDetails: vi.fn(), closeDetails: vi.fn() },
    reflect: { provide: (_key: string, value: any) => { service = value; return () => {} } },
    effect: (callback: () => unknown) => callback(), get: vi.fn(),
  }
  apply(ctx)
  return { ctx, service, module, attachment, actions, nativeStore, Page, switchTo: (id: string) => { current = id } }
}
it('registers the adjacent native view with the same store and opens without details or a header button', async () => {
  const h = harness()
  expect(h.ctx.slots.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'conversation.view', id: 'e-mate-canvas', order: 19, label: '画布', store: h.nativeStore }), expect.any(Function))
  await h.service.open('a')
  expect(h.actions.setView).toHaveBeenCalledWith('e-mate-canvas')
  expect(h.ctx.layout.openDetails).not.toHaveBeenCalled()
  expect(h.ctx.modules.import).not.toHaveBeenCalled()
  expect(h.ctx.slots.register.mock.calls.some(([entry]) => entry.name === 'details' || entry.id === 'e-mate-canvas-open')).toBe(false)
})
it('drops an open when the current session changes during flush', async () => {
  const h = harness(), opening = h.service.open('a')
  h.switchTo('b'); await opening
  expect(h.actions.setView).not.toHaveBeenCalled()
})
it('drops an image resolution that finishes after navigating away', async () => {
  const h = harness()
  const opening = h.service.insertAttachment('a', 'a', `sha256:${'a'.repeat(64)}`)
  await vi.waitFor(() => expect(h.ctx.connection.rpc.call).toHaveBeenCalled())
  h.switchTo('b'); h.attachment.resolve({ ok: true, value: {} }); await opening
  expect(h.actions.setView).not.toHaveBeenCalled()
})
it('native navigation guard awaits save and rejects conflict without changing views', async () => {
  const h = harness(), saved = deferred()
  const flush = vi.fn(() => saved.promise)
  h.module.resolve({ CanvasPanel({ bridge }: any) { useEffect(() => bridge.beforeLeave(flush), [bridge]); return <div>Canvas ready</div> } })
  render(<h.Page sessionId="a" actions={h.actions} />)
  await screen.findByText('Canvas ready')
  expect(h.service.activeSessionId()).toBe('a')
  const leaving = h.service.beforeNavigate()
  expect(flush).toHaveBeenCalledOnce()
  expect(h.actions.setView).not.toHaveBeenCalled()
  saved.resolve(undefined); await leaving
  flush.mockImplementationOnce(() => Promise.reject(new Error('save conflict')))
  await expect(h.service.beforeNavigate()).rejects.toThrow('save conflict')
  expect(h.actions.setView).not.toHaveBeenCalled()
})
it('a same-session native navigation cancels a pending Gallery insertion', async () => {
  const h = harness()
  const opening = h.service.insertAttachment('a', 'a', `sha256:${'a'.repeat(64)}`)
  await vi.waitFor(() => expect(h.ctx.connection.rpc.call).toHaveBeenCalled())
  expect(h.service.activeSessionId()).toBe('a')
  await h.service.beforeNavigate()
  h.attachment.resolve({ ok: true, value: {} }); await opening
  expect(h.actions.setView).not.toHaveBeenCalled()
})
it('returning to the page never reinserts a consumed Gallery asset', async () => {
  const h = harness()
  const received: any[] = []
  h.module.resolve({ CanvasPanel({ initialAsset, onInitialAssetConsumed }: any) {
    useEffect(() => { received.push(initialAsset); if (initialAsset) onInitialAssetConsumed() }, [])
    return <div>Opened</div>
  } })
  const asset = { ref: { attachmentId: `sha256:${'a'.repeat(64)}` }, ownerSessionId: 'a' }
  h.attachment.resolve({ ok: true, value: asset })
  await h.service.insertAttachment('a', 'a', asset.ref.attachmentId)
  const first = render(<h.Page sessionId="a" actions={h.actions} />)
  await screen.findByText('Opened'); first.unmount()
  render(<h.Page sessionId="a" actions={h.actions} />)
  await screen.findByText('Opened')
  expect(received).toEqual([asset, undefined])
})
