import { join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
  prepareMacUniversalRuntime,
} from '../scripts/mac-universal.ts'
import { verifyUniverNativeRuntime } from '../scripts/univer-native-runtime.ts'
import { resolvePackagedUnpackedRoot, verifyPackagedUniver } from '../scripts/verify-packaged-runtime.ts'

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

describe('bundled Univer native platform gate', () => {
  const bindings = ['libsql', '@univerjs-pro/engine-formula-rust-binding', '@univerjs-pro/exchange-node-binding']
  function fixture(root: string): string[] {
    const write = (directory: string, value: unknown) => {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify(value))
    }
    write(root, { dependencies: Object.fromEntries(bindings.map(name => [name, '1.0.0'])) })
    return bindings.map(name => {
      const parent = join(root, 'node_modules', name)
      const platformName = name === 'libsql' ? '@libsql/darwin-arm64' : `${name}-darwin-arm64`
      write(parent, { name, version: '1.0.0', optionalDependencies: { [platformName]: '1.0.0' } })
      const directory = join(parent, 'node_modules', platformName)
      write(directory, { name: platformName, version: '1.0.0', os: ['darwin'], cpu: ['arm64'], main: 'binding.node' })
      writeFileSync(join(directory, 'binding.node'), 'fixture native bytes')
      return directory
    })
  }

  it('refuses an undeclared Intel target even when every ARM64 binary is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'emate-univer-native-'))
    try {
      fixture(root)
      expect(() => verifyUniverNativeRuntime(root, ['darwin-arm64'])).not.toThrow()
      expect(() => verifyUniverNativeRuntime(root, ['darwin-arm64', 'darwin-x64']))
        .toThrow(/does not support darwin-x64/u)
      expect(() => verifyUniverNativeRuntime(root, ['win32-x64-msvc']))
        .toThrow(/does not support win32-x64-msvc/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects incomplete native targets and mismatched installed versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'emate-univer-native-'))
    try {
      const directories = fixture(root)
      const manifest = join(directories[2]!, 'package.json')
      const original = readFileSync(manifest, 'utf8')
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), version: '2.0.0' }))
      expect(() => verifyUniverNativeRuntime(root, ['darwin-arm64'])).toThrow(/metadata mismatch/u)
      writeFileSync(manifest, original)
      writeFileSync(join(directories[2]!, 'binding.node'), '')
      expect(() => verifyUniverNativeRuntime(root, ['darwin-arm64'])).toThrow(/empty/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rechecks the requested architecture in the final physical application', () => {
    const root = mkdtempSync(join(tmpdir(), 'emate-univer-package-'))
    const context = { appOutDir: root, electronPlatformName: 'darwin', arch: 3,
      packager: { appInfo: { productFilename: 'e-Mate' } } }
    try {
      fixture(join(resolvePackagedUnpackedRoot(context), 'build/e-mate-profile/bundles/univer-office'))
      expect(() => verifyPackagedUniver(context)).not.toThrow()
      expect(() => verifyPackagedUniver({ ...context, arch: 4 })).toThrow(/does not support darwin-x64/u)
      expect(() => verifyPackagedUniver({ ...context, arch: 1 })).toThrow(/does not support darwin-x64/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
