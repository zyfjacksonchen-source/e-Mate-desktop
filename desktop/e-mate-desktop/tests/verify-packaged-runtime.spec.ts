import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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
  verifyPackagedCalc,
  verifyPackagedVision,
  preservePackagedCalcDirectories,
  preserveCalcMetadataFile,
  preservePackagedCalcMetadata,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackageResolver,
  type PackagedRuntimeContext,
  type PtyProbeRunner,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

it('rejects missing, damaged and incomplete universal Vision wheel closures in packaged bytes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'emate-vision-package-'))
  const packaged = context(temporary, 'darwin', 4)
  const root = join(resolvePackagedUnpackedRoot(packaged), 'build/e-mate-profile/bundles/vision-toolkit/runtime')
  try {
    mkdirSync(root, { recursive: true })
    const names = ['pillow', 'numpy', 'vtracer']
    writeFileSync(join(root, 'requirements.lock'), names.map(name =>
      `${name}==1.0 --hash=sha256:${createHash('sha256').update(name).digest('hex')}`).join('\n'))
    expect(() => verifyPackagedVision(packaged)).toThrow()
    for (const target of ['darwin-arm64', 'darwin-x64']) {
      mkdirSync(join(root, 'wheels', target), { recursive: true })
      const platform = target === 'darwin-arm64' ? 'macosx_11_0_arm64' : 'macosx_10_13_x86_64'
      for (const name of names) writeFileSync(join(root, 'wheels', target, `${name}-1.0-cp312-cp312-${platform}.whl`), name)
      if (target === 'darwin-arm64') expect(() => verifyPackagedVision(packaged)).toThrow()
    }
    expect(() => verifyPackagedVision(packaged)).not.toThrow()
    writeFileSync(join(root, 'wheels/darwin-x64/pillow-1.0-cp312-cp312-macosx_10_13_x86_64.whl'), 'damaged')
    expect(() => verifyPackagedVision(packaged)).toThrow(/hash mismatch/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

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

function ptyReceipt(args: readonly string[], elapsedMs = 0): string {
  const receiptId = JSON.parse(/const receiptId=("[a-f0-9]+");/u.exec(args[1]!)![1]!) as string
  return JSON.stringify({ schema: 1, receiptId, elapsedMs }) + '\n'
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
    const run = vi.fn<PtyProbeRunner>((_command, args) => ({ status: 0, stderr: '', stdout: ptyReceipt(args) }))

    verifyPackagedNodePty(context('/build', platform), run)

    expect(run).toHaveBeenCalledOnce()
    const [executable, args, options] = run.mock.calls[0]!
    expect(executable).toBe(expectedExecutable)
    const comparableArgs = platform === 'win32' ? args.map(argument => argument.toLowerCase()) : args
    expect(comparableArgs).toEqual(expect.arrayContaining([
      join(resolvePackagedUnpackedRoot(context('/build', platform)), 'node_modules', 'node-pty'),
      expectedCommand,
    ].map(argument => platform === 'win32' ? argument.toLowerCase() : argument)))
    expect(options).toMatchObject({ timeout: platform === 'darwin' ? 180_000 : 60_000, killSignal: 'SIGKILL', env: { ELECTRON_RUN_AS_NODE: '1' } })
    if (platform === 'darwin') expect(args.at(-1)).toBe(JSON.stringify(['-c', 'printf e-mate-pty-ready']))
  })

  it('fails packaging when the native PTY cannot start', () => {
    const run = vi.fn<PtyProbeRunner>(() => ({ status: 1, stderr: 'posix_spawnp failed.' } as never))

    expect(() => verifyPackagedNodePty(context('/build', 'darwin'), run))
      .toThrow('packaged node-pty smoke failed: posix_spawnp failed.')
  })

  it.each([
    ['darwin', 180_000, 60_000, true], ['darwin', 120_011, 10, false],
    ['darwin', 180_001, 60_000, false], ['darwin', 60_002, 60_001, false],
    ['win32', 60_000, 10, true], ['win32', 60_001, 10, false],
  ] as const)('enforces %s total=%d and PTY=%d budgets', (platform, total, elapsed, accepted) => {
    const run = vi.fn<PtyProbeRunner>((_command, args) => ({ status: 0, stdout: ptyReceipt(args, elapsed) }))
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(total)
    const execute = () => verifyPackagedNodePty(context('/build', platform), run, now)
    if (accepted) expect(execute).not.toThrow()
    else expect(execute).toThrow('timing budget exceeded')
    expect(run).toHaveBeenCalledOnce()
  })

  it('rejects missing, contradictory, nonfinite, negative, foreign and duplicate receipts', () => {
    const corruptions: Array<(args: readonly string[]) => string | undefined> = [
      () => undefined, () => '', () => '{}', () => 'null', () => '[]',
      args => ptyReceipt(args, -1), args => ptyReceipt(args, 101),
      args => ptyReceipt(args).replace('"elapsedMs":0', '"elapsedMs":1e309'),
      args => ptyReceipt(args).replace('"receiptId":"', '"receiptId":"different-'),
      args => ptyReceipt(args).trim() + ptyReceipt(args),
      args => ptyReceipt(args).replace('"schema":1', '"schema":1,"extra":true'),
    ]
    for (const corrupt of corruptions) {
      const run: PtyProbeRunner = (_command, args) => {
        const stdout = corrupt(args)
        return { status: 0, ...(stdout === undefined ? {} : { stdout }) }
      }
      expect(() => verifyPackagedNodePty(context('/build', 'darwin'), run, vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(100)))
        .toThrow('missing or invalid timing receipt')
    }
  })

  it('measures the emitted child from require through completion and watchdog cleanup', () => {
    const capture = vi.fn<PtyProbeRunner>((_command, args) => ({ status: 0, stdout: ptyReceipt(args) }))
    verifyPackagedNodePty(context('/build', 'darwin'), capture)
    const script = capture.mock.calls[0]![1][1]!
    for (const scenario of ['normal', 'blocked-require', 'blocked-completion', 'watchdog'] as const) {
      let elapsed = 0, timer: (() => void) | undefined, receive: ((data: string) => void) | undefined
      let complete: ((event: { exitCode: number }) => void) | undefined
      const writes: string[] = [], exits: number[] = []
      const exit = new Error('synthetic process.exit')
      const terminal = { kill: vi.fn(), onData: (fn: typeof receive) => { receive = fn }, onExit: (fn: typeof complete) => { complete = fn } }
      const spawn = vi.fn(() => terminal), clear = vi.fn()
      const execute = () => runInNewContext(script, {
        process: { hrtime: { bigint: () => BigInt(elapsed * 1_000_000) }, argv: ['electron', 'node-pty', '/bin/sh', '["-c","printf e-mate-pty-ready"]'],
          cwd: () => '/synthetic', env: {}, exit: (code: number) => { exits.push(code); throw exit } },
        require: (name: string) => name === 'node:fs' ? { writeSync: (_fd: number, data: string) => writes.push(data) }
          : (elapsed = scenario === 'blocked-require' ? 60_001 : 500, { spawn }),
        setTimeout: (fn: () => void, delay: number) => { timer = fn; expect(delay).toBe(60_000); return 1 }, clearTimeout: clear,
      })
      if (scenario === 'blocked-require') {
        expect(execute).toThrow(exit); expect(spawn).not.toHaveBeenCalled(); expect(exits).toEqual([1]); continue
      }
      execute(); receive!('e-mate-pty-ready')
      elapsed = scenario === 'normal' ? 700 : 60_001
      expect(() => scenario === 'watchdog' ? timer!() : complete!({ exitCode: 0 })).toThrow(exit)
      expect(exits).toEqual([scenario === 'normal' ? 0 : 1]); expect(clear).toHaveBeenCalledOnce()
      if (scenario === 'normal') {
        expect(JSON.parse(writes[0]!).elapsedMs).toBe(700); expect(terminal.kill).not.toHaveBeenCalled()
      } else { expect(writes).toEqual([]); expect(terminal.kill).toHaveBeenCalledWith('SIGKILL') }
      complete!({ exitCode: 0 }); expect(exits).toHaveLength(1)
    }
  })

  it('executes the exact emitted probe with real node-pty and parses its newline-terminated receipt', () => {
    const run: PtyProbeRunner = (_executable, args, options) => {
      const actual = [...args]
      actual[2] = join(import.meta.dirname, '../node_modules/node-pty')
      return spawnSync(process.execPath, actual, options)
    }
    // Test host Node is deliberate here: packaged Electron cold startup is a
    // separate candidate gate; Unix test hosts use Mac-shaped probe arguments,
    // not a claim of Mac startup acceptance or Linux product support.
    verifyPackagedNodePty(context('/build', process.platform === 'win32' ? 'win32' : 'darwin'), run)
  })

  it('fails a hard timeout without retrying or accepting a success receipt', () => {
    const run = vi.fn<PtyProbeRunner>((_command, args) => ({ status: null, error: new Error('ETIMEDOUT'), stdout: ptyReceipt(args) }))
    expect(() => verifyPackagedNodePty(context('/build', 'darwin'), run)).toThrow('ETIMEDOUT')
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]![2]).toMatchObject({ timeout: 180_000, killSignal: 'SIGKILL' })
  })

  it('verifies both complete Calc payloads without allowing package-time downloads', () => {
    const run = vi.fn<PtyProbeRunner>(() => ({ status: 0, stderr: '' }))
    const runtimeContext = context('/build', 'darwin', 4)
    verifyPackagedCalc(runtimeContext, run)
    expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual(['darwin-arm64', 'darwin-x64'])
    for (const [, args] of run.mock.calls) {
      expect(args).toContain('--verify-root')
      expect(args).toContain(join(resolvePackagedResourcesRoot(runtimeContext), 'calc-runtime'))
      expect(args).not.toContain('--archive-dir')
    }
    const fail = vi.fn<PtyProbeRunner>(() => ({ status: 1, stderr: 'Calc cache contents changed' }))
    expect(() => verifyPackagedCalc(runtimeContext, fail)).toThrow('Calc cache contents changed')
    expect(fail).toHaveBeenCalledOnce()
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


it('preserves verified original Calc metadata and rejects corrupt sources or linked destinations', () => {
  const base = mkdtempSync(join(tmpdir(), 'emate-calc-plist-'))
  const source = join(base, 'source'), destination = join(base, 'destination')
  const name = 'Contents/Info.plist', original = '<plist>original upstream metadata</plist>'
  const digest = createHash('sha256').update(original).digest('hex')
  try {
    for (const root of [source, destination]) mkdirSync(join(root, 'Contents'), { recursive: true })
    writeFileSync(join(source, name), original)
    writeFileSync(join(destination, name), '<plist>injected Electron integrity</plist>')
    preserveCalcMetadataFile(source, destination, name, digest)
    expect(readFileSync(join(destination, name), 'utf8')).toBe(original)
    const mtime = statSync(join(destination, name)).mtimeMs
    preserveCalcMetadataFile(source, destination, name, digest)
    expect(statSync(join(destination, name)).mtimeMs).toBe(mtime)
    writeFileSync(join(source, name), 'corrupt')
    expect(() => preserveCalcMetadataFile(source, destination, name, digest)).toThrow('digest mismatch')
    expect(readFileSync(join(destination, name), 'utf8')).toBe(original)
    writeFileSync(join(source, name), original)
    rmSync(join(destination, name))
    expect(() => preserveCalcMetadataFile(source, destination, name, digest)).toThrow()
    if (process.platform !== 'win32') {
      symlinkSync(join(source, name), join(destination, name))
      expect(() => preserveCalcMetadataFile(source, destination, name, digest)).toThrow('regular file')
      rmSync(join(destination, 'Contents'), { recursive: true })
      symlinkSync(join(source, 'Contents'), join(destination, 'Contents'))
      expect(() => preserveCalcMetadataFile(source, destination, name, digest)).toThrow('real directory')
    }
    expect(() => preservePackagedCalcMetadata(context('/missing', 'win32', 1))).not.toThrow()
    expect(() => preservePackagedCalcMetadata(context('/missing', 'darwin', 1))).not.toThrow()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

it('preserves only pinned empty Calc directories and rejects symlink parents', () => {
  const base = mkdtempSync(join(tmpdir(), 'emate-calc-empty-'))
  const runtime = context(base, 'darwin', 1)
  const root = join(resolvePackagedResourcesRoot(runtime), 'calc-runtime/darwin-x64/LibreOffice.app')
  const resources = join(root, 'Contents/Resources')
  try {
    mkdirSync(join(resources, 'autotext'), { recursive: true })
    preservePackagedCalcDirectories(runtime)
    for (const name of ['autotext/common', 'en.lproj', 'uno_packages', 'uno_packages/cache', 'uno_packages/cache/uno_packages']) expect(statSync(join(resources, name)).isDirectory()).toBe(true)
    preservePackagedCalcDirectories(runtime)
    rmSync(join(resources, 'uno_packages'), { recursive: true })
    const outside = join(base, 'outside'); mkdirSync(outside)
    symlinkSync(outside, join(resources, 'uno_packages'))
    expect(() => preservePackagedCalcDirectories(runtime)).toThrow('not a real directory')
    expect(existsSync(join(outside, 'cache'))).toBe(false)
    rmSync(join(resources, 'uno_packages'))
    rmSync(join(resources, 'autotext'), { recursive: true })
    expect(() => preservePackagedCalcDirectories(runtime)).toThrow()
    expect(existsSync(join(resources, 'autotext'))).toBe(false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
