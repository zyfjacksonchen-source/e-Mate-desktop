import React, { useEffect } from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { createBridge } from '../src/client/bridge.ts'

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

it('refreshes outputs only for native parent and direct-child image projections while retaining the session subscription', () => {
  const listListeners = new Set<() => void>(), sessionListeners = new Set<() => void>()
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const row = (id: string, parentId?: string) => ({ id, parentId, displayTitle: id, running: false, blank: false, updatedAt: 1,
    projectionValues: { eMateImageReceipts: [] as unknown[], eMateImageBatches: [] as unknown[], title: id } })
  let list: any = { ids: ['parent', 'child', 'other'], byId: { parent: row('parent'), child: row('child', 'parent'), other: row('other') },
    current: 'parent', phase: 'ready', jobsBySession: {}, currentAddress: undefined,
    subagentsByParent: { parent: { parentAvailable: true, state: 'ready', error: null, entries: [{ kind: 'child', id: 'child', mode: 'one-shot', activity: 'inactive', hasChildren: false }] } } }
  const notify = () => { for (const listener of listListeners) listener() }
  const ctx = { sessions: { binding: () => ({ session: { subscribe: subscribe(sessionListeners) } }),
    list: { getSnapshot: () => list, subscribe: subscribe(listListeners) } } }
  const listener = vi.fn(), bridge = createBridge(ctx, 'parent', () => {}, () => () => {})
  const stop = bridge.subscribe(listener)
  for (let i = 0; i < 20; i++) {
    list = { ...list, byId: { ...list.byId, other: { ...row('other'), updatedAt: i, projectionValues: { eMateImageReceipts: [i] } },
      parent: { ...list.byId.parent, displayTitle: String(i), projectionValues: { ...list.byId.parent.projectionValues, title: String(i) } } } }
    notify()
  }
  expect(listener).not.toHaveBeenCalled()
  const replaceProjection = (id: string, key: string, value: unknown) => {
    list = { ...list, byId: { ...list.byId, [id]: { ...list.byId[id], projectionValues: { ...list.byId[id].projectionValues, [key]: value } } } }
    notify()
  }
  replaceProjection('parent', 'eMateImageBatches', [{ status: 'completed' }])
  replaceProjection('child', 'eMateImageReceipts', [{ status: 'completed', revision: 2 }])
  // A later receipt still refreshes even after the prior one was terminal.
  replaceProjection('child', 'eMateImageReceipts', [{ status: 'completed', revision: 3 }])
  expect(listener).toHaveBeenCalledTimes(3)
  for (const update of sessionListeners) update()
  expect(listener).toHaveBeenCalledTimes(4)
  // Catalog membership, missing rows, and new reconnect projection baselines matter.
  list.subagentsByParent = { parent: { ...list.subagentsByParent.parent, entries: [...list.subagentsByParent.parent.entries, { kind: 'child', id: 'late', mode: 'one-shot', activity: 'running', hasChildren: false }] } }
  notify()
  list = { ...list, byId: { ...list.byId, late: row('late', 'parent') } }; notify()
  delete list.byId.child; notify()
  replaceProjection('parent', 'eMateImageBatches', [{ status: 'completed' }])
  list.subagentsByParent = { parent: { ...list.subagentsByParent.parent, parentAvailable: false } }; notify()
  expect(listener).toHaveBeenCalledTimes(9)
  stop()
  expect(listListeners.size).toBe(0); expect(sessionListeners.size).toBe(0)
  notify(); expect(listener).toHaveBeenCalledTimes(9)
  // A fresh mount takes a fresh baseline, with no cross-mount suppression state.
  const stopAgain = bridge.subscribe(listener)
  replaceProjection('late', 'eMateImageReceipts', [{ status: 'completed' }])
  expect(listener).toHaveBeenCalledTimes(10)
  stopAgain()
})
