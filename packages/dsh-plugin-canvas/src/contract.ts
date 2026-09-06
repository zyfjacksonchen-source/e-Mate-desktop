export const CHANNEL = '/emate.canvas'
export const ASSET_PATH = '/emate-canvas-assets/'
export const EDITOR_MODULE = '@e-mate/dsh-plugin-canvas/editor'
export const MAX_PROJECT_BYTES = 4 * 1024 * 1024
export const MAX_HTML_BYTES = 512 * 1024
export const MAX_PROJECT_IMAGES = 100
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u
// Excalidraw's pinned nanoid alphabet permits '-' and '_' in the first position.
const ELEMENT_ID = /^[a-zA-Z0-9_-]{1,64}$/u
export const HASH = /^[0-9a-f]{64}$/u
export const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface ImageRef { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }
export interface CanvasAsset { ownerSessionId: string; ref: ImageRef }
export interface CanvasPage {
  id: string; title: string; elements: Record<string, Json>[]
  view: { scrollX: number; scrollY: number; zoom: number; background: string }
  html: string | null; slide: boolean
}
// These are bindings to native requests, never a second Job/status ledger.
export interface CanvasIntent { id: string; pageId: string; kind: 'image' | 'edit' | 'html' | 'slides'; sessionId: string; sourceIds: string[]; imported: string[] }
export interface CanvasProject {
  schemaVersion: 1; id: string; title: string; pages: CanvasPage[]; assets: CanvasAsset[]; intents: CanvasIntent[]
}
export interface ProjectReceipt { project: CanvasProject; revision: string; recovered: boolean }
export class CanvasError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
export function reject(message: string, code = 'invalid'): never { throw new CanvasError(code, message) }
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject('画布数据字段无效。')
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) reject('画布标识无效。')
  return value as string
}
export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) reject('会话标识无效。')
  return value as string
}
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) reject('画布文本无效。')
  return value as string
}
export function imageRef(value: unknown): ImageRef {
  if (!record(value)) reject('图片附件无效。')
  exact(value, ['attachmentId', 'mediaType', 'bytes', 'width', 'height', ...(Object.hasOwn(value, 'name') ? ['name'] : [])])
  if (typeof value.attachmentId !== 'string' || !ATTACHMENT_ID.test(value.attachmentId)
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mediaType))
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > MAX_IMAGE_BYTES
    || !Number.isSafeInteger(value.width) || Number(value.width) < 1 || Number(value.width) > 65535
    || !Number.isSafeInteger(value.height) || Number(value.height) < 1 || Number(value.height) > 65535
    || value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(value.name))) reject('图片附件无效。')
  return { attachmentId: value.attachmentId as string, mediaType: value.mediaType as string, bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height), ...(value.name === undefined ? {} : { name: value.name as string }) }
}
function jsonSafe(value: unknown, depth = 0, count = { value: 0 }): void {
  if (++count.value > 200_000 || depth > 20) reject('画布结构超出限制。')
  if (typeof value === 'string') { if (value.length > MAX_PROJECT_BYTES) reject('画布文本超出限制。'); return }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) reject('画布数值无效。'); return }
  if (Array.isArray(value)) { for (const child of value) jsonSafe(child, depth + 1, count); return }
  if (!record(value)) reject('画布仅接受 JSON 数据。')
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) reject('画布字段无效。')
    jsonSafe(child, depth + 1, count)
  }
}
export function validateProject(value: unknown): CanvasProject {
  jsonSafe(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength + 1 > MAX_PROJECT_BYTES) reject('画布项目超过 4 MiB。')
  exact(value, ['schemaVersion', 'id', 'title', 'pages', 'assets', 'intents'])
  if (value.schemaVersion !== 1 || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 64
    || !Array.isArray(value.assets) || value.assets.length > MAX_PROJECT_IMAGES || !Array.isArray(value.intents) || value.intents.length > 256) reject('画布项目版本或数量无效。')
  identifier(value.id); text(value.title, 120)
  const assets = (value.assets as unknown[]).map(item => {
    exact(item, ['ownerSessionId', 'ref']); sessionId(item.ownerSessionId)
    return { ownerSessionId: item.ownerSessionId as string, ref: imageRef(item.ref) }
  })
  const fileIds = new Set(assets.map(asset => asset.ref.attachmentId.slice(7)))
  if (assets.reduce((sum, asset) => sum + asset.ref.bytes, 0) > 100 * 1024 * 1024) reject('项目图片总量超过 100 MiB。')
  if (fileIds.size !== assets.length) reject('项目包含重复附件。')
  const pageIds = new Set<string>()
  let totalElements = 0
  for (const page of value.pages as unknown[]) {
    exact(page, ['id', 'title', 'elements', 'view', 'html', 'slide'])
    identifier(page.id); text(page.title, 120)
    if (pageIds.has(page.id as string)) reject('画布页面标识重复。')
    pageIds.add(page.id as string)
    if (!Array.isArray(page.elements) || page.elements.length > 5000 || (totalElements += page.elements.length) > 10000
      || typeof page.slide !== 'boolean' || page.html !== null && (typeof page.html !== 'string' || new TextEncoder().encode(page.html).byteLength > MAX_HTML_BYTES)) reject('画布页面超出限制。')
    exact(page.view, ['scrollX', 'scrollY', 'zoom', 'background'])
    for (const axis of ['scrollX', 'scrollY']) if (!Number.isFinite(page.view[axis]) || Math.abs(Number(page.view[axis])) > 1e9) reject('画布位置无效。')
    if (!Number.isFinite(page.view.zoom) || Number(page.view.zoom) < 0.1 || Number(page.view.zoom) > 30 || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(String(page.view.background))) reject('画布视图无效。')
    const ids = new Set<string>()
    for (const element of page.elements) {
      if (!record(element) || typeof element.id !== 'string' || !ELEMENT_ID.test(element.id) || ids.has(element.id)
        || !['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'frame'].includes(String(element.type))) reject('画布元素无效。')
      ids.add(element.id)
      if (element.type === 'image' && (typeof element.fileId !== 'string' || !fileIds.has(element.fileId))) reject('画布图片缺少确切附件。')
      if (element.link !== undefined && element.link !== null && (typeof element.link !== 'string' || !/^https?:\/\//u.test(element.link))) reject('画布链接仅允许 HTTP(S)。')
    }
  }
  const intentIds = new Set<string>()
  for (const intent of value.intents as unknown[]) {
    exact(intent, ['id', 'pageId', 'kind', 'sessionId', 'sourceIds', 'imported'])
    identifier(intent.id); sessionId(intent.sessionId)
    if (intentIds.has(intent.id as string) || !pageIds.has(String(intent.pageId)) || !['image', 'edit', 'html', 'slides'].includes(String(intent.kind))
      || !Array.isArray(intent.imported) || intent.imported.length > 100 || intent.imported.some(hash => typeof hash !== 'string' || !HASH.test(hash))
      || !Array.isArray(intent.sourceIds) || intent.sourceIds.length > 16 || intent.sourceIds.some(id => typeof id !== 'string' || !fileIds.has(id.slice(7)))) reject('画布请求绑定无效。')
    intentIds.add(intent.id as string)
  }
  return JSON.parse(JSON.stringify(value)) as CanvasProject
}
export function emptyPage(id: string, title = '画布 1'): CanvasPage {
  return { id: identifier(id), title, elements: [], view: { scrollX: 0, scrollY: 0, zoom: 1, background: '#ffffff' }, html: null, slide: true }
}
export function emptyProject(id: string): CanvasProject { return { schemaVersion: 1, id: identifier(id), title: '未命名画布', pages: [emptyPage('page-1')], assets: [], intents: [] } }
export const artifactPath = (projectId: string, intentId: string) => `.e-mate/canvas/${identifier(projectId)}-${identifier(intentId)}.html`
export const intentMarker = (id: string) => `[e-Mate canvas ${identifier(id)}]`
export function intentPrompt(project: CanvasProject, intent: CanvasIntent, instruction: string): string {
  text(instruction.trim(), 20_000)
  const source = intent.sourceIds.length ? `\n使用所附图片，确切附件 ID：${intent.sourceIds.join(', ')}。` : ''
  const output = intent.kind === 'html' || intent.kind === 'slides'
    ? `\n使用已有文件工具，将完整、离线可用的 HTML 写到工作区相对路径 ${artifactPath(project.id, intent.id)}。${intent.kind === 'slides' ? '每张幻灯片用独立的 <section data-slide> 容器。' : ''}不要引用网络字体、脚本或资源。`
    : '\n使用已有 imagegen 或 image_batch 工具生成结果；不要假装成功，也不要重新执行状态未知的请求。'
  return `${intentMarker(intent.id)}\n${instruction.trim()}${source}${output}`
}
