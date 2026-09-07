import React from 'react'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficePreview } from '../src/preview.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer, SessionProvider } from '@deepseek-ai/dsh-client-web-react'
import { apply, PreviewPanel } from '../src/client/panel.tsx'
let visibility = 'visible', online = true
beforeEach(() => {
  vi.useFakeTimers(); visibility = 'visible'; online = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState)
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const preview = { preview_id: 'lease', session_id: 'session' }
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
function fixture(read: (action: string, payload: any, signal?: AbortSignal) => Promise<any>) {
  const calls: any[] = [], close = vi.fn()
  const ctx = { connection: { rpc: { call: vi.fn(async (_channel: string, action: string, payload: any, signal?: AbortSignal) => {
    calls.push({ action, payload, signal }); return { ok: true, value: await read(action, payload, signal) }
  }) } }, sessions: { list: { getSnapshot: () => ({ current: 'session' }) }, binding: () => ({ session: { prompt: vi.fn(async () => ({ ok: true })) } }) } }
  return { ctx, close, calls }
}
it('serializes slow reads and releases on hide, offline and unmount without cancelling Jobs', async () => {
  let complete: ((value: any) => void) | undefined
  const f = fixture(async action => action === 'roster' ? await new Promise(resolve => { complete = resolve }) : {})
  const view = render(<PreviewPanel {...f} preview={preview} sessionId="session" />)
  await flush(); expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(1)
  visibility = 'hidden'; fireEvent(document, new Event('visibilitychange')); await flush()
  expect(f.calls[0].signal.aborted).toBe(true)
  complete!({ pages: [] }); await flush()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) }); expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(1)
  visibility = 'visible'; fireEvent(document, new Event('visibilitychange')); await flush()
  expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(2)
  online = false; fireEvent(window, new Event('offline')); await flush(); complete!({ pages: [] }); await flush()
  online = true; fireEvent(window, new Event('online')); await flush()
  expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(3)
  const lastRead = f.calls.filter(c => c.action === 'roster').at(-1)
  view.unmount(); await flush(); expect(lastRead.signal.aborted).toBe(true)
  complete!({ pages: [] }); await flush()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) }); expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(3)
  expect(f.calls.every(c => ['roster', 'close'].includes(c.action))).toBe(true)
})
it('retains drafts and old source version when a page changes', async () => {
  let version = 'v1'
  const f = fixture(async action => action === 'roster' ? { pages: ['01.svg'] } : action === 'page' ? {
    revision: version, png: version, elements: [{ id: 'text-1', tag: 'text', text: '2026', editable: true, annotation: '' }],
  } : action === 'save' ? { saved: true, instruction: 'check original source then export' } : {})
  render(<PreviewPanel {...f} preview={preview} sessionId="session" />); await flush(); await flush()
  fireEvent.change(screen.getByLabelText('元素'), { target: { value: 'text-1' } })
  fireEvent.change(screen.getByLabelText('修改内容'), { target: { value: '金额保持 0' } })
  version = 'v2'
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect((screen.getByLabelText('修改内容') as HTMLTextAreaElement).value).toBe('金额保持 0')
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,v1')
  expect(screen.getByRole('status').textContent).toContain('旧版预览已保留')
  fireEvent.click(screen.getByText('保存源文件修改')); await flush()
  expect(f.calls.find(c => c.action === 'save').payload.expected_revision).toBe('v1')
  expect(screen.getByText('交给助手检查并导出')).toBeTruthy()
})
it('stops the old account view and does not read another Session', async () => {
  const f = fixture(async () => ({ pages: [] }))
  const view = render(<PreviewPanel {...f} preview={preview} sessionId="session" />); await flush()
  fireEvent(window, new Event('emate:identity-changed')); await flush()
  expect(f.close).toHaveBeenCalledOnce()
  const count = f.calls.filter(c => c.action === 'roster').length
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(count)
  view.rerender(<PreviewPanel {...f} preview={preview} sessionId="other" />); await flush()
  expect(f.calls.filter(c => c.action === 'roster')).toHaveLength(count)
})

