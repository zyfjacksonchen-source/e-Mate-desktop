import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  REQUIRED_PYTHON_RUNTIME_ENTRIES,
  REQUIRED_UNPACKED_PACKAGE_SPECIFIERS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedResourcesRoot,
  resolvePackagedUnpackedRoot,
  verifyPackagedNodePty,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackageResolver,
  type PackagedRuntimeContext,
  type PtyProbeRunner,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'e-Mate' } },
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return REQUIRED_PACKAGED_RUNTIME_ENTRIES.map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

function completePackageResolver(unpackedRoot: string): PackageResolver {
  return specifier => join(unpackedRoot, 'resolved', `${specifier.replaceAll('/', '-')}.js`)
}

function retiredXinPath(unpackedRoot: string): string {
  return join(unpackedRoot, 'node_modules/@e-mate/dsh-plugin-xin-assistant')
}

describe('packaged desktop runtime verification', () => {
  it('tracks the Windows prebuilds shipped by the installed node-pty', () => {
    for (const entry of REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES) {
      expect(existsSync(join(import.meta.dirname, '..', entry))).toBe(true)
    }
  })

  it.each([
    ['darwin', join('/build', 'e-Mate.app', 'Contents', 'MacOS', 'e-Mate'), '/bin/sh'],
    ['win32', join('/build', 'e-Mate.exe'), 'C:\\Windows\\System32\\cmd.exe'],
  ])('runs the packaged node-pty smoke on %s', (platform, expectedExecutable, expectedCommand) => {
    const run = vi.fn<PtyProbeRunner>(() => ({ status: 0, stderr: '' } as never))

    verifyPackagedNodePty(context('/build', platform), run)

    expect(run).toHaveBeenCalledOnce()
    const [executable, args, options] = run.mock.calls[0]!
    expect(executable).toBe(expectedExecutable)
    const comparableArgs = platform === 'win32' ? args.map(argument => argument.toLowerCase()) : args
    expect(comparableArgs).toEqual(expect.arrayContaining([
      join(resolvePackagedUnpackedRoot(context('/build', platform)), 'node_modules', 'node-pty'),
      expectedCommand,
    ].map(argument => platform === 'win32' ? argument.toLowerCase() : argument)))
    expect(options).toMatchObject({ timeout: 60_000, env: { ELECTRON_RUN_AS_NODE: '1' } })
  })

  it('fails packaging when the native PTY cannot start', () => {
    const run = vi.fn<PtyProbeRunner>(() => ({ status: 1, stderr: 'posix_spawnp failed.' } as never))

    expect(() => verifyPackagedNodePty(context('/build', 'darwin'), run))
      .toThrow('packaged node-pty smoke failed: posix_spawnp failed.')
  })

  it.each([1, 3])('defers macOS architecture %s until the final universal app', arch => {
    const run = vi.fn<PtyProbeRunner>()

    verifyPackagedNodePty(context('/build', 'darwin', arch), run)

    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    [
      'darwin',
      join('/build', 'e-Mate.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))

    const unpackedRoot = `${expectedPath}.unpacked`
    const exists = vi.fn<FileProbe>(filename => filename !== retiredXinPath(unpackedRoot)
      && (platform !== 'darwin'
        || !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES.some(entry => filename === join(unpackedRoot, entry))))
    const resolvePackage = vi.fn<PackageResolver>(completePackageResolver(unpackedRoot))

    verifyPackagedRuntime(context('/build', platform), list, exists, resolvePackage)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(unpackedRoot)
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + (platform === 'win32' ? REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES.length : 0)
        + (platform === 'darwin' ? FORBIDDEN_MACOS_UNIVERSAL_ENTRIES.length : 0)
        + 2,
    )
    expect(resolvePackage.mock.calls.map(([specifier]) => specifier))
      .toEqual(REQUIRED_UNPACKED_PACKAGE_SPECIFIERS)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('requires both CPU variants from a universal macOS runtime', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missing = 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg'

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== join(unpackedRoot, missing)
        && filename !== retiredXinPath(unpackedRoot),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)

    const exists = vi.fn<FileProbe>(filename => filename !== retiredXinPath(unpackedRoot)
      && !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
        .some(entry => filename === join(unpackedRoot, entry)))
    verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
      completePackageResolver(unpackedRoot),
    )
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + REQUIRED_MACOS_UNIVERSAL_ENTRIES.length
        + FORBIDDEN_MACOS_UNIVERSAL_ENTRIES.length
        + 3,
    )
  })

  it('requires both fixed Python bootstraps from a universal macOS package', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const resourcesRoot = resolvePackagedResourcesRoot(runtimeContext)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missing = REQUIRED_PYTHON_RUNTIME_ENTRIES['darwin-arm64']

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== join(resourcesRoot, missing)
        && filename !== retiredXinPath(unpackedRoot),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing Python runtime entries: ${missing}`)
  })

  it('rejects a host-architecture node-pty build from a universal app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || (filename !== retiredXinPath(unpackedRoot)
          && !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
            .some(entry => filename === join(unpackedRoot, entry))),
      completePackageResolver(unpackedRoot),
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/desktop-runtime-environment.js',
    'lib/profile-service.js',
    'lib/pnpm.js',
    'lib/update-download.js',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each([
    'package.json',
    'build/app-icon-mac.png',
    'build/tray-iconTemplate.png',
    'build/e-mate-profile/component-inventory.json',
    'build/e-mate-profile/bundles/cdp/lib/index.mjs',
    'build/e-mate-profile/bundles/pet/lib/assets/xiaoxin-v2.webp',
    'build/e-mate-profile/bundles/pet/lib/assets/xiaoxin-office.json',
    'build/e-mate-profile/bundles/canvas/lib/assets/editor.js',
    'lib/terminal.js',
    'lib/update-download.js',
    'node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/agent.cordis.yml',
    'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
    'node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])('fails loud when physical runtime entry %s is absent from app.asar.unpacked', (missing) => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missingPath = join(unpackedRoot, missing)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== missingPath
        && filename !== retiredXinPath(unpackedRoot),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('rejects the retired xin-assistant package from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      () => true,
      completePackageResolver(unpackedRoot),
    )).toThrow('contains retired physical entries: node_modules/@e-mate/dsh-plugin-xin-assistant')
  })

  it('fails loud when a required package export cannot resolve from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@e-mate/desktop/profiles') {
        throw new Error('missing export')
      }
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== retiredXinPath(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export @e-mate/desktop/profiles`,
    )
  })

  it('fails loud when a required package export escapes app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const escapedPath = join('/workspace', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js')
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@deepseek-ai/dsh-base/package.json') return escapedPath
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== retiredXinPath(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `required package export @deepseek-ai/dsh-base/package.json resolved outside ${unpackedRoot}: ${escapedPath}`,
    )
  })
})
