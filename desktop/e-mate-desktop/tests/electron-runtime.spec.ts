import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'

const terminal = vi.hoisted(() => ({ open: vi.fn() }))
const svgRenderer = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../src/svg-page-renderer.ts', () => ({ renderSvgPage: svgRenderer.render }))
const childProcess = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Listener[]>()
  const child = {
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener))
      return child
    }),
    unref: vi.fn(),
  }
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      const current = [...(listeners.get(event) ?? [])]
      listeners.delete(event)
      for (const listener of current) listener(...args)
    },
    reset() { listeners.clear() },
    spawn: vi.fn(() => child),
  }
})

vi.mock('../src/desktop-terminal.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/desktop-terminal.ts')>(),
  openDesktopTerminal: terminal.open,
}))


vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: childProcess.spawn,
}))

const electron = vi.hoisted(() => {
  const browserWindowOptions: unknown[] = []
  const browserWindowThemeSources: string[] = []
  const browserWindows: BrowserWindow[] = []
  const browserWindowOn = vi.fn()
  const browserWindowOff = vi.fn()
  const loadURL = vi.fn(async (_url: string) => {})
  const menuTemplates: unknown[][] = []
  const menuPopups: Array<ReturnType<typeof vi.fn>> = []
  const notifications: Notification[] = []
  const dialog = {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    showSaveDialog: vi.fn(async (): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true })),
  }
  const appIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const templateIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const blueIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const webContents = {
    on: vi.fn(),
    off: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn(async (): Promise<unknown> => null),
    copyImageAt: vi.fn(),
    getZoomLevel: vi.fn(() => 0),
    setZoomLevel: vi.fn(),
    send: vi.fn(),
  }
  const ipcMain = { on: vi.fn(), off: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() }
  const nativeTheme = {
    themeSource: 'system',
    shouldUseDarkColors: false,
    on: vi.fn(),
    off: vi.fn(),
  }
  const systemPreferences = {
    isTrustedAccessibilityClient: vi.fn(() => false),
  }

  class BrowserWindow {
    readonly webContents = webContents
    accessibleTitle = ''

    constructor(options: unknown) {
      browserWindowOptions.push(options)
      browserWindowThemeSources.push(nativeTheme.themeSource)
      browserWindows.push(this)
    }

    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly isVisible = vi.fn(() => this.show.mock.calls.length > 0)
    readonly focus = vi.fn()
    readonly on = browserWindowOn
    readonly off = browserWindowOff
    readonly once = vi.fn()
    readonly destroy = vi.fn()
    readonly loadURL = loadURL
    readonly removeMenu = vi.fn()
    readonly setTitleBarOverlay = vi.fn()
  }

  class Tray {
    readonly image: unknown
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly on = vi.fn()
    readonly off = vi.fn()
    readonly destroy = vi.fn()

    constructor(image: unknown) {
      this.image = image
      trays.push(this)
    }
  }

  class Notification {
    static readonly isSupported = vi.fn(() => true)
    readonly once = vi.fn()
    readonly show = vi.fn()

    constructor(readonly options: unknown) {
      notifications.push(this)
    }
  }

  const trays: Tray[] = []
  const createFromPath = vi.fn((path: string) => {
    if (path.endsWith('app-icon.png')) return appIcon
    if (path.endsWith('tray-iconTemplate.png')) return templateIcon
    if (path.endsWith('tray-icon-blue.png')) return blueIcon
    throw new Error(`unexpected image path ${path}`)
  })

  return {
    app: {
      dock: { setIcon: vi.fn() },
      getPath: vi.fn((name: string): string => name === 'home' ? '/tmp/dsh-home' : '/tmp/dsh-desktop-user-data'),
      getVersion: vi.fn(() => '43.4.0'),
      isPackaged: false,
      on: vi.fn(),
      off: vi.fn(),
    },
    appIcon,
    blueIcon,
    BrowserWindow,
    browserWindowOptions,
    browserWindowThemeSources,
    browserWindows,
    browserWindowOff,
    browserWindowOn,
    loadURL,
    dialog,
    ipcMain,
    clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        menuTemplates.push(template)
        const popup = vi.fn()
        menuPopups.push(popup)
        return { popup }
      }),
    },
    webContents,
    menuTemplates,
    menuPopups,
    nativeImage: {
      createFromBuffer: vi.fn(() => ({ isEmpty: () => false })),
      createFromPath,
    },
    nativeTheme,
    net: { fetch: vi.fn() },
    Notification,
    notifications,
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
      showItemInFolder: vi.fn(),
    },
    systemPreferences,
    templateIcon,
    Tray,
    trays,
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  clipboard: electron.clipboard,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  nativeTheme: electron.nativeTheme,
  net: electron.net,
  Notification: electron.Notification,
  shell: electron.shell,
  systemPreferences: electron.systemPreferences,
  Tray: electron.Tray,
}))

