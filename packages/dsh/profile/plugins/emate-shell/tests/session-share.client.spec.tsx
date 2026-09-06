// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import * as SessionLogExport from '../../../../../../upstream/deepseek-harness/packages/session-query/session-log-export/src/client/index.ts'
import { inject, registerSessionShare } from '../src/client/index.ts'
import { HiddenSessionLogExport, SessionShareAction } from '../src/client/session-share.tsx'

afterEach(cleanup)

describe('session share plugin', () => {
  it('creates, copies, and revokes a real online link through the Host RPC', async () => {
    const shareId = 'A'.repeat(32)
    const callShare = vi.fn(async (endpoint: string) => endpoint === 'status'
      ? { ok: true, value: { schema_version: 1, stage: 'preparing', service_version: 1, ready: true } }
      : endpoint === 'list'
      ? { ok: true, value: { schema_version: 1, stage: 'listing', shares: [] } }
      : endpoint === 'create' ? {
        ok: true,
        value: {
          schema_version: 1,
          stage: 'created',
          share_id: shareId,
          public_url: `https://share.example/s/${shareId}`,
          expires_at: '2030-08-21T00:00:00.000Z',
        },
      } : { ok: true, value: { schema_version: 1, stage: 'revoking', revoked: true } })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const requestDownload = vi.fn(async () => {})
    const dismissDownload = vi.fn()
    render(<SessionShareAction
      sessionId="session-207"
      callShare={callShare}
      useSessionLogDownload={selector => selector({ bySession: {} })}
      requestDownload={requestDownload}
      dismissDownload={dismissDownload}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分享当前任务' }))
    expect(callShare).toHaveBeenCalledWith('list', { session_id: 'session-207' })
    fireEvent.click(await screen.findByRole('button', { name: '创建公开链接' }))
    await screen.findByRole('link', { name: `https://share.example/s/${shareId}` })
    expect(callShare).toHaveBeenCalledWith('create', { session_id: 'session-207' })

    fireEvent.click(screen.getByRole('button', { name: '复制链接 1' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(`https://share.example/s/${shareId}`) })
    expect(screen.getByRole('status').textContent).toBe('链接已复制。')

    fireEvent.click(screen.getByRole('button', { name: '撤销链接 1' }))
    await waitFor(() => { expect(callShare).toHaveBeenCalledWith('revoke', {
      share_id: shareId,
      session_id: 'session-207',
    }) })
    expect((await screen.findByRole('status')).textContent).toBe('公开链接已撤销。')
    expect(screen.getByRole('button', { name: '创建公开链接' })).toBeTruthy()
  })

  it('reads an active link back after the component is recreated and can still revoke it', async () => {
    const shareId = 'R'.repeat(32)
    const callShare = vi.fn(async (endpoint: string) => endpoint === 'list'
      ? {
        ok: true,
        value: {
          schema_version: 1,
          stage: 'listing',
          shares: [{
            share_id: shareId,
            public_url: `https://share.example/s/${shareId}`,
            expires_at: '2030-08-21T00:00:00.000Z',
          }],
        },
      }
      : { ok: true, value: { schema_version: 1, stage: 'revoking', revoked: true } })
    render(<SessionShareAction
      sessionId="session-restarted"
      callShare={callShare}
      useSessionLogDownload={selector => selector({ bySession: {} })}
      requestDownload={vi.fn()}
      dismissDownload={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分享当前任务' }))
    await screen.findByRole('link', { name: `https://share.example/s/${shareId}` })
    expect(callShare).toHaveBeenCalledWith('list', { session_id: 'session-restarted' })
    fireEvent.click(screen.getByRole('button', { name: '撤销链接 1' }))
    await waitFor(() => { expect(callShare).toHaveBeenCalledWith('revoke', {
      share_id: shareId,
      session_id: 'session-restarted',
    }) })
    expect(await screen.findByRole('button', { name: '创建公开链接' })).toBeTruthy()
  })

  it('accepts the enterprise subpath and ignores a link expiring during list transit', async () => {
    const shareId = 'E'.repeat(32)
    const publicUrl = `https://enterprise.example/e-mate/share/s/${shareId}`
    const callShare = vi.fn(async () => ({ ok: true, value: {
      schema_version: 1, stage: 'listing', shares: [
        { share_id: shareId, public_url: publicUrl, expires_at: '2030-08-21T00:00:00.000Z' },
        { share_id: 'X'.repeat(32), public_url: `https://enterprise.example/e-mate/share/s/${'X'.repeat(32)}`,
          expires_at: new Date(Date.now() - 1).toISOString() },
      ],
    } }))
    render(<SessionShareAction
      sessionId="session-enterprise"
      callShare={callShare}
      useSessionLogDownload={selector => selector({ bySession: {} })}
      requestDownload={vi.fn()}
      dismissDownload={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: '分享当前任务' }))
    await screen.findByRole('link', { name: publicUrl })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('recovers the server-side link when the create response is uncertain', async () => {
    const shareId = 'U'.repeat(32)
    let listCalls = 0
    const callShare = vi.fn(async (endpoint: string) => {
      if (endpoint === 'status') {
        return { ok: true, value: { schema_version: 1, stage: 'preparing', service_version: 1, ready: true } }
      }
      if (endpoint === 'create') {
        return {
          ok: false,
          error: {
            schema_version: 1,
            stage: 'failed',
            operation: 'create',
            failed_at: 'uploading',
            code: 'request-timeout',
            message: '在线分享请求超时，请稍后重试。',
          },
        }
      }
      listCalls += 1
      return {
        ok: true,
        value: {
          schema_version: 1,
          stage: 'listing',
          shares: listCalls === 1 ? [] : [{
            share_id: shareId,
            public_url: `https://share.example/s/${shareId}`,
            expires_at: '2030-08-21T00:00:00.000Z',
          }],
        },
      }
    })
    render(<SessionShareAction
      sessionId="session-uncertain"
      callShare={callShare}
      useSessionLogDownload={selector => selector({ bySession: {} })}
      requestDownload={vi.fn()}
      dismissDownload={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分享当前任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '创建公开链接' }))
    await screen.findByRole('link', { name: `https://share.example/s/${shareId}` })
    expect(screen.getByRole('status').textContent).toBe('已从服务恢复公开链接。')
  })

  it('shows preparing/uploading progress and maps typed failures without exposing raw text', async () => {
    let releaseStatus: (() => void) | undefined
    let releaseCreate: (() => void) | undefined
    const callShare = vi.fn((endpoint: string) => {
      if (endpoint === 'status') return new Promise(resolve => {
        releaseStatus = () => { resolve({
          ok: true,
          value: { schema_version: 1, stage: 'preparing', service_version: 1, ready: true },
        }) }
      })
      if (endpoint === 'create') return new Promise(resolve => {
        releaseCreate = () => { resolve({
          ok: false,
          error: {
            schema_version: 1,
            stage: 'failed',
            operation: 'create',
            failed_at: 'uploading',
            code: 'archive-too-large',
            message: 'raw upstream sensitive detail',
          },
        }) }
      })
      return Promise.resolve({ ok: true, value: { schema_version: 1, stage: 'listing', shares: [] } })
    })
    render(<SessionShareAction
      sessionId="session-staged"
      callShare={callShare}
      useSessionLogDownload={selector => selector({ bySession: {} })}
      requestDownload={vi.fn()}
      dismissDownload={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分享当前任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '创建公开链接' }))
    expect(screen.getByText('正在检查在线分享服务…')).toBeTruthy()
    releaseStatus?.()
    expect(await screen.findByText('正在准备并上传任务归档…')).toBeTruthy()
    releaseCreate?.()

    expect((await screen.findByRole('alert')).textContent).toBe('任务归档超过在线分享大小限制，请改用本地导出。')
    expect(screen.queryByText(/raw upstream|sensitive detail/u)).toBeNull()
    expect(screen.getByRole('button', { name: '重试创建公开链接' })).toBeTruthy()
  })

  it('keeps native Session ZIP export as a separate local backup action', () => {
    const requestDownload = vi.fn(async () => {})
    const dismissDownload = vi.fn()
    render(<SessionShareAction
      sessionId="session-207"
      callShare={vi.fn()}
      useSessionLogDownload={selector => selector({ bySession: {} })}
      requestDownload={requestDownload}
      dismissDownload={dismissDownload}
    />)

    fireEvent.click(screen.getByRole('button', { name: '分享当前任务' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 ZIP' }))
    expect(requestDownload).toHaveBeenCalledWith('session-207')
    expect(screen.queryByRole('dialog', { name: '分享任务' })).toBeNull()
  })

  it('projects the existing Session export failure without a second client transport or store', () => {
    const requestDownload = vi.fn(async () => {})
    const dismissDownload = vi.fn()
    render(<SessionShareAction
      sessionId="session-207"
      callShare={vi.fn()}
      useSessionLogDownload={selector => selector({
        bySession: { 'session-207': { open: true, status: 'error', error: 'archive unavailable' } },
      })}
      requestDownload={requestDownload}
      dismissDownload={dismissDownload}
    />)

    expect(screen.getByRole('dialog', { name: '导出任务' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('archive unavailable')
    fireEvent.click(screen.getByRole('button', { name: '关闭导出' }))
    expect(dismissDownload).toHaveBeenCalledWith('session-207')
  })

  it('uses the root application tool group and native Session export controller', () => {
    const source = readFileSync('src/client/index.ts', 'utf8')
    const header = readFileSync('src/client/header-controls.tsx', 'utf8')
    const component = readFileSync('src/client/session-share.tsx', 'utf8')
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    const registration = source.slice(0, source.indexOf('export function registerComputerUseTrigger'))
    expect(source).toContain("ctx.slots.inject('conversation.session.header.utilities'")
    expect(source).toContain("id: 'session-log-download'")
    expect(registration).toContain('priority: -1')
    expect(registration).toContain("ctx.connection.rpc.call('/emate.share', endpoint, payload)")
    expect(source).toContain('ctx.sessionLogDownload.download(sessionId)')
    expect(header).toContain('<SessionShareAction')
    expect(header).toContain("useSessions(state => state.current)")
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-session-log-export')
    expect(component).toContain("callShare('create', { session_id: requestedSession })")
    expect(component).toContain("callShare('list', { session_id: requestedSession })")
    expect(component).toContain("callShare('revoke', {")
    expect(component).not.toMatch(/\b(?:fetch|WebSocket|EventSource|createSnapshotStore|defineStore)\s*\(/u)
  })

  it('keeps the target Session Export controller while shadowing only its old header action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    ctx.provide('locale', { register: () => () => {} } as never)
    ctx.provide('connection', { rpc: { call: vi.fn() } } as never)
    await ctx.plugin(SessionLogExport).await()
    expect(inject).toContain('sessionLogDownload')
    const shareFiber = ctx.plugin({
      inject: inject.filter(service => ['slots', 'connection', 'sessionLogDownload'].includes(service)),
      apply: registerSessionShare,
    })
    await shareFiber.await()

    const entries = slots.entries('conversation.session.header.utilities')
    expect(entries).toHaveLength(2)
    expect(entries.map(entry => entry.options.priority ?? 0)).toEqual([-1, 0])
    expect(entries.map(entry => (entry.component as { name?: string }).name)).toContain('SessionLogDownloadHeaderAction')
    const winners = slots.entriesOfSlot('conversation.session.header.utilities')
    expect(winners).toHaveLength(1)
    expect(winners[0]?.component).toBe(HiddenSessionLogExport)
    expect((winners[0]?.component as { name?: string }).name).not.toBe('SessionLogDownloadHeaderAction')

    await ctx.fiber.dispose()
  })
})
