import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { IconCloseOutline16, IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  ALLOWED_MEDIA_BY_EXTENSION, allowedMediaType, CHANNEL, COMPOSER_DROP_TARGET, extensionOf, fileDropRoute,
  MAX_FILE_BYTES, MAX_FILES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGES, MAX_IMAGE_TOTAL_BYTES, MAX_TOTAL_BYTES, WORKSPACE_DROP_TARGET, type ImageAttachmentRef,
} from '../contract.ts'
import { normalizedImage } from './image.ts'
import { FileIcon } from './file-icons.tsx'
import { importedDraft, importedMessage, type FileReference } from './references.ts'
import { parseImageStageResult, parseImportResult, safeThrownImportMessage } from './result.ts'
import css from './style.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'e-mate.conversation.composer': { kind: 'single'; scope: 'session-maybe'; owner: { nativeProps: any; InputBar: ComponentType<any> } }
    'e-mate.conversation.composer.after-upload': { kind: 'list'; scope: 'session' }
  }
}

export const inject = ['slots', 'connection', 'inputTriggers', 'conversation', 'sessions']
export const FILE_PICK_EVENT = 'e-mate:file-picker-requested'
const IMAGE_STAGE_TIMEOUT_MS = 120_000

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const IMAGE_MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
}
interface ImportRow {
  readonly id: string
  readonly displayName: string
  readonly mediaType: string
  readonly phase: 'importing' | 'error'
  readonly message?: string
  readonly dismissible?: boolean
  readonly hydrationDraftKey?: string
}
interface DurableImageDraft {
  readonly schema_version: 1
  readonly draft_key: string
  readonly attachment: ImageAttachmentRef
}
interface DraftImageDescriptor { readonly id: string; readonly file: File }
interface FileInputActions {
  addFiles(files: readonly FileReference[], draft?: string): boolean
  removeFile(path: string): void
  beginImageStage(): boolean
  cancelImageStage(): void
  addDurableImages(images: readonly DurableImageDraft[], ids: readonly string[]): boolean
  hydrateDurableImage(key: string, id: string): boolean
  removeDurableImage(key: string): string | undefined
}
interface FileImportProps {
  readonly sessionId: string | undefined
  readonly input: {
    readonly draft: string; readonly phase: string; readonly fileRefs: readonly FileReference[]
    readonly imageIds: readonly string[]; readonly imageRefs: readonly DurableImageDraft[]
    readonly hydratedImageKeys: readonly string[]; readonly runtimeOnlyImageIds: readonly string[]; readonly imageStagePending: boolean
  }
  readonly inputActions: FileInputActions
  readonly isLoopback: boolean
  readonly call: (endpoint: 'import' | 'stage-images', payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  readonly createDraftImages: (files: readonly File[]) => readonly DraftImageDescriptor[]
  readonly draftImages: (ids: readonly string[]) => readonly DraftImageDescriptor[]
  readonly releaseDraftImages: (images: readonly DraftImageDescriptor[]) => void
  readonly readAttachment: (ref: ImageAttachmentRef) => Promise<unknown>
  readonly imageLimits: () => { maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number; maxImagePixels: number; mediaTypes: readonly string[] } | undefined
  readonly notify: (level: 'info' | 'error', text: string) => void
  readonly renderComposer: (parts: { accessory: ReactNode; controls: ReactNode; picker: ReactNode; pending: boolean; addFiles: (files: readonly File[]) => string | null }) => ReactNode
}
const EMPTY_INPUT = { draft: '', phase: 'plain', fileRefs: [], imageIds: [], imageRefs: [], hydratedImageKeys: [], runtimeOnlyImageIds: [], imageStagePending: false }
const ABSENT_ACTIONS: FileInputActions = {
  addFiles: () => false, removeFile() {}, beginImageStage: () => false, cancelImageStage() {}, addDurableImages: () => false, hydrateDurableImage: () => false, removeDurableImage: () => undefined,
}

function imageType(file: File): string | undefined {
  if (IMAGE_MEDIA.has(file.type)) return file.type
  if (file.type !== '') return undefined
  return IMAGE_MEDIA_BY_EXTENSION[file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()]
}

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function sameAttachment(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId && left.mediaType === right.mediaType && left.bytes === right.bytes
    && left.width === right.width && left.height === right.height && left.name === right.name
}

type AttachmentReadCheck = { readonly kind: 'ok'; readonly data: Uint8Array }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'transient' }

