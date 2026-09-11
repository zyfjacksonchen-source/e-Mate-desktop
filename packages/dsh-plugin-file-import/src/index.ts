import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  allowedMediaType,
  CHANNEL,
  MAX_FILE_BYTES,
  MAX_FILES,
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_TOTAL_BYTES,
  normalizedSafeFileName,
  type ImageAttachmentRef,
  type ImportedFile,
} from './contract.ts'

export const name = 'emate-file-import'
export const inject = [
  'webServer','connection', 'workspaceRegistry', 'attachments', 'sessions']

interface WorkspaceView {
  readonly path: string
  readonly sessionIds: readonly string[]
}

interface WorkspaceContext {
  readonly workspaceRegistry: {
    readonly archivedSessionIds: readonly string[]
    list(): readonly WorkspaceView[]
  }
}

interface ImageStageContext extends WorkspaceContext {
  readonly attachments: {
    readonly imageLimits: {
      readonly maxImageBytes: number
      readonly maxImagesPerMessage: number
      readonly maxMessageImageBytes: number
      readonly mediaTypes: readonly string[]
    }
    saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageAttachmentRef[]>
  }
  readonly sessions: {
    get(id: string): { append(type: string, data: unknown, options: { ignorable: true }): unknown } | undefined
    flush(session: object): Promise<boolean>
  }
}

interface EncodedImage {
  readonly data: Uint8Array
  readonly mediaType: typeof IMAGE_MEDIA_TYPES[number]
  readonly name: string
}

interface EncodedFile {
  readonly bytes: Buffer
  readonly displayName: string
  readonly mediaType: string
  readonly storedName: string
}

interface ImportFileOperations {
  readonly link: typeof link
  readonly lstat: typeof lstat
  readonly unlink: typeof unlink
}

const importFileOperations: ImportFileOperations = { link, lstat, unlink }

export class ImportValidationError extends Error {}

function badRequest(message: string) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalError() {
  return { ok: false, error: { code: 'internal', message: '文件暂时无法导入当前工作区。', details: {} } }
}

function diagnostic(value: unknown): { name: string; code: string } {
  const safe = (input: unknown): string => typeof input === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(input) ? input : 'unknown'
  return {
    name: safe(value instanceof Error ? value.name : typeof value),
    code: safe(value !== null && typeof value === 'object' ? (value as { code?: unknown }).code : undefined),
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function validatedDisplayName(value: unknown): string {
  const name = normalizedSafeFileName(value)
  if (name === undefined) throw new ImportValidationError('文件名无效。')
  if (allowedMediaType(name) === undefined) throw new ImportValidationError('不支持此文件类型。')
  return name
}

function storedName(displayName: string): string {
  return displayName.replace(/[\s@]+/gu, '_')
}

function imageName(value: unknown): string {
  if (typeof value !== 'string') throw new ImportValidationError('图片名称无效。')
  const name = value.normalize('NFC')
  if (name === '' || name === '.' || name === '..' || name !== name.trim()
    || Buffer.byteLength(name, 'utf8') > 255 || name.includes('/') || name.includes('\\')
    || Array.from(name).some(character => {
      const code = character.codePointAt(0) as number
      return code <= 0x1f || code === 0x7f
    })) throw new ImportValidationError('图片名称无效。')
  return name
}

function decodeImages(payload: unknown, limits: ImageStageContext['attachments']['imageLimits']): { sessionId: string; images: EncodedImage[] } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new ImportValidationError('图片暂存请求无效。')
  const body = payload as Record<string, unknown>
  const maxCount = Math.min(limits.maxImagesPerMessage, MAX_IMAGES)
  if (!exactKeys(body, ['images', 'session_id']) || typeof body.session_id !== 'string'
    || body.session_id.length < 1 || body.session_id.length > 256 || !Array.isArray(body.images)
    || body.images.length < 1 || body.images.length > maxCount) throw new ImportValidationError('图片暂存请求无效。')
  const maxBytes = Math.min(limits.maxImageBytes, MAX_IMAGE_BYTES)
  const maxTotal = Math.min(limits.maxMessageImageBytes, MAX_IMAGE_TOTAL_BYTES)
  let total = 0
  const images = body.images.map((entry): EncodedImage => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new ImportValidationError('图片暂存数据无效。')
    const item = entry as Record<string, unknown>
    if (!exactKeys(item, ['bytes_base64', 'media_type', 'name']) || typeof item.bytes_base64 !== 'string'
      || item.bytes_base64.length === 0 || item.bytes_base64.length > Math.ceil(maxBytes / 3) * 4
      || item.bytes_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.bytes_base64)
      || typeof item.media_type !== 'string' || !IMAGE_MEDIA_TYPES.includes(item.media_type as never)
      || !limits.mediaTypes.includes(item.media_type)) throw new ImportValidationError('图片暂存数据无效。')
    const bytes = Buffer.from(item.bytes_base64, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || bytes.toString('base64') !== item.bytes_base64) {
      throw new ImportValidationError('图片暂存数据无效。')
    }
    total += bytes.byteLength
    if (total > maxTotal) throw new ImportValidationError('图片总大小超过当前消息限制。')
    return { data: new Uint8Array(bytes), mediaType: item.media_type as EncodedImage['mediaType'], name: imageName(item.name) }
  })
  return { sessionId: body.session_id, images }
}

