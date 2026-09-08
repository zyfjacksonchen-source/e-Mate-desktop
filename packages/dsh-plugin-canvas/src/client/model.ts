import { emptyPage, validateProject, type CanvasAsset, type CanvasPage, type CanvasProject, type Json } from '../contract.ts'

export function insertAsset(project: CanvasProject, pageId: string, asset: CanvasAsset, besideAttachmentId?: string): CanvasProject {
  const next = validateProject(project)
  const page = next.pages.find(item => item.id === pageId)
  if (!page) throw new Error('目标页面已不存在。')
  const fileId = asset.ref.attachmentId.slice(7)
  if (!next.assets.some(item => item.ref.attachmentId === asset.ref.attachmentId)) next.assets.push(asset)
  if (page.elements.some(item => item.type === 'image' && item.fileId === fileId && !item.isDeleted)) return next
  const deleted = page.elements.find(item => item.type === 'image' && item.fileId === fileId && item.isDeleted)
  if (deleted) {
    // Excalidraw retains deleted elements for undo; restore that identity instead of colliding with it.
    deleted.isDeleted = false
    deleted.version = Number(deleted.version ?? 0) + 1
    deleted.versionNonce = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff
    deleted.updated = Date.now()
    return validateProject(next)
  }
  const width = Math.min(800, asset.ref.width)
  const visible = page.elements.filter(item => !item.isDeleted)
  const anchor = page.elements.find(item => item.type === 'image' && !item.isDeleted && `sha256:${item.fileId}` === besideAttachmentId)
  // Edited outputs occupy new space; the original and its annotations retain their coordinates.
  const x = visible.length ? Math.max(...visible.map(item => Number(item.x) + Math.max(Number(item.width) || 0, Number(item.height) || 0))) + 48 : 0
  const y = anchor ? Number(anchor.y) : 0
  page.elements.push({ id: `image-${fileId.slice(0, 40)}`, type: 'image', fileId, x, y,
    width, height: width * asset.ref.height / asset.ref.width, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(),
    link: null, locked: false, status: 'saved', scale: [1, 1], crop: null, index: null })
  return validateProject(next)
}
export function reorderPage(project: CanvasProject, id: string, delta: number): CanvasProject {
  const next = validateProject(project)
  const from = next.pages.findIndex(page => page.id === id)
  const to = from + delta
  if (from >= 0 && to >= 0 && to < next.pages.length) next.pages.splice(to, 0, next.pages.splice(from, 1)[0]!)
  return next
}
export function duplicatePage(project: CanvasProject, id: string, nextId: string): CanvasProject {
  const next = validateProject(project)
  const from = next.pages.findIndex(page => page.id === id)
  if (from < 0) throw new Error('页面不存在。')
  next.pages.splice(from + 1, 0, { ...structuredClone(next.pages[from]!), id: nextId, title: `${next.pages[from]!.title} 副本`.slice(0, 120) })
  return validateProject(next)
}
/** Excalidraw 0.18.1 mutateElement/newElementWith/bumpVersion advance these
 * fields even for in-place edits. Compare each ordered element, not a version sum
 * (which misses reordering), and keep legacy unversioned imports readable. */