const TERMINAL_ATTACHMENT_REASONS = new Set([
  'ATTACHMENT_NOT_REFERENCED', 'ATTACHMENT_NOT_FOUND', 'ATTACHMENT_CORRUPT', 'INVALID_ATTACHMENT_REF',
])

function attachmentReadCheck(value: unknown, expected: ImageAttachmentRef): AttachmentReadCheck {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'transient' }
  const result = value as Record<string, unknown>
  if (result.ok === true) {
    if (Object.keys(result).sort().join(',') !== 'ok,value'
      || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) return { kind: 'transient' }
    const body = result.value as Record<string, unknown>
    if (Object.keys(body).sort().join(',') !== 'attachment,data' || !(body.data instanceof Uint8Array)) return { kind: 'transient' }
    const parsed = parseImageStageResult({ ok: true, value: { schema_version: 1, attachments: [body.attachment] } })
    if (!parsed.ok) return { kind: 'transient' }
    if (!sameAttachment(parsed.attachments[0]!, expected) || body.data.byteLength !== expected.bytes) return { kind: 'terminal' }
    return { kind: 'ok', data: body.data }
  }
  if (result.ok !== false || Object.keys(result).sort().join(',') !== 'error,ok'
    || result.error === null || typeof result.error !== 'object' || Array.isArray(result.error)) return { kind: 'transient' }
  const error = result.error as Record<string, unknown>
  const details = error.details
  if (Object.keys(error).sort().join(',') === 'code,details,message' && error.code === 'attachment-error' && typeof error.message === 'string'
    && details !== null && typeof details === 'object' && !Array.isArray(details)
    && Object.keys(details).join(',') === 'reason' && typeof (details as Record<string, unknown>).reason === 'string'
    && TERMINAL_ATTACHMENT_REASONS.has((details as Record<string, unknown>).reason as string)) return { kind: 'terminal' }
  return { kind: 'transient' }
}

function errorRows(files: readonly File[], message: string): ImportRow[] {
  return files.map(file => ({ id: crypto.randomUUID(), displayName: file.name || '未命名文件', mediaType: file.type, phase: 'error', message }))
}

function FileCardContent({ name, mediaType }: { name: string; mediaType: string }) {
  return <>
    <span className={css.icon}><FileIcon name={name} mediaType={mediaType} /></span>
    <span className={css.details}>
      <span className={css.name} title={name}>{name}</span>
      <span className={css.extension}>{extensionOf(name).toUpperCase() || 'FILE'}</span>
    </span>
  </>
}

export function FileCards({ files, remove, open }: {
  files: readonly FileReference[]
  remove?: (path: string) => void
  open?: (path: string) => void
}) {
  return <>{files.map(file => <div key={file.relative_path} className={css.row} data-emate-resource-path={file.relative_path}>
    <button type="button" className={css.file} disabled={open === undefined} title={file.display_name}
      aria-label={`打开 ${file.display_name}`} onClick={() => { open?.(file.relative_path) }}>
      <FileCardContent name={file.display_name} mediaType={file.media_type} />
    </button>
    {remove !== undefined && <button type="button" className={css.dismiss} aria-label={`移除 ${file.display_name}`}
      onClick={() => { remove(file.relative_path) }}><IconCloseOutline16 size={12} /></button>}
  </div>)}</>
}