function imageValidationMessage(error: unknown): string | undefined {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'TOO_MANY_IMAGES') return '图片数量超过当前消息限制。'
  if (code === 'IMAGES_TOO_LARGE') return '图片总大小超过当前消息限制。'
  if (code === 'IMAGE_TOO_LARGE') return '图片超过单文件大小限制。'
  if (code === 'UNSUPPORTED_IMAGE_TYPE' || code === 'IMAGE_TYPE_MISMATCH') return '仅支持 PNG、JPEG、WebP 和 GIF 图片。'
  if (code === 'IMAGE_TOO_MANY_PIXELS') return '图片尺寸超过当前限制。'
  if (code === 'INVALID_IMAGE' || code === 'INVALID_IMAGE_BASE64') return '图片暂存数据无效。'
  return undefined
}

async function stageImages(ctx: ImageStageContext, payload: unknown, signal: AbortSignal): Promise<readonly ImageAttachmentRef[]> {
  signal.throwIfAborted()
  const request = decodeImages(payload, ctx.attachments.imageLimits)
  await workspaceRoot(ctx, request.sessionId)
  const session = ctx.sessions.get(request.sessionId)
  if (session === undefined) throw new ImportValidationError('当前会话不可用。')
  signal.throwIfAborted()
  const refs = await ctx.attachments.saveImages(request.images)
  signal.throwIfAborted()
  if (refs.length !== request.images.length) throw new Error('attachment staging cardinality mismatch')
  session.append('emate/image-draft-staged', { schema_version: 1, content: refs.map(attachment => ({ type: 'image', attachment })) }, { ignorable: true })
  if (await ctx.sessions.flush(session) !== true) throw new Error('session staging event was not durably flushed')
  return refs
}

function decodeFiles(payload: unknown): { sessionId: string; files: EncodedFile[] } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ImportValidationError('导入请求无效。')
  }
  const body = payload as Record<string, unknown>
  if (!exactKeys(body, ['files', 'session_id'])
    || typeof body.session_id !== 'string' || body.session_id.length < 1 || body.session_id.length > 256
    || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > MAX_FILES) {
    throw new ImportValidationError('导入请求无效。')
  }
  let total = 0
  const files = body.files.map((entry): EncodedFile => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ImportValidationError('导入文件无效。')
    }
    const item = entry as Record<string, unknown>
    if (!exactKeys(item, ['bytes_base64', 'media_type', 'name'])
      || typeof item.bytes_base64 !== 'string'
      || item.bytes_base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
      || item.bytes_base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.bytes_base64)
      || typeof item.media_type !== 'string' || item.media_type.length > 127) {
      throw new ImportValidationError('导入文件无效。')
    }
    const displayName = validatedDisplayName(item.name)
    const mediaType = allowedMediaType(displayName) as string
    const bytes = Buffer.from(item.bytes_base64, 'base64')
    if (bytes.byteLength > MAX_FILE_BYTES || bytes.toString('base64') !== item.bytes_base64) {
      throw new ImportValidationError('导入文件无效。')
    }
    total += bytes.byteLength
    if (total > MAX_TOTAL_BYTES) throw new ImportValidationError('单次导入文件总量超过 32 MiB。')
    return { bytes, displayName, mediaType, storedName: storedName(displayName) }
  })
  return { sessionId: body.session_id, files }
}

async function workspaceRoot(ctx: WorkspaceContext, sessionId: string): Promise<string> {
  if (ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
    throw new ImportValidationError('当前会话已归档。')
  }
  const workspace = ctx.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(sessionId))
  if (workspace === undefined) throw new ImportValidationError('当前会话没有绑定工作区。')
  const root = await realpath(workspace.path)
  if (!(await lstat(root)).isDirectory()) throw new ImportValidationError('当前工作区不可用。')
  return root
}

