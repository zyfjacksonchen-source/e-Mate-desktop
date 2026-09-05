import { describe, expect, it, vi } from 'vitest'
import { appendConnectionDraft, loadConnectionStates } from '../src/client/connection-status.ts'

describe('external connection projection', () => {
  it('checks each provider independently and never treats credential presence as a live connection', async () => {
    const call = vi.fn(async (channel: string) => channel === '/dingtalk'
      ? { ok: true, value: { ok: true, value: { schemaVersion: 1, state: 'connected', bots: [{ connected: false }] } } }
      : { ok: true, value: { schema_version: 1, items: [{ name: 'tencent_docs', authorized: true, active: false }] } })
    expect(await loadConnectionStates(call)).toEqual([
      { id: 'feishu', state: 'failed' }, { id: 'dingtalk', state: 'failed' }, { id: 'tencent_docs', state: 'failed' },
    ])
  })
  it('preserves healthy siblings when a provider fails', async () => {
    const call = vi.fn(async (channel: string, endpoint: string) => {
      if (channel === '/dingtalk') throw new Error('offline')
      return endpoint === 'feishu.status' ? { ok: true, value: { state: 'connected' } }
        : { ok: true, value: { schema_version: 1, items: [{ name: 'tencent_docs', authorized: true, active: true }] } }
    })
    expect((await loadConnectionStates(call)).map(item => item.state)).toEqual(['connected', 'failed', 'connected'])
  })
  it('appends text through the native owner, leaving all attachments and submission untouched', () => {
    const snapshot = { draft: '原文 @引用', phase: 'plain', imageIds: ['image-1'], fileRefs: ['file-1'] }
    const input = { state: { getSnapshot: () => snapshot }, setDraft: vi.fn(), submit: vi.fn() }
    const ctx = { sessions: { list: { getSnapshot: () => ({ current: 's1' }) }, scope: () => ({}) }, conversation: { input: { for: () => input } } }
    appendConnectionDraft(ctx, 's1', '连接飞书')
    expect(input.setDraft).toHaveBeenCalledWith('原文 @引用\n\n连接飞书')
    expect(snapshot.imageIds).toEqual(['image-1'])
    expect(snapshot.fileRefs).toEqual(['file-1'])
    expect(input.submit).not.toHaveBeenCalled()
    expect(() => appendConnectionDraft(ctx, 's2', '连接钉钉')).toThrow('会话已切换')
    snapshot.phase = 'submitting'
    expect(() => appendConnectionDraft(ctx, 's1', '连接钉钉')).toThrow('正在提交')
    expect(input.setDraft).toHaveBeenCalledTimes(1)
  })
})
