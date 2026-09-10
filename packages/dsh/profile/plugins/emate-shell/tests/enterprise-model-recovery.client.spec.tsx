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

  it('keeps an ordinary local route and shell interactive when enterprise auth is unavailable', async () => {
    history.replaceState(null, '', '/chat/local-session')
    const shell = document.createElement('main')
    shell.id = 'root'
    const localTool = document.createElement('button')
    localTool.textContent = 'Local Tool'
    shell.append(localTool)
    document.body.append(shell)
    // Management/control outage: the bootstrap call itself fails, so enterprise auth is
    // neither confirmed signed-out nor confirmed signed-in. Local work must stay usable.
    // A *confirmed* signed-out bootstrap instead opens login (identity-settings-fidelity).
    const callIdentity = vi.fn(async (): Promise<RpcResult> => ({ ok: false, error: { message: '企业身份服务暂不可用。' } }))

    render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => expect(callIdentity).toHaveBeenCalledOnce())

    expect(location.pathname).toBe('/chat/local-session')
    expect(shell.hidden).toBe(false)
    expect(shell.inert).not.toBe(true)
    expect(localTool.disabled).toBe(false)
    expect(document.querySelector('[data-emate-identity-gate]')).toBeNull()
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
