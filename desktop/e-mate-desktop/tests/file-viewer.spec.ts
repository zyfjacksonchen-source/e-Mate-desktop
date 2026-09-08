import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openFileWithSystem } from 'dsh-file-viewer'

const spawn = vi.fn()

beforeEach(() => {
  spawn.mockReset()
  vi.spyOn(childProcess, 'spawn').mockImplementation(spawn)
  syncBuiltinESMExports()
})
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

it.each(['darwin', 'win32'] as const)('waits for the actual %s opener spawn before reporting success', async platform => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  spawn.mockReturnValue(child)
  let settled = false
  const result = openFileWithSystem({ path: 'report.txt' }, environment(platform))
    .then(value => { settled = true; return value })
  await setImmediate()
  const premature = settled
  child.emit('spawn')
  expect(await result).toEqual({ kind: 'opened' })
  expect(premature).toBe(false)
  expect(child.unref).toHaveBeenCalledOnce()
})

it.each(['darwin', 'win32'] as const)('returns an explicit failure when the %s opener cannot start', async platform => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  spawn.mockReturnValue(child)
  const result = openFileWithSystem({ path: 'report.txt' }, environment(platform))
  await setImmediate()
  child.emit('error', Object.assign(new Error('missing opener'), { code: 'ENOENT' }))
  expect(await result).toEqual({ kind: 'rejected', code: 'open-failed' })
  expect(child.unref).not.toHaveBeenCalled()
})

function environment(platform: NodeJS.Platform): Parameters<typeof openFileWithSystem>[1] {
  return {
    platform,
    cwd: '/workspace',
    signal: new AbortController().signal,
    fs: {
      resolve: async (path: string) => path,
      contains: () => true,
      stat: async () => ({ type: 'file' }),
      processPath: () => '/workspace/report.txt',
    } as unknown as Parameters<typeof openFileWithSystem>[1]['fs'],
  }
}
