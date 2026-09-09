import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import { apply, Config, inject } from '../src/updates.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', { spy: true })

async function createHarness(options: {
  readonly state?: unknown
  readonly config?: Partial<Config>
  readonly request?: DesktopRuntime['updates']['request']
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e-mate-updates-'))
  const statePath = join(root, 'state.json')
  if (options.state !== undefined) await writeFile(statePath, `${JSON.stringify(options.state)}\n`)
  const request = vi.fn(options.request ?? (async () => Response.json({ version: '2.1.0' })))
  const confirmDownload = vi.fn(async () => false)
  const downloadAndOpen = vi.fn(async () => {})
  const notify = vi.fn()
  let tray: DesktopTrayItem | undefined
  let rendererCheck: (() => Promise<void>) | undefined
  let dispose: (() => void | Promise<void>) | undefined
  const runtime = {
    updates: {
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.0.17',
      statePath,
      request,
      confirmDownload,
      showManualCheckResult: vi.fn(async () => {}),
      downloadAndOpen,
      notify,
      setInteractiveUpdateHandler(handler: (() => Promise<void>) | undefined) {
        rendererCheck = handler
      },
    },
    registerTrayItem(item: DesktopTrayItem) {
      tray = item
      return { refresh: vi.fn(), dispose: vi.fn() }
    },
  } as unknown as DesktopRuntime
  const ctx = {
    desktopRuntime: runtime,
    provide(key: string, value: unknown) { Object.assign(ctx, { [key]: value }) },
    effect(register: () => (() => void | Promise<void>)) { dispose = register() },
  } as unknown as Context

  apply(ctx, Config({ enabled: false, ...options.config } as never))
  if (tray === undefined) throw new Error('Update tray item was not registered')
  return {
    ctx,
    statePath,
    request,
    confirmDownload,
    downloadAndOpen,
    notify,
    tray,
    get rendererCheck() { return rendererCheck },
    runRendererCheck: async () => await rendererCheck?.(),
    dispose: async () => { await dispose?.() },
  }
}

describe('native desktop update owner', () => {
  it('keeps the dsh-desktop schedule defaults and one runtime injection', () => {
    expect(inject).toEqual(['desktopRuntime'])
    expect(Config({} as never)).toEqual({
      enabled: true,
      initialDelayMs: 60_000,
      intervalMs: 21_600_000,
      requestTimeoutMs: 15_000,
    })
  })

  it('delegates natural-language and tray checks to the same lifecycle', async () => {
    const harness = await createHarness()
    expect(harness.rendererCheck).toBe(harness.tray.invoke)
    await expect(harness.ctx.desktopUpdates.runInteractiveUpdate()).resolves.toEqual({
      status: 'handled',
      installedVersion: '2.0.17',
    })
    await harness.tray.invoke()
    await harness.runRendererCheck()

    expect(harness.request).toHaveBeenCalledOnce()
    expect(harness.confirmDownload).toHaveBeenCalledTimes(3)
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    await harness.dispose()
    expect(harness.rendererCheck).toBeUndefined()
  })

  it('migrates exact legacy v3 state without repeating the same background prompt', async () => {
    const harness = await createHarness({
      state: { version: 3, lastNotifiedVersion: '2.1.0' },
      config: {
        enabled: true,
        initialDelayMs: 0,
        intervalMs: 10,
        requestTimeoutMs: 1_000,
      },
    })

    await vi.waitFor(() => {
      expect(harness.request.mock.calls.length).toBeGreaterThanOrEqual(3)
    })
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.notify).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 2,
      lastPromptedVersion: '2.1.0',
    })
    await harness.dispose()
  })

  it.each([
    ['an extra field', { version: 3, lastNotifiedVersion: '2.1.0', tampered: true }],
    ['an unstable SemVer', { version: 3, lastNotifiedVersion: '2.1.0-beta.1' }],
    ['an unknown schema version', { version: 4, lastNotifiedVersion: '2.1.0' }],
  ])('rejects and resets legacy state with %s', async (_name, state) => {
    const write = vi.mocked(atomicWrite.writeFileAtomic).mockClear()
    const harness = await createHarness({ state })
    try {
      // Observe the real write before reading; do not race Windows file replacement.
      await vi.waitFor(async () => {
        expect(write).toHaveBeenCalledOnce()
        await expect(write.mock.results[0]!.value).resolves.toBeUndefined()
      })
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({ version: 2 })
      expect(harness.request).not.toHaveBeenCalled()
      expect(harness.confirmDownload).not.toHaveBeenCalled()
      expect(harness.notify).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
      write.mockClear()
    }
  })
})
