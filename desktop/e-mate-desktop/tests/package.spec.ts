import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const workspaceRoot = new URL('../', packageRoot)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name?: unknown
  version?: unknown
  bin?: Record<string, unknown>
  exports?: Record<string, unknown>
  files?: unknown
  scripts?: Record<string, unknown>
  dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  build?: {
    productName?: unknown
    appId?: unknown
    asarUnpack?: unknown
    extraResources?: unknown
    afterPack?: unknown
    electronFuses?: unknown
    files?: unknown
    mac?: {
      artifactName?: unknown
      hardenedRuntime?: unknown
      icon?: unknown
      mergeASARs?: unknown
      notarize?: unknown
      target?: unknown
      x64ArchFiles?: unknown
    }
    win?: { icon?: unknown; target?: unknown }
    nsis?: Record<string, unknown>
    linux?: { icon?: unknown }
  }
  dependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}
const workspaceManifest = JSON.parse(readFileSync(new URL('package.json', workspaceRoot), 'utf8')) as {
  version?: unknown
  resolutions?: Record<string, unknown>
  scripts?: Record<string, unknown>
}

describe('published package surface', () => {
  it('registers the e-Mate desktop launcher', () => {
    expect(manifest.name).toBe('@e-mate/desktop')
    expect(manifest.bin).toEqual({ 'e-mate-desktop': 'lib/bin.js' })
  })

  it('exposes the Host plugin and desktop-owned client face', () => {
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).toHaveProperty('./windows-pwsh-sandbox', {
      types: './lib/types/windows-pwsh-sandbox.d.ts',
      default: './lib/windows-pwsh-sandbox.js',
    })
    expect(manifest.exports).toHaveProperty('./windows-directory-picker', {
      types: './lib/types/windows-directory-picker.d.ts',
      default: './lib/windows-directory-picker.js',
    })
    expect(manifest.exports).toHaveProperty('./terminal', {
      types: './lib/types/terminal.d.ts',
      default: './lib/terminal.js',
    })
    expect(manifest.exports).toHaveProperty('./pnpm', {
      types: './lib/types/pnpm.d.ts',
      default: './lib/pnpm.js',
    })
    expect(manifest.exports).toHaveProperty('./profile-service', {
      types: './lib/types/profile-service.d.ts',
      default: './lib/profile-service.js',
    })
    expect(manifest.exports).toHaveProperty('./profiles', {
      types: './lib/types/profiles.d.ts',
      default: './lib/profiles.js',
    })
    expect(manifest.exports).toHaveProperty('./updates', {
      types: './lib/types/updates.d.ts',
      default: './lib/updates.js',
    })
    expect(manifest.exports).toHaveProperty('./agent-update', {
      types: './lib/types/agent-update.d.ts',
      default: './lib/agent-update.js',
    })
    expect(manifest.exports).not.toHaveProperty('./computer-use-setup')
    expect(manifest.exports).not.toHaveProperty('./windows-acl-runner')
    expect(manifest.exports).not.toHaveProperty('./desktop-cli')
    expect(manifest.exports).not.toHaveProperty('./desktop-runtime-environment')
    expect(manifest.exports).not.toHaveProperty('./desktop-terminal')
    expect(manifest.exports).not.toHaveProperty('./update-checker')
    expect(manifest.exports).not.toHaveProperty('./update-download')
    expect(manifest.exports).toHaveProperty('./package.json')
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-theme',
      ],
    })
    const patch = readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')
    expect(patch).toContain("name: '@e-mate/desktop'")
    expect(patch).toContain("name: '@e-mate/desktop/terminal'")
    expect(patch).toContain("name: '@e-mate/desktop/pnpm'")
    expect(patch).toContain("name: '@e-mate/desktop/updates'")
    expect(patch).toContain("name: '@e-mate/desktop/agent-update'")
    expect(patch).not.toContain('desktop-computer-use-setup')
    expect(patch).not.toContain('desktop-profiles')
  })

  it('keeps unaudited marketplace packages out of the published runtime', () => {
    expect(manifest.dependencies).not.toHaveProperty('dshmarket')
    expect(manifest.optionalDependencies ?? {}).not.toHaveProperty('dshmarket')
  })

  it('runs only the pinned rc.7 Harness packages', () => {
    const runtime = Object.entries(manifest.dependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
    expect(runtime.length).toBeGreaterThan(0)
    expect(runtime.every(([, version]) => version === '0.1.0-rc.7')).toBe(true)
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    expect(lockfile).not.toMatch(/^\s*version: 0\.1\.0-rc\.6$/mu)
  })

  it('marks the DSH Workspace browser as the desktop folder-drop target', () => {
    const patchPath = './patches/dsh-client-ui-workspace@0.1.0-rc.7.patch'
    expect(workspaceManifest.resolutions).toMatchObject({
      '@deepseek-ai/dsh-client-ui-workspace@npm:0.1.0-rc.7': expect.stringContaining(patchPath),
      '@deepseek-ai/dsh-client-ui-workspace@npm:^0.1.0-rc.7': expect.stringContaining(patchPath),
    })
    const patch = readFileSync(new URL(patchPath, workspaceRoot), 'utf8')
    const installedClient = readFileSync(new URL(
      'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js',
      packageRoot,
    ), 'utf8')
    expect(patch).toContain('data-dsh-workspace-drop-target')
    expect(installedClient).toContain('data-dsh-workspace-drop-target')
  })

  it('builds public Host plugins and their private native bootstraps', () => {
    const config = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')

    expect(config).toContain("'windows-pwsh-sandbox': 'src/windows-pwsh-sandbox.ts'")
    expect(config).toContain("'windows-directory-picker': 'src/windows-directory-picker.ts'")
    expect(config).toContain("'windows-acl-runner': 'src/windows-acl-runner.ts'")
    expect(config).toContain("'desktop-cli': 'src/desktop-cli.ts'")
    expect(config).toContain("'desktop-runtime-environment': 'src/desktop-runtime-environment.ts'")
    expect(config).toContain("'desktop-terminal': 'src/desktop-terminal.ts'")
    expect(config).toContain("'profile-manager': 'src/profile-manager.ts'")
    expect(config).toContain("'profile-service': 'src/profile-service.ts'")
    expect(config).toContain("pnpm: 'src/pnpm.ts'")
    expect(config).toContain("profiles: 'src/profiles.ts'")
    expect(config).toContain("terminal: 'src/terminal.ts'")
    expect(config).toContain("'update-download': 'src/update-download.ts'")
    expect(config).toContain("updates: 'src/updates.ts'")
    expect(config).toContain("'agent-update': 'src/agent-update.ts'")
    expect(config).toContain("entry: { preload: 'src/preload.ts' }")
    expect(config).toContain("entryFileNames: 'preload.cjs'")
  })

  it('keeps host-only preparation and profile boot out of portable source checks', () => {
    expect(manifest.scripts?.build).toBe('yarn run prepare:python && yarn run prepare:calc && yarn run build:sdk')
    expect(manifest.scripts?.['build:sdk']).not.toContain('prepare:python')
    expect(manifest.scripts?.['check:source']).toBe('yarn run build:sdk && yarn run typecheck && yarn run test && yarn run verify:closure && yarn run verify:cli && yarn run verify:loader && yarn run verify:licenses')
    expect(manifest.scripts?.['check:source']).not.toContain('verify:profile')
    expect(manifest.scripts?.check).toBe('yarn run prepare:python && yarn run check:source && yarn run verify:profile')
  })

  it('installs Host command PATHs after the launch snapshot and before profile boot', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const recover = main.indexOf('await resolveDesktopShellEnvironment')
    const applyRecovered = main.indexOf('Object.entries(shellEnvironmentResolution.updates)')
    const snapshot = main.indexOf('const environment = loadLayeredEnv')
    const install = main.indexOf('const pnpmRuntime = installDesktopPnpmRuntime')
    const prepare = main.indexOf('const prepared = prepareDesktopProfile')
    const installDsh = main.indexOf('const dshRuntime = process.platform === \'win32\'')
    const boot = main.indexOf('const ctx = await boot')
    const beginRendererHealth = main.indexOf('runtime.beginRendererBootMonitoring()')
    const mount = main.indexOf('await runtime.mountScheduled(')
    const rendererHealth = main.indexOf('const rendererReport = await rendererBoot')
    const electronReady = main.indexOf('await app.whenReady()')
    const nativeReadyAck = main.indexOf("'.release-native-ready-ack'")
    const releaseAck = main.indexOf("'.release-health-ack'")
    const profileCleanup = main.indexOf('for (const path of deferredProfileCleanup)')

    expect(recover).toBeGreaterThanOrEqual(0)
    expect(applyRecovered).toBeGreaterThan(recover)
    expect(snapshot).toBeGreaterThan(applyRecovered)
    expect(install).toBeGreaterThan(snapshot)
    expect(nativeReadyAck).toBeGreaterThan(electronReady)
    expect(nativeReadyAck).toBeLessThan(snapshot)
    expect(prepare).toBeGreaterThan(install)
    expect(installDsh).toBeGreaterThan(prepare)
    expect(boot).toBeGreaterThan(prepare)
    expect(boot).toBeGreaterThan(installDsh)
    expect(beginRendererHealth).toBeGreaterThan(boot)
    expect(mount).toBeGreaterThan(boot)
    expect(mount).toBeGreaterThan(beginRendererHealth)
    expect(rendererHealth).toBeGreaterThan(mount)
    expect(releaseAck).toBeGreaterThan(rendererHealth)
    expect(releaseAck).toBeLessThan(profileCleanup)
    expect(profileCleanup).toBeGreaterThan(mount)
    expect(main).toContain("'@e-mate/desktop: packaged pnpm runtime PATH'")
    expect(main).toContain("'@e-mate/desktop: packaged dsh runtime PATH'")
    expect(main).toContain("process.env.EMATE_RELEASE_HEALTH_PROBE === '1'")
    expect(main).toContain("'.release-native-ready-ack'")
    expect(main).toContain("'.release-health-ack'")
    expect(main).toContain('disposePnpmRuntime?.()')
    expect(main).toContain('disposeDshRuntime?.()')
  })

  it('uses the upstream child-environment scrub around login-shell recovery', () => {
    const shellEnvironment = readFileSync(new URL('src/shell-environment.ts', packageRoot), 'utf8')

    expect(shellEnvironment).toContain('scrubbedParentEnv')
    expect(shellEnvironment).toContain('SENSITIVE_ENV_PATTERN')
    expect(shellEnvironment).toContain('DSH_ENV_PREFIX')
    expect(shellEnvironment).toContain('DESKTOP_SHELL_ENVIRONMENT_KEYS')
  })

  it('commits recoverable plugin installs only after Renderer health', () => {
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const pnpm = readFileSync(new URL('src/pnpm.ts', packageRoot), 'utf8')
    const claim = main.indexOf('const recoveryClaim = await installRecovery.claim()')
    const prepare = main.indexOf('const prepared = prepareDesktopProfile')
    const rendererHealth = main.indexOf('const rendererReport = await rendererBoot')
    const installHealth = main.indexOf('await installRecovery.markHealthy(verifyingInstall.transactionId)')

    expect(claim).toBeGreaterThanOrEqual(0)
    expect(claim).toBeLessThan(prepare)
    expect(installHealth).toBeGreaterThan(rendererHealth)
    expect(main).toContain("runtime.rendererBootFailureReason ?? 'startup-failed'")
    expect(main).toContain('await installRecovery.recordFailure(')
    expect(pnpm).toContain('plugin add must use the recoverable install boundary')
    expect(pnpm).toContain('async runPluginInstall(')
    expect(pnpm).toContain('await this.installRecovery.seal(active.recoveryTransactionId)')
  })

  it('fixes the installed application identity', () => {
    expect(manifest.version).toBe(workspaceManifest.version)
    expect(manifest.build?.productName).toBe('e-Mate')
    expect(manifest.build?.appId).toBe('net.ecoremedia.e-mate')
    expect(manifest.build?.asarUnpack).toEqual([
      'base-contract.json',
      'package.json',
      'cordis.patch.yml',
      'build/**',
      'lib/**',
      'node_modules/**',
    ])
    expect(manifest.build?.electronFuses).toEqual({ runAsNode: true })
    expect(manifest.files).toEqual(expect.arrayContaining([
      'base-contract.json',
      'build/app-icon.png',
      'build/app-icon-mac.png',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'docs/**',
      'lib/**/*.cjs',
    ]))
    expect(manifest.build?.files).toEqual([
      'base-contract.json',
      'build/e-mate-profile/**',
      'build/harness-runtime-provenance.json',
      'build/app-icon.png',
      'build/app-icon-mac.png',
      'build/tray-icon.svg',
      'build/tray-icon*.png',
      'cordis.patch.yml',
      'lib/**',
      'package.json',
      'node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json',
      '!node_modules/node-pty/build/**',
      '!node_modules/**/node-pty/build/**',
    ])
    expect(manifest.build?.extraResources).toEqual([
      { from: 'build/python-runtime', to: 'python-runtime' },
      { from: 'build/calc-runtime', to: 'calc-runtime' },
    ])
    expect(manifest.build?.mac?.icon).toBe('build/app-icon-mac.png')
    expect(manifest.build?.mac?.mergeASARs).toBe(false)
    expect(manifest.build?.win?.icon).toBe('build/app-icon.png')
    expect(manifest.build?.win?.target).toEqual([{
      target: 'nsis',
      arch: ['x64'],
    }])
    expect(manifest.build?.nsis).toEqual({
      license: 'THIRD_PARTY_NOTICES.md',
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      differentialPackage: false,
      shortcutName: 'e-Mate',
      useZip: true,
      artifactName: 'e-Mate-${version}-win-${arch}-Setup.${ext}',
    })
    expect((manifest.build as { toolsets?: unknown } | undefined)?.toolsets).toBeUndefined()
    expect(manifest.build?.linux).toBeUndefined()
  })

  it('uses the one native unsigned macOS packaging path', () => {
    const packageDir = readFileSync(new URL('scripts/package-dir.mjs', packageRoot), 'utf8')

    expect(manifest.scripts?.['build:sdk']).toContain('node scripts/sync-emate-profile.mjs')
    expect(manifest.scripts?.['build:sdk']).not.toContain('sync-emate-plugin-bundles.mjs')
    expect(manifest.scripts?.['build:sdk']).toContain('node scripts/generate-mac-app-icon.mjs')
    expect(manifest.scripts?.['package:dir']).toBe('yarn run build && node scripts/package-dir.mjs')
    expect(packageDir).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(packageDir).toContain("import { prepareInstalledMacUniversalRuntime } from './mac-universal.ts'")
    expect(packageDir).toContain("if (process.platform === 'darwin') prepareInstalledMacUniversalRuntime(packageRoot)")
    expect(manifest.scripts?.['dist:mac']).toBe('node scripts/package-mac.ts')
    expect(manifest.scripts?.['dist:mac-unsigned-release']).toBeUndefined()
    expect(manifest.scripts?.['dist:mac-smoke']).toBeUndefined()
    expect(manifest.scripts?.['dist:win']).toBe('node scripts/package-win.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('yarn run build')
    expect(manifest.scripts?.['check:win-package']).toContain('yarn run typecheck')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/e-mate-profile-win.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/electron-runtime.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/package-win.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/plugin.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/profile.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/update-checker.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/update-download.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/windows-directory-picker.spec.ts')
    expect(manifest.scripts?.['check:win-package']).not.toContain('tests/desktop-installer-quit.spec.ts')
    expect(manifest.scripts?.['check:win-package']).not.toContain('tests/installer-nsh.spec.ts')
    expect(manifest.scripts?.['check:win-package']).not.toContain('test:app-builder-fuses')
    expect(manifest.scripts?.['check:win-package']).not.toContain('windows-update-installer')
    expect(manifest.scripts?.['check:win-package']).not.toContain('windows-update-transaction')
    expect(manifest.scripts?.['check:win-package']).toContain('tests/windows-volume-diagnostics.spec.ts')
    expect(manifest.scripts?.['check:win-package']).toContain('yarn run verify:closure')
    expect(manifest.scripts?.['test:windows-update-transaction']).toBeUndefined()
    expect(manifest.scripts?.['verify:cli']).toBe('node scripts/verify-cli-runtime.mjs')
    expect(manifest.scripts?.['check:source']).toContain('yarn run verify:cli')
    expect(workspaceManifest.scripts?.['dist:mac']).toBe('yarn workspace @e-mate/desktop dist:mac')
    expect(workspaceManifest.scripts?.['dist:mac-unsigned-release']).toBeUndefined()
    expect(workspaceManifest.scripts?.['dist:mac-smoke']).toBeUndefined()
    expect(workspaceManifest.scripts?.['dist:win'])
      .toBe('yarn workspace @e-mate/desktop dist:win')
    expect(manifest.build?.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
    expect(manifest.build?.mac).toEqual(expect.objectContaining({
      hardenedRuntime: true,
      mergeASARs: false,
      notarize: false,
      target: ['dir'],
      x64ArchFiles: expect.stringContaining('node-pty/prebuilds/darwin-*'),
    }))
    expect(String(manifest.build?.mac?.x64ArchFiles))
      .toContain('python-runtime/darwin-*/**')
    expect(String(manifest.build?.mac?.x64ArchFiles))
      .not.toContain('xin-assistant')
    expect(manifest.build?.files).toContain('!node_modules/node-pty/build/**')
    expect(manifest.build?.files).toContain('!node_modules/**/node-pty/build/**')
    expect(manifest.devDependencies?.['@electron/asar']).toBe('3.4.1')
  })

  it('preserves architecture-scoped Python dylibs with the universal merger matching rules', () => {
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const universalRequire = createRequire(workspaceRequire.resolve('@electron/universal'))
    const { minimatch } = universalRequire('minimatch') as {
      minimatch(path: string, pattern: string, options: { matchBase: boolean }): boolean
    }
    const pattern = String(manifest.build?.mac?.x64ArchFiles)
    for (const arch of ['arm64', 'x64']) {
      expect(minimatch(`Contents/Resources/python-runtime/darwin-${arch}/python/lib/python3.12/site-packages/PIL/.dylibs/libXau.6.dylib`, pattern, { matchBase: true })).toBe(true)
    }
    expect(minimatch('Contents/Resources/unscoped/PIL/.dylibs/libXau.6.dylib', pattern, { matchBase: true })).toBe(false)
    expect(minimatch('Contents/Frameworks/Unexpected.dylib', pattern, { matchBase: true })).toBe(false)
  })

  it('keeps dsh-desktop as the only package and update owner', () => {
    const agentUpdate = readFileSync(new URL('src/agent-update.ts', packageRoot), 'utf8')
    const main = readFileSync(new URL('src/main.ts', packageRoot), 'utf8')
    const preload = readFileSync(new URL('src/preload.ts', packageRoot), 'utf8')
    const updates = readFileSync(new URL('src/updates.ts', packageRoot), 'utf8')
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', packageRoot), 'utf8')
    const forbidden = [
      'scripts/package-mac-unsigned-release.ts',
      'scripts/sign-existing-mac-release.ts',
      'scripts/desktop-release-manifest.ts',
      'src/profile-update.ts',
      'src/mac-update-helper.ts',
      'src/mac-update-installer.ts',
      'src/update-lifecycle.ts',
      'src/desktop-installer-quit.ts',
      'src/relaunch-arguments.ts',
      'build/installer.nsh',
      '../../scripts/local-flow.mjs',
      '../../scripts/base-sdk.mjs',
      '../../scripts/change-impact.mjs',
      '../../scripts/component-release.mjs',
      '../../scripts/smoke',
      '../../tests/smoke',
      '../../upstream/e-mate-2.0.5',
      '../../upstream/plugins/dsh-search-mcp',
      '../../deploy/download-page/site.d9ba6145f056.js',
      '../../.github/workflows/desktop-release.yml',
      '../../.github/workflows/audit.yml',
    ]

    for (const path of forbidden) expect(existsSync(new URL(path, packageRoot)), path).toBe(false)
    expect(agentUpdate.match(/runInteractiveUpdate\(\)/gu)).toHaveLength(1)
    expect(agentUpdate).not.toMatch(/\bfetch\b|https?:|node:fs|child_process|from ['"]electron['"]/u)
    expect(updates).toContain('const runManualCheck = (): Promise<void> =>')
    expect(updates).toContain('invoke: runManualCheck')
    expect(updates).toContain('interactiveUpdate = runManualCheck')
    expect(updates).toContain('setInteractiveUpdateHandler?.(runManualCheck)')
    expect(preload).toContain('DESKTOP_UPDATE_RUN_INTERACTIVE')
    expect(main).toContain('getOrCreateDesktopInstallationId(app.getPath(\'userData\'))')
    expect(main).toMatch(/void start\(\)\.catch\(/u)
    expect(workflow).not.toMatch(/yarn workspace @e-mate\/desktop dist:(?:mac|win)/u)
    expect(workflow).not.toMatch(/schema-2|local-flow|dist:mac-unsigned-release/u)
  })

  it('keeps one fixed e-Mate orange tray source for generated native assets', () => {
    const source = readFileSync(new URL('build/tray-icon.svg', packageRoot), 'utf8')

    expect(source.match(/#F06418/gu)).toHaveLength(1)
    expect(source).not.toMatch(/<style\b|prefers-color-scheme/iu)
    for (const filename of [
      'tray-iconTemplate.png',
      'tray-iconTemplate@2x.png',
      'tray-icon-blue.png',
      'tray-icon-blue@1.25x.png',
      'tray-icon-blue@1.5x.png',
      'tray-icon-blue@2x.png',
    ]) {
      expect(readFileSync(new URL(`build/${filename}`, packageRoot)).byteLength).toBeGreaterThan(0)
    }
  })

  it('generates rounded cross-platform and inset macOS application icons', async () => {
    const sourceFile = readFileSync(new URL('build/app-icon.png', packageRoot))
    const source = await sharp(sourceFile).metadata()
    const sourcePixels = await sharp(sourceFile).ensureAlpha().raw().toBuffer()
    const icon = sharp(readFileSync(new URL('build/app-icon-mac.png', packageRoot)))
    const metadata = await icon.metadata()
    const { info } = await icon
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
      .toBuffer({ resolveWithObject: true })

    expect(metadata).toEqual(expect.objectContaining({
      format: 'png',
      width: 1024,
      height: 1024,
      space: 'rgb16',
      depth: 'ushort',
      bitsPerSample: 16,
      channels: 4,
      hasAlpha: true,
    }))
    expect(metadata.icc).toEqual(source.icc)
    expect(sourcePixels[3]).toBe(0)
    expect(sourcePixels[(512 * 1024 + 512) * 4 + 3]).toBe(255)
    expect(info.width).toBeLessThan(824)
    expect(info.width).toBeGreaterThan(700)
    expect(info.height).toBe(info.width)
  })

  it('keeps Electron out of production dependencies consumed by electron-builder', () => {
    expect(manifest.dependencies).not.toHaveProperty('electron')
    expect(manifest.peerDependencies?.electron).toBe('43.4.0')
    expect(manifest.devDependencies?.electron).toBe('43.4.0')
    expect(manifest.dependencies?.pnpm).toBe('11.7.0')
  })

  it('packages the native-compiled Koffi Windows runtime', () => {
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')

    expect(manifest.dependencies?.koffi).toBe('3.1.5')
    expect(workspaceManifest.resolutions).toMatchObject({
      'koffi@npm:^3.1.0': '3.1.5',
    })
    expect(lockfile).toContain('"koffi@npm:3.1.5":')
    expect(lockfile).toContain('@koromix/koffi-win32-x64@npm:3.1.5')
    expect(lockfile).not.toContain('"koffi@npm:3.1.4":')
    expect(lockfile).not.toContain('@koromix/koffi-win32-x64@npm:3.1.4')
  })

  it('keeps the DSH node-pty runtime from duplicating an already-unpacked ASAR helper path', () => {
    const runtimePatch = 'patch:node-pty@npm%3A1.2.0-beta.15#./.yarn/patches/node-pty-npm-1.2.0-beta.15-asar-unpacked-path.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(
      new URL('.yarn/patches/node-pty-npm-1.2.0-beta.15-asar-unpacked-path.patch', workspaceRoot),
      'utf8',
    )
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const installed = readFileSync(workspaceRequire.resolve('node-pty/lib/unixTerminal.js'), 'utf8')

    expect(workspaceManifest.resolutions).toMatchObject({
      'node-pty@npm:1.2.0-beta.15': runtimePatch,
    })
    expect(lockfile).toContain('node-pty@patch:node-pty@npm%3A1.2.0-beta.15#./.yarn/patches/node-pty-npm-1.2.0-beta.15-asar-unpacked-path.patch')
    expect(patch).toContain("path.sep + 'app.asar' + path.sep")
    expect(installed).toContain("path.sep + 'app.asar' + path.sep")
    expect(installed).not.toContain("replace('app.asar', 'app.asar.unpacked')")
    expect(manifest.dependencies).not.toHaveProperty('dsh-better-sidebar')
    expect(workspaceManifest.resolutions).not.toHaveProperty('node-pty@npm:^1.1.0')
    expect(lockfile).not.toContain('dsh-better-sidebar@')
  })

  it('binds empty machine patch handling to the pinned rc.7 app-boot patch', () => {
    const patchResolution = 'patch:@deepseek-ai/dsh-app-boot@npm%3A0.1.0-rc.7#./patches/dsh-app-boot@0.1.0-rc.7.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL('patches/dsh-app-boot@0.1.0-rc.7.patch', workspaceRoot), 'utf8')

    expect(workspaceManifest.resolutions).toMatchObject({
      '@deepseek-ai/dsh-app-boot@npm:0.1.0-rc.7': patchResolution,
      '@deepseek-ai/dsh-app-boot@npm:^0.1.0-rc.7': patchResolution,
    })
    expect(patch).toBe([
      'diff --git a/lib/index.js b/lib/index.js',
      'index 8bca7aa8e26ef9c9f1495061d2e91ff89ebf434a..32c9f77f20af88f0606f75afd9fdf88126c91d90 100644',
      '--- a/lib/index.js',
      '+++ b/lib/index.js',
      '@@ -840 +840,2 @@ function parsePatchList(binName, file, content, label) {',
      '-\tif (!Array.isArray(parsed)) throw new Error(\`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries\`);',
      '+\tif (parsed === void 0 || parsed === null) return [];',
      '+\tif (!Array.isArray(parsed)) throw new Error(\`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries\`);',
      '',
    ].join('\n'))
    expect(lockfile).toContain(
      '"@deepseek-ai/dsh-app-boot@patch:@deepseek-ai/dsh-app-boot@npm%3A0.1.0-rc.7#./patches/dsh-app-boot@0.1.0-rc.7.patch::locator=%40e-mate%2Fdesktop-workspace%40workspace%3A.":',
    )
    expect(lockfile).toContain(
      'resolution: "@deepseek-ai/dsh-app-boot@patch:@deepseek-ai/dsh-app-boot@npm%3A0.1.0-rc.7#./patches/dsh-app-boot@0.1.0-rc.7.patch::version=0.1.0-rc.7&hash=d4ccf8&locator=%40e-mate%2Fdesktop-workspace%40workspace%3A."',
    )
  })

  it('keeps the pinned app-builder patch free of local NSIS changes', () => {
    const patchResolution = 'patch:app-builder-lib@npm%3A26.15.7#./patches/app-builder-lib@26.15.7.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL('patches/app-builder-lib@26.15.7.patch', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const electronBuilderManifest = workspaceRequire.resolve('electron-builder/package.json')
    const electronBuilderRequire = createRequire(electronBuilderManifest)
    const appBuilderManifest = electronBuilderRequire.resolve('app-builder-lib/package.json')
    const installedCodeSign = readFileSync(join(dirname(appBuilderManifest), 'out/codeSign/macCodeSign.js'), 'utf8')

    expect(workspaceManifest.resolutions).toMatchObject({
      'app-builder-lib@npm:26.15.7': patchResolution,
    })
    expect(lockfile).toContain('app-builder-lib@patch:app-builder-lib@npm%3A26.15.7#./patches/app-builder-lib@26.15.7.patch')
    expect(patch).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(patch).toContain('"-k", keychainPassword, keychainFile')
    expect(installedCodeSign).toContain('importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)')
    expect(installedCodeSign).toContain('"-k", keychainPassword, keychainFile')
    expect(patch).not.toContain('templates/nsis/')
    expect(patch).not.toContain('out/platformPackager.js')
  })

  it('starts restricted Windows shells with a hidden console show state', () => {
    const patchResolution = 'patch:@deepseek-ai/dsh-sandbox-windows-acl@npm%3A0.1.0-rc.7#./patches/dsh-sandbox-windows-acl@0.1.0-rc.7.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const patch = readFileSync(new URL('patches/dsh-sandbox-windows-acl@0.1.0-rc.7.patch', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))
    const sandboxManifest = workspaceRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json')
    const sandboxLocalManifest = workspaceRequire.resolve('@deepseek-ai/dsh-sandbox-local/package.json')
    const sandboxLocalRequire = createRequire(sandboxLocalManifest)
    const sandboxLib = join(dirname(sandboxManifest), 'lib')
    const runtimeChunks = readdirSync(sandboxLib).filter(name => /^types-.*\.js$/u.test(name))

    expect(workspaceManifest.resolutions).toMatchObject({
      '@deepseek-ai/dsh-sandbox-windows-acl@npm:0.1.0-rc.7': patchResolution,
      '@deepseek-ai/dsh-sandbox-windows-acl@npm:^0.1.0-rc.7': patchResolution,
    })
    expect(sandboxLocalRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json'))
      .toBe(sandboxManifest)
    expect(lockfile).toContain('@deepseek-ai/dsh-sandbox-windows-acl@patch:@deepseek-ai/dsh-sandbox-windows-acl@npm%3A0.1.0-rc.7#./patches/dsh-sandbox-windows-acl@0.1.0-rc.7.patch')
    expect(patch.match(/^\+\s*dwFlags: 257,\r?$/gmu)).toHaveLength(2)
    expect(patch.match(/^\+\s*wShowWindow: 0,\r?$/gmu)).toHaveLength(2)
    expect(runtimeChunks).toHaveLength(1)
    const installedRuntime = readFileSync(join(sandboxLib, runtimeChunks[0] as string), 'utf8')
    expect(installedRuntime.match(/dwFlags: 257,/gu)).toHaveLength(2)
    expect(installedRuntime.match(/wShowWindow: 0,/gu)).toHaveLength(2)
    expect(installedRuntime).toContain('api.createProcessAsUserW(token, null, commandLine, null, null, 1, 0, null')
    expect(installedRuntime).toContain('api.createProcessAsUserW(token, null, commandLine, null, null, 1, 4, null')
    expect(installedRuntime).not.toContain('134217728')
  })

  it('ignores redundant filesystem escalation metadata under the current policy', () => {
    const fsPatch = 'patch:@deepseek-ai/dsh-tool-fs@npm%3A0.1.0-rc.7#~/.yarn/patches/@deepseek-ai-dsh-tool-fs-npm-0.1.0-rc.7-redundant-escalation.patch'
    const lockfile = readFileSync(new URL('yarn.lock', workspaceRoot), 'utf8')
    const workspaceRequire = createRequire(new URL('package.json', packageRoot))

    expect(workspaceManifest.resolutions).toMatchObject({
      '@deepseek-ai/dsh-tool-fs@npm:^0.1.0-rc.7': fsPatch,
    })
    expect(lockfile).toContain('@deepseek-ai/dsh-tool-fs@patch:@deepseek-ai/dsh-tool-fs@npm%3A0.1.0-rc.7#~/.yarn/patches/')
    const packageManifest = workspaceRequire.resolve('@deepseek-ai/dsh-tool-fs/package.json')
    const installed = readFileSync(join(dirname(packageManifest), 'lib/index.js'), 'utf8')
    expect(installed).toContain('const redundantEscalation =')
    expect(installed).toContain('if (!redundantEscalation) validateEscalationArgs(')
    expect(installed).toContain('args.justification === void 0 || redundantEscalation')
  })

})
