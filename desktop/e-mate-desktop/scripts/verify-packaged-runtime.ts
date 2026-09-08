/** Fail-loud verification of the runtime entries sealed into Electron's app.asar. */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { listPackage } from '@electron/asar'
import {
  FORBIDDEN_MACOS_UNIVERSAL_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
} from './mac-universal.ts'

/** AfterPack fields consumed without importing Electron Builder's incomplete declaration graph. */
export interface PackagedRuntimeContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture (`4` is its stable universal enum value). */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
  /** Product metadata used to locate the macOS application bundle. */
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
    }
  }
}

/** Exact archive entries required by the desktop launcher on every supported platform. */
export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = [
  'base-contract.json',
  'package.json',
  'lib/main.js',
  'lib/client.js',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/desktop-cli.js',
  'lib/desktop-runtime-environment.js',
  'lib/desktop-terminal.js',
  'lib/terminal.js',
  'lib/update-checker.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-acl-runner.js',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/pnpm/bin/pnpm.mjs',
  'node_modules/@larksuite/cli/package.json',
  'node_modules/@larksuite/cli/LICENSE',
  'node_modules/@larksuite/cli/checksums.txt',
  'node_modules/@larksuite/cli/scripts/install.js',
] as const

/** Physical entries required because profile fallback symlinks cannot target ASAR paths. */
export const REQUIRED_UNPACKED_RUNTIME_ENTRIES = [
  'package.json',
  'cordis.patch.yml',
  'build/app-icon.png',
  'build/app-icon-mac.png',
  'build/tray-iconTemplate.png',
  'build/tray-icon-blue.png',
  'build/e-mate-profile/component-inventory.json',
  'build/e-mate-profile/bundles/cdp/package.json',
  'build/e-mate-profile/bundles/cdp/lib/index.mjs',
  'build/e-mate-profile/bundles/pet/lib/assets/xiaoxin-v2.json',
  'build/e-mate-profile/bundles/pet/lib/assets/xiaoxin-v2.webp',
  'build/e-mate-profile/bundles/pet/lib/assets/xiaoxin-office.json',
  'build/e-mate-profile/bundles/pet/lib/assets/xiaoxin-office.webp',
  'build/e-mate-profile/bundles/canvas/lib/assets/asset-manifest.json',
  'build/e-mate-profile/bundles/canvas/lib/assets/editor.js',
  'build/e-mate-profile/bundles/canvas/lib/assets/editor.css',
  'lib/main.js',
  'lib/client.js',
  'lib/index.js',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/terminal.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-directory-picker.js',
  'lib/windows-pwsh-sandbox.js',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/standard/preset.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/code/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/code/preset.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/preset.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/preset.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json',
  'node_modules/pnpm/bin/pnpm.mjs',
] as const

/** Retired packages that must never re-enter a future Desktop payload. */
export const RETIRED_UNPACKED_RUNTIME_ENTRIES = [
  'node_modules/@e-mate/dsh-plugin-xin-assistant',
] as const

/** Prebuilt Node-API modules required when the Windows package skips native source rebuilds. */
export const REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES = [
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
] as const

/** CPU-specific runtime assets that must coexist in a universal macOS application. */
export const REQUIRED_MACOS_UNIVERSAL_ENTRIES = [
  ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => entry.path),
] as const

/** Fixed Python bootstrap executables exposed to the rc.7 Vision component. */
export const REQUIRED_PYTHON_RUNTIME_ENTRIES = {
  'darwin-arm64': 'python-runtime/darwin-arm64/python/bin/python3',
  'darwin-x64': 'python-runtime/darwin-x64/python/bin/python3',
  'win32-x64': 'python-runtime/win32-x64/python/python.exe',
} as const

/** Package exports that profile fallback links must resolve from the physical application tree. */
export const REQUIRED_UNPACKED_PACKAGE_SPECIFIERS = [
  '@e-mate/desktop',
  '@e-mate/desktop/profile',
  '@e-mate/desktop/client',
  '@e-mate/desktop/terminal',
  '@e-mate/desktop/pnpm',
  '@e-mate/desktop/profile-service',
  '@e-mate/desktop/profiles',
  '@e-mate/desktop/updates',
  '@e-mate/desktop/windows-directory-picker',
  '@e-mate/desktop/windows-pwsh-sandbox',
  '@e-mate/desktop/package.json',
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/dsh-web-app/package.json',
] as const

