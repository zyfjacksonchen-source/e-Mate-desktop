import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { ASSET_PATH, artifactPath, CanvasError, CHANNEL, exact, HASH, identifier, imageRef, MAX_HTML_BYTES, MAX_IMAGE_BYTES, record, reject, sessionId, validateProject, type CanvasAsset, type CanvasProject } from './contract.ts'
import { canvasDirectory, listProjects, loadProject, readRegular, saveProject, sha256, workspaceRoot } from './project-files.ts'
import { nativeImageOutputs, requestCalls, resolveSessionAsset, inspectSession } from './native-artifacts.ts'

export const name = 'emate-canvas'
export const inject = ['connection', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'attachments', 'sandboxPolicy', 'fs', 'webServer']
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const errorResult = (error: unknown) => ({ ok: false, error: { code: error instanceof CanvasError ? error.code : 'unavailable',
  message: error instanceof CanvasError ? error.message : '画布暂不可用。项目文件与成功素材已保留。', details: {} } })
const extension = (type: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type])
function sameRef(left: unknown, right: unknown): boolean { return JSON.stringify(imageRef(left)) === JSON.stringify(imageRef(right)) }
async function storedImage(ctx: any, asset: CanvasAsset) {
  const stored = await ctx.attachments.readImage(asset.ref)
  if (!sameRef(stored.ref, asset.ref) || !(stored.data instanceof Uint8Array) || stored.data.byteLength !== asset.ref.bytes
    || `sha256:${sha256(stored.data)}` !== asset.ref.attachmentId) reject('画布附件内容校验失败。', 'corrupt')
  return stored
}
async function writable(ctx: any, id: string): Promise<void> {
  const session = await inspectSession(ctx, id)
  if (ctx.sandboxPolicy.resolve({ session }).mode === 'read-only') reject('当前工作区只读，未保存画布。', 'read-only')
}
async function verifyNewAssets(ctx: any, current: string, project: CanvasProject, previous?: CanvasProject) {
  const prior = new Map(previous?.assets.map(asset => [asset.ref.attachmentId, asset]) ?? [])
  for (const asset of project.assets) {
    const known = prior.get(asset.ref.attachmentId)
    if (known && known.ownerSessionId === asset.ownerSessionId && sameRef(known.ref, asset.ref)) continue
    {
      const owned = await resolveSessionAsset(ctx, current, asset.ownerSessionId, asset.ref.attachmentId)
      if (!sameRef(owned.ref, asset.ref)) reject('附件声明与会话记录不一致。', 'scope')
    }
    await storedImage(ctx, asset)
  }
}
export async function handleCanvas(ctx: any, endpoint: string, payload: unknown): Promise<unknown> {
  try {
    if (!record(payload)) reject('画布请求无效。')
    const body = payload as Record<string, unknown>
    const id = sessionId(body.session_id)
    const root = await workspaceRoot(ctx, id)
    if (endpoint === 'list') { exact(body, ['session_id']); return { ok: true, value: await listProjects(root, id) } }
    // Pre-session canvas files remain available only through an explicit copy.
    if (endpoint === 'legacy-list') { exact(body, ['session_id']); return { ok: true, value: await listProjects(root) } }
    if (endpoint === 'import-legacy') {
      exact(body, ['session_id', 'legacy_project_id', 'project_id'])
      await writable(ctx, id)
      const legacy = await loadProject(root, identifier(body.legacy_project_id))
      if (!legacy) reject('旧项目不存在。', 'not-found')
      const project = structuredClone(legacy!.project)
      project.id = identifier(body.project_id); project.intents = []
      for (const asset of project.assets) { await storedImage(ctx, asset); asset.ownerSessionId = id }
      return { ok: true, value: await saveProject(ctx.fs, root, project, null, id) }
    }
    if (endpoint === 'resolve-image') {
      exact(body, ['session_id', 'owner_session_id', 'attachment_id'])
      const asset = await resolveSessionAsset(ctx, id, sessionId(body.owner_session_id), String(body.attachment_id))
      await storedImage(ctx, asset)
      return { ok: true, value: asset }
    }
    if (endpoint === 'import') {
      exact(body, ['session_id', 'project_id', 'archive_base64'])
      await writable(ctx, id)
      const projectId = identifier(body.project_id)
      if (typeof body.archive_base64 !== 'string' || body.archive_base64.length > Math.ceil(MAX_ARCHIVE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body.archive_base64)) reject('项目压缩包无效。')
      const bytes = Buffer.from(body.archive_base64, 'base64')
      if (bytes.toString('base64') !== body.archive_base64) reject('项目压缩包编码无效。')
      let inflated = 0
      const names = new Set<string>()
      const entries = unzipSync(bytes, { filter(file) {
        if (names.has(file.name) || names.size >= 101) reject('项目压缩包素材条目重复或过多。')
        names.add(file.name)
        inflated += file.originalSize
        if (inflated > MAX_ARCHIVE_BYTES || file.originalSize > Math.max(MAX_IMAGE_BYTES, 4 * 1024 * 1024)
          || !/^(?:project\.json|assets\/[0-9a-f]{64}\.(?:png|jpg|webp|gif))$/u.test(file.name)) reject('项目压缩包包含不允许的路径或大小。')
        return true
      } })
      const project = validateProject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries['project.json'])))
      if (Object.keys(entries).length !== project.assets.length + 1) reject('项目素材清单不一致。')
      project.id = projectId; project.intents = []
      for (const asset of project.assets) {
        const data = entries[`assets/${asset.ref.attachmentId.slice(7)}.${extension(asset.ref.mediaType)}`]
        if (!data || data.byteLength !== asset.ref.bytes || `sha256:${sha256(data)}` !== asset.ref.attachmentId) reject('导入素材哈希不一致。', 'corrupt')
        const saved = await ctx.attachments.saveImage({ data, mediaType: asset.ref.mediaType, ...(asset.ref.name ? { name: asset.ref.name } : {}) })
        if (!sameRef(saved, asset.ref)) reject('导入素材尺寸不一致。', 'corrupt')
        asset.ownerSessionId = id
      }
      const saved = await saveProject(ctx.fs, root, project, null, id)
      return { ok: true, value: saved }
    }
    const projectId = identifier(body.project_id)
    if (endpoint === 'load') { exact(body, ['session_id', 'project_id']); return { ok: true, value: await loadProject(root, projectId, id) } }
    if (endpoint === 'save') {
      exact(body, ['session_id', 'project_id', 'expected_revision', 'project'])
      await writable(ctx, id)
      const project = validateProject(body.project)
      if (project.id !== projectId) reject('画布项目身份不一致。')
      const previous = await loadProject(root, projectId, id)
      await verifyNewAssets(ctx, id, project, previous?.project)
      return { ok: true, value: await saveProject(ctx.fs, root, project, body.expected_revision as string | null, id) }
    }
    const loaded = await loadProject(root, projectId, id)
    if (!loaded) reject('画布项目尚未保存。', 'not-found')
    const project = loaded!.project
    if (endpoint === 'image') {
      exact(body, ['session_id', 'project_id', 'attachment_id'])
      const asset = project.assets.find(item => item.ref.attachmentId === body.attachment_id)
      if (!asset) reject('附件不在当前画布项目中。', 'scope')
      const stored = await storedImage(ctx, asset!)
      return { ok: true, value: { ref: stored.ref, bytes_base64: Buffer.from(stored.data).toString('base64') } }
    }
    if (endpoint === 'export') {
      exact(body, ['session_id', 'project_id'])
      const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(project) + '\n') }
      let total = files['project.json']!.byteLength
      for (const asset of project.assets) {
        const stored = await storedImage(ctx, asset)
        total += stored.data.byteLength
        if (total > MAX_ARCHIVE_BYTES) reject('项目素材超过 100 MiB，未截断导出。')
        files[`assets/${asset.ref.attachmentId.slice(7)}.${extension(asset.ref.mediaType)}`] = stored.data
      }
      return { ok: true, value: { name: `${project.id}.emate-canvas.zip`, archive_base64: Buffer.from(zipSync(files, { level: 0 })).toString('base64') } }
    }
    if (endpoint === 'outputs') {
      exact(body, ['session_id', 'project_id', 'intent_id'])
      const intent = project.intents.find(item => item.id === body.intent_id)
      if (!intent || intent.sessionId !== id) reject('请求不属于当前会话。', 'scope')
      if (intent!.kind === 'image' || intent!.kind === 'edit') {
        const assets = await nativeImageOutputs(ctx, id, intent!)
        for (const asset of assets) await storedImage(ctx, asset)
        return { ok: true, value: { kind: 'images', assets } }
      }
      const session = await inspectSession(ctx, id)
      const requested = requestCalls(session.events, intent!)
      // File bytes are imported only after this exact native request has an observed completed turn.
      const completed = requested && session.events.some(event => event.type === 'turn/end' && event.data?.turn === requested.turn && event.data?.reason?.kind === 'completed')
      if (!completed) return { ok: true, value: { kind: 'html', html: null, sha256: null } }
      const directory = await canvasDirectory(root)
      const path = artifactPath(projectId, intent!.id).split('/').at(-1)!
      const bytes = await readRegular(join(directory, path), MAX_HTML_BYTES)
      return { ok: true, value: { kind: 'html', html: bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null, sha256: bytes ? sha256(bytes) : null } }
    }
    reject('未知画布操作。')
  } catch (error) { return errorResult(error) }
}

/** Package assets share the native web server. No project bytes or host paths are served here. */
export function apply(ctx: any): void {
  ctx.effect(() => ctx.connection.rpc.handle(CHANNEL, (endpoint: string, payload: unknown) => handleCanvas(ctx, endpoint, payload), { authority: 'loopback' }), 'emate.canvas: native RPC')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ASSET_PATH.slice(0, -1), handler: async (req: any, res: any) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return }
    const path = new URL(req.url, 'http://local.invalid').pathname.slice(ASSET_PATH.length)
    if (!/^(?:editor\.js|editor\.css|fonts\/[A-Za-z0-9_./-]+\.(?:woff2?|ttf))$/u.test(path) || path.includes('..')) { res.writeHead(404); res.end(); return }
    try {
      const bytes = await readFile(fileURLToPath(new URL(`./assets/${path}`, import.meta.url)))
      res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.woff2') ? 'font/woff2' : 'font/woff',
        'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch { res.writeHead(404); res.end() }
  } }), 'emate.canvas: same-origin offline assets')
}