async function managedImports(root: string): Promise<string> {
  let current = root
  for (const segment of ['.e-mate', 'imports']) {
    const candidate = join(current, segment)
    await mkdir(candidate, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const info = await lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ImportValidationError('工作区导入目录不安全。')
    current = await realpath(candidate)
    if (!inside(root, current)) throw new ImportValidationError('工作区导入目录越界。')
  }
  return current
}

function collisionName(name: string, index: number): string {
  if (index === 1) return name
  const extension = extname(name)
  const suffix = `-${index}${extension}`
  const limit = 160 - Buffer.byteLength(suffix, 'utf8')
  let stem = ''
  for (const character of name.slice(0, name.length - extension.length)) {
    if (Buffer.byteLength(stem + character, 'utf8') > limit) break
    stem += character
  }
  return `${stem}${suffix}`
}

async function removeFile(path: string, operations: ImportFileOperations): Promise<void> {
  try {
    await operations.unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function cleanupFailure(message: string, original: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([original, cleanup], message)
}

async function publishFile(
  directory: string,
  input: EncodedFile,
  signal: AbortSignal | undefined,
  operations: ImportFileOperations,
): Promise<{ path: string; name: string }> {
  signal?.throwIfAborted()
  const temporary = join(directory, `.import-${randomUUID()}.tmp`)
  await writeFile(temporary, input.bytes, { flag: 'wx', flush: true, mode: 0o600, signal })
  let saved: { path: string; name: string } | undefined
  let failure: unknown
  try {
    for (let index = 1; index <= 999; index += 1) {
      signal?.throwIfAborted()
      const name = collisionName(input.storedName, index)
      const target = join(directory, name)
      let linked = false
      try {
        await operations.link(temporary, target)
        linked = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      try {
        const info = await operations.lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) throw new ImportValidationError('导入结果不是普通文件。')
        signal?.throwIfAborted()
        saved = { path: target, name }
        break
      } catch (error) {
        if (linked) {
          try {
            await removeFile(target, operations)
          } catch (cleanup) {
            throw cleanupFailure('导入目标清理失败。', error, cleanup)
          }
        }
        throw error
      }
    }
    if (saved === undefined) throw new ImportValidationError('同名文件过多，无法安全导入。')
  } catch (error) {
    failure = error
  }

  try {
    await removeFile(temporary, operations)
  } catch (cleanup) {
    let combined: unknown = failure === undefined ? cleanup : cleanupFailure('导入临时文件清理失败。', failure, cleanup)
    if (saved !== undefined) {
      try {
        await removeFile(saved.path, operations)
      } catch (targetCleanup) {
        combined = cleanupFailure('导入提交回滚失败。', combined, targetCleanup)
      }
    }
    throw combined
  }
  if (failure !== undefined) throw failure
  if (saved === undefined) throw new Error('import publication did not settle')
  return saved
}

export async function importIntoWorkspace(
  root: string,
  files: readonly EncodedFile[],
  signal?: AbortSignal,
  operations: ImportFileOperations = importFileOperations,
): Promise<ImportedFile[]> {
  const directory = await managedImports(root)
  const published: string[] = []
  try {
    const result: ImportedFile[] = []
    for (const file of files) {
      if (await realpath(directory) !== directory) throw new ImportValidationError('工作区导入目录已变化。')
      const saved = await publishFile(directory, file, signal, operations)
      published.push(saved.path)
      result.push({
        bytes: file.bytes.byteLength,
        display_name: file.displayName,
        media_type: file.mediaType,
        relative_path: ['.e-mate', 'imports', saved.name].join('/'),
        stored_name: saved.name,
      })
    }
    return result
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (const path of published) {
      try {
        await removeFile(path, operations)
      } catch (cleanup) {
        cleanupErrors.push(cleanup)
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], '导入批次回滚失败。')
    throw error
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint: string, payload: unknown, signal: AbortSignal) => {
      if (endpoint !== 'import' && endpoint !== 'stage-images') return badRequest('未知文件导入操作。')
      try {
        if (endpoint === 'stage-images') {
          const attachments = await stageImages(ctx as unknown as ImageStageContext, payload, signal)
          return { ok: true, value: { schema_version: 1, attachments } }
        }
        const request = decodeFiles(payload)
        const root = await workspaceRoot(ctx, request.sessionId)
        const files = await importIntoWorkspace(root, request.files, signal)
        return { ok: true, value: { schema_version: 1, files } }
      } catch (error) {
        if (error instanceof ImportValidationError) return badRequest(error.message)
        if (endpoint === 'stage-images') {
          if (signal.aborted) return badRequest('图片暂存已取消。')
          const imageMessage = imageValidationMessage(error)
          if (imageMessage !== undefined) return badRequest(imageMessage)
        }
        console.error('[emate-file-import] internal import failure', diagnostic(error))
        return internalError()
      }
    },
    { authority: 'loopback' },
  ), 'emate.fileImport: loopback session-bound import')
}
