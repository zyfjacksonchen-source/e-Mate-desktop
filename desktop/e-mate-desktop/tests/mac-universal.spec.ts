import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
  prepareMacUniversalRuntime,
} from '../scripts/mac-universal.ts'

describe('universal macOS native runtime preparation', () => {
  it('requires every CPU-specific file and repairs both node-pty helpers', () => {
    const chmod = vi.fn()

    prepareMacUniversalRuntime({ desktopRoot: '/desktop', exists: () => true, chmod })

    expect(chmod.mock.calls).toEqual(MACOS_UNIVERSAL_NATIVE_ENTRIES
      .filter(entry => entry.path.endsWith('/spawn-helper'))
      .map(entry => [join(resolve('/desktop'), entry.path), 0o755]))
  })

  it('fails before changing permissions when one architecture is incomplete', () => {
    const chmod = vi.fn()
    const missing = MACOS_UNIVERSAL_NATIVE_ENTRIES.at(-1)!.path

    expect(() => prepareMacUniversalRuntime({
      desktopRoot: '/desktop',
      exists: path => path !== join(resolve('/desktop'), missing),
      chmod,
    })).toThrow(join(resolve('/desktop'), missing))
    expect(chmod).not.toHaveBeenCalled()
  })
})
