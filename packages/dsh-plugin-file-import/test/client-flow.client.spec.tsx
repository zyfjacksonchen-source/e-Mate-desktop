// @vitest-environment jsdom
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '../../../upstream/deepseek-harness/packages/test-support/client-runtime/src/index.ts'
import { InputBar } from '../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'
import { SessionInputShell } from '../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/input/facade.ts'
import { registerChatNodeRenderers } from '../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/chat/register-node-renderers.ts'
import { adaptHarnessConversationSource } from '../../../scripts/harness-conversation-adapter.mjs'
import { stripTypeScriptTypes } from 'node:module'
import { ComposerExpertMode } from '../../dsh/profile/plugins/emate-shell/src/client/composer-connectors.tsx'
import { apply, inject, FILE_PICK_EVENT, FileCards, FileImportControl } from '../src/client/index.tsx'
import { importedDraft, importedMessage, type FileReference } from '../src/client/references.ts'

const imported = {
  bytes: 4, display_name: '报告 带空格@验证.txt', media_type: 'text/plain',
  relative_path: '.e-mate/imports/报告_带空格_验证.txt', stored_name: '报告_带空格_验证.txt',
}
const success = { ok: true, value: { schema_version: 1, files: [imported] } }
const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'picture.png' }
const HYDRATED_NOTE = Uint8Array.from([110, 111, 116, 101])
const staged = { ok: true, value: { schema_version: 1, attachments: [attachment] } }
const stagedDuplicates = { ok: true, value: { schema_version: 1, attachments: [attachment, attachment] } }
const EMPTY_DURABLE_IMAGES: readonly any[] = []
const DEFAULT_IMAGE_LIMITS = { maxImageBytes: 5 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 100 * 1024 * 1024, maxImagePixels: 40_000_000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
function file(name = imported.display_name, type = 'text/plain'): File {
  const value = new File(['note'], name, { type })
  const arrayBuffer = async () => new TextEncoder().encode('note').buffer
  Object.defineProperty(value, 'arrayBuffer', { value: arrayBuffer })
  Object.defineProperty(value, 'slice', { value: () => ({ arrayBuffer }) })
  return value
}
function picker(): HTMLInputElement { return document.querySelector('input[type=file]') as HTMLInputElement }

// React store fixture for the plugin's native InputState face. The actual
// transformed native facade/store/hub are exercised by the adapter self-check.
function Composer({
  sessionId = 'one', draft = '', files = [], initialImages = EMPTY_DURABLE_IMAGES, images = EMPTY_DURABLE_IMAGES, callImport = vi.fn().mockResolvedValue(success),
  callRpc, createDraftImages = (selected: readonly File[]) => selected.map((value, index) => ({ id: `native-${index}`, file: value })),
  readAttachment = vi.fn(), acceptImages = true, onDurableImages, onHydrate, onRemoveImage, onRelease, onBeginStage, onCancelStage, refuseHydration = false,
  limits = DEFAULT_IMAGE_LIMITS,
}: {
  sessionId?: string; draft?: string; files?: readonly FileReference[]; initialImages?: readonly any[]; images?: readonly any[]; callImport?: any; callRpc?: any
  createDraftImages?: any; readAttachment?: any; acceptImages?: boolean; onDurableImages?: any; onHydrate?: any
  onRemoveImage?: any; onRelease?: any; onBeginStage?: any; onCancelStage?: any; refuseHydration?: boolean; limits?: any
}) {
  const [input, setInput] = useState({ draft, fileRefs: files, phase: 'plain', imageIds: [] as string[], imageRefs: [...initialImages] as any[], hydratedImageKeys: [] as string[], runtimeOnlyImageIds: [] as string[], imageStagePending: false })
  useEffect(() => {
    if (images.length === 0) return
    setInput(current => ({ ...current, imageIds: [], imageRefs: [...images], hydratedImageKeys: [] }))
  }, [images])
  const actions = useMemo(() => ({
    addFiles(added: readonly FileReference[], text?: string) {
      setInput(current => ({ ...current, draft: text ?? current.draft, fileRefs: [...current.fileRefs, ...added] }))
      return true
    },
    removeFile(path: string) { setInput(current => ({ ...current, fileRefs: current.fileRefs.filter(file => file.relative_path !== path) })) },
    beginImageStage() { onBeginStage?.(); setInput(current => ({ ...current, imageStagePending: true })); return true },
    cancelImageStage() { onCancelStage?.(); setInput(current => ({ ...current, imageStagePending: false })) },
    addDurableImages(added: readonly any[], ids: readonly string[]) {
      if (!acceptImages) return false
      onDurableImages?.(added, ids)
      setInput(current => ({ ...current, imageStagePending: false, imageRefs: [...current.imageRefs, ...added], imageIds: [...current.imageIds, ...ids], hydratedImageKeys: [...current.hydratedImageKeys, ...added.map(item => item.draft_key)] }))
      return true
    },
    hydrateDurableImage(key: string, id: string) {
      if (refuseHydration) return false
      onHydrate?.(key, id)
      setInput(current => ({ ...current, imageIds: [...current.imageIds, id], hydratedImageKeys: [...current.hydratedImageKeys, key] }))
      return true
    },
    removeDurableImage(key: string) { onRemoveImage?.(key); setInput(current => ({ ...current, imageRefs: current.imageRefs.filter(item => item.draft_key !== key) })); return undefined },
  }), [acceptImages, onBeginStage, onCancelStage, onDurableImages, onHydrate, onRemoveImage, refuseHydration])
  const releaseDraftImages = useMemo(() => (released: readonly any[]) => { onRelease?.(released) }, [onRelease])
  const resolveDraftImages = useCallback(() => [], [])
  const sendNotice = useCallback(() => {}, [])
  const getImageLimits = useCallback(() => limits, [limits])
  return <FileImportControl sessionId={sessionId} input={input} inputActions={actions} isLoopback
    call={callRpc ?? ((endpoint: string, payload: unknown, _signal?: AbortSignal) => endpoint === 'import' ? callImport(payload) : Promise.resolve(staged))}
    createDraftImages={createDraftImages} draftImages={resolveDraftImages} releaseDraftImages={releaseDraftImages}
    readAttachment={readAttachment} imageLimits={getImageLimits}
    notify={sendNotice}
    renderComposer={({ accessory, controls, pending }) => <div data-composer-card>{accessory}<textarea readOnly value={input.draft} /><button disabled={pending}>发送</button>{controls}</div>} />
}
afterEach(cleanup)

describe('file import composer lifecycle', () => {
  it('treats picker cancellation as a no-op', () => {
    const callImport = vi.fn()
    render(<Composer callImport={callImport} />)
    fireEvent.change(picker(), { target: { files: [] } })
    expect(callImport).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows standard file icons and separate extensions with complete names and independent actions', () => {
    const types = [
      ['季度经营报告 带空格@最终版本与补充说明.md', 'text/markdown', 'MD', 'FileText'],
      ['预算.XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'XLSX', 'FileSpreadsheet'],
      ['方案.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PPTX', 'FileChartColumn'],
      ['数据.json', 'application/json', 'JSON', 'FileJson2'],
      ['配置.yaml', 'application/yaml', 'YAML', 'FileCode2'],
      ['归档.zip', 'application/zip', 'ZIP', 'FileArchive'],
      ['说明.pdf', 'application/pdf', 'PDF', 'FileText'],
    ] as const
    const files = types.map(([display_name, media_type, extension], index) => ({
      ...imported, display_name, media_type, stored_name: `file-${index}.${extension.toLowerCase()}`,
      relative_path: `.e-mate/imports/file-${index}.${extension.toLowerCase()}`,
    }))
    const open = vi.fn()
    const remove = vi.fn()
    render(<FileCards files={files} open={open} remove={remove} />)

    for (const [name, , extension, icon] of types) {
      const card = screen.getByRole('button', { name: `打开 ${name}` })
      expect(card.getAttribute('title')).toBe(name)
      expect(within(card).getByText(name).getAttribute('title')).toBe(name)
      expect(within(card).getByText(extension)).not.toBe(within(card).getByText(name))
      expect(card.querySelector('svg')?.getAttribute('data-file-icon')).toBe(icon)
      expect(card.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    }
    expect(screen.queryByText('表格')).toBeNull()
    expect(screen.queryByText('演示')).toBeNull()
    expect(screen.queryByText('压缩')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `移除 ${files[0]!.display_name}` }))
    expect(remove).toHaveBeenCalledWith(files[0]!.relative_path)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `打开 ${files[1]!.display_name}` }))
    expect(open).toHaveBeenCalledWith(files[1]!.relative_path)
  })

  it('retains a failed import and puts the successful retry inside the composer above plain text', async () => {
    const callImport = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: '文件暂时无法导入当前工作区。', details: {} } })
      .mockResolvedValueOnce(success)
    render(<Composer draft="请读" callImport={callImport} />)
    fireEvent.change(picker(), { target: { files: [file()] } })
    const failure = await screen.findByText('文件暂时无法导入当前工作区。')
    const failedCard = failure.closest('[data-phase="error"]')!
    expect(within(failedCard as HTMLElement).getByText('TXT')).toBeTruthy()
    expect(failedCard.querySelector('svg')?.getAttribute('data-file-icon')).toBe('FileText')
    fireEvent.click(screen.getByRole('button', { name: `移除 ${imported.display_name}` }))
    fireEvent.change(picker(), { target: { files: [file()] } })
    await waitFor(() => expect(document.querySelector('[data-emate-resource-path]')).not.toBeNull())
    const remove = screen.getByRole('button', { name: `移除 ${imported.display_name}` })
    const card = remove.closest('[data-emate-resource-path]')!
    expect(card.getAttribute('data-emate-resource-path')).toBe(imported.relative_path)
    expect(card.closest('[data-composer-card]')).not.toBeNull()
    expect(card.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请读')
    expect(screen.queryByText(`@${imported.relative_path}`)).toBeNull()
    expect(callImport).toHaveBeenCalledTimes(2)
    fireEvent.click(remove)
    expect(screen.queryByRole('status')).toBeNull()
    expect(callImport).toHaveBeenCalledTimes(2)
  })

  it('stages a mixed picker batch before native image association without synthetic drops', async () => {
    const callImport = vi.fn().mockResolvedValue(success)
    const createDraftImages = vi.fn((selected: readonly File[]) => selected.map(value => ({ id: 'fresh-native', file: value })))
    const drop = vi.fn()
    document.addEventListener('drop', drop)
    try {
      render(<React.StrictMode><Composer callImport={callImport} createDraftImages={createDraftImages} /></React.StrictMode>)
      fireEvent.change(picker(), { target: { files: [file('picture.png', 'image/png'), file()] } })
      await screen.findByRole('button', { name: `移除 ${imported.display_name}` })
      expect(createDraftImages).toHaveBeenCalledOnce()
      expect(createDraftImages.mock.calls[0]![0][0].name).toBe('picture.png')
      expect(drop).not.toHaveBeenCalled()
      expect(callImport.mock.calls[0]![0].files).toHaveLength(1)
    } finally { document.removeEventListener('drop', drop) }
  })

  it('preserves duplicate CAS refs with distinct durable draft keys and exact cardinality', async () => {
    const callRpc = vi.fn(async (endpoint: string, _payload: unknown) => endpoint === 'stage-images' ? stagedDuplicates : success)
    const onDurableImages = vi.fn()
    const duplicate = file('same.png', 'image/png')
    render(<Composer callRpc={callRpc} onDurableImages={onDurableImages} />)
    fireEvent.change(picker(), { target: { files: [duplicate, duplicate] } })
    await waitFor(() => expect(onDurableImages).toHaveBeenCalledOnce())
    expect(callRpc).toHaveBeenCalledOnce()
    expect(callRpc.mock.calls[0]![0]).toBe('stage-images')
    expect(callRpc.mock.calls[0]![1].images).toHaveLength(2)
    const [drafts, ids] = onDurableImages.mock.calls[0]!
    expect(drafts).toHaveLength(2)
    expect(drafts[0].attachment).toEqual(attachment)
    expect(drafts[1].attachment).toEqual(attachment)
    expect(drafts[0].draft_key).not.toBe(drafts[1].draft_key)
    expect(ids).toEqual(['native-0', 'native-1'])
  })

  it('stages untyped image drop and paste exactly once through the shared path', async () => {
    const callRpc = vi.fn(async (endpoint: string) => endpoint === 'stage-images' ? staged : success)
    render(<Composer callRpc={callRpc} />)
    const dropped = file('drop.png', '')
    fireEvent.drop(document.querySelector('[data-composer-card]')!, {
      dataTransfer: { files: [dropped], items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }] },
    })
    await waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1))
    expect(callRpc.mock.calls[0]![0]).toBe('stage-images')
    const pasted = file('paste.png', '')
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [{ kind: 'file', getAsFile: () => pasted }], files: [pasted], getData: () => '' },
    })
    await waitFor(() => expect(callRpc).toHaveBeenCalledTimes(2))
    expect(callRpc.mock.calls.map(call => call[0])).toEqual(['stage-images', 'stage-images'])
  })

  it('releases no runtime descriptor when session disposal wins before staging settles', async () => {
    let finish!: (value: unknown) => void
    const callRpc = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const createDraftImages = vi.fn()
    const view = render(<Composer callRpc={callRpc} createDraftImages={createDraftImages} />)
    fireEvent.change(picker(), { target: { files: [file('picture.png', 'image/png')] } })
    await waitFor(() => expect(callRpc).toHaveBeenCalledOnce())
    view.unmount()
    finish(staged)
    await Promise.resolve()
    expect(createDraftImages).not.toHaveBeenCalled()
  })

  it('reports selected image refusal instead of silently losing it', async () => {
    render(<Composer acceptImages={false} />)
    fireEvent.change(picker(), { target: { files: [file('picture.png', 'image/png')] } })
    await screen.findByText('当前正在发送消息，图片未加入草稿，请稍后重试。')
    expect(screen.getByText('picture.png')).toBeTruthy()
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false)
  })

  it('migrates legacy imported paths into removable cards without changing native workspace mentions', async () => {
    render(<Composer draft={`请读 @src/main.ts @${imported.relative_path} `} />)
    const remove = await screen.findByRole('button', { name: `移除 ${imported.stored_name}` })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请读 @src/main.ts')
    fireEvent.click(remove)
    expect(screen.queryByRole('status')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('请读 @src/main.ts')
  })

  it('does not revive an importing card removed before its result arrives', async () => {
    let resolve!: (value: unknown) => void
    const callImport = vi.fn(() => new Promise(value => { resolve = value }))
    render(<Composer callImport={callImport} />)
    fireEvent.change(picker(), { target: { files: [file()] } })
    await waitFor(() => expect(callImport).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: `移除 ${imported.display_name}` }))
    resolve(success)
    await waitFor(() => expect(screen.getByRole('button', { name: '添加本地图片或文件' }).hasAttribute('disabled')).toBe(false))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('commits selected image rows until staging associates every original index', async () => {
    const refs = ['a', 'b', 'c'].map((digit, index) => ({ ...attachment, attachmentId: `sha256:${digit.repeat(64)}`, name: `image-${index}.png` }))
    let finish!: (value: unknown) => void
    const callRpc = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const created = vi.fn((selected: readonly File[]) => selected.map(file => ({ id: `native-${file.name}`, file })))
    const added = vi.fn()
    render(<Composer callRpc={callRpc} createDraftImages={created} onDurableImages={added} />)
    fireEvent.change(picker(), { target: { files: refs.map(ref => file(ref.name, 'image/png')) } })
    await waitFor(() => expect(callRpc).toHaveBeenCalledOnce())
    for (const ref of refs) expect(screen.queryByRole('button', { name: `移除 ${ref.name}` })).toBeNull()
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true)
    finish({ ok: true, value: { schema_version: 1, attachments: refs } })
    await waitFor(() => expect(added).toHaveBeenCalledOnce())
    expect(created.mock.calls[0]![0].map((value: File) => value.name)).toEqual(refs.map(ref => ref.name))
    const [drafts, ids] = added.mock.calls[0]!
    expect(drafts.map((draft: any) => draft.attachment)).toEqual(refs)
    expect(ids).toEqual(refs.map(ref => `native-${ref.name}`))
  })

  it('aborts the initiating image stage on session switch and ignores its late result', async () => {
    let finish!: (value: unknown) => void
    let signal!: AbortSignal
    const callRpc = vi.fn((_endpoint: string, _payload: unknown, active?: AbortSignal) => {
      signal = active!
      return new Promise(resolve => { finish = resolve })
    })
    const cancelled = vi.fn()
    const added = vi.fn()
    const created = vi.fn()
    const released = vi.fn()
    const view = render(<Composer callRpc={callRpc} onCancelStage={cancelled} onDurableImages={added} createDraftImages={created} onRelease={released} />)
    fireEvent.change(picker(), { target: { files: [file('switch.png', 'image/png')] } })
    await waitFor(() => expect(callRpc).toHaveBeenCalledOnce())
    expect(signal.aborted).toBe(false)
    view.rerender(<Composer sessionId="two" callRpc={callRpc} onCancelStage={cancelled} onDurableImages={added} createDraftImages={created} onRelease={released} />)
    expect(signal.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledOnce()
    finish(staged)
    await Promise.resolve()
    expect(added).not.toHaveBeenCalled()
    expect(created).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('uses the native 120s timeout signal and clears the stage reservation on abort', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const cancelled = vi.fn()
    let signal!: AbortSignal
    const callRpc = vi.fn((_endpoint: string, _payload: unknown, active?: AbortSignal) => {
      signal = active!
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }))
    })
    try {
      render(<Composer callRpc={callRpc} onCancelStage={cancelled} />)
      fireEvent.change(picker(), { target: { files: [file('timeout.png', 'image/png')] } })
      await waitFor(() => expect(callRpc).toHaveBeenCalledOnce())
      expect(timeoutSpy).toHaveBeenCalledWith(120_000)
      timeout.abort(new DOMException('timeout', 'TimeoutError'))
      await screen.findByText('文件暂时无法导入当前工作区。')
      expect(cancelled).toHaveBeenCalledOnce()
      expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false)
    } finally { timeoutSpy.mockRestore() }
  })

  it('drops an old in-flight result after switching sessions', async () => {
    let resolve!: (value: unknown) => void
    const callImport = vi.fn(() => new Promise(value => { resolve = value }))
    const view = render(<Composer callImport={callImport} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(picker(), { target: { files: [file()] } })
    await waitFor(() => expect(callImport).toHaveBeenCalledOnce())
    view.rerender(<Composer sessionId="two" callImport={callImport} />)
    expect(screen.getByRole('textbox')).toBe(textarea)
    resolve(success)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps same-name paths distinct and projects submitted names without changing transport content', () => {
    const another = { ...imported, relative_path: '.e-mate/imports/报告_带空格_验证-2.txt', stored_name: '报告_带空格_验证-2.txt' }
    const text = `请读\n@${imported.relative_path}\n@${another.relative_path}`
    const content = [{ type: 'text', text }, { type: 'image', attachment: { attachmentId: 'native-cas' } }]
    const projected = importedMessage(content, { mentions: [imported, another].map(file => ({ source: 'e-mate/file-import', ref: JSON.stringify(file) })) })
    expect(content[0].text).toBe(text)
    expect(projected.content[0].text).toBe('请读')
    expect(projected.content[1]).toBe(content[1])
    const open = vi.fn()
    render(<FileCards files={projected.files} open={open} />)
    expect(screen.getAllByText(imported.display_name)).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: `打开 ${imported.display_name}` })[1]!)
    expect(open).toHaveBeenCalledWith(another.relative_path)
    expect(importedDraft('@src/main.ts @.e-mate/imports/../secret.txt').files).toEqual([])
  })

  it('hydrates a persisted image with a fresh native id through readAttachment', async () => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    const created = vi.fn((selected: readonly File[]) => [{ id: 'fresh-after-restart', file: selected[0] }])
    const readAttachment = vi.fn().mockResolvedValue({ ok: true, value: { attachment, data: HYDRATED_NOTE } })
    render(<Composer draft="正文" files={Array.from({ length: 5 }, (_, index) => ({ ...imported, stored_name: `file-${index}.txt`, relative_path: `.e-mate/imports/file-${index}.txt` }))}
      images={[draft]} createDraftImages={created} readAttachment={readAttachment} />)
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(created).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: '添加本地图片或文件' }).hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false)
    expect(readAttachment).toHaveBeenCalledWith(attachment)
    expect(created.mock.calls[0]![0][0].name).toBe('picture.png')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('正文')
    expect(screen.getAllByRole('button', { name: /移除/u })).toHaveLength(5)
  })

  it('rehydrates an existing shell snapshot after transient navigation remount', async () => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    const firstRead = vi.fn().mockResolvedValue({ ok: false, error: { code: 'internal', message: 'hidden', details: {} } })
    const first = render(<Composer initialImages={[draft]} readAttachment={firstRead} />)
    await screen.findByRole('button', { name: '重试恢复 picture.png' })
    expect(firstRead).toHaveBeenCalledOnce()
    first.unmount()

    const readAttachment = vi.fn().mockResolvedValue({ ok: true, value: { attachment, data: HYDRATED_NOTE } })
    const created = vi.fn((selected: readonly File[]) => [{ id: 'remount-fresh-id', file: selected[0] }])
    const hydrated = vi.fn()
    render(<Composer initialImages={[draft]} readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} />)
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(draft.draft_key, 'remount-fresh-id'))
    expect(readAttachment).toHaveBeenCalledOnce()
    expect(created).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '重试恢复 picture.png' })).toBeNull()
  })

  it('does not settle stale hydration after switching session shells', async () => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    let finish!: (value: unknown) => void
    const readAttachment = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const created = vi.fn()
    const hydrated = vi.fn()
    const released = vi.fn()
    const view = render(<Composer key="one" initialImages={[draft]} readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} onRelease={released} />)
    await waitFor(() => expect(readAttachment).toHaveBeenCalledOnce())
    view.rerender(<Composer key="two" sessionId="two" readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} onRelease={released} />)
    finish({ ok: true, value: { attachment, data: HYDRATED_NOTE } })
    await Promise.resolve()
    await Promise.resolve()
    expect(created).not.toHaveBeenCalled()
    expect(hydrated).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
  })

  it('keeps controls blocked until the final concurrent hydration completes', async () => {
    const secondAttachment = { ...attachment, attachmentId: `sha256:${'b'.repeat(64)}`, name: 'second.png' }
    const drafts = [
      { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment },
      { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000002', attachment: secondAttachment },
    ]
    const reads = new Map<string, (value: unknown) => void>()
    const readAttachment = vi.fn((ref: any) => new Promise(resolve => { reads.set(ref.attachmentId, resolve) }))
    const hydrated = vi.fn()
    const created = vi.fn((selected: readonly File[]) => [{ id: `native-${selected[0]!.name}`, file: selected[0] }])
    render(<Composer images={drafts} readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} />)
    await waitFor(() => expect(readAttachment).toHaveBeenCalledTimes(2))
    reads.get(secondAttachment.attachmentId)!({ ok: true, value: { attachment: secondAttachment, data: HYDRATED_NOTE } })
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(drafts[1]!.draft_key, 'native-second.png'))
    expect(screen.getByRole('button', { name: '添加本地图片或文件' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true)
    reads.get(attachment.attachmentId)!({ ok: true, value: { attachment, data: HYDRATED_NOTE } })
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(drafts[0]!.draft_key, 'native-picture.png'))
    await waitFor(() => expect(screen.getByRole('button', { name: '添加本地图片或文件' }).hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false)
  })

  it('hydrates multiple refs once each across StrictMode rerenders', async () => {
    const secondAttachment = { ...attachment, attachmentId: `sha256:${'b'.repeat(64)}`, name: 'second.png' }
    const drafts = [
      { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment },
      { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000002', attachment: secondAttachment },
    ]
    const readAttachment = vi.fn(async (ref: any) => ({ ok: true, value: { attachment: ref, data: HYDRATED_NOTE } }))
    const created = vi.fn((selected: readonly File[]) => [{ id: `native-${selected[0]!.name}`, file: selected[0] }])
    const hydrated = vi.fn()
    const callRpc = vi.fn()
    render(<React.StrictMode><Composer callRpc={callRpc} images={drafts} readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} /></React.StrictMode>)
    await waitFor(() => expect(hydrated).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(readAttachment).toHaveBeenCalledTimes(2)
    expect(created).toHaveBeenCalledTimes(2)
    expect(callRpc).not.toHaveBeenCalled()
    expect(readAttachment.mock.calls.map(call => call[0].attachmentId).sort()).toEqual([attachment.attachmentId, secondAttachment.attachmentId].sort())
  })

  it('retains association refusal for explicit removal and releases its descriptor', async () => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    const readAttachment = vi.fn().mockResolvedValue({ ok: true, value: { attachment, data: HYDRATED_NOTE } })
    const created = vi.fn((selected: readonly File[]) => [{ id: 'refused-id', file: selected[0] }])
    const removed = vi.fn()
    const released = vi.fn()
    render(<Composer images={[draft]} readAttachment={readAttachment} createDraftImages={created}
      refuseHydration onRemoveImage={removed} onRelease={released} />)
    const remove = await screen.findByRole('button', { name: '移除 picture.png' })
    expect(screen.getByRole('button', { name: '重试恢复 picture.png' })).toBeTruthy()
    expect(removed).not.toHaveBeenCalled()
    expect(released).toHaveBeenCalledOnce()
    expect(released.mock.calls[0]![0][0].id).toBe('refused-id')
    fireEvent.click(remove)
    expect(removed).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '重试恢复 picture.png' })).toBeNull()
  })

  it('removes a terminal attachment reason without offering retry', async () => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    const readAttachment = vi.fn().mockResolvedValue({
      ok: false, error: { code: 'attachment-error', message: 'hidden', details: { reason: 'ATTACHMENT_NOT_FOUND' } },
    })
    const removed = vi.fn()
    render(<Composer images={[draft]} readAttachment={readAttachment} onRemoveImage={removed} />)
    await waitFor(() => expect(removed).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: '重试恢复 picture.png' })).toBeNull()
  })

  it.each([
    ['transport throw', new Error('offline')],
    ['internal response', { ok: false, error: { code: 'internal', message: 'hidden', details: {} } }],
  ])('retains %s until explicit retry succeeds', async (_label, first) => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    const readAttachment = vi.fn()
      .mockImplementationOnce(() => first instanceof Error ? Promise.reject(first) : Promise.resolve(first))
      .mockResolvedValueOnce({ ok: true, value: { attachment, data: HYDRATED_NOTE } })
    const hydrated = vi.fn()
    const removed = vi.fn()
    const created = vi.fn((selected: readonly File[]) => [{ id: 'retry-id', file: selected[0] }])
    render(<Composer images={[draft]} readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} onRemoveImage={removed} />)
    const retry = await screen.findByRole('button', { name: '重试恢复 picture.png' })
    expect(screen.getByRole('button', { name: '添加本地图片或文件' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true)
    expect(removed).not.toHaveBeenCalled()
    expect(readAttachment).toHaveBeenCalledOnce()
    fireEvent.click(retry)
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(draft.draft_key, 'retry-id'))
    expect(readAttachment).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: '重试恢复 picture.png' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: '添加本地图片或文件' }).hasAttribute('disabled')).toBe(false))
  })

  it('removes a newly inadmissible persisted ref before reading it', async () => {
    const draft = { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment }
    const readAttachment = vi.fn()
    const removed = vi.fn()
    render(<Composer images={[draft]} readAttachment={readAttachment} onRemoveImage={removed}
      limits={{ maxImageBytes: 3, maxImagesPerMessage: 20, maxMessageImageBytes: 100, maxImagePixels: 40_000_000, mediaTypes: ['image/png'] }} />)
    await waitFor(() => expect(removed).toHaveBeenCalledOnce())
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it('hydrates later valid refs when an earlier concurrent read fails', async () => {
    const secondAttachment = { ...attachment, attachmentId: `sha256:${'b'.repeat(64)}`, name: 'second.png' }
    const drafts = [
      { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000001', attachment },
      { schema_version: 1, draft_key: '00000000-0000-4000-8000-000000000002', attachment: secondAttachment },
    ]
    const reads = new Map<string, (value: unknown) => void>()
    const readAttachment = vi.fn((ref: any) => new Promise(resolve => { reads.set(ref.attachmentId, resolve) }))
    const hydrated = vi.fn()
    const removed = vi.fn()
    const created = vi.fn((selected: readonly File[]) => [{ id: `native-${selected[0]!.name}`, file: selected[0] }])
    render(<Composer images={drafts} readAttachment={readAttachment} createDraftImages={created} onHydrate={hydrated} onRemoveImage={removed} />)
    await waitFor(() => expect(readAttachment).toHaveBeenCalledTimes(2))
    reads.get(secondAttachment.attachmentId)!({ ok: true, value: { attachment: secondAttachment, data: HYDRATED_NOTE } })
    await waitFor(() => expect(hydrated).toHaveBeenCalledWith(drafts[1]!.draft_key, 'native-second.png'))
    reads.get(attachment.attachmentId)!({ ok: true, value: { attachment, data: Uint8Array.of(1) } })
    await waitFor(() => expect(removed).toHaveBeenCalledWith(drafts[0]!.draft_key))
    expect(hydrated).not.toHaveBeenCalledWith(drafts[0]!.draft_key, expect.anything())
  })

  it('registers against the real native slots and preserves child ownership and the native InputBar lifecycle', async () => {
    const runtime = await SlotTestRuntime.create()
    let trigger: any
    let lastNativeProps: any
    let live: any
    let finishImport!: (value: unknown) => void
    let finishStage!: (value: unknown) => void
    const callImport = vi.fn((_channel: string, endpoint: string) => new Promise(resolve => {
      if (endpoint === 'get') { resolve({ ok: true, value: { active: false } }); return }
      if (endpoint === 'stage-images') finishStage = resolve
      else finishImport = resolve
    }))
    const nativeAddImages = vi.fn()
    const beginImageStage = vi.fn(() => true)
    const cancelImageStage = vi.fn()
    const addDurableImages = vi.fn(() => true)
    const createDraftImages = vi.fn((selected: readonly File[]) => selected.map(value => ({ id: 'typed-native-id', file: value })))
    const releaseDraftImages = vi.fn()
    const Native = (props: any) => {
      lastNativeProps = props
      return <InputBar {...props} />
    }
    const picked = vi.fn()
    try {
      const shell = new SessionInputShell({ actx: {} as never, defaultSink: vi.fn() })
      const adaptedSnapshot = () => ({
        ...shell.snapshot, fileRefs: [], imageRefs: [], hydratedImageKeys: [],
        runtimeOnlyImageIds: shell.snapshot.imageIds, imageStagePending: false,
      })
      const shellAddImages = vi.spyOn(shell, 'addImages')
      const absentMenu = { getSnapshot: () => null, subscribe: () => () => {} }
      const locale = { revision: 0 }
      runtime.slots.installLocale({ getSnapshot: () => locale, subscribe: () => () => {}, bind: () => (key: string) => key } as never)
      runtime.provide('inputTriggers', { registerSource(source: any) { trigger = source; return () => {} } } as never)
      runtime.provide('connection', { isLoopback: true, rpc: { call: callImport } } as never)
      runtime.provide('conversation', {
        input: { for: () => ({ notify: vi.fn() }) }, draftImages: () => [], createDraftImages, releaseDraftImages,
      } as never)
      await runtime.sessions.add({ id: 'one' }, { current: false })
      await runtime.sessions.add({ id: 'two' }, { current: false })
      await runtime.declare({
        'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      } as never)
      // Execute the exact adapted native registration, including its children
      // and inject. SlotTestRuntime uses production SlotRegistry + web-react.
      const source = adaptHarnessConversationSource(readFileSync(resolve(process.cwd(), 'packages/client/ui-conversation/lib/client.js'), 'utf8'))
      const start = source.indexOf('\t\t\tslots.register({\n\t\t\t\tname: "conversation.composer.bar",')
      const end = source.indexOf('\t\t\tslots.register({\n\t\t\t\tname: "conversation.composer",', start)
      expect(start).toBeGreaterThan(0)
      expect(end).toBeGreaterThan(start)
      await runtime.mount({ inject: ['slots'], apply(ctx: any) {
        new Function('env', `const { slots, InputBar, react_jsx_runtime, NS, inputHub, concreteConversation, ctx, submissionPolicy, ABSENT_NOTICES, ABSENT_LEXICON, ABSENT_MENU_LAUNCHER } = env;\n${source.slice(start, end)}`)({
          slots: ctx.slots, InputBar: Native, react_jsx_runtime: jsxRuntime, NS: 'conversation', ctx,
          inputHub: { shell: () => shell, inputTriggers: () => undefined }, concreteConversation: () => ctx.conversation,
          submissionPolicy: { resolve: () => 'queue' }, ABSENT_NOTICES: shell.notices,
          ABSENT_LEXICON: shell.lexicon, ABSENT_MENU_LAUNCHER: absentMenu,
        })
        registerChatNodeRenderers(ctx)
        const shellSource = readFileSync(resolve(process.cwd(), '../../packages/dsh/profile/plugins/emate-shell/src/client/index.ts'), 'utf8')
        const expertStart = shellSource.indexOf("  ctx.slots.inject('e-mate.conversation.composer.after-upload'")
        const expertEnd = shellSource.indexOf("  ctx.slots.inject('conversation.input.right'", expertStart)
        expect(expertStart).toBeGreaterThan(0)
        expect(expertEnd).toBeGreaterThan(expertStart)
        // Execute the actual product registration against the native registry.
        new Function('ctx', 'ComposerExpertMode', stripTypeScriptTypes(shellSource.slice(expertStart, expertEnd)))(ctx, ComposerExpertMode)
        ctx.slots.register({ name: 'conversation.input.plan' }, () => <button>原生计划</button>)
        ctx.slots.register({ name: 'conversation.input.model' }, () => <button>原生模型</button>)
      } })
      const actions = { ...shell.actions, addImages: nativeAddImages, beginImageStage, cancelImageStage, addDurableImages, hydrateDurableImage: vi.fn(), removeDurableImage: vi.fn(), addFiles: vi.fn(() => true), removeFile: vi.fn() }
      runtime.renderSlot('conversation.composer.bar' as never, {
        useInput: (select: any) => select(live), inputActions: actions, leftItems: <button type="button" aria-label="引用">原生工具</button>,
      } as never)
      const nativeTextarea = screen.getByRole('textbox') // Fallback before the product plugin loads.
      expect(screen.queryByRole('button', { name: '添加本地图片或文件' })).toBeNull()
      live = adaptedSnapshot()
      await runtime.sessions.setCurrent('one')
      expect(screen.getByRole('textbox')).toBe(nativeTextarea)
      await runtime.sessions.setCurrent('two')
      expect(screen.getByRole('textbox')).not.toBe(nativeTextarea)
      live = undefined
      await runtime.sessions.setCurrent(undefined)
      const feature = await runtime.mount({ inject, apply })
      const textarea = screen.getByRole('textbox')
      expect(lastNativeProps.accessory).toBeUndefined()
      expect(screen.queryByRole('switch', { name: '专家模式' })).toBeNull()
      expect(runtime.slots.entries('conversation.composer.bar' as never)).toHaveLength(1)
      expect(runtime.slots.entries('e-mate.conversation.composer' as never)).toHaveLength(1)
      for (const key of ['user', 'steering']) {
        const entries = runtime.slots.entries('conversation.chat.node' as never).filter(entry => entry.options.key === key)
        expect(entries).toHaveLength(2)
        expect(entries[0]!.children).toBeUndefined()
      }
      live = adaptedSnapshot()
      await runtime.sessions.setCurrent('one')
      expect(screen.getByRole('textbox')).toBe(textarea)
      expect(screen.getByRole('button', { name: '原生计划' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '原生模型' })).toBeTruthy()
      const expert = await screen.findByRole('switch', { name: '专家模式' })
      await waitFor(() => expect((expert as HTMLButtonElement).disabled).toBe(false))
      const mentions = screen.getByRole('button', { name: '引用' })
      const upload = screen.getByRole('button', { name: '添加本地图片或文件' })
      expect(mentions.compareDocumentPosition(upload) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(upload.compareDocumentPosition(expert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect([mentions, upload, expert].map(button => button.tabIndex)).toEqual([0, 0, 0])
      expect(callImport).toHaveBeenCalledWith('/emate.expert-mode', 'get', { session_id: 'one' }, expect.any(AbortSignal))
      const typed = file('typed.png', 'image/png')
      expect(lastNativeProps.addImages([typed])).toBeNull()
      await waitFor(() => expect(callImport.mock.calls.filter(call => call[1] === 'stage-images')).toHaveLength(1))
      expect(nativeAddImages).not.toHaveBeenCalled()
      expect(beginImageStage).toHaveBeenCalledOnce()
      expect(shellAddImages).not.toHaveBeenCalled()
      finishStage(staged)
      await waitFor(() => expect(addDurableImages).toHaveBeenCalledOnce())
      expect(createDraftImages).toHaveBeenCalledOnce()
      expect(addDurableImages.mock.calls[0]![1]).toEqual(['typed-native-id'])
      expect(callImport.mock.calls.filter(call => call[1] === 'stage-images')).toHaveLength(1)
      expect(releaseDraftImages).not.toHaveBeenCalled()
      expect(cancelImageStage).not.toHaveBeenCalled()

      fireEvent.change(picker(), { target: { files: [file()] } })
      await waitFor(() => expect(callImport.mock.calls.filter(call => call[1] === 'import')).toHaveLength(1))
      expect(screen.getByRole('button', { name: `移除 ${imported.display_name}` })).toBeTruthy()
      await runtime.sessions.setCurrent('two')
      // rc.7 SessionMaybeEntry adopts the first session, then remounts on a
      // different session; the product follows the same isolation boundary.
      expect(screen.getByRole('textbox')).not.toBe(textarea)
      expect(lastNativeProps.accessory).toBeUndefined()
      finishImport(success)
      await runtime.flush()
      expect(screen.queryByRole('button', { name: `移除 ${imported.display_name}` })).toBeNull()
      expect(actions.addFiles).not.toHaveBeenCalled()
      expect(screen.getByText('原生工具')).toBeTruthy()
      const guard = vi.fn(() => true)
      runtime.sessions.scope('two' as never)!.on('slash/input-consume-token', guard)
      document.addEventListener(FILE_PICK_EVENT, picked)
      const span = { start: 4, end: 5, draftRev: 8 }
      trigger.onPick({ session: { sessionId: 'two' }, span })
      expect(guard).toHaveBeenCalledWith({ guard: { kind: 'span', span } })
      expect(picked).toHaveBeenCalledOnce()
      guard.mockReturnValue(false)
      trigger.onPick({ session: { sessionId: 'two' }, span })
      expect(picked).toHaveBeenCalledOnce()
      expect(callImport).toHaveBeenCalledWith('/emate.expert-mode', 'get', { session_id: 'two' }, expect.any(AbortSignal))
      await feature.dispose()
      expect(screen.queryByRole('switch', { name: '专家模式' })).toBeNull()
      expect(runtime.slots.entries('e-mate.conversation.composer' as never)).toHaveLength(0)
      expect(screen.getByRole('textbox')).toBeTruthy()
      expect(screen.getByRole('button', { name: '原生计划' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '原生模型' })).toBeTruthy()
    } finally {
      document.removeEventListener(FILE_PICK_EVENT, picked)
      await runtime.dispose()
    }
  })
})