export function FileImportControl({
  sessionId, input, inputActions, isLoopback, call, createDraftImages, draftImages, releaseDraftImages, readAttachment, imageLimits, notify, renderComposer,
}: FileImportProps) {
  const picker = useRef<HTMLInputElement>(null)
  const owner = useRef<string | undefined>(sessionId)
  const generation = useRef(0)
  const migrate = useRef(true)
  const dismissed = useRef(new Set<string>())
  const intakeBusy = useRef(false)
  const inputCurrent = useRef(input)
  const hydrationReads = useRef(new Map<string, { attachmentId: string; reader: FileImportProps['readAttachment']; pending: Promise<unknown> }>())
  const transientHydration = useRef(new Set<string>())
  const imageStage = useRef<{ controller: AbortController; actions: FileInputActions } | null>(null)
  inputCurrent.current = input
  const [rows, setRows] = useState<ImportRow[]>([])
  const [busy, setBusy] = useState(false)
  const [hydrating, setHydrating] = useState(false)
  const [hydrationRetryEpoch, setHydrationRetryEpoch] = useState(0)
  const hydrationPending = input.imageRefs.some(item => !input.hydratedImageKeys.includes(item.draft_key))
  const disabled = busy || hydrating || hydrationPending || sessionId === undefined || input.phase === 'adjudicating' || input.phase === 'submitting' || !isLoopback
  useLayoutEffect(() => {
    const previousStage = imageStage.current
    if (previousStage !== null) {
      imageStage.current = null
      previousStage.controller.abort()
      previousStage.actions.cancelImageStage()
    }
    hydrationReads.current.clear()
    transientHydration.current.clear()
    owner.current = sessionId
    generation.current += 1
    migrate.current = true
    setRows([])
    intakeBusy.current = false
    setBusy(false)
    setHydrating(false)
    return () => {
      owner.current = undefined
      hydrationReads.current.clear()
      transientHydration.current.clear()
      const activeStage = imageStage.current
      if (activeStage !== null) {
        imageStage.current = null
        activeStage.controller.abort()
        activeStage.actions.cancelImageStage()
      }
    }
  }, [sessionId])

  const imageAdmissible = useCallback((draftKey: string, ignoredKeys: ReadonlySet<string>): boolean => {
    const state = inputCurrent.current
    const runtime = draftImages(state.runtimeOnlyImageIds)
    const live = imageLimits()
    const maxImages = Math.min(live?.maxImagesPerMessage ?? MAX_IMAGES, MAX_IMAGES)
    const maxImageBytes = Math.min(live?.maxImageBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)
    const maxTotalBytes = Math.min(live?.maxMessageImageBytes ?? MAX_IMAGE_TOTAL_BYTES, MAX_IMAGE_TOTAL_BYTES)
    const maxPixels = Math.min(live?.maxImagePixels ?? MAX_IMAGE_PIXELS, MAX_IMAGE_PIXELS)
    const mediaTypes = live?.mediaTypes ?? [...IMAGE_MEDIA]
    if (runtime.length > maxImages || runtime.some(image => !mediaTypes.includes(image.file.type) || image.file.size > maxImageBytes)) return false
    let count = runtime.length
    let total = runtime.reduce((sum, image) => sum + image.file.size, 0)
    if (total > maxTotalBytes) return false
    for (const item of state.imageRefs) {
      if (ignoredKeys.has(item.draft_key)) continue
      const ref = item.attachment
      const accepted = mediaTypes.includes(ref.mediaType) && ref.bytes <= maxImageBytes
        && ref.width <= Math.floor(maxPixels / ref.height) && count < maxImages && total + ref.bytes <= maxTotalBytes
      if (item.draft_key === draftKey) return accepted
      if (accepted) { count += 1; total += ref.bytes }
    }
    return false
  }, [draftImages, imageLimits])

  useEffect(() => {
    const requestSession = sessionId
    const requestGeneration = generation.current
    const current = () => owner.current === requestSession && generation.current === requestGeneration
    const hydrated = new Set(input.hydratedImageKeys)
    const pending = input.imageRefs.filter(item => !hydrated.has(item.draft_key) && !transientHydration.current.has(item.draft_key))
    if (requestSession === undefined) return
    if (pending.length === 0) { setHydrating(false); return }
    let cancelled = false
    let notified = false
    const removedKeys = new Set<string>()
    const currentRef = (item: DurableImageDraft) => {
      if (cancelled || !current()) return undefined
      const live = inputCurrent.current.imageRefs.find(candidate => candidate.draft_key === item.draft_key)
      return live !== undefined && sameAttachment(live.attachment, item.attachment) ? live : undefined
    }
    const removeCurrent = (item: DurableImageDraft): void => {
      if (removedKeys.has(item.draft_key) || currentRef(item) === undefined) return
      removedKeys.add(item.draft_key)
      transientHydration.current.delete(item.draft_key)
      const released = inputActions.removeDurableImage(item.draft_key)
      if (released !== undefined) releaseDraftImages(draftImages([released]))
      if (!notified) { notified = true; notify('error', '一张图片草稿无法恢复，已从草稿中移除。') }
    }
    const retainCurrent = (item: DurableImageDraft): void => {
      if (currentRef(item) === undefined || transientHydration.current.has(item.draft_key)) return
      transientHydration.current.add(item.draft_key)
      setRows(currentRows => [
        ...currentRows.filter(row => row.hydrationDraftKey !== item.draft_key),
        {
          id: `hydrate-${item.draft_key}`, displayName: item.attachment.name ?? '图片', mediaType: item.attachment.mediaType,
          phase: 'error', message: '图片草稿暂时无法恢复。', hydrationDraftKey: item.draft_key,
        },
      ])
    }
    setHydrating(true)
    void Promise.all(pending.map(async (item) => {
      let created: readonly DraftImageDescriptor[] = []
      try {
        if (!imageAdmissible(item.draft_key, removedKeys)) { removeCurrent(item); return }
        const cached = hydrationReads.current.get(item.draft_key)
        let pendingRead: Promise<unknown>
        if (cached?.attachmentId === item.attachment.attachmentId && cached.reader === readAttachment) pendingRead = cached.pending
        else {
          pendingRead = readAttachment(item.attachment)
          const entry = { attachmentId: item.attachment.attachmentId, reader: readAttachment, pending: pendingRead }
          hydrationReads.current.set(item.draft_key, entry)
          void pendingRead.finally(() => { if (hydrationReads.current.get(item.draft_key) === entry) hydrationReads.current.delete(item.draft_key) }).catch(() => undefined)
        }
        let value: unknown
        try { value = await pendingRead }
        catch { retainCurrent(item); return }
        if (currentRef(item) === undefined) return
        if (!imageAdmissible(item.draft_key, removedKeys)) { removeCurrent(item); return }
        const checked = attachmentReadCheck(value, item.attachment)
        if (checked.kind === 'terminal') { removeCurrent(item); return }
        if (checked.kind === 'transient') { retainCurrent(item); return }
        created = createDraftImages([new File([checked.data.slice().buffer], item.attachment.name ?? 'image', { type: item.attachment.mediaType })])
        if (created.length !== 1) { retainCurrent(item); return }
        if (currentRef(item) === undefined) return
        if (!inputActions.hydrateDurableImage(item.draft_key, created[0]!.id)) { retainCurrent(item); return }
        transientHydration.current.delete(item.draft_key)
        setRows(currentRows => currentRows.filter(row => row.hydrationDraftKey !== item.draft_key))
        created = []
      } catch {
        retainCurrent(item)
      } finally {
        if (created.length > 0) releaseDraftImages(created)
      }
    })).finally(() => { if (!cancelled && current()) setHydrating(false) })
    return () => { cancelled = true }
  }, [createDraftImages, draftImages, hydrationPending, hydrationRetryEpoch, imageAdmissible, input.imageRefs, inputActions, notify, readAttachment, releaseDraftImages, sessionId])

  useLayoutEffect(() => {
    if (!migrate.current || (input.draft === '' && input.fileRefs.length === 0)) return
    const legacy = importedDraft(input.draft)
    if (legacy.files.length > 0) {
      try { if (inputActions.addFiles(legacy.files, legacy.text)) migrate.current = false }
      catch {
        migrate.current = false
        setRows([{ id: 'restore-error', displayName: '附件草稿', mediaType: '', phase: 'error', message: '附件草稿无法恢复，请重新选择文件。' }])
      }
    } else migrate.current = false
  }, [input.draft, input.fileRefs, input.phase, inputActions])

  const importFiles = useCallback(async (files: readonly File[]) => {
    const requestSession = sessionId
    const requestGeneration = generation.current
    const current = () => owner.current === requestSession && generation.current === requestGeneration
    if (files.length === 0) return
    if (!isLoopback || sessionId === undefined) {
      setRows(current => [...current, ...errorRows(files, '本地文件导入仅支持当前电脑上的 e-Mate。')])
      return
    }
    const accepted: File[] = []
    const rejected: File[] = []
    for (const file of files) (allowedMediaType(file.name) === undefined ? rejected : accepted).push(file)
    if (rejected.length > 0) setRows(current => [...current, ...errorRows(rejected, '仅支持办公文档、PDF、文本、结构化数据和常见归档。')])
    if (accepted.length === 0) return
    if (accepted.length > MAX_FILES || accepted.some(file => file.size > MAX_FILE_BYTES)
      || accepted.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      setRows(current => [...current, ...errorRows(accepted, '单次最多 8 个文件；单文件 16 MiB，总计 32 MiB。')])
      return
    }
    const pending = accepted.map(file => ({
      id: crypto.randomUUID(), displayName: file.name, mediaType: allowedMediaType(file.name) as string, phase: 'importing' as const,
    }))
    setRows(current => [...current, ...pending])
    try {
      const encoded = await Promise.all(accepted.map(async file => ({ name: file.name, media_type: allowedMediaType(file.name), bytes_base64: await base64Of(file) })))
      if (!current()) return
      const result = parseImportResult(await call('import', { session_id: sessionId, files: encoded }))
      if (!current()) return
      if (!result.ok) {
        setRows(current => current.map(row => pending.some(item => item.id === row.id) ? { ...row, phase: 'error', message: result.message } : row))
        return
      }
      if (result.files.length !== pending.length) throw new Error('response count mismatch')
      const files = result.files.filter((_file, index) => !dismissed.current.has(pending[index]!.id))
      if (!inputActions.addFiles(files)) {
        setRows(current => current.map(row => pending.some(item => item.id === row.id)
          ? { ...row, phase: 'error', message: '当前正在发送消息，文件未加入草稿，请重试。' } : row))
        return
      }
      setRows(current => current.filter(row => !pending.some(item => item.id === row.id)))
    } catch (error) {
      if (!current()) return
      setRows(current => current.map(row => pending.some(item => item.id === row.id)
        ? { ...row, phase: 'error', message: safeThrownImportMessage(error) } : row))
    } finally {
      for (const item of pending) dismissed.current.delete(item.id)
    }
  }, [call, inputActions, isLoopback, sessionId])

  const stageImageFiles = useCallback(async (files: readonly File[]): Promise<string | null> => {
    const requestSession = sessionId
    const requestGeneration = generation.current
    const current = () => owner.current === requestSession && generation.current === requestGeneration
    if (files.length === 0) return null
    if (!isLoopback || requestSession === undefined) return '本地图片暂存仅支持当前电脑上的 e-Mate。'
    const live = imageLimits()
    const maxImages = Math.min(live?.maxImagesPerMessage ?? MAX_IMAGES, MAX_IMAGES)
    const maxImageBytes = Math.min(live?.maxImageBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)
    const maxTotalBytes = Math.min(live?.maxMessageImageBytes ?? MAX_IMAGE_TOTAL_BYTES, MAX_IMAGE_TOTAL_BYTES)
    const mediaTypes = live?.mediaTypes ?? [...IMAGE_MEDIA]
    if (files.some(file => !mediaTypes.includes(file.type))) return '仅支持 PNG、JPEG、WebP 和 GIF 图片。'
    const runtime = draftImages(inputCurrent.current.runtimeOnlyImageIds)
    if (inputCurrent.current.imageRefs.length + runtime.length + files.length > maxImages) return `最多可添加 ${maxImages} 张图片。`
    if (files.some(file => file.size > maxImageBytes)) return '图片超过单文件大小限制。'
    const existingBytes = inputCurrent.current.imageRefs.reduce((sum, item) => sum + item.attachment.bytes, 0)
      + runtime.reduce((sum, image) => sum + image.file.size, 0)
    if (existingBytes + files.reduce((sum, file) => sum + file.size, 0) > maxTotalBytes) return '图片总大小超过当前消息限制。'
    if (!inputActions.beginImageStage()) return '当前正在处理图片，图片未加入草稿，请稍后重试。'
    const controller = new AbortController()
    const stage = { controller, actions: inputActions }
    imageStage.current = stage
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(IMAGE_STAGE_TIMEOUT_MS)])
    let reservation = true
    const pending = files.map(file => ({ id: crypto.randomUUID(), displayName: file.name, mediaType: file.type, phase: 'importing' as const, dismissible: false }))
    setRows(currentRows => [...currentRows, ...pending])
    let descriptors: readonly DraftImageDescriptor[] = []
    try {
      const encoded = await Promise.all(files.map(async file => ({ name: file.name, media_type: file.type, bytes_base64: await base64Of(file) })))
      if (!current()) return null
      const result = parseImageStageResult(await call('stage-images', { session_id: requestSession, images: encoded }, signal))
      if (!current()) return null
      if (!result.ok) return result.message
      if (result.attachments.length !== files.length) throw new Error('image staging response count mismatch')
      descriptors = createDraftImages(files)
      if (descriptors.length !== files.length) throw new Error('draft image creation cardinality mismatch')
      if (!current()) return null
      const drafts = result.attachments.map((attachment, index) => ({ schema_version: 1 as const, draft_key: pending[index]!.id, attachment }))
      if (!inputActions.addDurableImages(drafts, descriptors.map(image => image.id))) return '当前正在发送消息，图片未加入草稿，请稍后重试。'
      reservation = false
      descriptors = []
      setRows(currentRows => currentRows.filter(row => !pending.some(item => item.id === row.id)))
      return null
    } catch (error) {
      return safeThrownImportMessage(error)
    } finally {
      if (descriptors.length > 0) releaseDraftImages(descriptors)
      if (imageStage.current === stage) {
        imageStage.current = null
        if (reservation) stage.actions.cancelImageStage()
      }
      if (current()) setRows(currentRows => currentRows.filter(row => !pending.some(item => item.id === row.id)))
    }
  }, [call, createDraftImages, draftImages, imageLimits, inputActions, isLoopback, releaseDraftImages, sessionId])

  const intake = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    if (intakeBusy.current) {
      setRows(current => [...current, ...errorRows(files, '附件正在导入，请稍后重试。')])
      return
    }
    intakeBusy.current = true
    const requestSession = sessionId
    const requestGeneration = generation.current
    const current = () => owner.current === requestSession && generation.current === requestGeneration
    setBusy(true)
    const images: File[] = []
    const ordinary: File[] = []
    for (const file of files) {
      const mediaType = imageType(file)
      if (mediaType === undefined) ordinary.push(file)
      else try { images.push(await normalizedImage(file, mediaType)) }
      catch {
        if (current()) setRows(current => [...current, ...errorRows([file], '图片读取失败，请重新选择。')])
      }
    }
    if (!current()) return
    try {
      if (images.length > 0) {
        const message = await stageImageFiles(images)
        if (message !== null && current()) setRows(currentRows => [...currentRows, ...errorRows(images, message)])
      }
      if (ordinary.length > 0) await importFiles(ordinary)
    } finally { if (current()) { intakeBusy.current = false; setBusy(false) } }
  }, [importFiles, sessionId, stageImageFiles])

  useEffect(() => {
    const onDrop = (event: DragEvent): void => {
      const items = Array.from(event.dataTransfer?.items ?? [])
      const directory = items.some(item => (item as DataTransferItem & { webkitGetAsEntry?(): { isDirectory: boolean } | null }).webkitGetAsEntry?.()?.isDirectory)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const target = event.target instanceof Element ? event.target : undefined
      const route = fileDropRoute({
        composerTarget: target !== undefined && target.closest(COMPOSER_DROP_TARGET) !== null,
        directory, normalizeImage: files.some(file => imageType(file) !== undefined && file.type === ''),
        ordinary: files.some(file => imageType(file) === undefined),
        workspaceTarget: target !== undefined && target.closest(WORKSPACE_DROP_TARGET) !== null,
      })
      if (route === 'pass') return
      event.preventDefault()
      event.stopImmediatePropagation()
      window.dispatchEvent(new Event('dragend'))
      const routed = route === 'intake-all' ? files : files.filter(file => imageType(file) !== undefined)
      if (routed.length > 0) void intake(routed)
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (!(event.target instanceof HTMLTextAreaElement) || event.clipboardData === null) return
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null)
      const fallback = files.length > 0 ? files : Array.from(event.clipboardData.files)
      if (!fallback.some(file => imageType(file) === undefined || file.type === '')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void intake(fallback)
    }
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('paste', onPaste, true)
    return () => { document.removeEventListener('drop', onDrop, true); document.removeEventListener('paste', onPaste, true) }
  }, [intake])

  useEffect(() => {
    const open = (event: Event): void => {
      if (event instanceof CustomEvent && event.detail?.sessionId === sessionId && !disabled) picker.current?.click()
    }
    document.addEventListener(FILE_PICK_EVENT, open)
    return () => { document.removeEventListener(FILE_PICK_EVENT, open) }
  }, [disabled, sessionId])

  const retryHydration = useCallback((draftKey: string): void => {
    transientHydration.current.delete(draftKey)
    hydrationReads.current.delete(draftKey)
    setRows(currentRows => currentRows.filter(row => row.hydrationDraftKey !== draftKey))
    setHydrationRetryEpoch(epoch => epoch + 1)
  }, [])
  const removeHydration = useCallback((draftKey: string): void => {
    transientHydration.current.delete(draftKey)
    hydrationReads.current.delete(draftKey)
    const released = inputActions.removeDurableImage(draftKey)
    if (released !== undefined) releaseDraftImages(draftImages([released]))
    setRows(currentRows => currentRows.filter(row => row.hydrationDraftKey !== draftKey))
  }, [draftImages, inputActions, releaseDraftImages])

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void intake(files)
  }
  return renderComposer({
    pending: busy || hydrating || hydrationPending,
    // rc.1's InputBar takes the composer's addFiles intake; returning null keeps
    // the import transaction in this plugin's staging rows.
    addFiles: files => { void intake(files); return null },
    // A composer body that renders this plugin's own controls draws the trigger here;
    // the rc.1 native tool row draws it from the conversation.input.left entry instead.
    controls: <>
      <button type="button" className={css.button} aria-label="添加本地图片或文件"
        title={isLoopback ? '添加本地图片或文件' : '本地文件导入仅支持当前电脑'} disabled={disabled}
        onClick={() => { picker.current?.click() }}><IconPaperclipOutline16 size={16} /></button>
      <input ref={picker} hidden type="file" multiple
        accept={`${[...IMAGE_MEDIA].join(',')},${Object.keys(ALLOWED_MEDIA_BY_EXTENSION).map(extension => `.${extension}`).join(',')}`} onChange={choose} />
    </>,
    picker: <input ref={picker} hidden type="file" multiple
      accept={`${[...IMAGE_MEDIA].join(',')},${Object.keys(ALLOWED_MEDIA_BY_EXTENSION).map(extension => `.${extension}`).join(',')}`} onChange={choose} />,
    accessory: input.fileRefs.length + rows.length === 0 ? null : <div className={css.rows} role="status" aria-live="polite" aria-label="附件">
      <FileCards files={input.fileRefs} remove={inputActions.removeFile} />
      {rows.map(row => <div key={row.id} className={css.row} data-phase={row.phase}>
        <div className={css.file}><FileCardContent name={row.displayName} mediaType={row.mediaType} /></div>
        <span className={css.phase} title={row.message}>{row.phase === 'importing' ? '导入中…' : row.message}</span>
        {row.hydrationDraftKey !== undefined ? <>
          <button type="button" className={css.phase} aria-label={`重试恢复 ${row.displayName}`}
            onClick={() => { retryHydration(row.hydrationDraftKey!) }}>重试恢复</button>
          <button type="button" className={css.dismiss} aria-label={`移除 ${row.displayName}`}
            onClick={() => { removeHydration(row.hydrationDraftKey!) }}><IconCloseOutline16 size={12} /></button>
        </> : row.dismissible !== false && <button type="button" className={css.dismiss} aria-label={`移除 ${row.displayName}`} onClick={() => {
          dismissed.current.add(row.id)
          setRows(current => current.filter(item => item.id !== row.id))
        }}><IconCloseOutline16 size={12} /></button>}
      </div>)}
    </div>,
  })
}