it('restores an old Tool button through rc.7 SlotCore, session-scoped details and the actual Host lease owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'emate-preview-client-')); await mkdir(join(directory, 'deck'))
  let proofs = 0
  const session = { header: { id: 'session', cwd: directory }, events: [
    { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'call', name: 'office_read', arguments: JSON.stringify({ operation: 'preview', path: 'deck' }) } },
    { type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call' }] }, meta: { operation: 'preview', preview: { ...preview, kind: 'ppt-preview', project_path: 'deck' } } } },
  ] }
  const service = createOfficePreview({ sessions: { get: () => session }, emateAudit: { ownsTask: () => { proofs++; return true } },
    emateIdentity: { localAccountPrincipal: () => ({ tenantId: 'tenant', userId: 'user' }) },
    workspaceRegistry: { archivedSessionIds: [], list: () => [{ path: directory, sessionIds: ['session'] }] } })
  const core = new SlotCore(), f = fixture((action, payload, signal) => service.call(action, payload, signal))
  const info = { sessionId: 'session', hooks: {}, props: {} }
  const host: any = {
    subscribe: (key: string, fn: () => void) => core.subscribe(key, fn), getVersion: (key: string) => core.getVersion(key),
    entriesOf: (key: string) => core.entries(key), entriesOfSlot: (key: string) => core.entriesOfSlot(key),
    reportEntryError: (_key: string, _entry: any, error: unknown) => { throw error },
    specOf: (key: string) => core.specDynamic(key), isLive: (entry: any) => core.isLive(entry), storeOf: () => undefined,
    sessions: { list: f.ctx.sessions.list, provideInfo: { getSnapshot: () => info, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
  }
  core.register({ name: 'root', children: { details: { kind: 'single', scope: 'session' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as any,
    (({ renderSlot }: any) => <SessionProvider>{() => <>{renderSlot('tool.call.toolview', { block: { meta: { preview } } }, { entryKey: 'office_read' })}{renderSlot('details', {})}</>}</SessionProvider>) as any)
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
  apply({ ...f.ctx, layout, effect: () => {}, slots: { register: (spec: any, component: any) => core.register(spec, component), inject: (_key: string, callback: () => void) => callback() } })
  render(<>{createSlotRenderer().renderRoot(host, {})}</>); await flush()
  fireEvent.click(screen.getByText('打开 PPT 持续预览')); await flush()
  await act(async () => { const call = f.ctx.connection.rpc.call.mock.results.find(result => result.type === 'return'); await call?.value })
  expect(proofs).toBe(2)
  expect(layout.openDetails).toHaveBeenCalledOnce()
  expect(screen.getByRole('region', { name: 'PPT 持续预览' })).toBeTruthy()
  expect(f.calls.find(c => c.action === 'roster').payload.session_id).toBe('session')
  fireEvent.click(screen.getByText('关闭')); await flush()
  expect(screen.queryByRole('region', { name: 'PPT 持续预览' })).toBeNull()
  expect(f.calls.some(c => c.action === 'close')).toBe(true)
  service.dispose(); await rm(directory, { recursive: true, force: true })
})


it('decodes schema-compatible business failures and preserves an unsaved draft when recovery is unavailable', async () => {
  let expired = false
  const f = fixture(async action => expired && action !== 'close' ? { error: { code: 'preview-expired', message: '原账号归属尚不可验证，输入已保留。' } } : action === 'roster' ? { pages: ['01.svg'] } : action === 'page' ? {
    revision: 'old', png: 'old', elements: [{ id: 'text', tag: 'text', text: '原文 0', editable: true, annotation: '' }],
  } : {})
  render(<PreviewPanel {...f} preview={preview} sessionId="session" />); await flush(); await flush()
  fireEvent.change(screen.getByLabelText('元素'), { target: { value: 'text' } })
  fireEvent.change(screen.getByLabelText('修改内容'), { target: { value: '尚未保存的中文 0' } })
  expired = true; await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('alert').textContent).toContain('输入已保留')
  expect(screen.getByRole('alert').textContent).not.toContain('invalid_union')
  expect((screen.getByLabelText('修改内容') as HTMLTextAreaElement).value).toBe('尚未保存的中文 0')
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,old')
  expect(f.close).not.toHaveBeenCalled()
})


it('clears the old account snapshot when Host ownership rejects before an identity event arrives', async () => {
  let unauthorized = false
  const f = fixture(async action => unauthorized && action !== 'close' ? { error: { code: 'preview-unauthorized', message: '账号归属不匹配' } } : action === 'roster' ? { pages: ['01.svg'] } : action === 'page' ? {
    revision: 'old', png: 'old', elements: [{ id: 'text', tag: 'text', text: '原文', editable: true, annotation: '' }],
  } : {})
  render(<PreviewPanel {...f} preview={preview} sessionId="session" />); await flush(); await flush()
  fireEvent.change(screen.getByLabelText('元素'), { target: { value: 'text' } })
  fireEvent.change(screen.getByLabelText('修改内容'), { target: { value: '原账号输入' } })
  unauthorized = true; fireEvent.click(screen.getByText('保存源文件修改')); await flush()
  expect(f.close).toHaveBeenCalledOnce(); expect(screen.queryByRole('img')).toBeNull()
  expect((screen.getByLabelText('修改内容') as HTMLTextAreaElement).value).toBe('')
})
