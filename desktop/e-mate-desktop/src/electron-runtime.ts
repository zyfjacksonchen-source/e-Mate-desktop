/** Electron implementation of the launcher-provided desktop runtime capability. */

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  shell,
  Tray,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopTerminalStateDirectory, openDesktopTerminal } from './desktop-terminal.ts'
import { renderSvgPage as renderNativeSvgPage } from './svg-page-renderer.ts'
import type { DesktopRendererBootstrap } from './desktop-bootstrap-contract.ts'
import { DESKTOP_UPDATE_RUN_INTERACTIVE } from './desktop-update-trigger-contract.ts'
import type { DesktopInstallationId } from './desktop-installation-id.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import type {
  DesktopLocale,
  DesktopNotification,
  DesktopPlatform,
  DesktopRuntime,
  DesktopSvgRenderRequest,
  DesktopSvgRenderResult,
  DesktopShellSpec,
  DesktopTerminalSpec,
  DesktopThemeSource,
  DesktopTrayItem,
  DesktopTrayItemGroup,
  DesktopTrayItemRegistration,
  DesktopUpdateAdapter,
} from './runtime.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import {
  desktopUpdateFilename,
  downloadDesktopUpdate,
  pendingDesktopUpdateArtifact,
  recordDesktopUpdateArtifact,
  resolveDesktopUpdateArtifact,
  type DesktopUpdateArtifact,
} from './update-download.ts'
import type { UpdateCheckResult } from './update-checker.ts'
import { desktopWindowOptions, windowsTitleBarOverlay } from './window-options.ts'
import {
  DESKTOP_RESOURCE_RUN,
  parseDesktopResourceRequest,
  type DesktopResource,
  type DesktopResourceAction,
} from './desktop-resource-bridge-contract.ts'

/** Return the presentation mode opposite the active generation. */
export function nextDesktopShellMode(mode: DesktopShellSpec['mode']): DesktopShellSpec['mode'] {
  return mode === 'compatibility' ? 'advanced' : 'compatibility'
}

/** Return the tray command describing the mode that will be activated. */
export function modeToggleLabel(mode: DesktopShellSpec['mode']): string {
  return mode === 'compatibility'
    ? 'Switch to Advanced Mode'
    : 'Switch to Compatibility Mode'
}

/**
 * Read the desktop package version instead of Electron's development-app version.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @returns validated desktop product version.
 */
export function desktopProductVersion(moduleUrl: string = import.meta.url): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (value === null || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'string') {
    throw new Error('@e-mate/desktop: package.json has no product version')
  }
  return (value as { version: string }).version
}

/** Resolve the CommonJS preload emitted beside the Electron runtime bundle. */
export function desktopPreloadPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('./preload.cjs', moduleUrl))
}

const PRODUCT_VERSION = desktopProductVersion()
const RESOURCE_CONTEXT_SCRIPT = `Reflect.get(globalThis, '__EMATE_DESKTOP_RESOURCE__') ?? null`
const MAX_CONTEXT_IMAGE_BYTES = 32 * 1024 * 1024
const MIN_ZOOM_LEVEL = -4
const MAX_ZOOM_LEVEL = 4

function clampedZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level))
}

function zoomShortcut(input: Electron.Input): 'in' | 'out' | 'reset' | undefined {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 1_000)
}

function formatExitCode(exitCode: number): string {
  return exitCode < 0 ? `${String(exitCode)} / 0x${(exitCode >>> 0).toString(16)}` : String(exitCode)
}

type ResourceContext =
  | { kind: 'file'; name: string; path: string; root: string; sessionId: string }
  | { kind: 'image'; name: string; src: string; sessionId: string }
  | { kind: 'handled' }

type Resource = Exclude<ResourceContext, { kind: 'handled' }> | DesktopResource

