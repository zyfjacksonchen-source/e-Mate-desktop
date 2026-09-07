import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'

export interface SvgPageRenderRequest {
  svg: string
  width: number
  height: number
  signal?: AbortSignal
}

export interface SvgPageRenderResult {
  png: Buffer
  width: number
  height: number
}

const MAX_SVG_BYTES = 32 * 1024 * 1024
const MAX_PNG_BYTES = 64 * 1024 * 1024
const TIMEOUT_MS = 30_000
const PAGE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; script-src \'none\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>SVG renderer</title>',
)
let isolatedSession: Session | undefined

function rendererSession(): Session {
  if (!isolatedSession) {
    // One dedicated in-memory partition, shared only by these disposable windows.
    // Per-call UUID partitions remain alive in Electron and would accumulate.
    const value = session.fromPartition('emate-svg-page-renderer', { cache: false })
    value.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    value.setPermissionCheckHandler(() => false)
    value.setDevicePermissionHandler(() => false)
    value.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: details.url !== PAGE_URL && !/^data:(?:image\/(?:png|jpeg|webp|gif|avif|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype));/iu.test(details.url) })
    })
    isolatedSession = value
  }
  return isolatedSession
}

/** Runs only inside the sandboxed Chromium renderer; no closure or Node access. */
async function rasterize(svg: string, width: number, height: number): Promise<string> {
  const fail = (): never => { throw new Error('Unsupported or unsafe SVG content') }
  const withoutDeclaration = svg.replace(/^\uFEFF?<\?xml\s+version=(["'])1\.[01]\1(?:\s+encoding=(["'])UTF-8\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*\?>/iu, '')
  if (/<!|<\?/u.test(withoutDeclaration.replace(/<!--[\s\S]*?-->/gu, ''))) fail()
  const documentSvg = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = documentSvg.documentElement
  const svgNamespace = 'http://www.w3.org/2000/svg'
  if (root.localName !== 'svg' || root.namespaceURI !== svgNamespace || documentSvg.querySelector('parsererror')) fail()
  // Static SVG only. Animation, links, script, foreignObject and foreign namespaces
  // are deliberately unsupported; input is never inserted into the HTML document.
  const allowedElements = new Set(('svg g defs symbol use title desc metadata style path rect circle ellipse line polyline polygon text tspan textPath clipPath mask pattern marker linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence image').split(' '))
  const fragment = /^#[A-Za-z_][\w.:-]*$/u
  const rasterData = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/iu
  const fontData = /^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype));base64,[A-Za-z0-9+/]+={0,2}$/iu
  function data(value: string, kind: 'image' | 'font'): boolean {
    if (!(kind === 'image' ? rasterData : fontData).test(value)) return false
    const comma = value.indexOf(',')
    let head: string
    try { head = atob(value.slice(comma + 1, comma + 129)) } catch { return false }
    const mime = value.slice(5, value.indexOf(';')).toLowerCase()
    // Check the declared format's signature before handing bytes to the decoder.
    // In particular, XML labelled image/png must never become a nested SVG image.
    switch (mime) {
      case 'image/png': return head.startsWith('\x89PNG\r\n\x1a\n')
      case 'image/jpeg': return head.startsWith('\xff\xd8\xff')
      case 'image/gif': return /^GIF8[79]a/u.test(head)
      case 'image/webp': return head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'
      case 'image/avif': return head.slice(4, 8) === 'ftyp' && /avif|avis/u.test(head.slice(8))
      case 'font/woff': case 'application/font-woff': return head.startsWith('wOFF')
      case 'font/woff2': return head.startsWith('wOF2')
      case 'font/ttf': case 'application/x-font-ttf': return head.startsWith('\x00\x01\x00\x00') || head.startsWith('true')
      case 'font/otf': case 'application/x-font-opentype': return head.startsWith('OTTO')
      default: return false
    }
  }
  function css(value: string): void {
    // Reject CSS escapes/comments rather than guessing how obfuscated tokens parse.
    if (/\\|\/\*|@(?!(?:font-face)\b)|\b(?:local|image-set|image|src|paint|element)\s*\(|\banimation(?:-[a-z]+)?\s*:/iu.test(value)) fail()
    const rest = value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s'"()]+))\s*\)/giu, (_match, a: string | undefined, b: string | undefined, c: string | undefined) => {
      const url = a ?? b ?? c ?? ''
      if (!fragment.test(url) && !data(url, 'image') && !data(url, 'font')) fail()
      return ''
    })
    if (/\burl\s*\(/iu.test(rest)) fail()
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== svgNamespace || !allowedElements.has(element.localName)) fail()
    if (element.localName === 'style') css(element.textContent ?? '')
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName
      if (/^on/iu.test(name) || name === 'base' || name === 'src') fail()
      if (attribute.namespaceURI && !['http://www.w3.org/2000/xmlns/', 'http://www.w3.org/XML/1998/namespace', 'http://www.w3.org/1999/xlink'].includes(attribute.namespaceURI)) fail()
      if (name === 'href') {
        const value = attribute.value
        if (!fragment.test(value) && !(['image', 'feImage'].includes(element.localName) && data(value, 'image'))) fail()
      }
      css(attribute.value)
    }
  }
  // Explicit dimensions also make SVGs with percentage/no intrinsic size decodable.
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root))
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('SVG canvas is unavailable')
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

