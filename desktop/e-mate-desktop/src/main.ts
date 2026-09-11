/** e-Mate executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, dialog } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  resolveProfileDir,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { getOrCreateDesktopInstallationId } from './desktop-installation-id.ts'
import { pinHarnessHome } from './harness-home.ts'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
} from './desktop-runtime-environment.ts'
import { ElectronDesktopRuntime } from './electron-runtime.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import {
  desktopInstallRecoveryStatePath,
  DesktopInstallRecoveryStore,
  type DesktopInstallRecoveryTransaction,
} from './install-recovery.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import {
  beginDesktopProfileStartup,
  markDesktopProfileFailed,
  markDesktopProfileHealthy,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import {
  EMATE_DESKTOP_PROFILE_VERSION,
  EMATE_PROFILE_NAME,
  cleanupEmateDesktopProfileArtifact,
  emateProfileComponentSources,
  installEmateDesktopProfile,
} from './e-mate-profile.ts'
import { prepareDesktopProfile, type SkippedOptionalEntry } from './profile.ts'
import { loadProfileBaseContract } from './base-contract.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { resolveDesktopShellEnvironment } from './shell-environment.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import { bundledPythonPath } from './vision-toolkit.ts'
import type {} from '@deepseek-ai/dsh-shell-env'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'
import {
  diagnoseWindowsVolumes,
  formatWindowsVolumeConcern,
  type WindowsVolumeConcern,
} from './windows-volume-diagnostics.ts'

const BIN_NAME = '@e-mate/desktop'
const PRODUCT_NAME = 'e-Mate'

/** Report profile recovery without changing startup or rollback outcomes. */
function notifyProfileRecovery(runtime: ElectronDesktopRuntime, body: string): void {
  try {
    runtime.updates.notify({ title: 'Unable to Open Profile', body })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show profile recovery notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const names = entries.map(entry => entry.name)
  const suffix = names.length > 1 ? ` and ${names.length - 1} more` : ''
  try {
    runtime.updates.notify({
      title: 'Skipped Unavailable UI Plugin',
      body: `${names[0]} is not installed in this profile${suffix}.`,
    })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show skipped plugin notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Surface path/volume risks that otherwise become obscure sandbox or pnpm failures later. */
function warnWindowsVolumeConcerns(concerns: readonly WindowsVolumeConcern[]): void {
  for (const concern of concerns) {
    process.stderr.write(`${BIN_NAME}: Windows volume warning: ${formatWindowsVolumeConcern(concern)}\n`)
  }
}

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    runtime.updates.notify({
      title: 'Storage May Be Unsupported',
      body: `${concerns[0]?.label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
    })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  let current: Context | undefined
  let profileStartup: DesktopProfileStartup | undefined
  let profileStatePath: string | undefined
  const processGenerationId = randomUUID()
  let installRecovery: DesktopInstallRecoveryStore | undefined
  let verifyingInstall: DesktopInstallRecoveryTransaction | undefined
  let rolledBackInstall: DesktopInstallRecoveryTransaction | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let disposeDshRuntime: (() => void) | undefined
  let disposePnpmRuntime: (() => void) | undefined
  let runtime!: ElectronDesktopRuntime
  let rendererBootSettled = false
  let resolveRendererBoot!: (report: RendererBootReport) => void
  const rendererBoot = new Promise<RendererBootReport>((resolve) => {
    resolveRendererBoot = resolve
  })
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => { removeShutdownRequests?.() },
  )
  let restartRequested = false
  const installationId = await getOrCreateDesktopInstallationId(app.getPath('userData'))
  runtime = new ElectronDesktopRuntime(async () => {
    if (shutdown === undefined) {
      throw new Error('@e-mate/desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    restartRequested = true
    nativeExit.requestRelaunch()
    await shutdown.request(0)
  }, (report) => {
    if (rendererBootSettled) return
    rendererBootSettled = true
    resolveRendererBoot(report)
  }, processGenerationId, installationId)
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => {
      try {
        await current?.fiber.dispose()
      } finally {
        disposeDshRuntime?.()
        disposePnpmRuntime?.()
      }
    },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  app.on('second-instance', () => { runtime.show() })
  await app.whenReady()
  if (process.env.EMATE_RELEASE_HEALTH_PROBE === '1') {
    writeFileSync(join(app.getPath('userData'), '.release-native-ready-ack'), app.getVersion(), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  }
  if (process.platform === 'win32') app.setAppUserModelId('net.ecoremedia.e-mate')
  if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))
  const shellEnvironmentResolution = await resolveDesktopShellEnvironment({
    environment: process.env,
    home: app.getPath('home'),
    isPackaged: app.isPackaged,
    platform: process.platform,
  })
  for (const [name, value] of Object.entries(shellEnvironmentResolution.updates)) process.env[name] = value
  // The product owns its Harness home: resolve it here and pin DSH_HOME for everything this
  // process boots. A DSH_HOME inherited from the launcher names another application's home
  // (a locally installed DeepSeek Harness, a shell profile, any tool that exports it) and
  // must never decide where e-Mate reads sessions from or writes settings to.
  const harnessHome = pinHarnessHome()
  if (harnessHome.ignored !== undefined) {
    process.stderr.write(`${BIN_NAME}: ignoring inherited DSH_HOME ${harnessHome.ignored}; this application owns ${harnessHome.home}\n`)
  }
  const homeDir = harnessHome.home
  const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
    { label: 'application install', path: process.execPath },
    { label: 'desktop user data', path: app.getPath('userData') },
    { label: 'DSH home', path: homeDir },
  ])
  warnWindowsVolumeConcerns(windowsVolumeConcerns)

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: process.stderr,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => {
    try {
      await current?.fiber.dispose()
    } finally {
      disposeDshRuntime?.()
      disposePnpmRuntime?.()
    }
  })

  try {
    const currentVersion = app.getVersion()
    if (app.isPackaged && currentVersion !== EMATE_DESKTOP_PROFILE_VERSION) {
      throw new Error(`${BIN_NAME}: packaged application version ${currentVersion} does not match profile version ${EMATE_DESKTOP_PROFILE_VERSION}`)
    }
    const visionPythonPath = bundledPythonPath()
    if (!existsSync(visionPythonPath)) {
      throw new Error(`${BIN_NAME}: managed Python runtime is missing: ${visionPythonPath}`)
    }
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    const electronVersion = process.versions.electron
    if (electronVersion === undefined) {
      throw new Error(`${BIN_NAME}: plugin runtime requires the Electron runtime version`)
    }
    const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
    const pnpmRuntime = installDesktopPnpmRuntime({
      platform: process.platform,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      stateDir: join(app.getPath('userData'), 'runtime-commands'),
      environment: process.env,
    })
    const releasePnpmRuntime = (): void => { pnpmRuntime.dispose() }
    disposePnpmRuntime = releasePnpmRuntime
    const selectionStatePath = join(app.getPath('userData'), 'profile-selection', 'state.json')
    const baseContract = loadProfileBaseContract(fileURLToPath(new URL('../base-contract.json', import.meta.url)))
    const deferredProfileCleanup = new Set<string>()
    installEmateDesktopProfile(
      homeDir,
      path => { deferredProfileCleanup.add(path) },
    )
    profileStatePath = selectionStatePath
    profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    const activeProfileName = profileStartup.profileName
    if (activeProfileName !== EMATE_PROFILE_NAME) {
      throw new Error(`${BIN_NAME}: desktop profile must be ${EMATE_PROFILE_NAME}`)
    }
    const activeProfileDir = resolveProfileDir(activeProfileName, homeDir)
    const installRecoveryStatePath = desktopInstallRecoveryStatePath(app.getPath('userData'))
    installRecovery = new DesktopInstallRecoveryStore({
      statePath: installRecoveryStatePath,
      profileName: activeProfileName,
      profileDir: activeProfileDir,
      generationId: processGenerationId,
    })
    const recoveryClaim = await installRecovery.claim()
    if (recoveryClaim.action === 'verify') {
      verifyingInstall = recoveryClaim.transaction
    } else if (recoveryClaim.action === 'prompt') {
      const choice = await dialog.showMessageBox({
        type: 'warning',
        title: '插件安装恢复',
        message: `插件 ${recoveryClaim.transaction.packageName} 的上次安装没有完成。`,
        detail: '可恢复到安装前状态，或只重试一次当前插件。未知文件变化不会被覆盖。',
        buttons: ['恢复安装前状态', '重试一次', '退出 e-Mate'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      if (choice.response === 1) {
        await installRecovery.requestRetry(recoveryClaim.transaction.transactionId)
        nativeExit.requestRelaunch()
        await shutdown.request(0)
        return
      }
      if (choice.response !== 0) {
        await shutdown.request(1)
        return
      }
      const restored = await installRecovery.restore(
        recoveryClaim.transaction.transactionId,
        recoveryClaim.reason,
      )
      if (restored.status === 'manual-recovery-required') {
        throw new Error(`${BIN_NAME}: plugin install recovery requires manual repair for ${restored.mismatchedFiles.join(', ')}`)
      }
      rolledBackInstall = restored.transaction
    } else if (recoveryClaim.action === 'terminal') {
      if (recoveryClaim.transaction.phase === 'manual-recovery-required') {
        throw new Error(`${BIN_NAME}: plugin install recovery requires manual repair`)
      }
      if (recoveryClaim.transaction.phase === 'verified') {
        await installRecovery.clear(recoveryClaim.transaction.transactionId)
      } else if (recoveryClaim.transaction.phase === 'rolled-back') {
        rolledBackInstall = recoveryClaim.transaction
      }
    } else if (recoveryClaim.action === 'deferred') {
      throw new Error(`${BIN_NAME}: plugin install recovery is deferred by ${recoveryClaim.reason}`)
    }
    const prepared = await prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
    )
    const dshBootstrapPath = fileURLToPath(new URL('./desktop-cli.js', import.meta.url))
    const dshRuntime = process.platform === 'win32'
      ? installDesktopDshRuntime({
          platform: process.platform,
          appExecutable: process.execPath,
          dshBootstrapPath,
          profileName: activeProfileName,
          homeDir,
          stateDir: join(app.getPath('userData'), 'host-commands', activeProfileName),
          environment: process.env,
        })
      : undefined
    const releaseDshRuntime = (): void => { dshRuntime?.dispose() }
    disposeDshRuntime = releaseDshRuntime
    const desktopPnpmBootstrap: DesktopPnpmBootstrap = {
      activeProfileName,
      activeProfileDir: prepared.profile.dir,
      homeDir,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
      dshBootstrapPath,
      installRecoveryStatePath,
      generationId: processGenerationId,
    }
    const releasePackageResolver = installProfilePackageResolver(
      prepared.bareModuleBaseUrl,
      emateProfileComponentSources(),
      baseContract.runtime_imports,
    )
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        hostCtx.inject(['shellEnv'], (ctx) => {
          ctx.shellEnv.register({
            name: 'emate-bundled-node',
            variables: { DSH_EMATE_NODE: { description: 'Absolute path of the e-Mate managed Node command. Run local JavaScript scripts with "$DSH_EMATE_NODE" script.mjs in Bash or & $env:DSH_EMATE_NODE script.mjs in PowerShell. This existing launcher handles the Electron environment; no package.json, package install, or system Node is required.' } },
            resolve: () => ({ DSH_EMATE_NODE: pnpmRuntime.nodeShimPath }),
          })
          ctx.shellEnv.register({
            name: 'emate-bundled-python',
            variables: { DSH_EMATE_PYTHON: { description: 'Absolute path of the e-Mate bundled Python interpreter. Quote this path when executing local Skill scripts.' } },
            resolve: () => ({ DSH_EMATE_PYTHON: visionPythonPath }),
          })
        })
        hostCtx.effect(
          () => releasePnpmRuntime,
          '@e-mate/desktop: packaged pnpm runtime PATH',
        )
        if (dshRuntime !== undefined) {
          hostCtx.effect(
            () => releaseDshRuntime,
            '@e-mate/desktop: packaged dsh runtime PATH',
          )
        }
        current = hostCtx
        hostCtx.effect(
          () => releasePackageResolver,
          '@e-mate/desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', '3080'],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    current = ctx
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
    })
    runtime.beginRendererBootMonitoring()
    await runtime.mountScheduled()
    const rendererReport = await rendererBoot
    if (rendererReport.status === 'failed') {
      const plugins = rendererReport.plugins.length === 0 ? 'unknown client plugin' : rendererReport.plugins.join(', ')
      throw new Error(`Renderer boot failed for ${plugins}: ${rendererReport.error ?? 'client Loader did not provide an error'}`)
    }
    if (verifyingInstall !== undefined && installRecovery !== undefined) {
      await installRecovery.markHealthy(verifyingInstall.transactionId)
      await installRecovery.clear(verifyingInstall.transactionId)
      verifyingInstall = undefined
    }
    if (rolledBackInstall !== undefined && installRecovery !== undefined) {
      if (rolledBackInstall.rollbackNotifiedAt === undefined) {
        try {
          runtime.updates.notify({
            title: '插件安装已回滚',
            body: `${rolledBackInstall.packageName} 未能安全启动，e-Mate 已恢复安装前状态。`,
          })
          rolledBackInstall = await installRecovery.markRollbackNotified(rolledBackInstall.transactionId)
        } catch (noticeCause) {
          process.stderr.write(`${BIN_NAME}: failed to report plugin install rollback: ${noticeCause instanceof Error ? noticeCause.message : String(noticeCause)}\n`)
        }
      }
      if (rolledBackInstall.rollbackNotifiedAt !== undefined) {
        await installRecovery.clear(rolledBackInstall.transactionId)
        rolledBackInstall = undefined
      }
    }
    markDesktopProfileHealthy(selectionStatePath, activeProfileName)
    if (process.env.EMATE_RELEASE_HEALTH_PROBE === '1') {
      writeFileSync(join(app.getPath('userData'), '.release-health-ack'), app.getVersion(), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    }
    for (const path of deferredProfileCleanup) {
      try {
        await cleanupEmateDesktopProfileArtifact(activeProfileDir, path)
      } catch {
        process.stderr.write(`${BIN_NAME}: stale managed profile cleanup deferred for bounded retry\n`)
      }
    }
    notifySkippedOptionalEntries(runtime, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, windowsVolumeConcerns)
    if (profileStartup.rolledBackFrom !== undefined) {
      notifyProfileRecovery(
        runtime,
        `Reopened last-known-good profile ${activeProfileName}.`,
      )
    }
  } catch (cause) {
    runtime.stopRendererBootMonitoring()
    const failure = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
    if (process.env.EMATE_RELEASE_HEALTH_PROBE === '1') {
      writeFileSync(join(app.getPath('userData'), '.release-health-failure'), failure.slice(0, 16 * 1024), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    }
    if (verifyingInstall !== undefined && installRecovery !== undefined) {
      try {
        await installRecovery.recordFailure(
          verifyingInstall.transactionId,
          runtime.rendererBootFailureReason ?? 'startup-failed',
        )
      } catch (recoveryCause) {
        process.stderr.write(`${BIN_NAME}: failed to persist plugin install recovery: ${recoveryCause instanceof Error ? recoveryCause.message : String(recoveryCause)}\n`)
      }
    }
    process.stderr.write(`${BIN_NAME}: ${failure}\n`)
    let exitCode = 1
    if (profileStartup !== undefined && profileStatePath !== undefined) {
      const retryLastKnownGood = profileStartup.profileName !== profileStartup.state.lastKnownGood
      try {
        markDesktopProfileFailed(profileStatePath, profileStartup.profileName)
        if (retryLastKnownGood) {
          nativeExit.requestRelaunch()
          exitCode = 0
          notifyProfileRecovery(
            runtime,
            `Reopening last-known-good profile ${profileStartup.state.lastKnownGood}.`,
          )
        }
      } catch (stateCause) {
        process.stderr.write(`${BIN_NAME}: failed to roll back desktop profile state: ${stateCause instanceof Error ? stateCause.message : String(stateCause)}\n`)
      }
    }
    await shutdown.request(exitCode)
  }
}

void start().catch((cause: unknown) => {
  const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  process.stderr.write(`${BIN_NAME}: fatal launcher failure: ${detail}\n`)
  if (app.isReady()) dialog.showErrorBox('e-Mate 无法启动', '启动状态无法安全初始化，请检查应用数据目录权限后重试。')
  app.exit(1)
})
