// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_CHANGED_EVENT, IdentityGate, type RpcResult } from '../src/client/identity.tsx'

const agreements = {
  ready: true,
  bundle_sha256: 'bundle',
  required_acknowledgements: ['legal'],
  acknowledgements: [{ id: 'legal', label: '我已阅读并同意' }],
  documents: [],
}
const signedOut = {
  schema_version: 1 as const,
  ready: true,
  authenticated: false,
  workspace_unlocked: false,
  agreements,
}
const signedIn = {
  ...signedOut,
  authenticated: true,
  workspace_unlocked: true,
  account_status: 'active' as const,
  weekly_token_limit: 10_000,
}

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-emate-identity-gate]').forEach(element => element.remove())
  document.getElementById('root')?.remove()
  history.replaceState(null, '', '/')
})

describe('enterprise model recovery identity boundary', () => {
  it('routes an unauthenticated agreement request to login while keeping authenticated locked agreement', async () => {
    history.replaceState(null, '', '/agreement')
    const callIdentity = vi.fn(async (): Promise<RpcResult> => ({ ok: true, value: signedOut }))
    const view = render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(location.pathname).toBe('/login'))
    expect(document.querySelector('[data-emate-identity-gate="login"]')).not.toBeNull()
    view.unmount()

    history.replaceState(null, '', '/agreement')
    render(<IdentityGate callIdentity={vi.fn(async (): Promise<RpcResult> => ({
      ok: true,
      value: { ...signedIn, workspace_unlocked: false },
    }))} />)
    await waitFor(() => expect(document.querySelector('[data-emate-identity-gate="agreement"]')).not.toBeNull())
    expect(location.pathname).toBe('/agreement')
  })

  it.each(['/', '/chat/local-session', '/settings'])('requires login after signed-out startup on %s', async path => {
    history.replaceState(null, '', path)
    const shell = document.createElement('main')
    shell.id = 'root'
    const localTool = document.createElement('button')
    localTool.textContent = 'Local Tool'
    shell.append(localTool)
    document.body.append(shell)
    const callIdentity = vi.fn(async (): Promise<RpcResult> => ({ ok: true, value: signedOut }))

    render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(location.pathname).toBe('/login'))

    expect(shell.hidden).toBe(true)
    expect(shell.inert).toBe(true)
    expect(localTool.disabled).toBe(false)
    expect(document.querySelector('[data-emate-identity-gate="login"]')).not.toBeNull()
  })

  it('blocks the workspace immediately after logout while bootstrap is still pending', async () => {
    history.replaceState(null, '', '/chat/local-session')
    const shell = document.createElement('main')
    shell.id = 'root'
    document.body.append(shell)
    let finish!: (result: RpcResult) => void
    const callIdentity = vi.fn().mockResolvedValueOnce({ ok: true, value: signedIn })
      .mockImplementationOnce(() => new Promise<RpcResult>(resolve => { finish = resolve }))
    render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(document.querySelector('[data-emate-identity-gate]')).toBeNull())
    act(() => { dispatchEvent(new CustomEvent(IDENTITY_CHANGED_EVENT)) })
    expect(shell.hidden).toBe(true)
    expect(shell.inert).toBe(true)
    finish({ ok: true, value: signedOut })
    await waitFor(() => expect(location.pathname).toBe('/login'))
    act(() => {
      history.pushState(null, '', '/chat/local-session')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(location.pathname).toBe('/login'))
    expect(shell.hidden).toBe(true)
  })

  it('requires agreement on a restored chat route for an authenticated locked account', async () => {
    history.replaceState(null, '', '/chat/local-session')
    render(<IdentityGate callIdentity={vi.fn(async () => ({ok:true as const,value:{...signedIn,workspace_unlocked:false}}))} />)
    await waitFor(() => expect(location.pathname).toBe('/agreement'))
    expect(document.querySelector('[data-emate-identity-gate="agreement"]')).not.toBeNull()
  })

  it('locks late native portals while verifying identity and restores their original state after login', async () => {
    const shell = document.createElement('main')
    shell.id = 'root'
    document.body.append(shell)
    let complete!: (result: RpcResult) => void
    render(<IdentityGate callIdentity={vi.fn(() => new Promise<RpcResult>(resolve => { complete = resolve }))} />)
    const late = document.createElement('button')
    late.textContent = 'Late native settings portal'
    const originalInert = late.inert
    document.body.append(late)
    await waitFor(() => expect(late.hidden).toBe(true))
    expect(late.inert).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-emate-identity-gate]')?.hidden).toBe(false)
    complete({ ok: true, value: signedIn })
    await waitFor(() => expect(late.hidden).toBe(false))
    expect(late.inert).toBe(originalInert)
    late.remove()
  })

  it('discards an in-flight bootstrap and runs one trailing refresh after identity mutation', async () => {
    history.replaceState(null, '', '/agreement')
    let resolveStale!: (value: RpcResult) => void
    const stale = new Promise<RpcResult>(resolve => { resolveStale = resolve })
    const callIdentity = vi.fn()
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({ ok: true, value: signedOut })

    render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(callIdentity).toHaveBeenCalledOnce())
    act(() => { dispatchEvent(new CustomEvent(IDENTITY_CHANGED_EVENT)) })
    resolveStale({ ok: true, value: signedIn })

    await waitFor(() => expect(callIdentity).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(location.pathname).toBe('/login'))
  })

  it('coalesces reconnect signals during one pending bootstrap into exactly one trailing call', async () => {
    history.replaceState(null, '', '/chat/local-session')
    let resolvePending!: (value: RpcResult) => void
    const pending = new Promise<RpcResult>(resolve => { resolvePending = resolve })
    const callIdentity = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ ok: true, value: signedIn })

    render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(callIdentity).toHaveBeenCalledOnce())
    act(() => {
      dispatchEvent(new Event('online'))
      dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      dispatchEvent(new Event('online'))
    })
    expect(callIdentity).toHaveBeenCalledOnce()
    resolvePending({ ok: true, value: signedOut })
    await waitFor(() => expect(callIdentity).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(callIdentity).toHaveBeenCalledTimes(2)
  })

  it('does not run a queued reconnect refresh after unmount', async () => {
    let resolvePending!: (value: RpcResult) => void
    const pending = new Promise<RpcResult>(resolve => { resolvePending = resolve })
    const callIdentity = vi.fn(() => pending)
    const view = render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(callIdentity).toHaveBeenCalledOnce())
    act(() => {
      dispatchEvent(new Event('online'))
      dispatchEvent(new Event('focus'))
    })
    view.unmount()
    resolvePending({ ok: true, value: signedOut })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(callIdentity).toHaveBeenCalledOnce()
  })
})
