import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  preparePackagedFeishu,
  verifyPackagedFeishuNotices,
  verifyPackagedVision,
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
  it('rejects an ASAR-declared dependency outside the curated inventory when its physical file is missing', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missing = 'node_modules/yaml/dist/index.js'
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => [...completeArchiveEntries(), `/${missing}`],
      filename => filename !== join(unpackedRoot, missing) && filename !== retiredXinPath(unpackedRoot),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing ASAR-declared physical entries: ${missing}`)
  })

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
        + 2 + new Set(completeArchiveEntries()).size,
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
        + 3 + new Set(completeArchiveEntries()).size,
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
    'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml',
    'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md',
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


it.each([['darwin', 1, 'x64'], ['darwin', 3, 'arm64'], ['win32', 1, 'x64']] as const)('runs the official Feishu installer under the actual %s %s slice', (platform, arch, cpu) => {
  const temporary = mkdtempSync(join(tmpdir(), 'emate-feishu-'))
  const packaged = context(temporary, platform, arch)
  const root = join(resolvePackagedUnpackedRoot(packaged), 'node_modules/@larksuite/cli')
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@larksuite/cli', version: '1.0.88', license: 'MIT' }))
  for (const file of ['LICENSE', 'checksums.txt', 'scripts/install.js']) writeFileSync(join(root, file), 'official fixture')
  const calls: string[][] = []
  const versionBudgets: number[] = []
  const lipoBudgets: number[] = []
  const runner: PtyProbeRunner = (command, args, options) => {
    if (args[0] === '--version') versionBudgets.push(Number(options.timeout))
    if (command === '/usr/bin/lipo') lipoBudgets.push(Number(options.timeout))
    calls.push([command, ...args])
    if (args[0] === '-p') return { status: 0, stdout: `${platform}:${cpu}` } as never
    if (args[0]?.endsWith('install.js')) writeFileSync(join(root, 'bin', platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'), 'binary')
    return { status: 0, stdout: args[0] === '--version' ? 'lark-cli 1.0.88' : '' } as never
  }
  try {
    preparePackagedFeishu(packaged, runner)
    expect(versionBudgets).toEqual([platform === 'darwin' ? 180_000 : 30_000])
    expect(lipoBudgets).toEqual(platform === 'darwin' ? [30_000] : [])
    expect(() => preparePackagedFeishu(packaged, (command, args, options) => args[0] === '--version'
      ? { status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) } as never
      : runner(command, args, options))).toThrow('ETIMEDOUT')
    expect(() => preparePackagedFeishu(packaged, (command, args, options) => args[0] === '--version'
      ? { status: 0, stdout: 'lark-cli 0.0.0' } as never
      : runner(command, args, options))).toThrow('version mismatch')
    expect(calls.filter(call => call[1]?.endsWith('install.js'))).toHaveLength(3)
    expect((calls[0]?.[0] ?? '').split('\\').join('/')).toContain(platform === 'win32' ? '.exe' : '.app/Contents/MacOS/')
    expect(() => preparePackagedFeishu(packaged, () => ({ status: 0, stdout: 'darwin:wrong' }) as never)).toThrow('target mismatch')
    if (platform === 'darwin') {
      calls.length = 0
      preparePackagedFeishu({ ...packaged, arch: 4 }, runner)
      expect(calls.some(call => call[1]?.endsWith('install.js'))).toBe(false)
      expect(calls[0]?.slice(1)).toEqual([join(root, 'bin/lark-cli'), '-verify_arch', 'x86_64', 'arm64'])
      expect(versionBudgets.at(-1)).toBe(180_000)
      expect(lipoBudgets.at(-1)).toBe(30_000)
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})


describe('packaged Feishu notices', () => {
  let temporary: string
  let packaged: PackagedRuntimeContext
  let resources: string
  let root: string
  let manifestPath: string
  let binary: string
  let manifest: { version: string; binarySha256: Record<string, string>; files: { path: string }[] }

  // Stage and remove the real notice closure outside the assertion deadline.
  beforeAll(() => {
    temporary = mkdtempSync(join(tmpdir(), 'emate-feishu-notices-'))
    packaged = context(temporary, 'darwin', 3)
    resources = resolvePackagedResourcesRoot(packaged)
    root = join(resources, 'third-party-notices/feishu-cli/1.0.88')
    manifestPath = join(root, 'manifest.json')
    cpSync(join(import.meta.dirname, '../third-party-notices/feishu-cli/1.0.88'), root, { recursive: true })
    writeFileSync(join(resources, 'THIRD_PARTY_NOTICES.md'), '## Feishu native executable notices\nResources/third-party-notices/feishu-cli/1.0.88/')
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    binary = join(resolvePackagedUnpackedRoot(packaged), 'node_modules/@larksuite/cli/bin/lark-cli')
    mkdirSync(join(binary, '..'), { recursive: true })
    writeFileSync(binary, 'fixture binary')
    manifest.binarySha256['darwin-arm64'] = createHash('sha256').update('fixture binary').digest('hex')
    writeFileSync(manifestPath, JSON.stringify(manifest))
  })
  afterAll(() => { if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true }) })

  it('checks original notices, binary drift, universal handling and Windows static evidence', () => {
    expect(() => verifyPackagedFeishuNotices(packaged)).not.toThrow()
    writeFileSync(binary, 'different binary')
    expect(() => verifyPackagedFeishuNotices(packaged)).toThrow('differs from reviewed')
    expect(() => verifyPackagedFeishuNotices({ ...packaged, arch: 4 })).not.toThrow()
    const file = join(root, manifest.files[0]!.path)
    const original = readFileSync(file)
    writeFileSync(file, 'corrupt')
    expect(() => verifyPackagedFeishuNotices({ ...packaged, arch: 4 })).toThrow('notice hash mismatch')
    rmSync(file)
    expect(() => verifyPackagedFeishuNotices(packaged)).toThrow()
    writeFileSync(file, original)
    manifest.version = '1.0.89'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verifyPackagedFeishuNotices(packaged)).toThrow('manifest mismatch')
    manifest.version = '1.0.88'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const windows = context(join(temporary, 'windows'), 'win32', 1)
    cpSync(resources, resolvePackagedResourcesRoot(windows), { recursive: true })
    const windowsRoot = join(resolvePackagedResourcesRoot(windows), 'third-party-notices/feishu-cli/1.0.88')
    const windowsManifestPath = join(windowsRoot, 'manifest.json')
    const windowsManifest = JSON.parse(readFileSync(windowsManifestPath, 'utf8'))
    const windowsBinary = join(resolvePackagedUnpackedRoot(windows), 'node_modules/@larksuite/cli/bin/lark-cli.exe')
    writeFileSync(windowsBinary, 'Windows fixture binary')
    windowsManifest.binarySha256['win32-x64'] = createHash('sha256').update('Windows fixture binary').digest('hex')
    writeFileSync(windowsManifestPath, JSON.stringify(windowsManifest))
    expect(() => verifyPackagedFeishuNotices(windows)).not.toThrow()
    writeFileSync(windowsBinary, 'wrong Windows binary')
    expect(() => verifyPackagedFeishuNotices(windows)).toThrow('differs from reviewed')
    writeFileSync(windowsBinary, 'Windows fixture binary')
    const declaration = windowsManifest.files.find((entry: { module: string }) => entry.module === 'github.com/mattn/go-localereader')
    expect(declaration.evidenceKind).toContain('no complete LICENSE')
    rmSync(join(windowsRoot, declaration.path))
    expect(() => verifyPackagedFeishuNotices(windows)).toThrow()
    expect(windowsManifest.targetModules['win32-x64']).toHaveLength(45)
    expect(windowsManifest.targetModules['darwin-arm64']).toHaveLength(42)
    expect(windowsManifest.targetModules['darwin-x64']).toHaveLength(42)
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'))
    expect(pkg.files).toContain('third-party-notices/**')
    expect(pkg.build.extraResources).toEqual(expect.arrayContaining([
      { from: 'third-party-notices', to: 'third-party-notices' },
      { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    ]))
  })
})


const feishuStaging = join(import.meta.dirname, '../dist/mac-release/mac-universal-x64-temp')
const feishuStagingBinary = join(resolvePackagedUnpackedRoot(context(feishuStaging, 'darwin', 1)), 'node_modules/@larksuite/cli/bin/lark-cli')
it.skipIf(process.platform !== 'darwin' || !existsSync(feishuStagingBinary))('checks the actual staged Feishu binary with native lipo argument parsing', () => {
  let nativeChecks = 0
  preparePackagedFeishu(context(feishuStaging, 'darwin', 1), (command, args, options) => {
    if (command === '/usr/bin/lipo') {
      nativeChecks++
      expect(args).toEqual([feishuStagingBinary, '-verify_arch', 'x86_64'])
      return spawnSync(command, args, options)
    }
    // The installer already populated this staging tree. Do not install or execute it again.
    return { status: 0, stdout: args[0] === '-p' ? 'darwin:x64' : args[0] === '--version' ? 'lark-cli 1.0.88' : '' } as never
  })
  expect(nativeChecks).toBe(1)
})
