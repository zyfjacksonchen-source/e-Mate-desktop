// @vitest-environment jsdom
// Targeted check for the recorded fix "show an orange dot when expert mode is
// enabled" (regression-ledger 077f524469), which had no guard of its own.
import React from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerExpertMode } from '../src/client/composer-connectors.tsx'

afterEach(cleanup)

/** One deferred receipt so the control's pending state is observable. */
function deferred<T>() {
  let settle: (value: T) => void = () => {}
  let fail: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject })
  return { promise, settle, fail }
}

describe('composer expert mode indicator', () => {
  it('lights the dot only after the native receipt, and clears it on a rejected set', async () => {
    const pending = deferred<{ active: boolean }>()
    const request = vi.fn()
      .mockResolvedValueOnce({ active: false })
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('专家模式暂不可用。'))
    render(<ComposerExpertMode sessionId="session-1" request={request} />)
    const control = screen.getByRole('switch', { name: '专家模式' })

    await waitFor(() => { expect(control.hasAttribute('disabled')).toBe(false) })
    expect(request.mock.calls[0]?.[0]).toBe('get')
    expect(control.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(control)
    expect(request.mock.calls[1]?.[0]).toBe('set')
    expect(request.mock.calls[1]?.[1]).toBe(true)
    // The switch follows the receipt, never the click.
    expect(control.getAttribute('aria-checked')).toBe('false')
    pending.settle({ active: true })
    await waitFor(() => { expect(control.getAttribute('aria-checked')).toBe('true') })
    expect(control.getAttribute('title')).toMatch(/已开启/u)

    fireEvent.click(control)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('专家模式暂不可用。') })
    expect(control.getAttribute('aria-checked')).toBe('true')
  })

  it('paints the enabled dot with the brand colour and full opacity', () => {
    const styles = readFileSync('src/client/composer-connectors.module.css', 'utf8')
    expect(styles).toMatch(/\.expert i \{[^}]*width:\s*7px;[^}]*border-radius:\s*50%;[^}]*opacity:\s*\.4;/u)
    expect(styles).toMatch(/\.expert\[aria-checked='true'\] i \{[^}]*background:\s*var\(--emate-color-brand\);[^}]*opacity:\s*1;/u)
  })
})
