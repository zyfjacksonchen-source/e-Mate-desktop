import { emptyPage, validateProject, type CanvasAsset, type CanvasPage, type CanvasProject, type Json } from '../contract.ts'

export function insertAsset(project: CanvasProject, pageId: string, asset: CanvasAsset): CanvasProject {
  const next = validateProject(project)
  const page = next.pages.find(item => item.id === pageId)
  if (!page) throw new Error('目标页面已不存在。')
  const fileId = asset.ref.attachmentId.slice(7)
  if (!next.assets.some(item => item.ref.attachmentId === asset.ref.attachmentId)) next.assets.push(asset)
  if (page.elements.some(item => item.type === 'image' && item.fileId === fileId && !item.isDeleted)) return next
  const width = Math.min(800, asset.ref.width)
  const count = page.elements.filter(item => item.type === 'image' && !item.isDeleted).length
  page.elements.push({ id: `image-${fileId.slice(0, 40)}`, type: 'image', fileId, x: count * 40, y: count * 40,
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
export function scenePage(page: CanvasPage, elements: readonly Record<string, any>[], appState: any): CanvasPage {
  return { ...page, elements: JSON.parse(JSON.stringify(elements)) as Record<string, Json>[],
    view: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, background: appState.viewBackgroundColor } }
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
