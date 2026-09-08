import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

type ImageRef = {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

type AttachmentContext = {
  readonly attachments: {
    readImage(ref: ImageRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>
  }
}

type VisionExecution = {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly session?: {
      deriveMessages?(): unknown
      readonly events?: readonly unknown[]
      readonly header?: { readonly cwd?: unknown }
    }
  }
}

const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u
const EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export class VisionAttachmentError extends Error {
  readonly code = 'input'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VisionToolkitError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function imageRef(value: unknown): ImageRef | undefined {
  const item = record(value)
  if (item === undefined || typeof item.attachmentId !== 'string' || !ATTACHMENT_ID.test(item.attachmentId)
    || typeof item.mediaType !== 'string' || EXTENSION[item.mediaType] === undefined
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1
    || !Number.isSafeInteger(item.width) || Number(item.width) < 1
    || !Number.isSafeInteger(item.height) || Number(item.height) < 1
    || (item.name !== undefined && typeof item.name !== 'string')) return undefined
  return item as unknown as ImageRef
}

function collectBlocks(value: unknown, refs: Map<string, ImageRef>): void {
  if (!Array.isArray(value)) return
  for (const blockValue of value) {
    const block = record(blockValue)
    if (block === undefined) continue
    if (block.type === 'image') {
      const ref = imageRef(block.attachment)
      if (ref !== undefined) refs.set(ref.attachmentId, ref)
    } else if (block.type === 'tool-result') collectBlocks(block.content, refs)
  }
}

function currentSessionImages(exec: VisionExecution): Map<string, ImageRef> {
  const session = exec.agent?.session
  if (session === undefined) throw new VisionAttachmentError('vision_glance attachment IDs require an owning Agent session')
  const refs = new Map<string, ImageRef>()
  const messages = session.deriveMessages?.()
  if (Array.isArray(messages)) {
    for (const value of messages) collectBlocks(record(value)?.content, refs)
  }
  for (const value of session.events ?? []) {
    const event = record(value)
    const data = record(event?.data)
    if (event?.type === 'user/message') collectBlocks(data?.content, refs)
    else if (event?.type === 'assistant/message' || event?.type === 'tool/result') {
      collectBlocks(record(data?.message)?.content, refs)
    } else if (event?.type === 'emate/image-output') {
      collectBlocks(data?.content, refs)
      const output = imageRef(data?.output)
      if (output !== undefined) refs.set(output.attachmentId, output)
    }
  }
  return refs
}

function currentWorkspace(exec: VisionExecution): string {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new VisionAttachmentError('vision_glance attachments require an absolute current Agent workspace')
  }
  return cwd
}

/** Stage exact current-session Attachment/CAS bytes only for one Vision call. */
export async function withResolvedVisionGlanceImages<T>(
  ctx: AttachmentContext,
  images: readonly string[],
  exec: VisionExecution,
  run: (images: readonly string[]) => Promise<T>,
): Promise<T> {
  if (!images.some(value => ATTACHMENT_ID.test(value))) return run(images)
  exec.signal?.throwIfAborted()
  const refs = currentSessionImages(exec)
  for (const value of images) {
    if (ATTACHMENT_ID.test(value) && !refs.has(value)) {
      throw new VisionAttachmentError(`vision_glance attachment ${value} is not present in the current Agent session`)
    }
  }
  let directory: string
  try {
    directory = await mkdtemp(join(currentWorkspace(exec), '.e-mate-vision-attachment-'))
  } catch (error) {
    if (exec.signal?.aborted === true) throw exec.signal.reason
    if (error instanceof VisionAttachmentError) throw error
    throw new VisionAttachmentError('vision_glance attachment workspace could not be prepared', { cause: error })
  }
  try {
    const resolved: string[] = []
    for (const [index, value] of images.entries()) {
      if (!ATTACHMENT_ID.test(value)) {
        resolved.push(value)
        continue
      }
      const ref = refs.get(value)
      if (ref === undefined) throw new VisionAttachmentError(`vision_glance attachment ${value} is invalid`)
      let stored: { data: Uint8Array }
      try {
        stored = await ctx.attachments.readImage(ref, exec.signal)
      } catch (error) {
        if (exec.signal?.aborted === true) throw exec.signal.reason
        throw new VisionAttachmentError(`vision_glance attachment ${value} could not be read from CAS`, { cause: error })
      }
      const path = join(directory, `image-${index + 1}${EXTENSION[ref.mediaType]}`)
      try {
        await writeFile(path, stored.data, { mode: 0o600, signal: exec.signal })
      } catch (error) {
        if (exec.signal?.aborted === true) throw exec.signal.reason
        throw new VisionAttachmentError(`vision_glance attachment ${value} could not be prepared in the Agent workspace`, { cause: error })
      }
      resolved.push(path)
    }
    return await run(resolved)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