export function apply(ctx: Context): void {
  const source: InputTriggerSource = {
    trigger: '@', name: '文件', order: -30,
    candidates(_session, { query }) { return Promise.resolve('文件'.includes(query) ? [{ name: '文件', description: '选择本地图片或文件' }] : []) },
    onPick({ session, span }) {
      const scope = ctx.sessions.scope(session.sessionId)
      if (scope === undefined) return 'handled'
      if (!scope.bail(scope, 'slash/input-consume-token', { guard: { kind: 'span', span } })) {
        ctx.conversation.input.for(scope).notify('info', '输入已变化，请重新选择文件。')
        return 'handled'
      }
      document.dispatchEvent(new CustomEvent(FILE_PICK_EVENT, { detail: { sessionId: session.sessionId } }))
      return 'handled'
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'file-import: @文件 source')
  // rc.1 renders the composer's tool row from conversation.input.left and has no
  // leftItems prop, so the trigger is its own entry; it asks the owning control to
  // open its picker through the same request event the @文件 source dispatches.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'e-mate-file-import',
    order: 12,
    inject: (sessionId: string) => ({ sessionId, isLoopback: ctx.connection.isLoopback }),
  }, function FileAttachControl({ sessionId, isLoopback }: any) {
    // Busy/hydration admission stays with the owning control, whose listener refuses
    // the request unless the composer is idle; this trigger only mirrors the platform gate.
    return <button type="button" className={css.button} aria-label="添加本地图片或文件"
      title={isLoopback ? '添加本地图片或文件' : '本地文件导入仅支持当前电脑'}
      disabled={!isLoopback}
      onClick={() => { document.dispatchEvent(new CustomEvent(FILE_PICK_EVENT, { detail: { sessionId } })) }}>
      <IconPaperclipOutline16 size={16} />
    </button>
  }))
  ctx.slots.inject('e-mate.conversation.composer', () => {
    return ctx.slots.register({
      name: 'e-mate.conversation.composer',
      children: { 'e-mate.conversation.composer.after-upload': { kind: 'list', scope: 'session' } },
    }, function FileImportComposer({ nativeProps: props, InputBar, renderSlot }: any) {
      const input = props.useInput((state: any) => state) ?? EMPTY_INPUT
      const sessionId = props.sessionId as string | undefined
      const target = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)?.session
      const call = useCallback((endpoint: 'import' | 'stage-images', payload: Record<string, unknown>, signal?: AbortSignal) =>
        ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal), [])
      // rc.1 owns draft attachments per target session and names the three
      // resolvers createDrafts / resolveDraftAttachments / releaseDraftAttachments.
      const createImages = useCallback((files: readonly File[]) =>
        sessionId === undefined
          ? []
          : ctx.conversation.createDrafts(sessionId, files) as readonly DraftImageDescriptor[], [sessionId])
      const resolveDraftImages = useCallback((ids: readonly string[]) =>
        ctx.conversation.resolveDraftAttachments(ids) as readonly DraftImageDescriptor[], [])
      const releaseImages = useCallback((images: readonly DraftImageDescriptor[]) => {
        ctx.conversation.releaseDraftAttachments(images as never)
      }, [])
      const readImage = useCallback(async (ref: ImageAttachmentRef) => {
        if (target === undefined || sessionId === undefined || ctx.sessions.binding(sessionId)?.session !== target) throw new Error('stale session')
        const result = await target.readAttachment(ref.attachmentId as never)
        if (ctx.sessions.binding(sessionId)?.session !== target) throw new Error('stale session')
        return result
      }, [sessionId, target])
      const limits = useCallback(() => {
        if (target === undefined || sessionId === undefined || ctx.sessions.binding(sessionId)?.session !== target) return undefined
        return target.projections.faceOf('imageLimits').getSnapshot()
      }, [sessionId, target])
      const sendNotice = useCallback((level: 'info' | 'error', text: string) => {
        if (sessionId === undefined || ctx.sessions.binding(sessionId)?.session !== target) return
        const scope = ctx.sessions.scope(sessionId)
        if (scope !== undefined) ctx.conversation.input.for(scope).notify(level, text)
      }, [sessionId, target])
      return <FileImportControl sessionId={sessionId} input={input} inputActions={props.inputActions ?? ABSENT_ACTIONS}
        isLoopback={ctx.connection.isLoopback}
        call={call}
        createDraftImages={createImages}
        draftImages={resolveDraftImages}
        releaseDraftImages={releaseImages}
        readAttachment={readImage}
        imageLimits={limits}
        notify={sendNotice}
        renderComposer={({ accessory, picker, pending, addFiles }) => createElement(InputBar, {
          ...props,
          addFiles,
          blocked: props.blocked ?? (pending ? { reason: '附件正在导入，请稍候。' } : undefined),
          accessory: <>{picker}{props.accessory}{accessory}</>,
        })} />
    })
  })
  ctx.slots.inject('conversation.chat.node', () => {
    const disposers = (['user', 'steering'] as const).map(key => {
      const native = ctx.slots.entries('conversation.chat.node').find((entry: any) => entry.options?.key === key && (entry.options?.priority ?? 0) === 0)
      if (native?.component === undefined) throw new Error('native user message renderer is unavailable')
      return ctx.slots.register({ name: 'conversation.chat.node', key, priority: -1, inject: native.inject, locale: native.locale }, function FileMessage(props: any) {
        const projected = importedMessage(props.node.data.content, props.node.data.source)
        if (projected.files.length === 0) return createElement(native.component as any, props)
        return <div className={css.message}>
          <div className={css.rows}><FileCards files={projected.files} open={props.openFile} /></div>
          {createElement(native.component as any, { ...props, node: { ...props.node, data: { ...props.node.data, content: projected.content } } })}
        </div>
      })
    })
    return () => { for (const dispose of disposers) dispose() }
  })
}