export function sameSceneElements(left: readonly Record<string, any>[], right: readonly Record<string, any>[]): boolean {
  return left.length === right.length && left.every((element, index) => {
    const other = right[index]!
    if (element.id !== other.id) return false
    if (Number.isInteger(element.version) && element.version > 0 && Number.isInteger(element.versionNonce)
      && Number.isInteger(other.version) && other.version > 0 && Number.isInteger(other.versionNonce)) {
      return element.version === other.version && element.versionNonce === other.versionNonce && element.isDeleted === other.isDeleted
    }
    return JSON.stringify(element) === JSON.stringify(other)
  })
}
export function scenePage(page: CanvasPage, elements: readonly Record<string, any>[], appState: any): CanvasPage {
  const unchanged = sameSceneElements(page.elements, elements)
  const view = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, background: appState.viewBackgroundColor }
  if (unchanged && page.view.scrollX === view.scrollX && page.view.scrollY === view.scrollY
    && page.view.zoom === view.zoom && page.view.background === view.background) return page
  // Persist an independent snapshot only for actual scene edits. View changes
  // retain the last saved element snapshot; native selection/hover is transient.
  return { ...page, elements: unchanged ? page.elements : JSON.parse(JSON.stringify(elements)) as Record<string, Json>[], view }
}
export function htmlDocument(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`
  const inner = `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
  const encoded = inner.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)
  // A second opaque frame retains interactive HTML while the outer CSP blocks the project's own
  // location/refresh navigation. srcdoc initializes without a network frame request in Chromium.
  return `<!doctype html><html><head>${head}<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;background:white}</style></head><body><iframe title="隔离页面内容" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${encoded}"></iframe></body></html>`
}
export function externalLinks(html: string): string[] {
  const links = [...html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/giu)].map(match => {
    try { const url = new URL(match[2]!); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
  }).filter((url): url is string => url !== undefined)
  return [...new Set(links)].slice(0, 30)
}
export function pagesFromHtml(html: string, idPrefix: string): CanvasPage[] {
  // Parse inside a template: scripts and subresources stay inert, never attached to the host document.
  const template = document.createElement('template')
  template.innerHTML = html
  const sections = [...template.content.querySelectorAll('section[data-slide]')]
  const style = [...template.content.querySelectorAll('style')].map(item => item.outerHTML).join('')
  if (sections.length === 0) return [{ ...emptyPage(idPrefix, 'HTML'), html }]
  if (sections.length > 64) throw new Error('幻灯片超过 64 页。')
  return sections.map((section, index) => ({ ...emptyPage(`${idPrefix}-${index + 1}`, section.getAttribute('data-title')?.slice(0, 120) || `幻灯片 ${index + 1}`), html: style + section.outerHTML }))
}
export function bytesOf(value: unknown): Uint8Array {
  if (typeof value === 'string') {
    if (value.length < 1 || value.length > Math.ceil(100 * 1024 * 1024 / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error('附件编码无效。')
    const binary = atob(value)
    if (btoa(binary) !== value) throw new Error('附件编码无效。')
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  }
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return new Uint8Array(value)
  throw new Error('附件字节无效。')
}
export function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  return btoa(binary)
}
export async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Select only an unambiguous image at the arrow head, then fall back to its tail.
 * Excalidraw stores linear points relative to the element and rotates around its bounds.
 */
export function arrowImageTarget(elements: CanvasPage['elements'], arrow: CanvasPage['elements'][number]) {
  if (arrow.type !== 'arrow' || arrow.isDeleted || !Array.isArray(arrow.points) || arrow.points.length < 2) return undefined
  const points = arrow.points.filter((point): point is Json[] => Array.isArray(point))
  if (points.length !== arrow.points.length || points.some(point => !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))) return undefined
  if (!points.some(point => Math.hypot(Number(point[0]) - Number(points[0]![0]), Number(point[1]) - Number(points[0]![1])) >= 2)) return undefined
  const images = elements.filter(item => item.type === 'image' && !item.isDeleted)
  const endpoint = (point: Json[], binding: Json | undefined) => {
    const id = binding && typeof binding === 'object' && !Array.isArray(binding) ? binding.elementId : undefined
    const bound = images.filter(image => image.id === id)
    if (bound.length) return bound
    const [x, y] = arrowPoint(arrow, point)
    return images.filter(image => imageContains(image, x, y))
  }
  const head = endpoint(points.at(-1)!, arrow.endBinding)
  if (head.length) return head.length === 1 ? head[0] : undefined
  const tail = endpoint(points[0]!, arrow.startBinding)
  return tail.length === 1 ? tail[0] : undefined
}
function arrowPoint(arrow: Record<string, Json>, point: Json[]) {
  const points = arrow.points as Json[][]
  const xs = points.map(value => Number(value[0])), ys = points.map(value => Number(value[1]))
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const angle = Number(arrow.angle ?? 0), dx = Number(point[0]) - cx, dy = Number(point[1]) - cy
  return [Number(arrow.x) + cx + dx * Math.cos(angle) - dy * Math.sin(angle), Number(arrow.y) + cy + dx * Math.sin(angle) + dy * Math.cos(angle)] as const
}
function imageContains(image: Record<string, Json>, x: number, y: number) {
  const cx = Number(image.x) + Number(image.width) / 2, cy = Number(image.y) + Number(image.height) / 2
  const angle = -Number(image.angle ?? 0), dx = x - cx, dy = y - cy
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle), localY = dx * Math.sin(angle) + dy * Math.cos(angle)
  return Number.isFinite(localX) && Number.isFinite(localY) && Math.abs(localX) <= Number(image.width) / 2 && Math.abs(localY) <= Number(image.height) / 2
}

/** Render-only modification reference: selected images and their on-image marks.
 * Never mutate the project or include a different image just because it shares a page.
 */
export function selectedAnnotationElements(elements: CanvasPage['elements'], selectedImageIds: readonly string[]): CanvasPage['elements'] {
  const wanted = new Set(selectedImageIds)
  const images = elements.filter(item => item.type === 'image' && !item.isDeleted && wanted.has(String(item.id)))
  const selected = new Set(images.map(item => item.id))
  const bindingId = (value: Json | undefined) => value && typeof value === 'object' && !Array.isArray(value) ? value.elementId : undefined
  const arrows = elements.filter(item => {
    if (item.type !== 'arrow' || item.isDeleted) return false
    if (selected.has(bindingId(item.startBinding) as Json) || selected.has(bindingId(item.endBinding) as Json)) return true
    if (!Array.isArray(item.points) || !item.points.length) return false
    return [item.points[0], item.points.at(-1)].some(point => Array.isArray(point) && images.some(image => imageContains(image, ...arrowPoint(item, point))))
  })
  const included = new Set([...images, ...arrows].map(item => item.id))
  const annotationArrowId = (item: CanvasPage['elements'][number]) => item.customData && typeof item.customData === 'object' && !Array.isArray(item.customData) ? item.customData.emateAnnotationArrowId : undefined
  const texts = elements.filter(item => item.type === 'text' && !item.isDeleted && (included.has(annotationArrowId(item) as Json) || (item.containerId
    ? included.has(item.containerId)
    : images.some(image => imageContains(image, Number(item.x) + Number(item.width) / 2, Number(item.y) + Number(item.height) / 2)))))
  for (const text of texts) included.add(text.id)
  return elements.filter(item => included.has(item.id)).map(item => {
    const copy = structuredClone(item)
    if (copy.frameId && !included.has(copy.frameId)) copy.frameId = null
    for (const field of ['startBinding', 'endBinding']) if (copy[field] && !included.has(bindingId(copy[field]) as Json)) copy[field] = null
    if (Array.isArray(copy.boundElements)) copy.boundElements = copy.boundElements.filter(value => value && typeof value === 'object' && !Array.isArray(value) && included.has(value.id))
    return copy
  })
}