/** Chromium SVG-to-PNG adapter for DesktopRuntime; does not touch user windows. */
export async function renderSvgPage({ svg, width, height, signal }: SvgPageRenderRequest): Promise<SvgPageRenderResult> {
  if (typeof svg !== 'string' || !svg.trim() || Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
    throw new Error('SVG must be nonempty UTF-8 text no larger than 32 MiB')
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_000_000) {
    throw new Error('SVG dimensions must be positive integers <= 8192 and <= 16 megapixels')
  }
  const abortError = () => Object.assign(new Error('SVG render aborted'), { name: 'AbortError' })
  if (signal?.aborted) throw abortError()
  let window: BrowserWindow | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const prevent = (event: { preventDefault(): void }) => event.preventDefault()
  let onGone: (() => void) | undefined
  try {
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError())
      onGone = () => reject(new Error('SVG renderer closed unexpectedly'))
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => reject(new Error('SVG render timed out after 30 seconds')), TIMEOUT_MS)
    })
    window = new BrowserWindow({
      width: 1, height: 1, show: false, focusable: false, skipTaskbar: true,
      webPreferences: {
        session: rendererSession(), nodeIntegration: false, nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
        devTools: false, backgroundThrottling: false,
      },
    })
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', prevent)
    contents.on('will-frame-navigate', prevent)
    contents.on('will-redirect', prevent)
    contents.on('will-attach-webview', prevent)
    contents.on('render-process-gone', onGone!)
    window.on('closed', onGone!)
    const render = async (): Promise<SvgPageRenderResult> => {
      await window!.loadURL(PAGE_URL)
      if (window!.isDestroyed()) throw new Error('SVG renderer is no longer available')
      if (signal?.aborted) throw abortError()
      const response: unknown = await contents.executeJavaScript(`(${rasterize.toString()})(${JSON.stringify(svg)},${width},${height})`, false)
      if (typeof response !== 'string' || response.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 22) throw new Error('Invalid or oversized SVG render result')
      const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(response)
      if (!match) throw new Error('SVG renderer did not return PNG data')
      const png = Buffer.from(match[1]!, 'base64')
      if (png.length > MAX_PNG_BYTES || png.length < 33 || png.toString('base64') !== match[1]
        || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
        throw new Error('SVG renderer returned invalid PNG dimensions or bytes')
      }
      return { png, width, height }
    }
    return await Promise.race([render(), stopped])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (window) {
      const contents = window.webContents
      contents.removeListener('will-navigate', prevent)
      contents.removeListener('will-frame-navigate', prevent)
      contents.removeListener('will-redirect', prevent)
      contents.removeListener('will-attach-webview', prevent)
      if (onGone) {
        contents.removeListener('render-process-gone', onGone)
        window.removeListener('closed', onGone)
      }
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
