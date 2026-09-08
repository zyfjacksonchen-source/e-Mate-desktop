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
  it.each([404, 405])('projects an absent native route as unavailable and missing credentials as authorization required (HTTP %s)', async (status) => {
    const states = await loadConnectionStates(async (channel, endpoint) => {
      if (channel === '/dingtalk') throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${status}`)
      return endpoint === 'feishu.status' ? { ok: true, value: { state: 'expired' } }
        : { ok: true, value: { schema_version: 1, items: [{ name: 'tencent_docs', active: false, authorized: false }] } }
    })
    expect(states.map(item => item.state)).toEqual(['expired', 'unavailable', 'authorization-required'])
  })
  it.each([
    'transport failure for /dingtalk/connection.status: HTTP 403',
    'transport failure for /dingtalk/connection.status: HTTP 500',
    'transport failure for /another/status: HTTP 405',
    'provider status 404',
  ])('does not disguise permission, server or unrelated failures: %s', async (message) => {
    expect((await loadConnectionStates(async () => { throw new Error(message) })).map(item => item.state))
      .toEqual(['failed', 'failed', 'failed'])
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

import { callXinConnection, parseXinConnection } from '../src/client/connection-status.ts'
const xinProof = {
  schema_version: 1, service: 'xin-business-assistant', name: 'xin-business-assistant', transport: 'streamable-http',
  state: 'ready', active: true, authorized: true,
  binding: { tenant_id: 'tenant-xin', user_id: 8, principal_id: 12 },
  permissions: { tools: ['query_projects'], project_count: 2, knowledge_project_count: 3, writable_project_count: 1, scope_revision: 'scope-1' },
  verified_at: '2026-09-07T01:00:00.000Z',
} as const

describe('Xin shared Host contract', () => {
  it('requires an exact current service and complete real proof for ready state', () => {
    expect(parseXinConnection({ ok: true, value: { ok: true, value: xinProof } }).binding?.user_id).toBe(8)
    expect(() => parseXinConnection({ ...xinProof, binding: undefined })).toThrow()
    expect(() => parseXinConnection({ ...xinProof, state: 'unavailable' })).toThrow()
    expect(() => parseXinConnection({ ...xinProof, access_token: 'must-not-render' })).toThrow()
    expect(() => parseXinConnection({ ...xinProof, name: 'other-service' })).toThrow()
    expect(() => parseXinConnection({ ...xinProof, permissions: { ...xinProof.permissions, writable_project_count: -1 } })).toThrow()
  })
  it('uses only the same native ensure/status/disconnect endpoints with empty payloads', async () => {
    const call = vi.fn(async () => ({ ok: true, value: xinProof }))
    const signal = new AbortController().signal
    for (const action of ['status', 'ensure', 'disconnect'] as const) await callXinConnection(call, action, signal)
    expect(call.mock.calls).toEqual(['status','ensure','disconnect'].map(action => ['/emate.mcpManage', `xin.${action}`, {}, signal]))
  })
  it('keeps local removal and remote revocation separate and rejects credential-bearing receipts', () => {
    const disconnection = { local_stopped: true, local_forgotten: true, remote_revocation: 'unknown' }
    const stopped = { ...xinProof, state: 'authorization-required', active: false, authorized: false, disconnection }
    expect(parseXinConnection(stopped).disconnection?.remote_revocation).toBe('unknown')
    expect(parseXinConnection({ ...stopped, authorization_unknown: true }).authorization_unknown).toBe(true)
    expect(() => parseXinConnection({ ...stopped, authorization_unknown: false })).toThrow()
    expect(() => parseXinConnection({ ...stopped, authorization_unknown: { token: 'secret' } })).toThrow()
    expect(() => parseXinConnection({ ...xinProof, disconnection })).toThrow()
    expect(() => parseXinConnection({ ...stopped, disconnection: { ...disconnection, local_stopped: false } })).toThrow()
    expect(() => parseXinConnection({ ...stopped, disconnection: { ...disconnection, token: 'secret' } })).toThrow()
  })
  it('rejects a late native response after cancellation without exposing its account', async () => {
    const controller = new AbortController()
    const call = vi.fn(async () => { controller.abort(); return xinProof })
    await expect(callXinConnection(call, 'ensure', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
