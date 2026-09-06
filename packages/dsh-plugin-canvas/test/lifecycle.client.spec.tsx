import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

vi.mock('http://localhost:3000/emate-canvas-assets/editor.js', () => ({}))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function deferred() {
  let resolve!: (value: any) => void
  return { promise: new Promise<any>(done => { resolve = done }), resolve: (value: any) => resolve(value) }
}
function harness() {
  vi.stubGlobal('location', { origin: 'http://localhost:3000' })
  const module = deferred(), attachment = deferred()
  let current = 'a', service: any
  const ctx = {
    modules: { import: vi.fn(() => module.promise) },
    sessions: { list: { getSnapshot: () => ({ current }) }, binding: () => ({ session: {} }), open: vi.fn() },
    connection: { rpc: { call: vi.fn(() => attachment.promise) } },
    slots: { register: vi.fn(() => () => {}), inject: vi.fn() },
    layout: { openDetails: vi.fn(), closeDetails: vi.fn() },
    reflect: { provide: (_key: string, value: any) => { service = value; return () => {} } },
    effect: (callback: () => unknown) => callback(), get: vi.fn(),
  }
  apply(ctx)
  return { ctx, service, module, attachment, switchTo: (id: string) => { current = id } }
}
it('drops a delayed lazy open after the native current session changes', async () => {
  const h = harness(), opening = h.service.open('a')
  await vi.waitFor(() => expect(h.ctx.modules.import).toHaveBeenCalled())
  h.switchTo('b'); h.module.resolve({ CanvasPanel() {} }); await opening
  expect(h.ctx.sessions.open).not.toHaveBeenCalled()
  expect(h.ctx.slots.register).not.toHaveBeenCalled()
})
it('drops an image resolution that finishes after navigating away', async () => {
  const h = harness()
  h.module.resolve({ CanvasPanel() {} })
  const opening = h.service.insertAttachment('a', 'a', `sha256:${'a'.repeat(64)}`)
  await vi.waitFor(() => expect(h.ctx.connection.rpc.call).toHaveBeenCalled())
  h.switchTo('b'); h.attachment.resolve({ ok: true, value: {} }); await opening
  expect(h.ctx.sessions.open).not.toHaveBeenCalled()
  expect(h.ctx.slots.register).not.toHaveBeenCalled()
})