const spec: DesktopShellSpec = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  productName: 'e-Mate',
  windowTitle: 'e-Mate',
  iconPath: '/tmp/app-icon.png',
  trayIcons: {
    templatePath: '/tmp/tray-iconTemplate.png',
    bluePath: '/tmp/tray-icon-blue.png',
  },
  readThemeSource: vi.fn(() => 'system' as const),
  resourceRoots: () => ['/tmp'],
  resourceSessionRoot: sessionId => sessionId === 'session-1' ? '/tmp' : undefined,
  requestQuit: () => {},
  requestModeChange: vi.fn(async () => {}),
}

describe('Electron compatibility runtime', () => {
  beforeEach(() => {
    electron.app.isPackaged = false
    electron.browserWindowOptions.length = 0
    electron.browserWindowThemeSources.length = 0
    electron.browserWindows.length = 0
    electron.trays.length = 0
    electron.menuTemplates.length = 0
    electron.menuPopups.length = 0
    electron.notifications.length = 0
    childProcess.reset()
    vi.clearAllMocks()
    svgRenderer.render.mockReset()
    electron.loadURL.mockReset()
    electron.loadURL.mockResolvedValue(undefined)
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    electron.dialog.showOpenDialog.mockReset()
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    electron.shell.openPath.mockResolvedValue('')
    electron.systemPreferences.isTrustedAccessibilityClient.mockReturnValue(false)
    electron.nativeTheme.themeSource = 'system'
    electron.nativeTheme.shouldUseDarkColors = false
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('forwards native SVG rendering and propagates caller cancellation', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const controller = new AbortController()
    const result = { png: Buffer.from('renderer result'), width: 320, height: 180 }
    svgRenderer.render.mockResolvedValue(result)
    expect(await runtime.renderSvgPage({ svg: '<svg/>', width: 320, height: 180, signal: controller.signal })).toBe(result)
    const request = svgRenderer.render.mock.calls[0]![0]
    expect(request).toMatchObject({ svg: '<svg/>', width: 320, height: 180 })
    expect(request.signal.aborted).toBe(false)
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('cancels native SVG work on quit and rejects new renders', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    svgRenderer.render.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const pending = runtime.renderSvgPage({ svg: '<svg/>', width: 320, height: 180 })
    const rejected = expect(pending).rejects.toThrow('Desktop is shutting down')
    runtime.prepareToQuit()
    await rejected
    await expect(runtime.renderSvgPage({ svg: '<svg/>', width: 320, height: 180 })).rejects.toThrow('Desktop is shutting down')
    expect(svgRenderer.render).toHaveBeenCalledTimes(1)
  })

  it('uses the native macOS frame, Dock icon, and template tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    expect(electron.browserWindowOptions).toHaveLength(0)
    await runtime.mountScheduled()

    expect(electron.browserWindowOptions).toHaveLength(1)
    const options = electron.browserWindowOptions[0]
    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      show: false,
      webPreferences: {
        preload: expect.stringMatching(/preload\.cjs$/),
        additionalArguments: [expect.stringMatching(/^--e-mate-desktop-bootstrap=/u)],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    }))
    expect(options).not.toHaveProperty('autoHideMenuBar')
    for (const option of [
      'frame',
      'titleBarStyle',
      'titleBarOverlay',
      'trafficLightPosition',
      'transparent',
      'vibrancy',
      'visualEffectState',
      'backgroundMaterial',
      'roundedCorners',
      'thickFrame',
    ]) {
      expect(options).not.toHaveProperty(option)
    }
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('e-Mate')
    expect(spec.readThemeSource).toHaveBeenCalledOnce()
    expect(electron.nativeTheme.themeSource).toBe('system')
    expect(electron.browserWindows[0]?.removeMenu).not.toHaveBeenCalled()
    expect(electron.app.dock.setIcon).toHaveBeenCalledWith(electron.appIcon)
    expect(electron.templateIcon.setTemplateImage).toHaveBeenCalledWith(true)
    expect(electron.trays[0]?.image).toBe(electron.templateIcon)
    expect(electron.menuTemplates[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Quit' }),
    ]))
    expect(electron.menuTemplates[0]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('Mode') }),
    ]))

    const contextMenuListener = electron.webContents.on.mock.calls.find(([event]) => event === 'context-menu')?.[1]
    expect(contextMenuListener).toEqual(expect.any(Function))
    contextMenuListener({}, {
      isEditable: false,
      selectionText: '可复制内容',
      editFlags: { canCut: false, canCopy: true, canPaste: false },
    })
    await vi.waitFor(() => { expect(electron.menuTemplates.at(-1)).toHaveLength(3) })
    expect(electron.menuTemplates.at(-1)).toEqual([
      expect.objectContaining({ role: 'copy', enabled: true }),
      expect.objectContaining({ type: 'separator' }),
      expect.objectContaining({ role: 'selectAll' }),
    ])
    expect(electron.menuPopups.at(-1)).toHaveBeenCalledWith({ window: electron.browserWindows[0] })

    electron.webContents.executeJavaScript.mockResolvedValueOnce({
      kind: 'file', name: '报告.docx', path: '/tmp/e-mate-workspace/报告.docx',
      root: '/tmp/e-mate-workspace', sessionId: 'session-1',
    })
    contextMenuListener({}, {
      x: 40,
      y: 80,
      isEditable: false,
      selectionText: '',
      editFlags: { canCut: false, canCopy: false, canPaste: false },
    })
    await vi.waitFor(() => {
      expect(electron.menuTemplates.at(-1)?.map(item => (item as { label?: string }).label).filter(Boolean))
        .toEqual(['另存为…', '复制路径', '复制文件内容', '打开方式', '在 Finder 中显示'])
    })
    const menuCount = electron.menuTemplates.length
    electron.webContents.executeJavaScript.mockResolvedValueOnce({ kind: 'handled' })
    contextMenuListener({}, {
      x: 40,
      y: 80,
      isEditable: false,
      selectionText: '',
      editFlags: { canCut: false, canCopy: false, canPaste: false },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(electron.menuTemplates).toHaveLength(menuCount)

    const titleListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'page-title-updated')?.[1]
    expect(titleListener).toEqual(expect.any(Function))
    const titleEvent = { preventDefault: vi.fn() }
    titleListener(titleEvent)
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce()

    await release()
    expect(electron.browserWindowOff).toHaveBeenCalledWith('page-title-updated', titleListener)
    expect(electron.webContents.off).toHaveBeenCalledWith('context-menu', contextMenuListener)
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('fences every file action to the live session workspace and rejects path escape', async () => {
    const hostPlatform = process.platform
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const root = mkdtempSync(join(tmpdir(), 'e-mate-resource-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'e-mate-resource-outside-'))
    const source = join(root, '报告.txt')
    const copied = join(root, '报告-copy.txt')
    const outsideFile = join(outside, 'outside.txt')
    const escape = join(root, 'escape')
    const escapedFile = join(escape, 'outside.txt')
    writeFileSync(source, 'artifact bytes')
    writeFileSync(outsideFile, 'outside bytes')
    symlinkSync(outside, escape, hostPlatform === 'win32' ? 'junction' : 'dir')
    try {
      const canonicalSource = await realpath(source)
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      const release = runtime.schedule({
        ...spec,
        resourceRoots: () => [root],
        resourceSessionRoot: sessionId => sessionId === 'session-files' ? root : undefined,
      })
      await runtime.mountScheduled()
      const runResource = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === 'emate:desktop-resource-run')?.[1]
      const resource = { kind: 'file', sessionId: 'session-files', root, path: source }

      await runResource({ sender: electron.webContents }, { action: 'copy-path', resource })
      expect(electron.clipboard.writeText).toHaveBeenCalledWith(canonicalSource)
      await runResource({ sender: electron.webContents }, { action: 'reveal', resource })
      expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(canonicalSource)

      electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: copied })
      await runResource({ sender: electron.webContents }, { action: 'save-as', resource })
      expect(readFileSync(copied, 'utf8')).toBe('artifact bytes')

      electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Applications/Preview.app'] })
      const opening = runResource({ sender: electron.webContents }, { action: 'open-with', resource })
      await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenCalledWith(
        '/usr/bin/open', ['-a', '/Applications/Preview.app', '--', canonicalSource], expect.any(Object),
      ) })
      childProcess.emit('spawn')
      await opening

      const copying = runResource({ sender: electron.webContents }, { action: 'copy-file', resource })
      await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenLastCalledWith(
        '/usr/bin/osascript', expect.any(Array), expect.objectContaining({
          env: expect.objectContaining({ E_MATE_COPY_PATH: canonicalSource }),
        }),
      ) })
      childProcess.emit('spawn')
      await copying

      await expect(runResource({ sender: electron.webContents }, {
        action: 'reveal', resource: { ...resource, sessionId: 'missing' },
      })).rejects.toThrow('resource session is not active')
      await expect(runResource({ sender: electron.webContents }, {
        action: 'reveal', resource: { ...resource, root: outside, path: outsideFile },
      })).rejects.toThrow('resource workspace does not match its session')
      await expect(runResource({ sender: electron.webContents }, {
        action: 'reveal', resource: { ...resource, path: escapedFile },
      })).rejects.toThrow('resource is not a regular workspace file')
      await expect(runResource({ sender: electron.webContents }, {
        action: 'reveal', resource: { ...resource, path: join(root, 'missing.txt') },
      })).rejects.toThrow()
      await expect(runResource({ sender: electron.webContents }, {
        action: 'reveal', resource: { ...resource, path: root },
      })).rejects.toThrow('resource is not a regular workspace file')

      await release()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps historical child image actions renderer-scoped and materializes only for download or reveal', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const root = mkdtempSync(join(tmpdir(), 'e-mate-image-resource-'))
    const originalGetPath = electron.app.getPath.getMockImplementation()
    electron.app.getPath.mockImplementation(() => root)
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      const release = runtime.schedule({
        ...spec,
        resourceRoots: () => [root],
        resourceSessionRoot: () => undefined,
      })
      await runtime.mountScheduled()
      const runResource = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === 'emate:desktop-resource-run')?.[1]
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const response = `data:image/png;base64,${bytes.toString('base64')}`
      const resource = {
        kind: 'image', sessionId: 'disposed-child', name: 'result.png', src: 'blob:result',
      }

      electron.webContents.executeJavaScript.mockResolvedValueOnce(response)
      await runResource({ sender: electron.webContents }, { action: 'copy-image', resource })
      expect(electron.clipboard.writeImage).toHaveBeenCalledOnce()
      expect(existsSync(join(root, 'e-mate-resources'))).toBe(false)

      electron.webContents.executeJavaScript.mockResolvedValueOnce(response)
      await runResource({ sender: electron.webContents }, { action: 'reveal', resource })
      const revealed = electron.shell.showItemInFolder.mock.calls.at(-1)?.[0]
      expect(readFileSync(revealed)).toEqual(bytes)

      const copy = join(root, 'downloaded.png')
      electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: copy })
      electron.webContents.executeJavaScript.mockResolvedValueOnce(response)
      await runResource({ sender: electron.webContents }, { action: 'save-as', resource })
      expect(readFileSync(copy)).toEqual(bytes)

      await release()
    } finally {
      electron.app.getPath.mockImplementation(originalGetPath!)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the compatibility frame synchronized with the e-Mate theme', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({ ...spec, readThemeSource: () => 'dark' })

    await runtime.mountScheduled()
    expect(electron.browserWindowThemeSources).toEqual(['dark'])
    expect(electron.nativeTheme.themeSource).toBe('dark')

    runtime.setThemeSource('light')
    expect(electron.nativeTheme.themeSource).toBe('light')
    await release()
    expect(electron.nativeTheme.themeSource).toBe('light')
  })

  it('uses the Windows caption, hidden menu bar, removed menu, and fixed brand tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      title: 'e-Mate',
      autoHideMenuBar: true,
    }))
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('e-Mate')
    expect(electron.browserWindows[0]?.removeMenu).toHaveBeenCalledOnce()
    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.trays[0]?.image).toBe(electron.blueIcon)
    expect(electron.templateIcon.setTemplateImage).not.toHaveBeenCalled()

    await release()
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('launches the assisted Windows update installer visibly', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const launchInstaller = Reflect.get(runtime, 'launchWindowsUpdateInstaller') as (path: string) => Promise<void>

    const launched = launchInstaller.call(runtime, 'C:\\Downloads\\e-Mate-2.0.17-win-x64-Setup.exe')
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'C:\\Downloads\\e-Mate-2.0.17-win-x64-Setup.exe',
      ['--updated', '--force-run'],
      { detached: true, stdio: 'ignore', shell: false, windowsHide: false },
    )
    childProcess.emit('spawn')
    await launched

    expect(childProcess.child.unref).toHaveBeenCalledOnce()
  })

  it('parents update cleanup to the live window and preserves artifacts without one', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const userData = mkdtempSync(join(tmpdir(), 'e-mate-update-window-'))
    const installer = join(userData, 'e-Mate-2.0.17-mac.dmg')
    const originalGetPath = electron.app.getPath.getMockImplementation()
    electron.app.getPath.mockImplementation((name: string) => name === 'userData' ? userData : originalGetPath!(name))
    writeFileSync(installer, 'installer')
    try {
      const { recordDesktopUpdateArtifact, pendingDesktopUpdateArtifact } = await import('../src/update-download.ts')
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const artifact = { platform: 'darwin' as const, version: '2.0.17', path: installer }
      await recordDesktopUpdateArtifact(userData, artifact)
      electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const runtime = new ElectronDesktopRuntime(async () => {})
      const showUpdateMessageBox = Reflect.get(runtime, 'showUpdateMessageBox') as (options: unknown) => Promise<unknown>

      await expect(showUpdateMessageBox.call(runtime, { message: 'unowned update dialog' })).resolves.toBeUndefined()
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()

      const release = runtime.schedule(spec)
      await runtime.mountScheduled()
      const window = electron.browserWindows[0]!
      await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce() })
      expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({
        type: 'question',
        title: '清理 e-Mate 安装包',
        message: 'e-Mate 2.0.17 已安装。',
        buttons: ['删除', '保留'],
      }))
      await vi.waitFor(async () => { expect(await pendingDesktopUpdateArtifact(userData, '2.0.17', 'darwin')).toBeUndefined() })
      expect(existsSync(installer)).toBe(true)
      await release()

      await recordDesktopUpdateArtifact(userData, artifact)
      electron.dialog.showMessageBox.mockClear()
      let finishLoad!: () => void
      electron.loadURL.mockImplementationOnce(() => new Promise<void>(resolve => { finishLoad = resolve }))
      const destroyedRuntime = new ElectronDesktopRuntime(async () => {})
      const destroyedRelease = destroyedRuntime.schedule(spec)
      const mounted = destroyedRuntime.mountScheduled()
      await vi.waitFor(() => { expect(electron.browserWindows).toHaveLength(2) })
      electron.browserWindows[1]!.isDestroyed.mockReturnValue(true)
      finishLoad()
      await mounted
      await new Promise(resolve => setImmediate(resolve))

      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(existsSync(installer)).toBe(true)
      await expect(pendingDesktopUpdateArtifact(userData, '2.0.17', 'darwin')).resolves.toEqual(artifact)
      await destroyedRelease()
    } finally {
      electron.app.getPath.mockImplementation(originalGetPath!)
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('opens one parented Windows folder chooser and returns its selected path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\Work'] })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    await expect(runtime.pickDirectory()).resolves.toBe('C:\\Work')
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      electron.browserWindows[0],
      {
        title: '选择工作区目录',
        properties: ['openDirectory', 'dontAddToRecent'],
      },
    )

    await release()
  })

  it('single-flights one Windows chooser and opens a new generation after cancellation or failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let resolveDialog!: (result: { canceled: boolean; filePaths: string[] }) => void
    electron.dialog.showOpenDialog.mockReturnValue(
      new Promise(resolve => { resolveDialog = resolve }),
    )
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const first = runtime.pickDirectory()
    const repeated = runtime.pickDirectory()
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledOnce()
    resolveDialog({ canceled: true, filePaths: [] })
    await expect(Promise.all([first, repeated])).resolves.toEqual([null, null])

    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\Next'] })
    await expect(runtime.pickDirectory()).resolves.toBe('C:\\Next')
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(2)

    electron.dialog.showOpenDialog.mockRejectedValueOnce(new Error('dialog unavailable'))
    await expect(runtime.pickDirectory()).rejects.toThrow('dialog unavailable')
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\Recovered'] })
    await expect(runtime.pickDirectory()).resolves.toBe('C:\\Recovered')
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(4)

    await release()
  })

  it('does not mount a registration disposed before Host boot settles', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await release()

    await expect(runtime.mountScheduled()).rejects.toThrow(
      'the Cordis shell plugin did not register a window',
    )
    expect(electron.browserWindowOptions).toHaveLength(0)
  })

  it('keeps tray commands unavailable until the Web surface loads and startup commits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    let finishLoad!: () => void
    electron.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve }))
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    const beforeInteractive = vi.fn(() => {
      expect(electron.trays).toHaveLength(1)
    })

    const mounted = runtime.mountScheduled(beforeInteractive)
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledOnce() })
    expect(electron.trays).toHaveLength(0)
    expect(beforeInteractive).not.toHaveBeenCalled()

    finishLoad()
    await mounted
    expect(beforeInteractive).toHaveBeenCalledOnce()
    expect(electron.trays).toHaveLength(1)

    await release()
  })

  it('does not expose a shell mode tray command', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const requestModeChange = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({ ...spec, requestModeChange })

    await runtime.mountScheduled()
    const labels = (electron.menuTemplates[0] as Array<{ label?: string }>).map(item => item.label)
    expect(labels).not.toContain('Switch to Advanced Mode')
    expect(labels).not.toContain('Switch to Compatibility Mode')
    expect(requestModeChange).not.toHaveBeenCalled()

    await release()
  })

  it('rebuilds ordered effect-scoped tray contributions without replacing native commands', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const later = runtime.registerTrayItem({
      group: 'tools',
      order: 20,
      label: () => 'Later Tool',
      invoke: vi.fn(),
    })
    let statusLabel = 'Check for Updates…'
    const status = runtime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => statusLabel,
      enabled: () => false,
      invoke: vi.fn(),
    })
    const earlier = runtime.registerTrayItem({
      group: 'tools',
      order: 10,
      label: () => 'Earlier Tool',
      invoke: vi.fn(),
    })
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const labels = (electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label)
    expect(labels).toEqual([
      'Open e-Mate', undefined,
      'Earlier Tool', 'Later Tool', undefined,
      'Check for Updates…', undefined,
      'Quit',
    ])
    expect(electron.menuTemplates.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Check for Updates…', enabled: false }),
    ]))

    statusLabel = 'Version 2.1.0 Available'
    status.refresh()
    expect(electron.menuTemplates.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Version 2.1.0 Available', enabled: false }),
    ]))

    earlier.dispose()
    later.dispose()
    status.dispose()
    expect(electron.menuTemplates.at(-1)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Earlier Tool' }),
    ]))

    await release()
  })

  it('renders contributed radio submenus in their own profile section', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const invoke = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.registerTrayItem({
      group: 'profiles',
      order: 10,
      label: () => 'Profile: desktop',
      invoke: () => {},
      submenu: () => [{
        label: () => 'web',
        type: 'radio',
        checked: () => false,
        enabled: () => true,
        invoke,
      }],
    })
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const profile = (electron.menuTemplates.at(-1) as Array<{
      label?: string
      submenu?: Array<{ label?: string, type?: string, checked?: boolean, click?: () => void }>
    }>).find(item => item.label === 'Profile: desktop')
    expect(profile?.submenu).toEqual([
      expect.objectContaining({ label: 'web', type: 'radio', checked: false }),
    ])
    profile?.submenu?.[0]?.click?.()
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })

    await release()
  })

  it('opens the active profile through the packaged terminal adapter', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.4.0',
    })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: '/tmp/dsh-home/profiles/desktop',
        homeDir: '/tmp/dsh-home',
      })

      runtime.openTerminal()

      expect(terminal.open).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'darwin',
        appExecutable: process.execPath,
        electronVersion: '43.4.0',
        profileName: 'desktop',
        productVersion: '2.0.18',
        profileDir: '/tmp/dsh-home/profiles/desktop',
        homeDir: '/tmp/dsh-home',
        spawn: expect.any(Function),
        onLaunchError: expect.any(Function),
      }))
      const terminalOptions = terminal.open.mock.calls[0]?.[0]
      expect(terminalOptions.dshBootstrapPath.endsWith(join('src', 'desktop-cli.js'))).toBe(true)
      expect(terminalOptions.pnpmBinPath.endsWith(join('node_modules', 'pnpm', 'bin', 'pnpm.mjs'))).toBe(true)
      expect(dirname(terminalOptions.stateDir)).toBe(join('/tmp/dsh-desktop-user-data', 'cli'))
      expect(basename(terminalOptions.stateDir)).toMatch(/^[a-f0-9]{64}$/u)
      expect(() => runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: '/other',
        homeDir: '/other',
      })).toThrow('already configured')
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('shows native errors for synchronous and asynchronous terminal launch failures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.4.0',
    })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
        homeDir: 'C:\\Users\\Example\\.dsh',
      })
      terminal.open.mockImplementationOnce(() => { throw new Error('cannot create launcher') })

      expect(() => { runtime.openTerminal() }).not.toThrow()
      expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
        'Unable to Open DSH Terminal',
        'cannot create launcher',
      )

      terminal.open.mockImplementationOnce((options: { onLaunchError: (cause: Error) => void }) => {
        options.onLaunchError(new Error('launcher exited with code 1'))
      })
      runtime.openTerminal()
      expect(electron.dialog.showErrorBox).toHaveBeenLastCalledWith(
        'Unable to Open DSH Terminal',
        'launcher exited with code 1',
      )
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('failed to open terminal'))
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('shows native recovery when the renderer Loader reports a failed plugin', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    const report = {
      status: 'failed' as const,
      plugins: ['dsh-vision-router'],
      error: 'keyed slot "tool.call.toolview" already has an entry for key "vision_crop" at priority 0',
    }

    runtime.reportRendererBoot(report)
    await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce() })
    runtime.reportRendererBoot({ status: 'healthy' })

    expect(onRendererBoot).toHaveBeenCalledWith(report)
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: 'Plugin Recovery',
      message: 'e-Mate could not load all plugins.',
      detail: expect.stringContaining('dsh-vision-router'),
      buttons: ['Open DSH Terminal', 'Restart e-Mate', 'Dismiss'],
    }))
    const recoveryCalls = electron.dialog.showMessageBox.mock.calls as unknown as Array<[{ detail?: string }]>
    expect(recoveryCalls[0]?.[0].detail).toContain('vision_crop')
    expect(electron.browserWindows[0]?.show).not.toHaveBeenCalled()
    await release()
  })

  it('shows an ordinary healthy renderer exactly once', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    const window = electron.browserWindows[0]
    const ready = window?.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]
    expect(ready).toEqual(expect.any(Function))

    ready()
    runtime.show()
    expect(window?.show).not.toHaveBeenCalled()

    runtime.reportRendererBoot({ status: 'healthy' })

    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(window?.show).toHaveBeenCalledOnce()
    expect(window?.focus).toHaveBeenCalledOnce()
    await release()
  })

  it('does not block a release probe on the interactive recovery dialog', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const previous = process.env.EMATE_RELEASE_HEALTH_PROBE
    process.env.EMATE_RELEASE_HEALTH_PROBE = '1'
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const onRendererBoot = vi.fn()
      const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
      const report = { status: 'failed' as const, plugins: ['broken-client'] }

      runtime.reportRendererBoot(report)

      expect(onRendererBoot).toHaveBeenCalledWith(report)
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.EMATE_RELEASE_HEALTH_PROBE
      else process.env.EMATE_RELEASE_HEALTH_PROBE = previous
    }
  })

  it('fails a renderer generation that never reports boot health', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)

    runtime.beginRendererBootMonitoring(25)
    await vi.advanceTimersByTimeAsync(25)

    expect(runtime.rendererBootFailureReason).toBe('renderer-timeout')
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(onRendererBoot).toHaveBeenCalledWith({
      status: 'failed',
      plugins: [],
      error: 'The Renderer did not report boot health within 25ms.',
    })
  })

  it('cancels the renderer deadline after the first healthy report', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)

    runtime.beginRendererBootMonitoring(25)
    runtime.reportRendererBoot({ status: 'healthy' })
    await vi.advanceTimersByTimeAsync(25)

    expect(runtime.rendererBootFailureReason).toBeUndefined()
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
  })

  it('guards only main-frame cross-origin and malformed navigation with split Electron signatures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const navigate = electron.webContents.on.mock.calls.find(([event]) => event === 'will-frame-navigate')?.[1]
    const redirect = electron.webContents.on.mock.calls.find(([event]) => event === 'will-redirect')?.[1]
    expect(navigate).toEqual(expect.any(Function))
    expect(redirect).toEqual(expect.any(Function))

    for (const event of [
      { url: 'https://example.com/plugin', isMainFrame: false, preventDefault: vi.fn() },
      { url: 'not a URL', isMainFrame: false, preventDefault: vi.fn() },
      { url: `${spec.url}client`, isMainFrame: true, preventDefault: vi.fn() },
    ]) {
      navigate(event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    for (const url of ['https://example.com/', 'not a URL']) {
      const event = { preventDefault: vi.fn() }
      navigate({ url, isMainFrame: true, preventDefault: event.preventDefault })
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }

    const iframeRedirect = { preventDefault: vi.fn() }
    redirect(iframeRedirect, 'https://example.com/plugin', false, false)
    expect(iframeRedirect.preventDefault).not.toHaveBeenCalled()
    const mainRedirect = { preventDefault: vi.fn() }
    redirect(mainRedirect, 'https://example.com/', false, true)
    expect(mainRedirect.preventDefault).toHaveBeenCalledOnce()

    const openHandler = electron.webContents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(openHandler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    await release()
    expect(electron.webContents.off).toHaveBeenCalledWith('will-frame-navigate', navigate)
    expect(electron.webContents.off).toHaveBeenCalledWith('will-redirect', redirect)
  })

  it('owns clamped native zoom shortcuts for exactly one generation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    const zoom = electron.webContents.on.mock.calls.find(([event]) => event === 'before-input-event')?.[1]
    expect(zoom).toEqual(expect.any(Function))

    electron.webContents.getZoomLevel.mockReturnValueOnce(4).mockReturnValueOnce(-4)
    for (const [key, expected] of [['=', 4], ['-', -4], ['0', 0]] as const) {
      const event = { preventDefault: vi.fn() }
      zoom(event, { type: 'keyDown', control: true, key })
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(expected)
    }
    const ignored = { preventDefault: vi.fn() }
    zoom(ignored, { type: 'keyUp', meta: true, key: '+' })
    zoom(ignored, { type: 'keyDown', alt: true, meta: true, key: '+' })
    expect(ignored.preventDefault).not.toHaveBeenCalled()

    await release()
    await release()
    expect(electron.webContents.off).toHaveBeenCalledWith('before-input-event', zoom)
  })

  it('fails pending health once on renderer loss but not after healthy boot', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValue({ response: 2, checkboxChecked: false })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const pendingBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, pendingBoot)
    const release = runtime.schedule(spec)
    runtime.beginRendererBootMonitoring()
    await runtime.mountScheduled()
    const gone = electron.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1]

    gone({}, { reason: 'crashed', exitCode: 9 })
    gone({}, { reason: 'crashed', exitCode: 9 })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('renderer process gone (reason: crashed, exitCode: 9)'))
    expect(pendingBoot).toHaveBeenCalledOnce()
    expect(runtime.rendererBootFailureReason).toBe('renderer-failed')
    await release()
    expect(electron.webContents.off).toHaveBeenCalledWith('render-process-gone', gone)

    vi.clearAllMocks()
    const healthyBoot = vi.fn()
    const healthyRuntime = new ElectronDesktopRuntime(async () => {}, healthyBoot)
    const healthyRelease = healthyRuntime.schedule(spec)
    healthyRuntime.beginRendererBootMonitoring()
    await healthyRuntime.mountScheduled()
    healthyRuntime.reportRendererBoot({ status: 'healthy' })
    const postHealthGone = electron.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1]
    postHealthGone({}, { reason: 'crashed', exitCode: 9 })
    expect(healthyBoot).toHaveBeenCalledOnce()
    expect(healthyBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(healthyRuntime.rendererBootFailureReason).toBeUndefined()
    await healthyRelease()
  })

  it('fails pending health only for non-cancelled main-frame load failure and cleans failed mounts', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.dialog.showMessageBox.mockResolvedValue({ response: 2, checkboxChecked: false })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const release = runtime.schedule(spec)
    runtime.beginRendererBootMonitoring()
    await runtime.mountScheduled()
    const failed = electron.webContents.on.mock.calls.find(([event]) => event === 'did-fail-load')?.[1]

    failed({}, -105, 'NAME_NOT_RESOLVED', `${spec.url}asset`, false)
    failed({}, -3, 'ERR_ABORTED', spec.url, true)
    expect(onRendererBoot).not.toHaveBeenCalled()
    failed({}, -102, 'CONNECTION_REFUSED', spec.url, true)
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(onRendererBoot).toHaveBeenCalledWith({
      status: 'failed', plugins: [], error: 'renderer main frame failed to load (-102: CONNECTION_REFUSED)',
    })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('renderer failed to load (-105: NAME_NOT_RESOLVED)'))
    await release()
    expect(electron.webContents.off).toHaveBeenCalledWith('did-fail-load', failed)

    vi.clearAllMocks()
    electron.loadURL.mockRejectedValueOnce(new Error('renderer unavailable'))
    const failedRuntime = new ElectronDesktopRuntime(async () => {})
    const failedRelease = failedRuntime.schedule(spec)
    await expect(failedRuntime.mountScheduled()).rejects.toThrow('renderer unavailable')
    for (const event of ['before-input-event', 'will-frame-navigate', 'will-redirect', 'render-process-gone', 'did-fail-load']) {
      const listener = electron.webContents.on.mock.calls.find(([name]) => name === event)?.[1]
      expect(electron.webContents.off).toHaveBeenCalledWith(event, listener)
    }
    await expect(failedRelease()).rejects.toThrow('renderer unavailable')
  })

  it('opens the active profile terminal from plugin recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: '43.4.0',
    })
    try {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      runtime.configureTerminal({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
        homeDir: 'C:\\Users\\Example\\.dsh',
      })

      runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
      await vi.waitFor(() => { expect(terminal.open).toHaveBeenCalledOnce() })

      expect(terminal.open).toHaveBeenCalledWith(expect.objectContaining({
        profileName: 'desktop',
        profileDir: 'C:\\Users\\Example\\.dsh\\profiles\\desktop',
      }))
    } finally {
      delete (process.versions as { electron?: string }).electron
    }
  })

  it('requests an orderly restart from plugin recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)

    runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
    await vi.waitFor(() => { expect(restart).toHaveBeenCalledOnce() })
  })

  it('keeps advanced material internals free of a user-visible mode switch', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const readThemeSource = vi.fn(() => 'dark' as const)
    const release = runtime.schedule({ ...spec, mode: 'advanced', readThemeSource })

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('light')
    await runtime.mountScheduled()

    expect(readThemeSource).toHaveBeenCalledOnce()
    expect(electron.browserWindowThemeSources).toEqual(['dark'])
    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      transparent: true,
      vibrancy: 'sidebar',
    }))
    expect(electron.menuTemplates[0]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Switch to Compatibility Mode' }),
    ]))

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('system')
    await release()
    expect(electron.nativeTheme.themeSource).toBe('light')
    runtime.setThemeSource('dark')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })

  it('keeps the native Windows caption symbols legible across light, dark, and system changes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.nativeTheme.shouldUseDarkColors = true
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({ ...spec, mode: 'advanced', readThemeSource: () => 'system' })

    await runtime.mountScheduled()
    expect((electron.browserWindowOptions[0] as any).titleBarOverlay.symbolColor).toBe('#f5f5f5')
    electron.nativeTheme.shouldUseDarkColors = false
    runtime.setThemeSource('light')
    expect(electron.browserWindows[0]?.setTitleBarOverlay).toHaveBeenLastCalledWith(expect.objectContaining({
      symbolColor: '#2f3337',
    }))
    electron.nativeTheme.shouldUseDarkColors = true
    const updated = electron.nativeTheme.on.mock.calls.find(([event]) => event === 'updated')?.[1]
    expect(updated).toEqual(expect.any(Function))
    updated()
    expect(electron.browserWindows[0]?.setTitleBarOverlay).toHaveBeenLastCalledWith(expect.objectContaining({
      symbolColor: '#f5f5f5',
    }))
    await release()
    expect(electron.nativeTheme.off).toHaveBeenCalledWith('updated', updated)
  })

  it('restores the preceding native appearance when advanced loading fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'light'
    electron.loadURL.mockRejectedValueOnce(new Error('renderer unavailable'))
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule({
      ...spec,
      mode: 'advanced',
      readThemeSource: () => 'dark',
    })

    await expect(runtime.mountScheduled()).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('dark')
    await expect(release()).rejects.toThrow('renderer unavailable')
    expect(electron.nativeTheme.themeSource).toBe('light')
  })
})