/** Injectable archive listing seam used by focused tests. */
export type ArchiveLister = (archivePath: string, options: { isPack: boolean }) => readonly string[]

/** Injectable physical-file probe used by focused tests. */
export type FileProbe = (filename: string) => boolean

/** Injectable Node package resolver used by focused tests. */
export type PackageResolver = (specifier: string) => string

/** Injectable packaged Electron runner used by the native PTY smoke. */
export type PtyProbeRunner = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly env: NodeJS.ProcessEnv; readonly timeout: number; readonly killSignal?: NodeJS.Signals },
) => { readonly error?: Error; readonly status: number | null; readonly stderr?: string; readonly stdout?: string }

/**
 * Resolve the platform-specific archive produced by Electron Builder.
 * @param context - completed application directory and target platform.
 * @returns absolute path to the packaged app.asar.
 */
export function resolvePackagedAsarPath(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app.asar')
  }
  throw new Error(
    `@e-mate/desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/**
 * Resolve the physical dependency tree emitted beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns absolute path to app.asar.unpacked.
 */
export function resolvePackagedUnpackedRoot(context: PackagedRuntimeContext): string {
  return `${resolvePackagedAsarPath(context)}.unpacked`
}

/** Resolve the physical Resources directory that contains app.asar and Python. */
export function resolvePackagedResourcesRoot(context: PackagedRuntimeContext): string {
  return dirname(resolvePackagedAsarPath(context))
}

/** Verify the packaged Electron process can spawn one real PTY command. */
export function verifyPackagedNodePty(
  context: PackagedRuntimeContext,
  run: PtyProbeRunner = (command, args, options) => spawnSync(command, args, options),
  now: () => number = () => performance.now(),
): void {
  // electron-builder creates temporary single-architecture slices before the
  // final universal app. Run the live probe on that final app so an arm64 host
  // never depends on a cold Rosetta launch merely to assemble the x64 slice.
  if (context.electronPlatformName === 'darwin'
    && context.arch !== undefined
    && context.arch !== 4) return
  const executable = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'MacOS', context.packager.appInfo.productFilename)
    : join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const nodePtyRoot = join(resolvePackagedUnpackedRoot(context), 'node_modules', 'node-pty')
  const command = context.electronPlatformName === 'win32'
    ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
    : '/bin/sh'
  const commandArgs = context.electronPlatformName === 'win32'
    ? ['/d', '/s', '/c', 'echo e-mate-pty-ready']
    : ['-c', 'printf e-mate-pty-ready']
  const receiptId = randomBytes(16).toString('hex')
  const ptyBudgetMs = 60_000
  const totalBudgetMs = context.electronPlatformName === 'darwin' ? 180_000 : 60_000
  // Start before either require. Recheck monotonic elapsed at completion: a
  // blocked event loop must not turn a late PTY result into watchdog success.
  // This fixed non-login shell runs only a builtin; closing the probe's PTY
  // descriptors cannot leave user startup-script jobs behind.
  const probe = [
    'const started=process.hrtime.bigint();',
    `const receiptId=${JSON.stringify(receiptId)};`,
    'let t,finished=false;',
    'function finish(ok){if(finished)return;finished=true;clearTimeout(watchdog);',
    'const elapsedMs=Number(process.hrtime.bigint()-started)/1e6;',
    `if(!ok||elapsedMs>${ptyBudgetMs}){try{t?.kill("SIGKILL")}catch{}process.exit(1);return;}`,
    'fs.writeSync(1,JSON.stringify({schema:1,receiptId,elapsedMs})+"\\n");process.exit(0)}',
    `const watchdog=setTimeout(()=>finish(false),${ptyBudgetMs});`,
    'const fs=require("node:fs");const p=require(process.argv[1]);',
    // A synchronous require timeout must not start another process afterward.
    `if(Number(process.hrtime.bigint()-started)/1e6>${ptyBudgetMs})finish(false);`,
    't=p.spawn(process.argv[2],JSON.parse(process.argv[3]),{cwd:process.cwd(),env:process.env});',
    'let out="";',
    't.onData(d=>{out+=d});',
    't.onExit(e=>finish(e.exitCode===0&&out.includes("e-mate-pty-ready")));',
  ].join('')
  const started = now()
  const result = run(executable, ['-e', probe, nodePtyRoot, command, JSON.stringify(commandArgs)], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: totalBudgetMs,
    killSignal: 'SIGKILL',
  })
  const totalMs = now() - started
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.error?.message, String(result.stderr ?? '').trim()]
      .filter(value => value !== undefined && value !== '')
      .join(': ')
    throw new Error(
      `@e-mate/desktop: packaged node-pty smoke failed${detail === '' ? '' : `: ${detail}`}`,
      result.error === undefined ? undefined : { cause: result.error },
    )
  }
  let receipt: unknown
  try { receipt = JSON.parse(result.stdout ?? '') } catch { /* Missing, duplicate or malformed receipts fail below. */ }
  const value = receipt as { schema?: unknown; receiptId?: unknown; elapsedMs?: unknown } | null
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'elapsedMs,receiptId,schema'
    || value.schema !== 1 || value.receiptId !== receiptId
    || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
    || !Number.isFinite(totalMs) || totalMs < value.elapsedMs) {
    throw new Error('@e-mate/desktop: packaged node-pty smoke failed: missing or invalid timing receipt')
  }
  const startupMs = totalMs - value.elapsedMs // includes process launch, receipt flush and exit overhead
  const timing = `startup_ms=${startupMs.toFixed(1)} pty_ms=${value.elapsedMs.toFixed(1)} total_ms=${totalMs.toFixed(1)}`
  if (value.elapsedMs > ptyBudgetMs || totalMs > totalBudgetMs
    || context.electronPlatformName === 'darwin' && startupMs > 120_000) {
    throw new Error(`@e-mate/desktop: packaged node-pty smoke failed: timing budget exceeded (${timing})`)
  }
  console.log(`@e-mate/desktop: packaged node-pty smoke passed (${timing})`)
}

function requiredPythonEntries(context: PackagedRuntimeContext): readonly string[] {
  if (context.electronPlatformName === 'win32') return [REQUIRED_PYTHON_RUNTIME_ENTRIES['win32-x64']]
  if (context.electronPlatformName === 'darwin' && context.arch === 4) {
    return [
      REQUIRED_PYTHON_RUNTIME_ENTRIES['darwin-arm64'],
      REQUIRED_PYTHON_RUNTIME_ENTRIES['darwin-x64'],
    ]
  }
  return [context.arch === 3
    ? REQUIRED_PYTHON_RUNTIME_ENTRIES['darwin-arm64']
    : REQUIRED_PYTHON_RUNTIME_ENTRIES['darwin-x64']]
}

/** Normalize the host-specific separators emitted by the ASAR reader. */
function normalizeArchiveEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Inspect one archive and reject an incomplete packaged runtime.
 * @param archivePath - resolved app.asar path.
 * @param list - ASAR listing implementation.
 * @returns The normalized archive entry set for physical mirror verification.
 */
export function verifyPackagedAsar(
  archivePath: string,
  list: ArchiveLister = listPackage,
): ReadonlySet<string> {
  let entries: readonly string[]
  try {
    entries = list(archivePath, { isPack: false })
  } catch (cause) {
    throw new Error(
      `@e-mate/desktop: failed to inspect packaged runtime at ${archivePath}`,
      { cause },
    )
  }

  const present = new Set(entries.map(normalizeArchiveEntry))
  const missing = REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `@e-mate/desktop: packaged runtime at ${archivePath} is missing required ASAR entries: ${missing.join(', ')}`,
    )
  }
  return present
}

/**
 * Require every ASAR header entry to have a physical counterpart.
 *
 * The Desktop packaging contract unpacks every included application file so
 * profile fallback links and Node ESM resolution never target virtual paths.
 * Checking the complete header closes the gap left by a curated entry list:
 * a collector regression cannot silently omit transitive packages such as
 * yaml, zod, or typebox from app.asar.unpacked.
 */
export function verifyUnpackedArchiveMirror(
  archiveEntries: ReadonlySet<string>,
  unpackedRoot: string,
  exists: FileProbe = existsSync,
): void {
  const missing = [...archiveEntries]
    .filter(entry => entry.length > 0 && !exists(join(unpackedRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `@e-mate/desktop: unpacked runtime at ${unpackedRoot} is missing ASAR-declared physical entries: ${missing.join(', ')}`,
    )
  }
}

/**
 * Verify package exports resolve through the physical tree instead of the build workspace.
 * @param unpackedRoot - absolute path to app.asar.unpacked.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects missing exports and paths outside app.asar.unpacked.
 */
export function verifyUnpackedPackageResolution(
  unpackedRoot: string,
  resolvePackage: PackageResolver = createRequire(join(unpackedRoot, 'package.json')).resolve,
): void {
  for (const specifier of REQUIRED_UNPACKED_PACKAGE_SPECIFIERS) {
    let resolvedPath: string
    try {
      resolvedPath = resolvePackage(specifier)
    } catch (cause) {
      throw new Error(
        `@e-mate/desktop: packaged runtime at ${unpackedRoot} cannot resolve required package export ${specifier}`,
        { cause },
      )
    }

    const relativePath = relative(unpackedRoot, resolvedPath)
    if (
      !isAbsolute(resolvedPath)
      || relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(
        `@e-mate/desktop: required package export ${specifier} resolved outside ${unpackedRoot}: ${resolvedPath}`,
      )
    }
  }
}

/**
 * Verify Electron Builder's completed application before signing begins.
 * @param context - Electron Builder's afterPack context.
 * @param list - ASAR listing implementation.
 * @param exists - physical-file probe for the unpacked CLI dependency tree.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedRuntime(
  context: PackagedRuntimeContext,
  list: ArchiveLister = listPackage,
  exists: FileProbe = existsSync,
  resolvePackage?: PackageResolver,
): void {
  const archiveEntries = verifyPackagedAsar(resolvePackagedAsarPath(context), list)
  const unpackedRoot = resolvePackagedUnpackedRoot(context)
  const requiredPhysicalEntries = context.electronPlatformName === 'win32'
    ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
    : context.electronPlatformName === 'darwin' && context.arch === 4
      ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_MACOS_UNIVERSAL_ENTRIES]
      : REQUIRED_UNPACKED_RUNTIME_ENTRIES
  const missing = requiredPhysicalEntries.filter(entry => !exists(join(unpackedRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `@e-mate/desktop: packaged runtime at ${unpackedRoot} is missing required physical entries: ${missing.join(', ')}`,
    )
  }
  const retired = RETIRED_UNPACKED_RUNTIME_ENTRIES
    .filter(entry => exists(join(unpackedRoot, entry)))
  if (retired.length > 0) {
    throw new Error(
      `@e-mate/desktop: packaged runtime at ${unpackedRoot} contains retired physical entries: ${retired.join(', ')}`,
    )
  }
  const resourcesRoot = resolvePackagedResourcesRoot(context)
  const missingPython = requiredPythonEntries(context)
    .filter(entry => !exists(join(resourcesRoot, entry)))
  if (missingPython.length > 0) {
    throw new Error(
      `@e-mate/desktop: packaged runtime at ${resourcesRoot} is missing Python runtime entries: ${missingPython.join(', ')}`,
    )
  }
  if (context.electronPlatformName === 'darwin') {
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .filter(entry => exists(join(unpackedRoot, entry)))
    if (forbidden.length > 0) {
      throw new Error(
        `@e-mate/desktop: universal macOS runtime at ${unpackedRoot} contains host-architecture build output: ${forbidden.join(', ')}`,
      )
    }
  }
  verifyUnpackedArchiveMirror(archiveEntries, unpackedRoot, exists)
  verifyUnpackedPackageResolution(unpackedRoot, resolvePackage)
}

/** Prepare the official CLI using each native Builder slice's own Electron, before signing. */
export function preparePackagedFeishu(
  context: PackagedRuntimeContext,
  run: PtyProbeRunner = (command, args, options) => spawnSync(command, args, options),
): void {
  const platform = context.electronPlatformName
  if (platform !== 'darwin' && platform !== 'win32') return
  const root = join(resolvePackagedUnpackedRoot(context), 'node_modules/@larksuite/cli')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@larksuite/cli' || manifest.version !== '1.0.88' || manifest.license !== 'MIT') {
    throw new Error('packaged Feishu CLI identity/license mismatch')
  }
  for (const file of ['LICENSE', 'checksums.txt', 'scripts/install.js']) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error(`packaged Feishu CLI missing ${file}`)
  }
  const executable = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/MacOS', context.packager.appInfo.productFilename)
    : join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const binary = join(root, 'bin', platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  const execute = (command: string, args: string[], timeout = 30_000) => {
    const result = run(command, args, { encoding: 'utf8', timeout, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LARK_CLI_RUN: 'true' } })
    if (result.error || result.status !== 0) throw new Error(`packaged Feishu CLI command failed: ${result.error?.message ?? result.stderr ?? 'nonzero exit'}`)
    return String(result.stdout ?? '').trim()
  }
  if (!(platform === 'darwin' && context.arch === 4)) {
    const target = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : undefined
    if (target === undefined) throw new Error('packaged Feishu CLI requires an explicit native target architecture')
    const actual = execute(executable, ['-p', 'process.platform + ":" + process.arch'], 180_000)
    if (actual !== `${platform}:${target}`) throw new Error(`packaged Feishu CLI target mismatch: ${actual}`)
    // npmRebuild is disabled. Use the unmodified official installer, which owns its
    // release URLs, archive SHA256 verification and extraction. No runtime fallback.
    console.info(`Feishu official installer: ${actual} @larksuite/cli@1.0.88`)
    const output = execute(executable, [join(root, 'scripts/install.js')], 180_000)
    if (output !== '') console.info(output)
  }
  if (!lstatSync(binary).isFile()) throw new Error('packaged Feishu CLI executable missing')
  if (platform === 'darwin') {
    execute('/usr/bin/lipo', [binary, '-verify_arch', ...(context.arch === 4 ? ['x86_64', 'arm64'] : [context.arch === 1 ? 'x86_64' : 'arm64'])])
  }
  // Newly downloaded or merged Mach-O files may incur macOS first-launch validation.
  const version = execute(binary, ['--version'], platform === 'darwin' ? 180_000 : 30_000)
  if (!/(?:^|\s)v?1\.0\.88(?:\s|$)/u.test(version)) throw new Error('packaged Feishu CLI executable version mismatch')
}

/** Verify the reviewed native-binary notices in the actual Builder resource tree. */
export function verifyPackagedFeishuNotices(context: PackagedRuntimeContext): void {
  const resources = resolvePackagedResourcesRoot(context)
  const root = join(resources, 'third-party-notices/feishu-cli/1.0.88')
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    package: string; version: string; binarySha256: Record<string, string>
    files: Array<{ path: string; bytes: number; sha256: string }>
  }
  if (manifest.package !== '@larksuite/cli' || manifest.version !== '1.0.88' || manifest.files.length !== 93) {
    throw new Error('packaged Feishu native notice manifest mismatch')
  }
  const notice = readFileSync(join(resources, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  if (!notice.includes('## Feishu native executable notices') || !notice.includes('feishu-cli/1.0.88/')) {
    throw new Error('packaged Feishu native notice index missing')
  }
  for (const file of manifest.files) {
    if (isAbsolute(file.path) || file.path.split(/[\\/]/u).includes('..')) throw new Error('invalid Feishu notice path')
    const bytes = readFileSync(join(root, file.path))
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`packaged Feishu notice hash mismatch: ${file.path}`)
    }
  }
  const targets = context.electronPlatformName === 'darwin' && context.arch === 4
    ? ['darwin-x64', 'darwin-arm64']
    : [`${context.electronPlatformName}-${context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'unknown'}`]
  for (const target of targets) {
    if (!/^[a-f0-9]{64}$/u.test(manifest.binarySha256[target] ?? '')) {
      throw new Error(`Feishu native license evidence not verified for ${target}`)
    }
  }
  // Builder already validated each thin slice before its native universal merge.
  // The merged executable has different bytes; retain the existing lipo/version checks.
  if (context.electronPlatformName === 'darwin' && context.arch === 4) return
  const binary = join(resolvePackagedUnpackedRoot(context), 'node_modules/@larksuite/cli/bin',
    context.electronPlatformName === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== manifest.binarySha256[targets[0]!]) {
    throw new Error('packaged Feishu binary differs from reviewed native license evidence')
  }
}

/**
 * Complete official per-slice CLI preparation and verify the native package before signing.
 * @param context - Electron Builder's afterPack context.
 * @returns A promise that rejects before signing when the runtime is incomplete.
 */
export async function afterPack(context: PackagedRuntimeContext): Promise<void> {
  preparePackagedFeishu(context)
  verifyPackagedFeishuNotices(context)
  verifyPackagedRuntime(context)
  verifyPackagedVision(context)
  preservePackagedCalcDirectories(context)
  preservePackagedCalcMetadata(context)
  verifyPackagedCalc(context)
  verifyPackagedNodePty(context)
}

/** Reject incomplete offline visual dependencies in the actual unpacked bundle. */
export function verifyPackagedVision(context: PackagedRuntimeContext): void {
  const targets = context.electronPlatformName === 'darwin' ? ['darwin-arm64', 'darwin-x64']
    : context.electronPlatformName === 'win32' ? ['win32-x64'] : []
  if (targets.length === 0) return
  const root = join(resolvePackagedUnpackedRoot(context), 'build/e-mate-profile/bundles/vision-toolkit/runtime')
  const requirements = readFileSync(join(root, 'requirements.lock'), 'utf8').trim().split('\n')
  for (const target of targets) {
    const directory = join(root, 'wheels', target)
    const files = readdirSync(directory)
    if (files.length !== 3) throw new Error(`packaged Vision wheel closure is incomplete: ${target}`)
    for (const name of ['pillow', 'numpy', 'vtracer']) {
      const matches = files.filter(file => file.startsWith(`${name}-`) && file.endsWith('.whl'))
      if (matches.length !== 1) throw new Error(`packaged Vision wheel is missing or duplicated: ${target}/${name}`)
      const suffix = target === 'darwin-arm64' ? '_arm64.whl'
        : target === 'darwin-x64' ? '_x86_64.whl' : '-win_amd64.whl'
      if (!matches[0]!.includes('-cp312-cp312-') || !matches[0]!.endsWith(suffix)) {
        throw new Error(`packaged Vision wheel target mismatch: ${target}/${name}`)
      }
      const path = join(directory, matches[0]!)
      if (!lstatSync(path).isFile()) throw new Error(`packaged Vision wheel is not a regular file: ${path}`)
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      const lock = requirements.find(line => line.startsWith(`${name}==`))
      if (!lock?.split(/\s+/u).includes(`--hash=sha256:${digest}`)) {
        throw new Error(`packaged Vision wheel hash mismatch: ${target}/${name}`)
      }
    }
  }
}

/** Preserve original empty directories omitted by Electron Builder's resource copier. */
export function preservePackagedCalcDirectories(context: PackagedRuntimeContext): void {
  if (context.electronPlatformName !== 'darwin') return
  // These paths and 0755 modes were verified in both pinned upstream DMGs.
  const directories = ['Contents/Resources/autotext/common', 'Contents/Resources/en.lproj', 'Contents/Resources/uno_packages/cache/uno_packages']
  for (const target of requiredPythonEntries(context).map(entry => entry.split('/')[1]!)) {
    const root = join(resolvePackagedResourcesRoot(context), 'calc-runtime', target, 'LibreOffice.app')
    if (!lstatSync(root).isDirectory()) throw new Error('Calc package root must be a directory')
    for (const directory of directories) {
      let current = root
      for (const part of directory.split('/')) {
        current = join(current, part)
        try {
          if (!lstatSync(current).isDirectory()) throw new Error('Calc directory path is not a real directory')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          // Only the fixed empty leaves and their empty uno_packages parents may be created.
          const suffix = relative(root, current).split(sep).join('/')
          if (!directories.includes(suffix) && suffix !== 'Contents/Resources/uno_packages' && suffix !== 'Contents/Resources/uno_packages/cache') throw error
          mkdirSync(current, { mode: 0o755 })
        }
      }
    }
  }
}

/** Original metadata hashes verified in both pinned Calc DMGs. */
const CALC_METADATA = [
  ['Contents/Info.plist', 'f3c82437a0fb5110f0c0974c11db13c9299ea29393b10760d9ba3ec5f2b22d71'],
  ['Contents/Frameworks/LibreOfficePython.framework/Versions/3.13/Resources/Info.plist', '17ae01719cf4cf059f95ddf3192d72275e7ac3498eb485ffb5c34d4eac303bd0'],
  ['Contents/Frameworks/LibreOfficePython.framework/Versions/3.13/Resources/Python.app/Contents/Info.plist', 'd7d5978df7b34a747123d2d1b3dbe51bea53c7260d4a232b6576a6911f4b3edb'],
  ['Contents/Library/Spotlight/OOoSpotlightImporter.mdimporter/Contents/Info.plist', 'e497abd0b747742f7fb1e55a71323d076ab61f2fb54b0fddfd65576990803239'],
  ['Contents/PlugIns/QuickLookPreview.appex/Contents/Info.plist', 'ef8a37d7c0d46a65807b76b581219633c2b52559a3e437554429a835f314f55b'],
  ['Contents/PlugIns/QuickLookThumbnail.appex/Contents/Info.plist', 'aab49421e8f08b4969a468d1125c394240ac7f5efeca73a12c15bc9f89882179'],
] as const

/** Reapply fixed upstream bytes after Universal injects Electron-only plist fields. */
export function preserveCalcMetadataFile(sourceRoot: string, destinationRoot: string, name: string, sha256: string): void {
  for (const root of [sourceRoot, destinationRoot]) {
    let current = root
    if (!lstatSync(current).isDirectory()) throw new Error('Calc metadata root must be a real directory')
    for (const part of name.split('/').slice(0, -1)) {
      current = join(current, part)
      if (!lstatSync(current).isDirectory()) throw new Error('Calc metadata parent must be a real directory')
    }
    if (!lstatSync(join(root, name)).isFile()) throw new Error('Calc metadata must be a regular file')
  }
  const original = readFileSync(join(sourceRoot, name))
  if (createHash('sha256').update(original).digest('hex') !== sha256) throw new Error('Calc original metadata digest mismatch')
  const destination = join(destinationRoot, name)
  if (!readFileSync(destination).equals(original)) writeFileSync(destination, original)
}

export function preservePackagedCalcMetadata(context: PackagedRuntimeContext): void {
  if (context.electronPlatformName !== 'darwin' || context.arch !== 4) return
  for (const target of requiredPythonEntries(context).map(entry => entry.split('/')[1]!)) {
    const source = join(import.meta.dirname, '../build/calc-runtime', target, 'LibreOffice.app')
    const destination = join(resolvePackagedResourcesRoot(context), 'calc-runtime', target, 'LibreOffice.app')
    for (const [name, sha256] of CALC_METADATA) preserveCalcMetadataFile(source, destination, name, sha256)
  }
}

/** Read-only whole-payload verification; never downloads into a finished package. */
export function verifyPackagedCalc(context: PackagedRuntimeContext, run: PtyProbeRunner = (command, args, options) => spawnSync(command, args, options)): void {
  const targets = requiredPythonEntries(context).map(entry => entry.split('/')[1]!)
  for (const target of targets) {
    const result = run(process.execPath, [join(import.meta.dirname, 'prepare-calc-runtime.mjs'), '--verify-root', join(resolvePackagedResourcesRoot(context), 'calc-runtime'), '--packaged', '--target', target], {
      encoding: 'utf8', env: process.env, timeout: 180_000,
    })
    if (result.error || result.status !== 0) throw new Error(`Packaged Calc verification failed for ${target}: ${result.error?.message ?? result.stderr ?? 'nonzero exit'}`)
  }
}

export default afterPack
