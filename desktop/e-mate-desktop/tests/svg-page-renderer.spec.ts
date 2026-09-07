// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { SvgPageRenderRequest, SvgPageRenderResult } from '../src/svg-page-renderer.ts'

interface WindowDouble extends EventEmitter {
  webContents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn>; executeJavaScript: ReturnType<typeof vi.fn> }
  loadURL: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed(): boolean
}
const mock = vi.hoisted(() => ({
  windows: [] as WindowDouble[], options: [] as BrowserWindowConstructorOptions[],
  execute: vi.fn<(script: string) => Promise<unknown>>(),
  load: vi.fn<(url: string) => Promise<void>>(),
  request: vi.fn(), permission: vi.fn(), permissionCheck: vi.fn(), devicePermission: vi.fn(),
  partition: vi.fn(),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const isolated = {
    webRequest: { onBeforeRequest: mock.request },
    setPermissionRequestHandler: mock.permission,
    setPermissionCheckHandler: mock.permissionCheck,
    setDevicePermissionHandler: mock.devicePermission,
  }
  mock.partition.mockReturnValue(isolated)
  return {
    session: { fromPartition: mock.partition },
    BrowserWindow: class extends EventEmitter {
      destroyed = false
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(), executeJavaScript: mock.execute,
      })
      loadURL = mock.load
      isDestroyed() { return this.destroyed }
      destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
      constructor(options: BrowserWindowConstructorOptions) {
        super()
        mock.options.push(options)
        mock.windows.push(this)
      }
    },
  }
})
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="red"/></svg>'
// Real 1x1 PNG fixture. Chromium rasterization remains an integration gate; this
// double tests the decode -> drawImage -> PNG -> Buffer delivery contract.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKXcAAAAASUVORK5CYII='
let renderSvgPage: (request: SvgPageRenderRequest) => Promise<SvgPageRenderResult>
let decoded: ReturnType<typeof vi.fn>
let draw: ReturnType<typeof vi.fn>
let encoded: ReturnType<typeof vi.fn<(...args: unknown[]) => string>>
let imageSources: string[]
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mock.windows.length = 0
  mock.options.length = 0
  mock.load.mockResolvedValue(undefined)
  decoded = vi.fn().mockResolvedValue(undefined)
  draw = vi.fn()
  encoded = vi.fn<(...args: unknown[]) => string>().mockReturnValue('data:image/png;base64,' + PNG)
  imageSources = []
  vi.stubGlobal('Image', class {
    set src(value: string) { imageSources.push(value) }
    decode = decoded
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(encoded)
  mock.execute.mockImplementation(async script => (0, eval)(script) as Promise<unknown>)
  ;({ renderSvgPage } = await import('../src/svg-page-renderer.ts'))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function checkDisposed(): void {
  for (const window of mock.windows) {
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(window.eventNames()).toEqual([])
    expect(window.webContents.eventNames()).toEqual([])
  }
}
it('delivers PNG bytes from image/canvas and preserves fixed pixel dimensions', async () => {
  const result = await renderSvgPage({ svg: SVG, width: 1, height: 1 })
  expect(result).toEqual({ png: Buffer.from(PNG, 'base64'), width: 1, height: 1 })
  expect(decoded).toHaveBeenCalledOnce()
  expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 1, 1)
  expect(encoded).toHaveBeenCalledWith('image/png')
  expect(imageSources[0]).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u)
  expect(decodeURIComponent(imageSources[0]!.split(',')[1]!)).toContain('width="1" height="1"')
  expect(mock.execute).toHaveBeenCalledWith(expect.any(String), false)
  checkDisposed()
})
it('accepts a standard UTF-8 XML declaration on standalone SVG', async () => {
  await renderSvgPage({ svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + SVG, width: 1, height: 1 })
  expect(decoded).toHaveBeenCalledOnce()
  checkDisposed()
})
it('uses a hidden nonfocusable sandbox without preload and reuses one memory session', async () => {
  await renderSvgPage({ svg: SVG, width: 1, height: 1 })
  await renderSvgPage({ svg: SVG, width: 1, height: 1 })
  expect(mock.partition).toHaveBeenCalledExactlyOnceWith('emate-svg-page-renderer', { cache: false })
  expect(mock.options[0]).toEqual(expect.objectContaining({ show: false, focusable: false, skipTaskbar: true }))
  expect(mock.options[0]!.webPreferences).toEqual(expect.objectContaining({
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
  }))
  expect(mock.options[0]!.webPreferences).not.toHaveProperty('preload')
  expect(mock.options[0]!.webPreferences!.session).toBe(mock.options[1]!.webPreferences!.session)
  // Double has no show/focus methods, so any such call fails.
  const html = decodeURIComponent(mock.load.mock.calls[0]![0])
  expect(html).toContain("connect-src 'none'")
  expect(html).toContain("script-src 'none'")
  checkDisposed()
})
it('denies navigation, new windows, webviews, permissions and external requests', async () => {
  mock.load.mockImplementation(() => new Promise(() => {}))
  const abort = new AbortController()
  const result = renderSvgPage({ svg: SVG, width: 1, height: 1, signal: abort.signal })
  const contents = mock.windows[0]!.webContents
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    const preventDefault = vi.fn()
    contents.emit(name, { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  }
  expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
  const permissionCallback = vi.fn()
  mock.permission.mock.calls[0]![0](null, 'media', permissionCallback)
  expect(permissionCallback).toHaveBeenCalledWith(false)
  expect(mock.permissionCheck.mock.calls[0]![0]()).toBe(false)
  expect(mock.devicePermission.mock.calls[0]![0]()).toBe(false)
  for (const url of ['https://evil.test/font.woff2', 'http://127.0.0.1:8080/', 'file:///etc/passwd', 'ftp://evil.test/a', 'blob:https://evil.test/a', 'ws://evil.test', 'javascript:alert(1)']) {
    const callback = vi.fn()
    mock.request.mock.calls[0]![1]({ url }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  }
  abort.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  checkDisposed()
})
describe('input limits', () => {
  it.each([[0, 1], [1, -1], [1.5, 1], [8193, 1], [1, 8193], [8192, 8192], [4001, 4000], [NaN, 1], [1, Infinity]])('rejects %s x %s before creating a window', async (width, height) => {
    await expect(renderSvgPage({ svg: SVG, width, height })).rejects.toThrow('dimensions')
    expect(mock.windows).toHaveLength(0)
  })
  it('rejects blank and oversized UTF-8 inputs before creating a window', async () => {
    await expect(renderSvgPage({ svg: ' ', width: 1, height: 1 })).rejects.toThrow('UTF-8')
    await expect(renderSvgPage({ svg: '中'.repeat(Math.ceil(32 * 1024 * 1024 / 3)), width: 1, height: 1 })).rejects.toThrow('UTF-8')
    expect(mock.windows).toHaveLength(0)
  })
})
describe('static SVG validation before image decoding', () => {
  it.each([
    '<!DOCTYPE svg SYSTEM "https://evil.test/x"><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<?xml-stylesheet href="file:///tmp/x"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'https://evil.test\')"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="https://evil.test"/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#104;ttps://evil.test/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="file:///tmp/a.svg#x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.test/style";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>text{fill:url(https://evil.test/x)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>text{fill:u\\72l(https://evil.test/x)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>text{fill:u/**/rl(https://evil.test/x)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://evil.test/"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" to="https://evil.test/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,PHN2Zy8+"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>text{background-image:image-set("https://evil.test/x" 1x)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:Evil;src:local("system")}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:Evil;src:url(data:font/woff2;base64,PHN2Zy8+)}</style></svg>',

  ])('rejects unsupported markup before decoding: %s', async svg => {
    await expect(renderSvgPage({ svg, width: 1, height: 1 })).rejects.toThrow('Unsupported or unsafe SVG')
    expect(imageSources).toEqual([])
    expect(decoded).not.toHaveBeenCalled()
    checkDisposed()
  })
  it('accepts fragment references, raster data and inline font data', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:Test;src:url(data:font/woff2;base64,d09GMg==)} text{font-family:Test}</style><defs><linearGradient id="grad"><stop offset="0" stop-color="red"/></linearGradient><path id="shape" d="M0 0L1 1"/></defs><use href="#shape" fill="url(#grad)"/><image href="data:image/png;base64,${PNG}"/><text>中文</text></svg>`
    await renderSvgPage({ svg, width: 1, height: 1 })
    expect(decoded).toHaveBeenCalledOnce()
    checkDisposed()
  })
})
it('rejects invalid PNG data and wrong dimensions, always destroying the window', async () => {
  for (const response of [null, 'data:image/png;base64,eA==', 'data:image/jpeg;base64,' + PNG, 'not a PNG']) {
    mock.execute.mockResolvedValueOnce(response)
    await expect(renderSvgPage({ svg: SVG, width: 1, height: 1 })).rejects.toThrow()
  }
  await expect(renderSvgPage({ svg: SVG, width: 2, height: 1 })).rejects.toThrow('dimensions or bytes')
  checkDisposed()
})
it('rejects output over 64 MiB before base64 decoding', async () => {
  mock.execute.mockResolvedValue('data:image/png;base64,' + 'A'.repeat(Math.ceil(64 * 1024 * 1024 / 3) * 4 + 4))
  await expect(renderSvgPage({ svg: SVG, width: 1, height: 1 })).rejects.toThrow('oversized')
  checkDisposed()
})
it('handles cancellation before window creation', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(renderSvgPage({ svg: SVG, width: 1, height: 1, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(mock.windows).toHaveLength(0)
})
it('cancels pending decoding and removes its signal listener', async () => {
  decoded.mockImplementation(() => new Promise(() => {}))
  const abort = new AbortController()
  const removed = vi.spyOn(abort.signal, 'removeEventListener')
  const result = renderSvgPage({ svg: SVG, width: 1, height: 1, signal: abort.signal })
  await vi.waitFor(() => expect(decoded).toHaveBeenCalledOnce())
  abort.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  checkDisposed()
})
it.each(['load', 'decode'])('destroys the renderer when %s exceeds 30 seconds', async stage => {
  vi.useFakeTimers()
  if (stage === 'load') mock.load.mockImplementation(() => new Promise(() => {}))
  else decoded.mockImplementation(() => new Promise(() => {}))
  const result = renderSvgPage({ svg: SVG, width: 1, height: 1 })
  const rejected = expect(result).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  checkDisposed()
})
it('cleans up on load failure, decode failure, and renderer crash', async () => {
  mock.load.mockRejectedValueOnce(new Error('load failed'))
  await expect(renderSvgPage({ svg: SVG, width: 1, height: 1 })).rejects.toThrow('load failed')
  decoded.mockRejectedValueOnce(new Error('decode failed'))
  await expect(renderSvgPage({ svg: SVG, width: 1, height: 1 })).rejects.toThrow('decode failed')
  mock.load.mockImplementation(() => new Promise(() => {}))
  const result = renderSvgPage({ svg: SVG, width: 1, height: 1 })
  mock.windows.at(-1)!.webContents.emit('render-process-gone')
  await expect(result).rejects.toThrow('closed unexpectedly')
  checkDisposed()
})