function resourceContext(value: unknown): ResourceContext | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.kind === 'handled' && Object.keys(item).length === 1) return { kind: 'handled' }
  if (item.kind === 'file' && typeof item.name === 'string' && typeof item.path === 'string'
    && typeof item.root === 'string' && typeof item.sessionId === 'string') {
    return { kind: 'file', name: item.name, path: item.path, root: item.root, sessionId: item.sessionId }
  }
  if (item.kind === 'image' && typeof item.name === 'string' && typeof item.src === 'string'
    && item.src.startsWith('blob:') && typeof item.sessionId === 'string') {
    return { kind: 'image', name: item.name, src: item.src, sessionId: item.sessionId }
  }
  return undefined
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function safeResourceName(name: string, fallback: string): string {
  const value = basename(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim()
  return value === '' || value === '.' || value === '..' ? fallback : value.slice(0, 180)
}

function imageMediaType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** Main-process deadline for one Renderer generation to settle its client Loader. */
export const RENDERER_BOOT_TIMEOUT_MS = 30_000

/** Failure class used by startup recovery to distinguish a hung Renderer. */
export type RendererBootFailureReason = 'renderer-failed' | 'renderer-timeout'

/** Native adapter used by the e-Mate launcher and owned by its Cordis shell plugin. */
export class ElectronDesktopRuntime implements DesktopRuntime {
  readonly platform: DesktopPlatform
  get locale(): DesktopLocale { return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en' }
  readonly updates: DesktopUpdateAdapter

  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private scheduled: DesktopShellSpec | undefined
  private mountTask: Promise<void> | undefined
  private release: (() => Promise<void>) | undefined
  private quitting = false
  private readonly svgRenderShutdown = new AbortController()
  private readonly trayItems = new Map<symbol, DesktopTrayItem>()
  private terminalSpec: DesktopTerminalSpec | undefined
  private rendererBootReported = false
  private rendererBootMonitoring = false
  private rendererHealthy = false
  private rendererBootTimer: NodeJS.Timeout | undefined
  private bootFailureReason: RendererBootFailureReason | undefined
  private directoryPickTask: Promise<string | null> | undefined
  private readonly profileGeneration = 'bundled' as const
  private interactiveUpdate: (() => Promise<void>) | undefined

  constructor(
    private readonly restart: () => Promise<void>,
    private readonly onRendererBoot: (report: RendererBootReport) => void = () => {},
    private readonly runtimeId = randomUUID(),
    installationId?: DesktopInstallationId,
  ) {
    if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
      throw new Error(`@e-mate/desktop: unsupported Electron platform ${process.platform}`)
    }
    this.platform = process.platform
    this.updates = {
      get isPackaged() { return app.isPackaged },
      get canDownload() { return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32') },
      get currentVersion() { return PRODUCT_VERSION },
      get statePath() { return join(app.getPath('userData'), 'updates', 'state.json') },
      ...(installationId === undefined ? {} : { installationId }),
      request: (url, init) => net.fetch(url, init),
      confirmDownload: version => this.confirmUpdateDownload(version),
      showManualCheckResult: result => this.showManualUpdateCheckResult(result),
      downloadAndOpen: (version, signal) => this.downloadAndOpenUpdate(version, signal),
      notify: notification => { this.showNotification(notification) },
      setInteractiveUpdateHandler: handler => { this.interactiveUpdate = handler },
    }
  }

  /** Terminal failure class for the first Renderer boot report, when it failed. */
  get rendererBootFailureReason(): RendererBootFailureReason | undefined {
    return this.bootFailureReason
  }

  /** Arm one main-process deadline immediately before the native shell starts loading. */
  beginRendererBootMonitoring(timeoutMs: number = RENDERER_BOOT_TIMEOUT_MS): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('@e-mate/desktop: renderer boot timeout must be a positive integer')
    }
    if (this.rendererBootReported || this.rendererBootMonitoring) {
      throw new Error('@e-mate/desktop: renderer boot monitoring already started')
    }
    this.rendererBootMonitoring = true
    this.rendererBootTimer = setTimeout(() => {
      this.failRendererBoot(
        'renderer-timeout',
        `The Renderer did not report boot health within ${String(timeoutMs)}ms.`,
      )
    }, timeoutMs)
    this.rendererBootTimer.unref()
  }

  /** Stop a pending deadline while startup is being torn down for another failure. */
  stopRendererBootMonitoring(): void {
    this.rendererBootMonitoring = false
    if (this.rendererBootTimer !== undefined) clearTimeout(this.rendererBootTimer)
    this.rendererBootTimer = undefined
  }

  /** @inheritdoc */
  schedule(spec: DesktopShellSpec): () => Promise<void> {
    if (this.scheduled !== undefined || this.mountTask !== undefined) {
      throw new Error('@e-mate/desktop: a native shell generation is already registered')
    }
    const previousThemeSource = nativeTheme.themeSource
    this.scheduled = spec
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      try {
        await this.mountTask
      } finally {
        try {
          await this.release?.()
        } finally {
          this.release = undefined
          this.mountTask = undefined
          if (this.scheduled === spec) {
            nativeTheme.themeSource = previousThemeSource
            this.scheduled = undefined
          }
        }
      }
    }
  }

  /** @inheritdoc */
  mountScheduled(beforeInteractive?: () => void): Promise<void> {
    const spec = this.scheduled
    if (spec === undefined) {
      return Promise.reject(new Error('@e-mate/desktop: the Cordis shell plugin did not register a window'))
    }
    this.mountTask ??= this.mount(spec, beforeInteractive).then((release) => { this.release = release })
    return this.mountTask
  }

  /** @inheritdoc */
  show(): void {
    if (!this.rendererHealthy) return
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  }

  /** @inheritdoc */
  async pickDirectory(): Promise<string | null> {
    if (this.directoryPickTask !== undefined) return await this.directoryPickTask
    const task = this.showDirectoryPicker()
    this.directoryPickTask = task
    try {
      return await task
    } finally {
      if (this.directoryPickTask === task) this.directoryPickTask = undefined
    }
  }

  /** @inheritdoc */
  async renderSvgPage(request: DesktopSvgRenderRequest): Promise<DesktopSvgRenderResult> {
    this.svgRenderShutdown.signal.throwIfAborted()
    const signal = request.signal === undefined
      ? this.svgRenderShutdown.signal
      : AbortSignal.any([request.signal, this.svgRenderShutdown.signal])
    return await renderNativeSvgPage({ ...request, signal })
  }

  private async showDirectoryPicker(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: '选择工作区目录',
      properties: ['openDirectory', 'dontAddToRecent'],
    }
    const window = this.window
    const result = window === undefined || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
    return result.canceled ? null : result.filePaths[0] ?? null
  }

  /** @inheritdoc */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration {
    const key = Symbol()
    this.trayItems.set(key, item)
    this.rebuildTrayMenu()
    let active = true
    return {
      refresh: () => {
        if (active) this.rebuildTrayMenu()
      },
      dispose: () => {
        if (!active) return
        active = false
        this.trayItems.delete(key)
        this.rebuildTrayMenu()
      },
    }
  }

  /**
   * Fix the profile identity before Cordis plugins can contribute terminal commands.
   * @param spec - launcher-resolved desktop profile and Harness home.
   */
  configureTerminal(spec: DesktopTerminalSpec): void {
    if (this.terminalSpec !== undefined) {
      throw new Error('@e-mate/desktop: terminal profile is already configured')
    }
    this.terminalSpec = { ...spec }
  }

  /** @inheritdoc */
  openTerminal(): void {
    try {
      const spec = this.terminalSpec
      if (spec === undefined) {
        throw new Error('@e-mate/desktop: terminal profile is not configured')
      }
      const electronVersion = process.versions.electron
      if (electronVersion === undefined) {
        throw new Error('@e-mate/desktop: terminal requires the Electron runtime version')
      }
      openDesktopTerminal({
        platform: this.platform,
        appExecutable: process.execPath,
        dshBootstrapPath: fileURLToPath(new URL('./desktop-cli.js', import.meta.url)),
        pnpmBinPath: packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs'),
        electronVersion,
        profileName: spec.profileName,
        productVersion: PRODUCT_VERSION,
        profileDir: spec.profileDir,
        homeDir: spec.homeDir,
        stateDir: desktopTerminalStateDirectory(app.getPath('userData'), spec.profileName),
        spawn,
        onLaunchError: cause => { this.reportTerminalLaunchError(cause) },
      })
    } catch (cause) {
      this.reportTerminalLaunchError(cause)
    }
  }

  /** @inheritdoc */
  reportRendererBoot(report: RendererBootReport): void {
    if (this.rendererBootReported) return
    this.rendererBootReported = true
    this.stopRendererBootMonitoring()
    if (report.status === 'failed') this.bootFailureReason ??= 'renderer-failed'
    try {
      this.onRendererBoot(report)
    } catch (cause) {
      process.stderr.write(`@e-mate/desktop: failed to persist renderer boot health: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    }
    if (report.status === 'healthy') {
      this.rendererHealthy = true
      this.show()
    }
    if (report.status === 'failed' && process.env.EMATE_RELEASE_HEALTH_PROBE !== '1') {
      void this.showRendererBootRecovery(report).catch((cause: unknown) => {
        process.stderr.write(`@e-mate/desktop: failed to show plugin recovery: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
    }
  }

  /** @inheritdoc */
  setThemeSource(source: DesktopThemeSource): void {
    if (this.scheduled !== undefined && this.window !== undefined) {
      nativeTheme.themeSource = source
      this.syncWindowsTitleBarOverlay()
    }
  }

  private syncWindowsTitleBarOverlay(): void {
    if (this.platform === 'win32' && this.scheduled?.mode === 'advanced' && this.window !== undefined) {
      this.window.setTitleBarOverlay(windowsTitleBarOverlay(nativeTheme.shouldUseDarkColors))
    }
  }

  /** @inheritdoc */
  async requestRestart(): Promise<void> {
    await this.restart()
  }

  /** @inheritdoc */
  prepareToQuit(): void {
    this.quitting = true
    this.svgRenderShutdown.abort(new Error('Desktop is shutting down'))
    this.stopRendererBootMonitoring()
  }

  private failRendererBoot(reason: RendererBootFailureReason, error: string): void {
    if (!this.rendererBootMonitoring || this.rendererBootReported) return
    this.bootFailureReason = reason
    this.reportRendererBoot({ status: 'failed', plugins: [], error })
  }

  private showUpdateMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue | undefined> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? Promise.resolve(undefined)
      : dialog.showMessageBox(window, options)
  }

  private async showRendererBootRecovery(report: Extract<RendererBootReport, { status: 'failed' }>): Promise<void> {
    const plugins = report.plugins.length === 0
      ? 'Unknown client plugin'
      : report.plugins.map(plugin => `- ${plugin}`).join('\n')
    const error = report.error === undefined ? 'The client Loader did not provide an error message.' : report.error
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'Plugin Recovery',
      message: 'e-Mate could not load all plugins.',
      detail: `Failed plugins:\n${plugins}\n\n${error}\n\nOpen DSH Terminal to update or remove the failing third-party plugin, then restart e-Mate.`,
      buttons: ['Open DSH Terminal', 'Restart e-Mate', 'Dismiss'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (result.response === 0) this.openTerminal()
    else if (result.response === 1) await this.requestRestart()
  }

  private contributedTrayItems(group: DesktopTrayItemGroup): Electron.MenuItemConstructorOptions[] {
    return [...this.trayItems.values()]
      .filter(item => item.group === group)
      .sort((left, right) => left.order - right.order)
      .map((item): Electron.MenuItemConstructorOptions => {
        const common = {
          label: item.label(),
          enabled: item.enabled?.() ?? true,
        }
        if (item.submenu !== undefined) {
          return {
            ...common,
            submenu: item.submenu().map(command => ({
              label: command.label(),
              enabled: command.enabled?.() ?? true,
              ...(command.type === undefined ? {} : { type: command.type }),
              ...(command.checked === undefined ? {} : { checked: command.checked() }),
              click: this.trayCommand(() => command.invoke()),
            })),
          }
        }
        return {
          ...common,
          click: this.trayCommand(() => item.invoke()),
        }
      })
  }

  /** Contain asynchronous contribution failures outside Electron menu callbacks. */
  private trayCommand(invoke: () => void | Promise<void>): () => void {
    return () => {
      void Promise.resolve().then(invoke).catch((cause: unknown) => {
        process.stderr.write(`@e-mate/desktop: tray command failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
    }
  }

  private showNotification(notification: DesktopNotification): void {
    if (!Notification.isSupported()) return
    const nativeNotification = new Notification({
      title: notification.title,
      body: notification.body,
    })
    nativeNotification.show()
  }

  /** Ask before making the fixed download endpoint's counted request. */
  private async confirmUpdateDownload(version: string): Promise<boolean> {
    const result = await this.showUpdateMessageBox({
      type: 'info',
      title: '发现 e-Mate 更新',
      message: `e-Mate ${version} 已可更新。`,
      detail: this.platform === 'darwin'
        ? '将下载安装包并打开磁盘映像，由你手动退出旧版后覆盖安装。'
        : '将自动下载并校验安装包，安装完成后重新打开 e-Mate。',
      buttons: [this.platform === 'darwin' ? '下载更新' : '更新并重启', '稍后'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result?.response === 0
  }

  /** Report one user-triggered check without exposing network or response details. */
  private async showManualUpdateCheckResult(result: UpdateCheckResult | null): Promise<void> {
    if (result === null) {
      await this.showUpdateMessageBox({
        type: 'warning',
        title: '无法检查更新',
        message: '暂时无法连接更新服务。',
        detail: '请稍后再试。',
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (result.status === 'up-to-date') {
      await this.showUpdateMessageBox({
        type: 'info',
        title: 'e-Mate 已是最新版本',
        message: '当前没有更新版本。',
        detail: `已安装版本：${result.currentVersion}`,
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    await this.showUpdateMessageBox({
      type: 'info',
      title: '发现 e-Mate 更新',
      message: `e-Mate ${result.latestVersion} 已可更新。`,
      detail: '当前构建不支持下载安装包。',
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true,
    })
  }

  /** Download a confirmed installer and hand it to the native installation flow. */
  private async downloadAndOpenUpdate(
    version: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') {
      throw new Error(`@e-mate/desktop: updates are unavailable on ${this.platform}`)
    }
    const destinationPath = await this.chooseUpdateDestination(version)
    if (destinationPath === undefined) return
    signal.throwIfAborted()
    const artifactPath = await downloadDesktopUpdate({
      platform: this.platform,
      version,
      destinationPath,
      request: (url, init) => net.fetch(url, init),
      signal,
    })
    signal.throwIfAborted()
    const artifact: DesktopUpdateArtifact = { platform: this.platform, version, path: artifactPath }
    try {
      await recordDesktopUpdateArtifact(app.getPath('userData'), artifact)
    } catch (cause) {
      process.stderr.write(`@e-mate/desktop: failed to remember update installer: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    }

    if (this.platform === 'darwin') {
      const openError = await shell.openPath(artifactPath)
      if (openError !== '') throw new Error(`@e-mate/desktop: failed to open update disk image: ${openError}`)
      signal.throwIfAborted()
      await this.showUpdateMessageBox({
        type: 'info',
        title: 'e-Mate 更新已下载',
        message: `e-Mate ${version} 已准备好安装。`,
        detail: '当前 e-Mate 未使用 Apple Developer ID 签名。请在打开的磁盘映像中退出旧版后覆盖 e-Mate；若 macOS 拦截，请按官网的未签名安装说明操作。',
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    const result = await this.showUpdateMessageBox({
      type: 'info',
      title: 'e-Mate 更新已下载',
      message: `e-Mate ${version} 已准备好安装。`,
      detail: '现在退出 e-Mate 并启动安装程序吗？Windows 可能显示未知发布者提示。',
      buttons: ['退出并安装', '稍后'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (result?.response !== 0) return
    const spec = this.scheduled
    if (spec === undefined) throw new Error('@e-mate/desktop: no active shell can exit for update installation')
    signal.throwIfAborted()
    await this.launchWindowsUpdateInstaller(artifactPath)
    this.quitting = true
    spec.requestQuit(0)
  }

  private async chooseUpdateDestination(version: string): Promise<string | undefined> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return undefined
    const filename = desktopUpdateFilename(this.platform, version)
    const extension = this.platform === 'darwin' ? 'dmg' : 'exe'
    const result = await dialog.showSaveDialog({
      title: '保存 e-Mate 安装包',
      defaultPath: join(app.getPath('downloads'), filename),
      buttonLabel: '保存并下载',
      filters: [{ name: this.platform === 'darwin' ? '磁盘映像' : 'Windows 安装程序', extensions: [extension] }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    })
    return result.canceled ? undefined : result.filePath
  }

  private async performUpdateArtifactCleanup(): Promise<void> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return
    const userDataPath = app.getPath('userData')
    const artifact = await pendingDesktopUpdateArtifact(userDataPath, PRODUCT_VERSION, this.platform)
    if (artifact === undefined) return
    const result = await this.showUpdateMessageBox({
      type: 'question',
      title: '清理 e-Mate 安装包',
      message: `e-Mate ${artifact.version} 已安装。`,
      detail: `是否删除安装包？\n${artifact.path}`,
      buttons: ['删除', '保留'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (result === undefined) return
    await resolveDesktopUpdateArtifact(userDataPath, artifact, result.response === 0)
  }

  /** Start the downloaded NSIS installer before releasing the current process. */
  private async launchWindowsUpdateInstaller(installerPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(installerPath, ['--updated', '--force-run'], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: false,
        })
      } catch (cause) {
        reject(cause)
        return
      }
      const fail = (cause: Error): void => { reject(cause) }
      child.once('error', fail)
      child.once('spawn', () => {
        child.off('error', fail)
        child.once('error', cause => {
          process.stderr.write(`@e-mate/desktop: update installer failed after launch: ${cause.message}\n`)
        })
        child.unref()
        resolve()
      })
    })
  }

  /** Keep native-terminal launch failures visible in a packaged GUI process. */
  private reportTerminalLaunchError(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    process.stderr.write(`@e-mate/desktop: failed to open terminal: ${error.message}\n`)
    try {
      dialog.showErrorBox('Unable to Open DSH Terminal', error.message)
    } catch (dialogCause) {
      process.stderr.write(`@e-mate/desktop: failed to show terminal error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}\n`)
    }
  }

  private rebuildTrayMenu(): void {
    const tray = this.tray
    const spec = this.scheduled
    if (tray === undefined || spec === undefined) return

    const show = (): void => { this.show() }
    const tools = this.contributedTrayItems('tools')
    const profiles = this.contributedTrayItems('profiles')
    const status = this.contributedTrayItems('status')
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `Open ${spec.productName}`, click: show },
    ]
    if (tools.length > 0) template.push({ type: 'separator' }, ...tools)
    if (profiles.length > 0) template.push({ type: 'separator' }, ...profiles)
    if (status.length > 0) template.push({ type: 'separator' }, ...status)
    template.push(
      { type: 'separator' },
      { label: 'Quit', click: () => { spec.requestQuit(0) } },
    )
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  private async authorizedSessionRoot(spec: DesktopShellSpec, sessionId: string): Promise<string> {
    const sessionRoot = spec.resourceSessionRoot(sessionId)
    if (sessionRoot === undefined) throw new Error('resource session is not active')
    const root = await realpath(sessionRoot)
    const allowedRoots = await Promise.all(spec.resourceRoots().map(async candidate => realpath(candidate).catch(() => undefined)))
    if (!allowedRoots.includes(root)) throw new Error('resource session workspace is not authorized')
    return root
  }

  private async authorizedResourcePath(
    resource: Extract<Resource, { kind: 'file' }>,
    sessionRoot: string,
  ): Promise<string> {
    if (!isAbsolute(resource.path) || !isAbsolute(resource.root) || resource.path.includes('\0') || resource.root.includes('\0')) {
      throw new Error('invalid resource path')
    }
    const root = await realpath(resource.root)
    if (root !== sessionRoot) throw new Error('resource workspace does not match its session')
    const path = await realpath(resource.path)
    if (!inside(root, path) || !(await lstat(path)).isFile()) throw new Error('resource is not a regular workspace file')
    return path
  }

  private async readImageBytes(
    window: BrowserWindow,
    resource: Extract<Resource, { kind: 'image' }>,
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    const dataUrl = await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch(${JSON.stringify(resource.src)});
      const blob = await response.blob();
      if (blob.size > ${String(MAX_CONTEXT_IMAGE_BYTES)}) throw new Error('image-too-large');
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    })()`) as unknown
    if (typeof dataUrl !== 'string') throw new Error('invalid image response')
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u)
    if (match === null) throw new Error('unsupported image response')
    const encoded = match[2]!
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTEXT_IMAGE_BYTES || bytes.toString('base64') !== encoded) {
      throw new Error('invalid image bytes')
    }
    const mediaType = imageMediaType(bytes)
    if (mediaType === undefined || mediaType !== match[1]) throw new Error('image type does not match its bytes')
    return { bytes, mediaType }
  }

  private async materializeImage(window: BrowserWindow, resource: Extract<Resource, { kind: 'image' }>): Promise<string> {
    const { bytes, mediaType } = await this.readImageBytes(window, resource)
    const extension = mediaType === 'image/jpeg' ? '.jpg' : `.${mediaType.slice('image/'.length)}`
    const requested = safeResourceName(resource.name, `e-mate-image${extension}`)
    const name = /\.(?:png|jpe?g|webp|gif)$/iu.test(requested) ? requested : `${requested}${extension}`
    const directory = join(app.getPath('temp'), 'e-mate-resources')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${randomUUID()}-${name}`)
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    return path
  }

  private async copyFileToClipboard(path: string): Promise<void> {
    if (this.platform === 'darwin') {
      await this.spawnNative('/usr/bin/osascript', ['-l', 'JavaScript', '-e', [
        'ObjC.import("AppKit")',
        'const app = Application.currentApplication(); app.includeStandardAdditions = true',
        'const path = app.systemAttribute("E_MATE_COPY_PATH")',
        'const board = $.NSPasteboard.generalPasteboard',
        'board.clearContents',
        'board.writeObjects([$.NSURL.fileURLWithPath($(path))])',
      ].join(';')], { E_MATE_COPY_PATH: path })
      return
    }
    if (this.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      await this.spawnNative(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($env:E_MATE_COPY_PATH); [System.Windows.Forms.Clipboard]::SetFileDropList($files)',
      ], { SystemRoot: systemRoot, E_MATE_COPY_PATH: path })
      return
    }
    throw new Error('file clipboard is unavailable on this platform')
  }

  private async openWith(path: string): Promise<void> {
    if (this.platform === 'darwin') {
      const choice = await dialog.showOpenDialog({
        title: '选择打开方式', defaultPath: '/Applications', properties: ['openFile'],
        filters: [{ name: '应用程序', extensions: ['app'] }],
      })
      const application = choice.canceled ? undefined : choice.filePaths[0]
      if (application !== undefined) await this.spawnNative('/usr/bin/open', ['-a', application, '--', path])
      return
    }
    if (this.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      await this.spawnNative(join(systemRoot, 'System32', 'rundll32.exe'), ['shell32.dll,OpenAs_RunDLL', path], { SystemRoot: systemRoot })
      return
    }
    throw new Error('open with is unavailable on this platform')
  }

  private spawnNative(command: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...extraEnv },
      })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }

  private async resourcePath(window: BrowserWindow, spec: DesktopShellSpec, resource: Resource): Promise<string> {
    return resource.kind === 'file'
      ? this.authorizedResourcePath(resource, await this.authorizedSessionRoot(spec, resource.sessionId))
      : this.materializeImage(window, resource)
  }

  private async runResourceAction(
    action: DesktopResourceAction,
    window: BrowserWindow,
    spec: DesktopShellSpec,
    resource: Resource,
  ): Promise<void> {
    if (action === 'copy-image') {
      if (resource.kind !== 'image') throw new Error('copy-image requires an image resource')
      const image = nativeImage.createFromBuffer((await this.readImageBytes(window, resource)).bytes)
      if (image.isEmpty()) throw new Error('invalid image bitmap')
      clipboard.writeImage(image)
      return
    }
    const path = await this.resourcePath(window, spec, resource)
    if (action === 'save-as') {
      const selected = await dialog.showSaveDialog({
        title: '另存为',
        defaultPath: join(
          app.getPath('downloads'),
          safeResourceName(resource.kind === 'image' ? resource.name : basename(resource.path), basename(path)),
        ),
      })
      if (!selected.canceled && selected.filePath !== undefined) await copyFile(path, selected.filePath)
    } else if (action === 'copy-path') clipboard.writeText(path)
    else if (action === 'copy-file') await this.copyFileToClipboard(path)
    else if (action === 'open-with') await this.openWith(path)
    else shell.showItemInFolder(path)
  }

  private async mount(
    spec: DesktopShellSpec,
    beforeInteractive: (() => void) | undefined,
  ): Promise<() => Promise<void>> {
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`@e-mate/desktop: failed to load application icon ${spec.iconPath}`)
    }
    if (this.platform === 'darwin') app.dock?.setIcon(icon)
    const origin = new URL(spec.url).origin
    nativeTheme.themeSource = spec.readThemeSource()
    const bootstrap: DesktopRendererBootstrap = {
      schemaVersion: 1,
      mode: spec.mode,
      platform: this.platform,
      profileGeneration: this.profileGeneration,
      runtimeId: this.runtimeId,
      windowKind: 'main',
    }
    const window = new BrowserWindow(desktopWindowOptions(
      spec,
      icon,
      this.platform,
      desktopPreloadPath(),
      bootstrap,
      nativeTheme.shouldUseDarkColors,
    ))
    window.accessibleTitle = spec.windowTitle
    if (this.platform === 'win32') window.removeMenu()
    this.window = window

    const runInteractiveUpdate = async (event: Electron.IpcMainInvokeEvent): Promise<void> => {
      if (event.sender !== window.webContents) {
        throw new Error('@e-mate/desktop: update request did not originate from owning Renderer')
      }
      if (this.interactiveUpdate === undefined) throw new Error('@e-mate/desktop: updater is not ready')
      await this.interactiveUpdate()
    }
    ipcMain.handle(DESKTOP_UPDATE_RUN_INTERACTIVE, runInteractiveUpdate)

    const runDesktopResource = async (event: Electron.IpcMainInvokeEvent, value: unknown): Promise<void> => {
      if (event.sender !== window.webContents) {
        throw new Error('@e-mate/desktop: resource request did not originate from owning Renderer')
      }
      const request = parseDesktopResourceRequest(value)
      if (request === undefined) throw new Error('@e-mate/desktop: invalid resource request')
      await this.runResourceAction(request.action, window, spec, request.resource)
    }
    ipcMain.handle(DESKTOP_RESOURCE_RUN, runDesktopResource)

    const show = (): void => { this.show() }
    const close = (event: Electron.Event): void => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const showContextMenu = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
      void (async () => {
        const resource = resourceContext(await window.webContents.executeJavaScript(RESOURCE_CONTEXT_SCRIPT))
        if (resource?.kind === 'handled') return
        const template: Electron.MenuItemConstructorOptions[] = []
        if (resource?.kind === 'image') {
          template.push({ label: '复制', click: () => { window.webContents.copyImageAt(params.x, params.y) } }, { type: 'separator' })
        } else if (params.isEditable) template.push({ role: 'cut', enabled: params.editFlags.canCut })
        if (resource === undefined) {
          template.push({ role: 'copy', enabled: params.editFlags.canCopy || params.selectionText.length > 0 })
          if (params.isEditable) template.push({ role: 'paste', enabled: params.editFlags.canPaste })
          template.push({ type: 'separator' }, { role: 'selectAll' })
        } else {
          const run = (action: Parameters<ElectronDesktopRuntime['runResourceAction']>[0]) => () => {
            void this.runResourceAction(action, window, spec, resource).catch(cause => {
              process.stderr.write(`@e-mate/desktop: resource action ${action} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
            })
          }
          template.push(
            { label: '另存为…', click: run('save-as') },
            { label: '复制路径', click: run('copy-path') },
            { label: '复制文件内容', click: run('copy-file') },
            { label: '打开方式', submenu: [{ label: '选择应用…', click: run('open-with') }] },
            { type: 'separator' },
            { label: this.platform === 'win32' ? '在资源管理器中显示' : '在 Finder 中显示', click: run('reveal') },
          )
        }
        Menu.buildFromTemplate(template).popup({ window })
      })().catch(cause => {
        process.stderr.write(`@e-mate/desktop: failed to build context menu: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
    }
    const handleZoomShortcut = (event: Electron.Event, input: Electron.Input): void => {
      const action = zoomShortcut(input)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'reset') {
        window.webContents.setZoomLevel(0)
        return
      }
      const step = action === 'in' ? 1 : -1
      window.webContents.setZoomLevel(clampedZoomLevel(window.webContents.getZoomLevel() + step))
    }
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
      if (!event.isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const redirect = (
      event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      const detail = boundedDiagnostic(
        `renderer process gone (reason: ${details.reason}, exitCode: ${formatExitCode(details.exitCode)})`,
      )
      process.stderr.write(`@e-mate/desktop: ${detail}\n`)
      this.failRendererBoot('renderer-failed', detail)
    }
    const loadFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      const description = boundedDiagnostic(errorDescription)
      process.stderr.write(`@e-mate/desktop: renderer failed to load (${String(errorCode)}: ${description})\n`)
      if (isMainFrame && errorCode !== -3) {
        this.failRendererBoot(
          'renderer-failed',
          `renderer main frame failed to load (${String(errorCode)}: ${description})`,
        )
      }
    }
    const syncWindowsTitleBarOverlay = (): void => { this.syncWindowsTitleBarOverlay() }

    app.on('activate', show)
    if (this.platform === 'win32' && spec.mode === 'advanced') nativeTheme.on('updated', syncWindowsTitleBarOverlay)
    window.on('close', close)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('context-menu', showContextMenu)
    window.webContents.on('before-input-event', handleZoomShortcut)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', redirect)
    window.webContents.on('render-process-gone', rendererGone)
    window.webContents.on('did-fail-load', loadFailed)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            process.stderr.write(`@e-mate/desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}\n`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })

    window.once('ready-to-show', show)
    let tray: Tray | undefined
    try {
      await window.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, this.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.rebuildTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
      void this.performUpdateArtifactCleanup().catch((cause: unknown) => {
        process.stderr.write(`@e-mate/desktop: failed to offer update installer cleanup: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
    } catch (cause) {
      ipcMain.removeHandler(DESKTOP_UPDATE_RUN_INTERACTIVE)
      ipcMain.removeHandler(DESKTOP_RESOURCE_RUN)
      this.stopRendererBootMonitoring()
      app.off('activate', show)
      nativeTheme.off('updated', syncWindowsTitleBarOverlay)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.off('ready-to-show', show)
      window.webContents.off('context-menu', showContextMenu)
      window.webContents.off('before-input-event', handleZoomShortcut)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', redirect)
      window.webContents.off('render-process-gone', rendererGone)
      window.webContents.off('did-fail-load', loadFailed)
      tray?.off('click', show)
      tray?.destroy()
      window.destroy()
      this.tray = undefined
      this.window = undefined
      throw cause
    }

    if (tray === undefined) {
      throw new Error('@e-mate/desktop: native tray did not mount')
    }
    const mountedTray = tray

    let released = false
    return async () => {
      if (released) return
      released = true
      ipcMain.removeHandler(DESKTOP_UPDATE_RUN_INTERACTIVE)
      ipcMain.removeHandler(DESKTOP_RESOURCE_RUN)
      app.off('activate', show)
      nativeTheme.off('updated', syncWindowsTitleBarOverlay)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.off('ready-to-show', show)
      window.webContents.off('context-menu', showContextMenu)
      window.webContents.off('before-input-event', handleZoomShortcut)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', redirect)
      window.webContents.off('render-process-gone', rendererGone)
      window.webContents.off('did-fail-load', loadFailed)
      mountedTray.off('click', show)
      mountedTray.destroy()
      if (!window.isDestroyed()) window.destroy()
      if (this.tray === mountedTray) this.tray = undefined
      if (this.window === window) this.window = undefined
    }
  }
}
