// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, useSyncExternalStore } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { assistantDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { toolDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/tool.ts'
import { turnTailDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts'
import { chatViewDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { unknownFallbackDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/fallback.ts'
import { chatNode, CHAT_SYNTHETIC_SEQ_OFFSETS } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/common.ts'
import { deriveTurnMetrics } from '../../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/contract/turn-metrics.ts'
import { adaptHarnessConversationSource, adaptHarnessChatSource } from '../../../../../../scripts/harness-conversation-adapter.mjs'
import { bindSnapshotSelector } from '../../../../../../upstream/deepseek-harness/packages/client/ui-renderer/src/client/bind.ts'
import { SlotTestRuntime } from '../../../../../../upstream/deepseek-harness/packages/test-support/client-runtime/lib/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseImageOutputReceipt, parseImageOutputGroup } from '../src/client/image-gallery-contract.ts'
import {
  ArtifactTerminal,
  childGalleryImageItems,
  galleryImageItems,
  ImageGalleryView,
  imageCallsDefinition,
  namedGalleryImageItems,
  selectArtifactTerminal,
  schemaAwareChildGalleryImageItems,
  subagentSettledDefinition,
  terminalChildImageItems,
  terminalImageItems,
  toolImagesDefinition,
} from '../src/client/image-gallery.tsx'
import { createTransientGalleryNotice, registerImageGallery } from '../src/client/index.ts'
import { LegacyArtifacts } from '../src/client/legacy-artifacts.tsx'
import fileCss from '../../../../../dsh-plugin-file-import/src/client/style.module.css'

const nativeImageRendering = vi.hoisted(() => ({ enabled: false }))
vi.mock('@deepseek-ai/dsh-client-ui-attachment', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-client-ui-attachment')>('@deepseek-ai/dsh-client-ui-attachment')
  return {
    MessageImage: (props: Parameters<typeof actual.MessageImage>[0]) => nativeImageRendering.enabled
      ? createElement(actual.MessageImage, props)
      : mockMessageImage(props),
  }
})
// 0.1.5 passes a MessageImageSpec ({ attachment } | { preview }), not a bare attachment.
const mockMessageImage = ({ image, labels }: {
    image: { attachment?: { name?: string } }
    labels: { open: string; openNamed: (label: string) => string }
  }) => {
    const name = image.attachment?.name ?? 'image'
    return (
      <button
        type="button"
        data-variant="tile"
        title={labels.open}
        aria-label={labels.openNamed(name)}
      >{name}</button>
    )
  }

// The native conversation dictionary's zh entries, which the registered
// conversation.message.images slot resolves its labels from.
const CONVERSATION_ZH: Record<string, string> = {
  'image.label': '图片',
  'image.openOriginal': '查看原图',
  'image.openOriginalLabel': '{label}，点击查看原图',
  'image.loading': '正在加载图像…',
  'image.loadFailed': '图像加载失败，点击重试',
  'image.preview': '原图预览',
  'image.closePreview': '关闭原图预览',
}
const zh = (key: string, params?: { label?: string }) =>
  (CONVERSATION_ZH[key] ?? key).replace('{label}', params?.label ?? '')
const slotLabels = {
  image: zh('image.label'),
  open: zh('image.openOriginal'),
  openNamed: (label: string) => zh('image.openOriginalLabel', { label }),
  loading: zh('image.loading'),
  loadFailed: zh('image.loadFailed'),
  lightbox: { dialog: zh('image.preview'), close: zh('image.closePreview') },
}

afterEach(() => { cleanup(); nativeImageRendering.enabled = false })

const attachment = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 42,
  width: 2,
  height: 3,
  name: 'result.png',
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    revision: 2,
    call_id: 'call-image-1',
    operation: 'generate',
    status: 'completed',
    billing_status: 'recorded',
    parent_session_id: 'session-parent',
    sources: [],
    content: [{ type: 'image', attachment }],
    verifier: { structural: 'attachment-cas-v1', semantic: 'not-required' },
    verification: { structural: 'passed', source_output: 'not-applicable', semantic: 'not-applicable' },
    output: attachment,
    job_id: 'job-1',
    provider_request_id: 'provider-1',
    client_request_id: 'client-1',
    model: 'gpt-image-2-pro',
    ...overrides,
  }
}

function event(data: Record<string, unknown>, seq = 8) {
  return { type: 'emate/image-output', seq, time: seq, data }
}

function adaptedTurnTailDefinition(): typeof turnTailDefinition {
  // 0.1.5 moved the turn-tail node to ui-chat and emits isAppendSurfaceEvent as
  // a bare local, so the injected runtime namespace is gone.
  const bundle = adaptHarnessChatSource(readFileSync(resolve('../../../../../upstream/deepseek-harness/packages/client/ui-chat/lib/client.js'), 'utf8'))
  const start = bundle.indexOf('//#region lib/types/client/conversation-nodes/turn-tail.js')
  return new Function('chatNode', 'CHAT_SYNTHETIC_SEQ_OFFSETS', 'deriveTurnMetrics',
    bundle.slice(start, bundle.indexOf('//#endregion', start)) + '\nreturn turnTailDefinition',
  )(chatNode, CHAT_SYNTHETIC_SEQ_OFFSETS, deriveTurnMetrics)
}

function v3Receipt(overrides: Record<string, unknown> = {}) {
  return { schema_version: 3, revision: 2, call_id: 'call-image-1', root_call_id: 'call-image-1', turn: 1,
    tool_name: 'generate_image', task_id: 'task-1', parent_session_id: 'session-parent', operation: 'generate',
    status: 'completed', sources: [], content: [{ type: 'image', attachment }], model: 'gpt-image-2.5-flare',
    requested_count: 1, returned_count: 1, failed_count: 0,
    ...overrides }
}

function hidden(
  item: ReturnType<typeof parseImageOutputReceipt>,
  key = 'receipt',
  turnNumber = 1,
  anchorSeq = 1,
) {
  return {
    key, kind: 'e-mate-tool-images', id: key, target: 'chat', anchorSeq,
    location: { kind: 'turn', turn: turn({}, turnNumber) }, visibility: 'hidden', data: { callId: item?.callId, revision: item?.revision, items: item === null ? [] : [item] },
  }
}

function turn(data: Record<string, unknown>, turnNumber = 1, status: 'open' | 'closed' = 'closed') {
  return {
    turn: turnNumber, status, start: undefined, end: undefined, steps: [],
    data: { get: (key: string) => data[key] },
  }
}

const limits = {
  maxImagesPerMessage: 20,
  maxImageBytes: 5 * 1024 * 1024,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 20_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function projectionHook(imageBatches: unknown = undefined): UseProjection {
  return ((key: string, selector?: (value: unknown) => unknown) => {
    const value = key === 'imageLimits' ? limits : key === 'eMateImageBatches' ? imageBatches : undefined
    return selector === undefined ? value : selector(value)
  }) as UseProjection
}

function chatNodeFixture(nodes: readonly any[]) {
  return {
    nodes: { values: () => nodes, get: (key: string) => nodes.find(node => node.key === key) },
    locations: { getTurn: (turn: number) => nodes.filter(node =>
      (node.location?.kind === 'turn' || node.location?.kind === 'step') && node.location.turn.turn === turn,
    ).map(node => node.key) },
  }
}

function terminalProps(
  nodes: readonly unknown[],
  matched = { callIds: ['call-image-1'], paths: [] as string[], childSessionIds: [] as string[] },
  overrides: Record<string, unknown> = {},
) {
  return {
    matched: { childSessionIds: [], ...matched },
    sessionId: 'session-1',
    turn: turn({}),
    seq: 20,
    openFile: vi.fn(),
    useSession: (selector: (value: unknown) => unknown) => selector({ chat: chatNodeFixture(nodes) }),
    useSessions: (selector: (value: unknown) => unknown) => selector({ byId: { 'session-1': { cwd: '/work' } } }),
    useInput: (selector: (value: unknown) => unknown) => selector({ imageIds: [], phase: 'plain' }),
    useProjection: projectionHook(),
    loadImage: vi.fn(async () => 'blob:image'),
    addImageToDraft: vi.fn(async () => {}),
    draftBytes: () => 0,
    notify: vi.fn(),
    runResource: vi.fn(async () => {}),
    // Mirrors the native conversation.message.images slot entry (MessageImages).
    renderSlot: ((name: string, owner: { images: readonly { attachment?: unknown }[] }) =>
      name === 'conversation.message.images'
        ? owner.images.map((image, index) => mockMessageImage({ key: index, image, labels: slotLabels } as never))
        : null) as never,
    ...overrides,
  }
}

function sessionListHarness(initial: unknown) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    useSessions: <T,>(selector: (value: any) => T): T => useSyncExternalStore(
      listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      () => selector(snapshot),
      () => selector(snapshot),
    ),
    set(next: unknown): void {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function galleryProps(
  sessionId: string,
  nodes: readonly unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    sessionId,
    useSession: (selector: (value: unknown) => unknown) => selector({
      chat: {
        ...chatNodeFixture(nodes),
        timeline: { turnOrder: [], turns: new Map() },
      },
    }),
    useSessions: (selector: (value: unknown) => unknown) => selector({
      byId: { [sessionId]: {} }, subagentsByParent: {},
    }),
    useInput: (selector: (value: unknown) => unknown) => selector({ imageIds: [], phase: 'plain' }),
    useProjection: projectionHook(),
    loadImage: vi.fn(async () => 'blob:image'),
    addImageToDraft: vi.fn(async () => {}),
    draftBytes: () => 0,
    notify: vi.fn(),
    runResource: vi.fn(async () => {}),
    // Mirrors the native conversation.message.images slot entry (MessageImages).
    renderSlot: ((name: string, owner: { images: readonly { attachment?: unknown }[]; loadImage: unknown }) =>
      name === 'conversation.message.images'
        ? owner.images.map((image, index) => mockMessageImage({ key: index, image, labels: slotLabels } as never))
        : null) as never,
    ...overrides,
  }
}

function galleryAdmissionHarness(imageLimits: typeof limits, acceptImages = true) {
  const pendingReads: Array<(result: unknown) => void> = []
  const drafts = new Map<string, { id: string; file: File }>()
  let imageIds: readonly string[] = []
  let draft = ''
  let phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' = 'plain'
  let injected: any
  const readAttachment = vi.fn(() => new Promise(resolve => { pendingReads.push(resolve) }))
  const addImages = vi.fn((ids: readonly string[]) => {
    if (!acceptImages) return false
    imageIds = [...imageIds, ...ids]
    return true
  })
  const releaseDraftImages = vi.fn((images: readonly { id: string }[]) => {
    for (const image of images) drafts.delete(image.id)
  })
  const shell = {
    state: { getSnapshot: () => ({ draft, imageIds, phase }) },
    setDraft: vi.fn((value: string) => { draft = value }),
    addImages,
    notify: vi.fn(),
  }
  const notice = vi.fn()
  const binding = vi.fn(() => ({ session: {
    readAttachment,
    projections: { faceOf: () => ({ getSnapshot: () => imageLimits }) },
  } }))
  const ctx = {
    slots: {
      inject: (_name: string, install: () => void) => { install() },
      register: (options: { inject: (sessionId: string) => unknown }) => {
        injected = options.inject('session-gallery')
      },
    },
    sessions: {
      binding,
      scope: () => ({}),
      open: vi.fn(),
    },
    conversation: {
      resolveImage: vi.fn(async () => 'blob:image'),
      input: { for: () => shell },
      createDraftImages: vi.fn((files: readonly File[]) => files.map((file) => {
        const draft = { id: `draft-${drafts.size + 1}`, file }
        drafts.set(draft.id, draft)
        return draft
      })),
      draftImages: (ids: readonly string[]) => ids.flatMap(id => {
        const draft = drafts.get(id)
        return draft === undefined ? [] : [draft]
      }),
      releaseDraftImages,
    },
  }
  registerImageGallery(ctx, notice)
  return {
    injected,
    binding,
    readAttachment,
    addImages,
    createDraftImages: ctx.conversation.createDraftImages,
    releaseDraftImages,
    shell,
    notice,
    imageIds: () => imageIds,
    setImageIds: (value: readonly string[]) => { imageIds = value },
    draft: () => draft,
    setDraft: (value: string) => { draft = value },
    setPhase: (value: typeof phase) => { phase = value },
    openSession: ctx.sessions.open,
    draftCount: () => drafts.size,
    resolveReads: () => {
      for (const resolveRead of pendingReads.splice(0)) {
        resolveRead({ ok: true, value: { attachment, data: new Uint8Array(attachment.bytes) } })
      }
    },
  }
}

describe('completed artifact terminal', () => {
  it('sends the real image attachment to the canvas without reading a preview or modifying drafts', async () => {
    const item = parseImageOutputReceipt(receipt())!
    const addImageToCanvas = vi.fn(async () => {})
    const props = terminalProps([hidden(item)], undefined, { addImageToCanvas })
    render(<ArtifactTerminal {...props as any} />)
    fireEvent.click(screen.getByRole('button', { name: /加入画布：/ }))
    await waitFor(() => expect(addImageToCanvas).toHaveBeenCalledWith(attachment, undefined))
    expect(props.loadImage).not.toHaveBeenCalled()
    expect(props.addImageToDraft).not.toHaveBeenCalled()
    expect(props.runResource).not.toHaveBeenCalled()
  })

  it('keeps the gallery image after a failed canvas insertion and reports that failure', async () => {
    const item = parseImageOutputReceipt(receipt())!
    const addImageToCanvas = vi.fn(async () => { throw new Error('missing attachment') })
    const props = galleryProps('session-1', [hidden(item)], { addImageToCanvas })
    render(<ImageGalleryView {...props as any} />)
    fireEvent.click(screen.getByRole('button', { name: /加入画布：/ }))
    await waitFor(() => expect(props.notify).toHaveBeenCalledWith('error', '图片未能加入画布，请确认附件仍可用。'))
    expect(screen.getByRole('button', { name: /加入画布：/ })).toBeTruthy()
    expect(props.addImageToDraft).not.toHaveBeenCalled()
  })

  it('registers one native conversation.view Gallery Tab', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.root.declare({
      'conversation.view': { kind: 'list', scope: 'session' },
    } as never, (() => null) as never)
    await runtime.mount({ inject: ['slots'], apply: registerImageGallery })
    const entries = runtime.slots.entries('conversation.view')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options).toMatchObject({
      id: 'e-mate-gallery', order: 18, label: '画廊',
    })
    expect(entries[0]?.component).toBe(ImageGalleryView)
    await runtime.dispose()
  })

  it('keeps the historical batch retry runner out of Gallery actions', () => {
    const actions = galleryAdmissionHarness(limits)
    expect(actions.injected.prepareImageRetry).toBeUndefined()
    expect(actions.draft()).toBe('')
  })

  it('uses the native overlay Toast transiently without changing composer layout', () => {
    vi.useFakeTimers()
    try {
      const composer = render(<div data-composer-card><textarea defaultValue="保留中的草稿" /></div>)
      const composerNode = composer.container.firstElementChild
      const composerMarkup = composer.container.innerHTML
      let toastView: ReturnType<typeof render> | undefined
      const dispose = vi.fn(() => { toastView?.unmount() })
      const ctx = {
        slots: {
          register: vi.fn((_options: unknown, Component: () => JSX.Element) => {
            toastView = render(<Component />)
            return dispose
          }),
        },
      }

      const notice = createTransientGalleryNotice(ctx)
      notice('info', '图片已添加到聊天草稿。')
      expect(screen.getByRole('alert').textContent).toBe('图片已添加到聊天草稿。')
      expect(screen.getByRole('alert').querySelector('svg')).toBeNull()
      expect(composer.container.firstElementChild).toBe(composerNode)
      expect(composer.container.innerHTML).toBe(composerMarkup)

      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
      notice('error', '图片操作失败，请重试。')
      expect(screen.getByRole('alert').textContent).toBe('图片操作失败，请重试。')
      expect(screen.getByRole('alert').querySelector('svg')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(dispose).toHaveBeenCalledTimes(2)
      expect(composer.container.firstElementChild).toBe(composerNode)
      expect(composer.container.innerHTML).toBe(composerMarkup)
    } finally {
      vi.useRealTimers()
    }
  })

  it('projects readable portable names with edit, batch, and fallback handling', () => {
    const createdAt = new Date(2026, 8, 2, 12, 34, 56).getTime()
    const item = (callId: string, operation: 'generate' | 'edit' = 'generate') => ({
      ...parseImageOutputReceipt(receipt({ call_id: callId, operation }))!,
      createdAt,
    })
    const timestamp = '20260902-123456'

    expect(namedGalleryImageItems([item('中文')], '武汉整装套餐/报价')[0]?.attachment?.name)
      .toBe(`武汉整装套餐-报价-生成-${timestamp}.png`)
    expect(namedGalleryImageItems([item('改图', 'edit')], '客厅改造')[0]?.attachment?.name)
      .toBe(`客厅改造-改图-${timestamp}.png`)
    expect(namedGalleryImageItems([item('批次一'), item('批次二')], '春季海报').map(value => value.attachment?.name))
      .toEqual([`春季海报-生成-${timestamp}-01.png`, `春季海报-生成-${timestamp}-02.png`])
    expect(namedGalleryImageItems([item('非法')], '装修<>:"/\\|?*\u0001方案. ')[0]?.attachment?.name)
      .toBe(`装修-方案-生成-${timestamp}.png`)
    expect(namedGalleryImageItems([item('保留名')], 'CON.')[0]?.attachment?.name)
      .toBe(`e-Mate-图片-生成-${timestamp}.png`)
    expect(namedGalleryImageItems([item('回退')], ' \u0001 ')[0]?.attachment?.name)
      .toBe(`e-Mate-图片-生成-${timestamp}.png`)
    expect(Buffer.byteLength(namedGalleryImageItems([item('限长')], '图'.repeat(200))[0]!.attachment!.name!, 'utf8'))
      .toBeLessThanOrEqual(255)
  })

  it('deduplicates current-Session receipts by revision then anchor and ignores visible nodes', () => {
    const item = (callId: string, revision: number, name: string) => parseImageOutputReceipt(receipt({
      call_id: callId,
      revision,
      status: revision === 3 ? 'needs-review' : 'completed',
      content: [{ type: 'image', attachment: { ...attachment, name } }],
    }))!
    const olderRevision = item('revision-call', 2, 'older-revision.png')
    const latestRevision = item('revision-call', 3, 'latest-revision.png')
    const earlierAnchor = item('anchor-call', 2, 'earlier-anchor.png')
    const latestAnchor = item('anchor-call', 2, 'latest-anchor.png')
    const newest = item('newest-call', 2, 'newest.png')
    expect(galleryImageItems([
      hidden(olderRevision, 'older-revision', 1, 9),
      hidden(latestRevision, 'latest-revision', 1, 2),
      hidden(earlierAnchor, 'earlier-anchor', 1, 4),
      hidden(latestAnchor, 'latest-anchor', 1, 5),
      hidden(newest, 'newest', 1, 10),
      { ...hidden(newest, 'visible', 1, 99), visibility: 'visible' },
    ] as never)).toEqual([newest, latestAnchor, latestRevision])
    expect(parseImageOutputReceipt(receipt({ failure_code: '/Users/private/image.png' }))).toBeNull()
  })

  it('reads only the active Session and searches status, type, and redacted failures', () => {
    const sessionA = parseImageOutputReceipt(receipt({
      call_id: 'session-a',
      content: [{ type: 'image', attachment: { ...attachment, name: 'session-a.png' } }],
    }))!
    const sessionB = parseImageOutputReceipt(receipt({
      call_id: 'session-b', revision: 3, operation: 'edit', status: 'needs-review',
      content: [{ type: 'image', attachment: { ...attachment, name: 'session-b.png' } }],
    }))!
    const failed = parseImageOutputReceipt(receipt({
      call_id: 'session-b-failed', revision: 3, operation: 'fusion', status: 'failed',
      content: [], output: undefined, failure_code: 'provider-result-uncommitted',
    }))!
    const view = render(<ImageGalleryView {...galleryProps('session-a', [hidden(sessionA)]) as never} />)
    expect(screen.getByRole('article', { name: 'session-a.png' })).toBeTruthy()

    view.rerender(<ImageGalleryView {...galleryProps('session-b', [hidden(sessionB), hidden(failed, 'failed', 1, 2)]) as never} />)
    expect(screen.queryByRole('article', { name: 'session-a.png' })).toBeNull()
    expect(screen.getByRole('article', { name: 'session-b.png' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '添加到聊天：session-b.png' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('筛选状态'), { target: { value: 'failed' } })
    expect(screen.getByRole('article', { name: /session-b-failed/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /session-b-failed/u })).toBeNull()
    fireEvent.change(screen.getByLabelText('筛选状态'), { target: { value: 'all' } })
    fireEvent.change(screen.getByLabelText('筛选类型'), { target: { value: 'fusion' } })
    fireEvent.change(screen.getByPlaceholderText('搜索文件名或结果编号'), { target: { value: 'provider-result' } })
    expect(screen.getByText('错误：provider-result-uncommitted')).toBeTruthy()
    expect(view.container.textContent).not.toContain('/Users')
    expect(screen.queryByRole('button', { name: /删除/u })).toBeNull()
  })

  it('streams direct child receipts into the parent Gallery by terminal completion order', async () => {
    const parentId = 'parent-gallery'
    const children = [
      { id: 'child-a', label: '第一张' },
      { id: 'child-b', label: '第二张' },
      { id: 'child-review', label: '待确认改图' },
      { id: 'child-failed', label: '失败图片' },
    ]
    const projected = (childId: string, data: Record<string, unknown>, seq: number, createdAt: number) => ({
      childId,
      row: { seq, createdAt, receipt: { ...data, parent_session_id: childId } },
    })
    const childReceipt = (childId: string, callId: string, name: string, suffix: string, overrides = {}) => receipt({
      call_id: callId,
      parent_session_id: childId,
      content: [{ type: 'image', attachment: {
        ...attachment,
        attachmentId: `sha256:${suffix.repeat(64)}`,
        name,
      } }],
      output: {
        ...attachment,
        attachmentId: `sha256:${suffix.repeat(64)}`,
        name,
      },
      ...overrides,
    })
    const state = (rows: readonly ReturnType<typeof projected>[], running = true) => ({
      byId: {
        [parentId]: { title: '并发生图测试', displayTitle: '并发生图测试', running },
        ...Object.fromEntries(children.map(child => [child.id, {
          displayTitle: child.label,
          projectionValues: {
            eMateImageReceipts: rows.filter(row => row.childId === child.id).map(row => row.row),
          },
        }])),
      },
      subagentsByParent: {
        [parentId]: {
          entries: children.map(child => ({
            kind: 'child', id: child.id, label: child.label, mode: 'one-shot', activity: 'inactive', hasChildren: false,
          })),
          state: 'ready', error: null, parentAvailable: true,
        },
      },
    })
    const first = projected('child-b', childReceipt('child-b', 'call-b', 'second.png', 'b'), 8, 100)
    const second = projected('child-a', childReceipt('child-a', 'call-a', 'first.png', 'c'), 9, 200)
    const review = projected('child-review', childReceipt(
      'child-review', 'call-review', 'review.png', 'd', { revision: 3, operation: 'edit', status: 'needs-review' },
    ), 10, 250)
    const failed = projected('child-failed', receipt({
      call_id: 'call-failed', parent_session_id: 'child-failed', status: 'failed', content: [], output: undefined,
      failure_code: 'provider-result-uncommitted',
    }), 11, 300)
    const actions = {
      loadImage: vi.fn(async () => 'blob:child-image'),
      addImageToDraft: vi.fn(async () => {}),
      runResource: vi.fn(async () => {}),
    }
    const sessions = sessionListHarness(state([]))
    const props = (nodes: readonly unknown[] = []) => galleryProps(parentId, nodes, {
      ...actions,
      useSessions: sessions.useSessions,
    })

    const view = render(<ImageGalleryView {...props() as never} />)
    const mountedGallery = screen.getByRole('region', { name: '画廊' })
    expect(screen.getByText('暂无图片结果')).toBeTruthy()

    act(() => { sessions.set(state([first])) })
    const firstCard = screen.getByRole('article', { name: /子任务02-生成/u })
    expect(firstCard.textContent).toContain('来自子任务：第二张')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('region', { name: '画廊' })).toBe(mountedGallery)

    fireEvent.click(screen.getByRole('button', { name: /复制图像：.*子任务02-生成/u }))
    await waitFor(() => {
      expect(actions.loadImage).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: `sha256:${'b'.repeat(64)}` }), 'child-b')
      expect(actions.runResource).toHaveBeenCalledWith(expect.objectContaining({
        resource: expect.objectContaining({ kind: 'image', sessionId: 'child-b' }),
      }))
    })
    fireEvent.click(screen.getByRole('button', { name: /添加到聊天：.*子任务02-生成/u }))
    await waitFor(() => {
      expect(actions.addImageToDraft).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentId: `sha256:${'b'.repeat(64)}` }), 'child-b',
      )
    })

    act(() => { sessions.set(state([first, second])) })
    expect(screen.getAllByRole('article').map(node => node.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/子任务02-生成/u),
      expect.stringMatching(/子任务01-生成/u),
    ])
    act(() => { sessions.set(state([first, second])) })
    expect(screen.getAllByRole('article')).toHaveLength(2)

    act(() => { sessions.set(state([first, second, review, failed], false)) })
    expect(screen.getAllByRole('article')).toHaveLength(4)
    expect(screen.getByRole('article', { name: /子任务03-改图/u }).textContent).toContain('待确认')
    expect(screen.getByRole('article', { name: 'call-failed' }).textContent).toContain('来自子任务：失败图片')
    expect(screen.getAllByRole('article').at(-1)?.getAttribute('aria-label')).toBe('call-failed')

    const own = { ...parseImageOutputReceipt(receipt({
      call_id: 'parent-own', parent_session_id: parentId,
      content: [{ type: 'image', attachment: { ...attachment, name: 'parent-own.png' } }],
    }))!, createdAt: 400 }
    view.rerender(<ImageGalleryView {...props([hidden(own)]) as never} />)
    expect(screen.getAllByRole('article')).toHaveLength(5)
    expect(screen.getByRole('article', { name: /并发生图测试-生成/u })).toBeTruthy()

    cleanup()
    const coldSessions = sessionListHarness(state([first, second, review, failed], false))
    render(<ImageGalleryView {...galleryProps(parentId, [], {
      ...actions, useSessions: coldSessions.useSessions,
    }) as never} />)
    expect(screen.getAllByRole('article')).toHaveLength(4)
    expect(childGalleryImageItems(state([first, second, review, failed]) as never, parentId))
      .toHaveLength(4)
  })

  it('keeps empty upgrade projection legacy until exact batch state or a logged call exists', () => {
    const parentId = 'schema-parent'
    const row = (child: string, call: string, seq: number, suffix: string) => ({
      seq, createdAt: seq, receipt: receipt({
        parent_session_id: child, call_id: call,
        content: [{ type: 'image', attachment: {
          ...attachment, attachmentId: 'sha256:' + suffix.repeat(64), name: call + '.png',
        } }],
        output: { ...attachment, attachmentId: 'sha256:' + suffix.repeat(64), name: call + '.png' },
      }),
    })
    const exact = row('child-exact', 'call-exact', 7, 'b')
    const wrongPointer = row('child-exact', 'call-wrong', 9, 'd')
    const foreign = row('child-foreign', 'call-foreign', 8, 'c')
    const sessions = {
      byId: {
        'child-exact': { projectionValues: { eMateImageReceipts: [exact, wrongPointer] } },
        'child-foreign': { projectionValues: { eMateImageReceipts: [foreign] } },
        'child-empty': { projectionValues: {} },
      },
      subagentsByParent: { [parentId]: { entries: [
        { kind: 'child', id: 'child-exact', label: '同名任务', mode: 'one-shot' },
        { kind: 'child', id: 'child-foreign', label: '同名任务', mode: 'one-shot' },
        { kind: 'child', id: 'child-empty', label: '同名任务', mode: 'one-shot' },
      ] } },
    }
    const emptyUpgradeProjection = { batches: [], batchesById: {} }
    expect(schemaAwareChildGalleryImageItems(sessions as never, parentId, emptyUpgradeProjection).map(item => item.callId))
      .toEqual(['call-exact', 'call-foreign', 'call-wrong'])

    const task = { childSessionId: 'child-exact', receipt: {
      ownerSessionId: 'child-exact', callId: 'call-exact', revision: 2, eventSeq: 7, status: 'completed',
    } }
    const batch = { batches: [{ tasks: [task] }], batchesById: {} }
    expect(schemaAwareChildGalleryImageItems(sessions as never, parentId, batch as never).map(item => item.callId))
      .toEqual(['call-exact', 'call-foreign'])
    expect(schemaAwareChildGalleryImageItems(
      sessions as never, parentId, emptyUpgradeProjection, true,
    )).toEqual([])
    expect(schemaAwareChildGalleryImageItems(
      sessions as never, parentId, { batches: [], batchesById: {} }, true,
    )).toEqual([])

    const props = (batchCalls: readonly unknown[]) => galleryProps(parentId, [], {
      useSession: (selector: (value: unknown) => unknown) => selector({
        chat: {
          nodes: { values: () => [][Symbol.iterator]() },
          timeline: {
            turnOrder: [1], turns: new Map([[1, { data: { get: () => ({ batchCalls }) } }]]),
          },
        },
      }),
      useSessions: (selector: (value: unknown) => unknown) => selector(sessions),
      useProjection: projectionHook([]),
    })
    const upgraded = render(<ImageGalleryView {...props([]) as never} />)
    expect(screen.getAllByRole('article')).toHaveLength(3)
    upgraded.rerender(<ImageGalleryView {...props([{ callId: 'batch-call', seq: 1 }]) as never} />)
    expect(screen.getByText('暂无图片结果')).toBeTruthy()
  })

  it('reads a child-owned attachment into the parent draft without changing receipt ownership', async () => {
    const harness = galleryAdmissionHarness(limits)
    const adding = harness.injected.addImageToDraft(attachment, 'child-owner')
    harness.resolveReads()
    await adding

    expect(harness.binding.mock.calls.map(call => call[0])).toEqual(['session-gallery', 'child-owner'])
    expect(harness.addImages).toHaveBeenCalledOnce()
    expect(harness.notice).toHaveBeenCalledWith('info', '图片已添加到聊天草稿。')
  })

  it('mounts at most 24 Gallery images per page and resets paging after every input or Session change', () => {
    const items = (label: string) => Array.from({ length: 60 }, (_, index) => parseImageOutputReceipt(receipt({
      call_id: `batch-${label}-${index}`,
      content: [{ type: 'image', attachment: {
        ...attachment,
        attachmentId: `sha256:${index.toString(16).padStart(64, '0')}`,
        name: `batch-${label}-${index}.png`,
      } }],
    }))!)
    const nodes = (values: readonly ReturnType<typeof parseImageOutputReceipt>[]) =>
      values.map((item, index) => hidden(item, `page-${index}`, 1, index + 1))
    const view = render(<ImageGalleryView {...galleryProps('session-gallery', nodes(items('first'))) as never} />)

    expect(screen.getAllByRole('article')).toHaveLength(24)
    expect(screen.getAllByRole('button', { name: /查看原图/u })).toHaveLength(24)
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'batch-first-59.png' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '画廊下一页' }))
    expect(screen.getAllByRole('article')).toHaveLength(24)
    expect(screen.getAllByRole('button', { name: /查看原图/u })).toHaveLength(24)
    fireEvent.click(screen.getByRole('button', { name: '画廊下一页' }))
    expect(screen.getAllByRole('article')).toHaveLength(12)
    expect(screen.getAllByRole('button', { name: /查看原图/u })).toHaveLength(12)

    fireEvent.change(screen.getByPlaceholderText('搜索文件名或结果编号'), { target: { value: 'batch' } })
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '画廊下一页' }))
    fireEvent.change(screen.getByLabelText('筛选状态'), { target: { value: 'completed' } })
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '画廊下一页' }))
    fireEvent.change(screen.getByLabelText('筛选类型'), { target: { value: 'generate' } })
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '画廊下一页' }))
    view.rerender(<ImageGalleryView {...galleryProps('session-gallery', nodes(items('updated'))) as never} />)
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'batch-updated-59.png' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /查看原图/u })).toHaveLength(24)
  })

  it('routes Gallery copy, download, and add-to-chat through the shared native owners', async () => {
    const createdAt = new Date(2026, 8, 2, 12, 34, 56).getTime()
    const name = '武汉整装套餐-生成-20260902-123456.png'
    const genericAttachment = { ...attachment, name: 'e-Mate-image.png' }
    const completed = parseImageOutputReceipt(receipt({
      content: [{ type: 'image', attachment: genericAttachment }],
      output: genericAttachment,
    }))!
    const props = galleryProps('session-gallery', [hidden({ ...completed, createdAt })], {
      useSessions: (selector: (value: unknown) => unknown) => selector({
        byId: { 'session-gallery': { title: '武汉整装套餐' } },
      }),
    })
    render(<ImageGalleryView {...props as never} />)
    expect(props.loadImage).not.toHaveBeenCalled()

    expect(screen.getByRole('article', { name })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${name}，点击查看原图` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `复制图像：${name}` }))
    await waitFor(() => { expect(props.runResource).toHaveBeenCalledWith({
      action: 'copy-image',
      resource: { kind: 'image', sessionId: 'session-gallery', name, src: 'blob:image' },
    }) })
    fireEvent.click(screen.getByRole('button', { name: `下载副本：${name}` }))
    await waitFor(() => { expect(props.runResource).toHaveBeenCalledWith({
      action: 'save-as',
      resource: { kind: 'image', sessionId: 'session-gallery', name, src: 'blob:image' },
    }) })
    fireEvent.click(screen.getByRole('button', { name: `添加到聊天：${name}` }))
    await waitFor(() => { expect(props.addImageToDraft).toHaveBeenCalledWith({ ...genericAttachment, name }) })
    expect(props.notify).not.toHaveBeenCalled()
  })

  it('routes Gallery resource failures through the transient notice callback', async () => {
    const completed = parseImageOutputReceipt(receipt())!
    const props = galleryProps('session-gallery', [hidden(completed)], {
      runResource: vi.fn(async () => { throw new Error('/Users/private/result.png') }),
    })
    render(<ImageGalleryView {...props as never} />)

    fireEvent.click(screen.getByRole('button', { name: '复制图像：result.png' }))
    await waitFor(() => {
      expect(props.notify).toHaveBeenCalledWith('error', '图片操作失败，请确认图片仍可用。')
    })
    expect(props.notify).toHaveBeenCalledOnce()
    expect(props.notify.mock.calls.flat().join(' ')).not.toContain('/Users')
  })

  it.each([
    ['max image count', { ...limits, maxImagesPerMessage: 1 }],
    ['total image bytes', { ...limits, maxImagesPerMessage: 2, maxMessageImageBytes: attachment.bytes }],
  ])('atomically rechecks live %s after concurrent delayed reads', async (_name, imageLimits) => {
    const createdAt = new Date(2026, 8, 2, 12, 34, 56).getTime()
    const name = '武汉整装套餐-生成-20260902-123456.png'
    const completed = { ...parseImageOutputReceipt(receipt())!, createdAt }
    const harness = galleryAdmissionHarness(imageLimits)
    render(<ImageGalleryView {...galleryProps('session-gallery', [hidden(completed)], {
      ...harness.injected,
      useSessions: (selector: (value: unknown) => unknown) => selector({
        byId: { 'session-gallery': { title: '武汉整装套餐' } },
      }),
    }) as never} />)
    const add = screen.getByRole('button', { name: `添加到聊天：${name}` })

    fireEvent.click(add)
    fireEvent.click(add)
    expect(harness.readAttachment).toHaveBeenCalledTimes(2)
    expect(harness.addImages).not.toHaveBeenCalled()
    harness.resolveReads()

    await waitFor(() => {
      expect(harness.notice).toHaveBeenCalledWith('info', '图片已添加到聊天草稿。')
      expect(harness.notice).toHaveBeenCalledWith('error', '图片未能添加到聊天，请重试。')
    })
    expect(harness.addImages).toHaveBeenCalledTimes(1)
    expect(harness.createDraftImages).toHaveBeenCalledTimes(1)
    expect(harness.createDraftImages.mock.calls[0]?.[0]?.[0]?.name).toBe(name)
    expect(harness.imageIds()).toHaveLength(1)
    expect(harness.notice).toHaveBeenCalledTimes(2)
    expect(harness.shell.notify).not.toHaveBeenCalled()
  })

  it('releases a temporary draft image when the native synchronous commit refuses it', async () => {
    const completed = parseImageOutputReceipt(receipt())!
    const harness = galleryAdmissionHarness({ ...limits, maxImagesPerMessage: 1 }, false)
    render(<ImageGalleryView {...galleryProps('session-gallery', [hidden(completed)], harness.injected) as never} />)

    fireEvent.click(screen.getByRole('button', { name: '添加到聊天：result.png' }))
    harness.resolveReads()

    await waitFor(() => { expect(harness.releaseDraftImages).toHaveBeenCalledTimes(1) })
    expect(harness.addImages).toHaveBeenCalledTimes(1)
    expect(harness.releaseDraftImages).toHaveBeenCalledWith(harness.createDraftImages.mock.results[0]?.value)
    expect(harness.draftCount()).toBe(0)
    expect(harness.notice).toHaveBeenCalledWith('error', '图片未能添加到聊天，请重试。')
    expect(harness.shell.notify).not.toHaveBeenCalled()
  })

  it('publishes ImageGen call provenance and selects native files under one Turn tail', () => {
    const start = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
    const call = { type: 'tool/call', seq: 2, time: 2, data: {
      turn: 1, step: 1, callId: 'call-image-1', name: 'imagegen', arguments: '{}',
    } }
    const state = imageCallsDefinition.start({} as never, { event: start } as never, {} as never)
    const updated = imageCallsDefinition.update({ state } as never, { event: call } as never)
    expect(updated.calls).toEqual([{ callId: 'call-image-1', seq: 2 }])
    const data = {
        'e-mate-image-calls': { calls: updated.calls },
        deliverables: { produced: [
          { seq: 3, path: 'out/result.zip' }, { seq: 4, path: 'out/result.zip' }, { seq: 30, path: 'late.txt' },
        ] },
    }
    expect(selectArtifactTerminal({
      turn: turn(data, 1, 'open'),
      nodes: [hidden(parseImageOutputReceipt(receipt())!)],
      seq: 20,
      openFile: vi.fn(),
    } as never)).toEqual({ callIds: ['call-image-1'], paths: [], childSessionIds: [] })
    expect(selectArtifactTerminal({
      turn: turn(data),
      nodes: [hidden(parseImageOutputReceipt(receipt())!)],
      seq: 20,
      openFile: vi.fn(),
    } as never)).toEqual({ callIds: ['call-image-1'], paths: ['out/result.zip'], childSessionIds: [] })
  })

  it('distinguishes explicit foreground subagents from background calls without reading child ids from text', () => {
    const start = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
    const initial = imageCallsDefinition.start({} as never, { event: start } as never, {} as never)
    const background = { type: 'tool/call', seq: 2, time: 2, data: {
      turn: 1, step: 1, callId: 'background', name: 'subagent', arguments: '{"run_in_background":true}',
    } }
    const foreground = { type: 'tool/call', seq: 3, time: 3, data: {
      turn: 1, step: 1, callId: 'foreground', name: 'subagent',
      arguments: '{"description":"前台结果","run_in_background":false}',
    } }
    expect(imageCallsDefinition.match(background as never)).toMatchObject({ id: '1', role: 'update' })
    expect(imageCallsDefinition.update({ state: initial } as never, { event: background } as never)).toBe(initial)
    const state = imageCallsDefinition.update({ state: initial } as never, { event: foreground } as never)
    expect(state).toEqual({ turn: 1, calls: [], foregroundSubagents: [{ seq: 3, label: '前台结果' }] })
    expect(imageCallsDefinition.match({ ...foreground, data: { ...foreground.data, name: 'subagent_fork' } } as never))
      .toBeNull()
    const legacy = parseImageOutputReceipt(receipt({ child_session_id: 'image-child' }))
    expect(legacy).toEqual(expect.objectContaining({ callId: 'call-image-1', status: 'completed' }))
    expect(legacy).not.toHaveProperty('childSessionId')
    expect(selectArtifactTerminal({
      turn: {
        ...turn({ 'e-mate-image-calls': state }),
        start: { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
        end: { type: 'turn/end', seq: 20, time: 200, data: { turn: 1, reason: { kind: 'completed' } } },
      },
      nodes: [], seq: 20, openFile: vi.fn(),
    } as never)).toEqual({
      callIds: [], paths: [], childSessionIds: [],
      foregroundWindow: { startTime: 100, endTime: 200, labels: ['前台结果'] },
    })
  })

  it('binds native background settlement notices to exact child-owned images and keeps foreground windows disjoint', async () => {
    const parentId = 'parent-chat'
    const makeChild = (sessionId: string, callId: string, name: string, createdAt: number, digit: string) => ({
      seq: createdAt,
      createdAt,
      receipt: receipt({
        call_id: callId,
        parent_session_id: sessionId,
        content: [{ type: 'image', attachment: {
          ...attachment, attachmentId: `sha256:${digit.repeat(64)}`, name,
        } }],
        output: { ...attachment, attachmentId: `sha256:${digit.repeat(64)}`, name },
      }),
    })
    const sessions = {
      byId: {
        [parentId]: {
          title: '并发卡片', cwd: '/work', projectionValues: { eMateImageBatches: [{ unrelated: true }] },
        },
        'child-notice': { projectionValues: { eMateImageReceipts: [
          makeChild('child-notice', 'notice-image', 'notice.png', 90, '1'),
        ] } },
        'child-foreground': { projectionValues: { eMateImageReceipts: [
          makeChild('child-foreground', 'foreground-image', 'foreground.png', 150, '2'),
        ] } },
        'child-sibling': { projectionValues: { eMateImageReceipts: [
          makeChild('child-sibling', 'sibling-image', 'sibling.png', 160, '3'),
        ] } },
      },
      subagentsByParent: {
        [parentId]: { entries: [
          { kind: 'child', id: 'child-notice', label: '通知结果', mode: 'continuable' },
          { kind: 'child', id: 'child-foreground', label: '前台结果', mode: 'continuable' },
          { kind: 'child', id: 'child-sibling', label: '乱序兄弟', mode: 'continuable' },
        ] },
      },
    }
    const noticeEvent = { type: 'user/message', seq: 30, time: 210, data: {
      content: [], role: 'user', id: 'notice-message',
      source: { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'child-notice' },
    } }
    expect(subagentSettledDefinition.match(noticeEvent as never)).toEqual({
      id: 'child-notice:30', role: 'start',
    })
    expect(subagentSettledDefinition.start({} as never, { event: noticeEvent } as never, {} as never))
      .toEqual({ sessionId: 'child-notice', sourceSeq: 30 })

    const settledNode = {
      key: 'settled', kind: 'e-mate-subagent-settled', id: 'child-notice:30', target: 'chat', anchorSeq: 30,
      location: { kind: 'turn', turn: turn({}, 2) }, visibility: 'hidden', data: { sessionId: 'child-notice' },
    }
    const backgroundMatch = selectArtifactTerminal({
      turn: turn({ 'e-mate-image-calls': { calls: [], foregroundSubagents: [] } }, 2),
      nodes: [settledNode], seq: 40, openFile: vi.fn(),
    } as never)
    expect(backgroundMatch).toEqual({ callIds: [], paths: [], childSessionIds: ['child-notice'] })
    const childItems = childGalleryImageItems(sessions as never, parentId)
    expect(terminalChildImageItems(childItems, backgroundMatch!.childSessionIds)).toMatchObject([
      { callId: 'notice-image', source: { sessionId: 'child-notice' } },
    ])

    const foregroundMatch = {
      callIds: [], paths: [], childSessionIds: [],
      foregroundWindow: { startTime: 100, endTime: 170, labels: ['前台结果'] },
    }
    expect(terminalChildImageItems(
      childItems, [], foregroundMatch.foregroundWindow, new Set(['child-sibling']),
    )).toMatchObject([
      { callId: 'foreground-image', source: { sessionId: 'child-foreground' } },
    ])
    const foreground = childItems.find(item => item.callId === 'foreground-image')!
    const settledSibling = {
      ...childItems.find(item => item.callId === 'sibling-image')!,
      source: { ...foreground.source!, sessionId: 'child-sibling' },
    }
    expect(terminalChildImageItems(
      [foreground, settledSibling], [], foregroundMatch.foregroundWindow, new Set(['child-sibling']),
    ).map(item => item.callId)).toEqual(['foreground-image'])
    const duplicates = Array.from({ length: 3 }, (_, index) => ({
      ...foreground,
      callId: `duplicate-${index + 1}`,
      createdAt: 140 + index,
      source: { ...foreground.source!, sessionId: `duplicate-child-${index + 1}` },
    }))
    expect(terminalChildImageItems(duplicates, [], {
      ...foregroundMatch.foregroundWindow, labels: ['前台结果', '前台结果'],
    }).map(item => item.callId)).toEqual(['duplicate-1', 'duplicate-2'])
    expect(terminalChildImageItems(childItems, ['child-sibling'])).toMatchObject([
      { callId: 'sibling-image', source: { sessionId: 'child-sibling' } },
    ])

    const props = terminalProps([], backgroundMatch!, {
      sessionId: parentId,
      useSessions: (selector: (value: unknown) => unknown) => selector(sessions),
    })
    const view = render(<ArtifactTerminal {...props as never} />)
    expect(screen.getAllByRole('button', { name: /图片操作/u })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /子任务01-生成.*点击查看原图/u })).toBeTruthy()
    expect(view.container.textContent).not.toContain('sha256:')
    fireEvent.contextMenu(screen.getByRole('button', { name: /查看原图/u }))
    fireEvent.click(screen.getByRole('menuitem', { name: '下载副本' }))
    await waitFor(() => {
      expect(props.loadImage).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringMatching(/子任务01-生成/u) }), 'child-notice')
      expect(props.runResource).toHaveBeenCalledWith(expect.objectContaining({
        resource: expect.objectContaining({ sessionId: 'child-notice' }),
      }))
    })
  })

  it('keeps the newest strict receipt hidden and never joins another Turn call', () => {
    const complete = event(receipt())
    const review = event(receipt({ revision: 3, status: 'needs-review' }), 9)
    expect(toolImagesDefinition.match(complete as never)).toEqual({ id: 'tool-images:call-image-1', role: 'start' })
    expect(toolImagesDefinition.match(review as never)).toEqual({ id: 'tool-images:call-image-1', role: 'update' })
    const started = toolImagesDefinition.start({} as never, { event: complete } as never, {} as never)
    const updated = toolImagesDefinition.update({ state: started } as never, { event: review } as never)
    expect(started.items[0]!.createdAt).toBe(complete.time)
    expect(updated.items[0]!.createdAt).toBe(complete.time)
    const other = parseImageOutputReceipt(receipt({ call_id: 'call-other' }))!
    const otherTurn = parseImageOutputReceipt(receipt({ revision: 99 }))!
    expect(terminalImageItems([
      hidden(updated.items[0]! as never), hidden(other, 'other'), hidden(otherTurn, 'other-turn', 2),
      { ...hidden(updated.items[0]! as never, 'visible'), visibility: 'visible' },
    ] as never, ['call-image-1'], 1)).toEqual([updated.items[0]!])
    expect(toolImagesDefinition.match({ type: 'tool/result', seq: 10, data: {} } as never)).toBeNull()
    expect(parseImageOutputReceipt(receipt({ revision: 1, status: 'running', returned_count: 0, content: [], output: undefined }))).toBeNull()
    expect(parseImageOutputReceipt(receipt({ failure_code: '/Users/private/image.png' }))).toBeNull()
    expect(parseImageOutputReceipt({ ...receipt(), extra: true })).toBeNull()
  })

  it.each([1, 4, 8])('renders %i images as one rail and the same Turn ZIP once', (count) => {
    const items = Array.from({ length: count }, (_, index) => parseImageOutputReceipt(receipt({
      call_id: `call-${index + 1}`,
      content: [{ type: 'image', attachment: { ...attachment, attachmentId: `sha256:${String(index + 1).padStart(64, '0')}`, name: `${index + 1}.png` } }],
    }))!)
    const props = terminalProps(items.map((item, index) => hidden(item, `r${index}`)), {
      callIds: items.map(item => item.callId), paths: ['out/images.zip'],
    })
    render(<ArtifactTerminal {...props as never} />)
    expect(screen.getByRole('region', { name: '图片结果' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /图片操作/u })).toHaveLength(count)
    expect(screen.getByRole('button', { name: '打开 images.zip' })).toBeTruthy()
    expect(screen.getAllByText('images.zip')).toHaveLength(1)
  })

  it.each([1, 3, 7])('renders %i native files with a six-row cap and no path leak', (count) => {
    const paths = Array.from({ length: count }, (_, index) => `folder-${index % 2}/${
      index < 2 ? '同名产物.pptx' : index === 2 ? '未知格式.bin' : `很长的中文文件名-${index}.pdf`
    }`)
    const view = render(<ArtifactTerminal {...terminalProps([], { callIds: [], paths }) as never} />)
    expect(screen.getAllByRole('button', { name: /^打开 /u })).toHaveLength(Math.min(count, 6))
    expect(view.container.textContent).not.toContain('/work')
    expect(screen.queryByRole('button', { name: /展开其余/u }) === null).toBe(count <= 6)
    if (count > 6) {
      fireEvent.click(screen.getByRole('button', { name: /展开其余/u }))
      expect(screen.getAllByRole('button', { name: /^打开 /u })).toHaveLength(count)
    }
  })

  it.each([
    ['docx', 'FileText'], ['pdf', 'FileText'], ['xlsx', 'FileSpreadsheet'], ['csv', 'FileSpreadsheet'],
    ['pptx', 'FileChartColumn'], ['html', 'File'], ['md', 'FileText'], ['txt', 'FileText'],
    ['zip', 'FileArchive'], ['json', 'FileJson2'], ['unknown', 'File'],
  ])('uses the upload icon and compact text style for %s terminal files', (extension, icon) => {
    const name = `完整的很长中文文件名称与版本信息-${extension}.${extension}`
    const path = `private/output/${name}`
    const props = terminalProps([], { callIds: [], paths: [path] })
    const view = render(<ArtifactTerminal {...props as never} />)
    const open = screen.getByRole('button', { name: `打开 ${name}` })
    const svg = open.querySelector('svg[data-file-icon]')
    expect(svg?.getAttribute('data-file-icon')).toBe(icon)
    expect(svg?.parentElement?.className).toBe(fileCss.icon)
    expect(screen.getByText(name).className).toBe(fileCss.name)
    expect(screen.getByText(name).getAttribute('title')).toBe(name)
    expect(screen.getByText(extension.toUpperCase()).className).toBe(fileCss.extension)
    expect(open.getAttribute('title')).toBe(name)
    expect(open.tabIndex).toBe(0)
    open.focus()
    expect(document.activeElement).toBe(open)
    fireEvent.click(open)
    expect(props.openFile).toHaveBeenCalledWith(path)
    expect(screen.getByRole('button', { name: `打开方式：${name}` }).tabIndex).toBe(0)
    expect(view.container.textContent).not.toContain('private/output')
  })

  it('keeps legacy downloads and unavailable evidence while reusing upload file presentation', () => {
    const name = '很长的历史项目结果及附件名称.docx'
    const sha = 'a'.repeat(64)
    const node = { data: { items: [
      { status: 'available', artifact_id: `legacy-sha256:${sha}`, kind: 'artifact', message_seq: '1',
        name, media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size_bytes: 2048, sha256: sha },
      { status: 'unavailable', kind: 'attachment', message_seq: '2', name: '找不到的报表.xlsx', reason: '原始文件不可用' },
    ] } }
    const view = render(<LegacyArtifacts {...{ node, canDownload: true } as never} />)
    const download = screen.getByRole('link', { name: `下载 ${name}` })
    expect(download.getAttribute('href')).toBe(`/api/e-mate/legacy-artifact.download?id=${sha}`)
    expect(download.getAttribute('download')).toBe(name)
    expect(download.tabIndex).toBe(0)
    expect(screen.getByText(name).getAttribute('title')).toBe(name)
    expect(screen.getByText('DOCX · 2.0 KiB').className).toBe(fileCss.extension)
    expect(view.container.querySelectorAll(`.${fileCss.icon} svg[data-file-icon]`)).toHaveLength(2)
    expect(view.container.querySelector('[data-status="unavailable"] svg')?.getAttribute('data-file-icon')).toBe('FileSpreadsheet')
    expect(screen.getByText('不可用 · 原始文件不可用')).toBeTruthy()
    cleanup()
    render(<LegacyArtifacts {...{ node, canDownload: false } as never} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('仅可在本机下载')).toBeTruthy()
    expect(screen.getByText('不可用 · 原始文件不可用')).toBeTruthy()
  })

  it('closes the one file menu outside or by Escape and keeps keyboard order', async () => {
    const paths = Array.from({ length: 7 }, (_, index) => `folder-${index}/很长的中文文件名-${index}.pptx`)
    const props = terminalProps([], { callIds: [], paths })
    const view = render(<ArtifactTerminal {...props as never} />)
    expect(screen.getAllByText('PPTX')).toHaveLength(6)
    expect(screen.getByRole('button', { name: '展开其余 1 项文件' })).toBeTruthy()
    expect(view.container.textContent).not.toContain('/work')
    fireEvent.click(screen.getByRole('button', { name: /打开方式：很长的中文文件名-0/u }))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    fireEvent.pointerDown(document.body)
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: /打开方式：很长的中文文件名-0/u }))
    const first = screen.getByRole('menuitem', { name: '在默认应用中打开' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '打开方式 > 选择应用…' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /打开方式：很长的中文文件名-0/u }))
  })

  it('adds a completed image without sending and blocks needs-review', async () => {
    const completed = parseImageOutputReceipt(receipt())!
    const props = terminalProps([hidden(completed)])
    const view = render(<ArtifactTerminal {...props as never} />)
    fireEvent.click(screen.getByRole('button', { name: '图片操作：result.png' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '添加到聊天' }))
    await waitFor(() => { expect(props.addImageToDraft).toHaveBeenCalledWith(attachment) })
    expect(props.notify).not.toHaveBeenCalled()

    cleanup()
    const review = parseImageOutputReceipt(receipt({ revision: 3, status: 'needs-review' }))!
    render(<ArtifactTerminal {...terminalProps([hidden(review)]) as never} />)
    fireEvent.contextMenu(screen.getByText('result.png'))
    expect((screen.getByRole('menuitem', { name: '添加到聊天' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.container.querySelectorAll('[role="menu"]')).toHaveLength(0)
  })

  it('removes failed and cancelled Turn rows and reports one transient aggregate only once', () => {
    const failed = parseImageOutputReceipt(receipt({
      call_id: 'failed-call', status: 'failed', content: [], output: undefined,
      failure_code: 'provider-result-uncommitted',
    }))!
    const cancelled = parseImageOutputReceipt(receipt({
      call_id: 'cancelled-call', status: 'cancelled', content: [], output: undefined,
      failure_code: 'cancelled',
    }))!
    const props = terminalProps(
      [hidden(failed, 'failed'), hidden(cancelled, 'cancelled')],
      { callIds: ['failed-call', 'cancelled-call'], paths: [] },
    )
    const failureView = render(<ArtifactTerminal {...props as never} />)

    expect(failureView.container.firstChild).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(failureView.container.querySelector('[aria-label^="图片操作"]')).toBeNull()
    expect(props.notify).toHaveBeenCalledOnce()
    expect(props.notify).toHaveBeenCalledWith(
      'error',
      '2 张图片生成失败，可在画廊的「失败」筛选中查看详情。',
    )

    failureView.rerender(<ArtifactTerminal {...props as never} />)
    expect(props.notify).toHaveBeenCalledOnce()
  })

  it('fails closed for busy or full drafts', () => {
    const completed = parseImageOutputReceipt(receipt())!
    const busy = terminalProps([hidden(completed)], undefined, {
      useInput: (selector: (value: unknown) => unknown) => selector({ imageIds: [], phase: 'submitting' }),
    })
    render(<ArtifactTerminal {...busy as never} />)
    fireEvent.click(screen.getByRole('button', { name: '图片操作：result.png' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '添加到聊天' }))
    expect(busy.addImageToDraft).not.toHaveBeenCalled()
    expect(busy.notify).toHaveBeenCalledWith('error', '当前正在发送消息，请稍后再添加图片。')

    cleanup()
    const full = terminalProps([hidden(completed)], undefined, {
      useInput: (selector: (value: unknown) => unknown) => selector({ imageIds: Array(20).fill('draft'), phase: 'plain' }),
    })
    render(<ArtifactTerminal {...full as never} />)
    fireEvent.click(screen.getByRole('button', { name: '图片操作：result.png' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '添加到聊天' }))
    expect(full.addImageToDraft).not.toHaveBeenCalled()
    expect(full.notify).toHaveBeenCalledWith('error', '最多可添加 20 张图片。')
  })

  it('loads and dispatches a native image action only after the operator chooses it', async () => {
    const completed = parseImageOutputReceipt(receipt())!
    const props = terminalProps([hidden(completed)])
    render(<ArtifactTerminal {...props as never} />)
    expect(props.loadImage).not.toHaveBeenCalled()
    expect(props.runResource).not.toHaveBeenCalled()
    fireEvent.contextMenu(screen.getByText('result.png'))
    fireEvent.click(screen.getByRole('menuitem', { name: '下载副本' }))
    await waitFor(() => { expect(props.runResource).toHaveBeenCalledWith({
      action: 'save-as',
      resource: { kind: 'image', sessionId: 'session-1', name: 'result.png', src: 'blob:image' },
    }) })
  })

  it('does not expose lower-level paths when adding an image fails', async () => {
    const completed = parseImageOutputReceipt(receipt())!
    const props = terminalProps([hidden(completed)], undefined, {
      addImageToDraft: vi.fn(async () => { throw new Error('/Users/private/result.png') }),
    })
    render(<ArtifactTerminal {...props as never} />)
    fireEvent.click(screen.getByRole('button', { name: '图片操作：result.png' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '添加到聊天' }))
    await waitFor(() => {
      expect(props.notify).toHaveBeenCalledWith('error', '图片未能添加到聊天，请重试。')
    })
    expect(props.notify.mock.calls.flat().join(' ')).not.toContain('/Users')
  })

  it('fails a native file action without leaking the local path', async () => {
    const props = terminalProps([], { callIds: [], paths: ['private/report.pdf'] }, {
      runResource: vi.fn(async () => { throw new Error('/Users/private/report.pdf') }),
    })
    render(<ArtifactTerminal {...props as never} />)
    fireEvent.click(screen.getByRole('button', { name: '打开方式：report.pdf' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在 Finder 中显示' }))
    await waitFor(() => {
      expect(props.notify).toHaveBeenCalledWith('error', '系统文件操作失败，请确认资源仍存在且属于当前工作区。')
    })
    expect(props.notify.mock.calls.flat().join(' ')).not.toContain('/Users')
  })

  it('has no DOM relocation, persistent observer or model/provider heuristic', () => {
    const source = readFileSync(resolve('src/client/image-gallery.tsx'), 'utf8')
    const contract = readFileSync(resolve('src/client/image-gallery-contract.ts'), 'utf8')
    expect(source).not.toMatch(/querySelector|createPortal|MutationObserver|setInterval/u)
    expect(source).not.toMatch(/gpt-image|provider/u)
    expect(source).not.toContain('imageBatchRetryTasks')
    expect(source).toContain('subagentsByParent')
    expect(source.match(/child_session_id/gu)).toHaveLength(1)
    expect(source).toContain('row.receipt.child_session_id !== undefined')
    expect(source).not.toMatch(/child_session_id\s*:/u)
    expect(contract).toContain("kind: 'subagent'")
    expect(contract).not.toMatch(/childSessionId|delegations/u)
    expect(`${source}\n${contract}`).not.toMatch(/indexedDB|localStorage|sessionStorage|tombstone|\bfetch\s*\(|WebSocket|EventSource|setTimeout|setInterval/u)
    // 0.1.5 forbids value-importing another feature plugin's component.
    expect(source).toContain("renderSlot('conversation.message.images'")
    expect(source).toContain("visibility: 'hidden'")
    const apply = readFileSync(resolve('src/client/index.ts'), 'utf8')
    expect(apply).toContain("ctx.slots.inject('conversation.view'")
    expect(apply).toContain('owner.readAttachment(attachment.attachmentId)')
    expect(apply).not.toMatch(/\bfetch\s*\(/u)
    expect(apply).not.toContain('ctx.conversation.input.for(scope).notify')
    expect(apply).toContain('releaseDraftImages(images)')
  })
})


describe('native image render stability', () => {
  it.each(['gallery', 'terminal'] as const)('keeps loaded %s images visible through 20 unrelated renders', async kind => {
    nativeImageRendering.enabled = true
    const item = { ...parseImageOutputReceipt(receipt())!, createdAt: 1234 }
    const props = kind === 'gallery'
      ? galleryProps('session-1', [hidden(item)])
      : terminalProps([hidden(item)])
    const component = () => kind === 'gallery'
      ? <ImageGalleryView {...props as any} />
      : <ArtifactTerminal {...props as any} />
    const view = render(component())
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
    const image = screen.getByRole('img')
    for (let i = 0; i < 20; i++) {
      view.rerender(component())
      expect.soft(screen.queryByRole('img')).toBe(image)
      await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
    }
    expect(props.loadImage).toHaveBeenCalledTimes(1)
  })

  it('retains native failure retry and reloads when the authorized loader changes', async () => {
    nativeImageRendering.enabled = true
    const item = parseImageOutputReceipt(receipt())!
    const loadImage = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue('blob:retry')
    const props = galleryProps('session-1', [hidden(item)], { loadImage })
    const view = render(<ImageGalleryView {...props as any} />)
    const retry = await screen.findByRole('button', { name: /重试/ })
    view.rerender(<ImageGalleryView {...props as any} />)
    expect(loadImage).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:retry'))
    expect(loadImage).toHaveBeenCalledTimes(2)
    const replacement = vi.fn(async () => 'blob:new-identity')
    view.rerender(<ImageGalleryView {...props as any} loadImage={replacement} />)
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:new-identity'))
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['attachmentId', `sha256:${'b'.repeat(64)}`], ['mediaType', 'image/jpeg'],
    ['bytes', 99], ['width', 8], ['height', 9], ['name', 'renamed.png'],
  ])('reloads changed attachment %s instead of retaining stale metadata', async (field, value) => {
    nativeImageRendering.enabled = true
    const item = parseImageOutputReceipt(receipt())!
    const loadImage = vi.fn(async () => 'blob:image')
    const view = render(<ImageGalleryView {...galleryProps('session-1', [hidden(item)], { loadImage }) as any} />)
    await screen.findByRole('img')
    const nextAttachment = { ...attachment, [field]: value }
    const next = { ...item, attachment: nextAttachment }
    view.rerender(<ImageGalleryView {...galleryProps('session-1', [hidden(next)], { loadImage }) as any} />)
    await screen.findByRole('img')
    expect(loadImage).toHaveBeenCalledTimes(2)
    expect(loadImage).toHaveBeenLastCalledWith(nextAttachment, undefined)
  })

  it('changes owner and revision without displaying a late result from the previous owner', async () => {
    nativeImageRendering.enabled = true
    const item = parseImageOutputReceipt(receipt())!
    let finishOld!: (url: string) => void
    const loadImage = vi.fn((_attachment, owner) => owner === 'old-owner'
      ? new Promise<string>(resolve => { finishOld = resolve })
      : Promise.resolve('blob:new-owner'))
    const owned = (sessionId: string, revision: number) => ({ ...item, revision,
      source: { kind: 'subagent' as const, sessionId, label: 'child', ordinal: 1, mode: 'one-shot' as const },
    })
    const view = render(<ImageGalleryView {...galleryProps('session-1', [hidden(owned('old-owner', 2))], { loadImage }) as any} />)
    view.rerender(<ImageGalleryView {...galleryProps('session-1', [hidden(owned('new-owner', 2))], { loadImage }) as any} />)
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:new-owner'))
    await act(async () => { finishOld('blob:old-owner') })
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:new-owner')
    view.rerender(<ImageGalleryView {...galleryProps('session-1', [hidden(owned('new-owner', 3))], { loadImage }) as any} />)
    await screen.findByRole('img')
    expect(loadImage).toHaveBeenCalledTimes(3)
    expect(loadImage.mock.calls.map(call => call[1])).toEqual(['old-owner', 'new-owner', 'new-owner'])
  })

})


describe('indexed terminal projection', () => {
  it.each(['completed', 'interrupted'])('shows a direct image during verification and keeps one card through retries and %s', (ending) => {
    const callId = 'call-image|fc-response-item'
    const data = { 'e-mate-image-calls': { calls: [{ callId, seq: 2 }] } }
    const item = parseImageOutputReceipt(receipt({ call_id: callId }))!
    let currentTurn = turn(data, 1, 'open')
    let nodes: any[] = []
    let seq = 2
    const props = () => {
      const matched = selectArtifactTerminal({ turn: currentTurn, nodes, seq, openFile: vi.fn() } as never)!
      return terminalProps(nodes, matched, { turn: currentTurn, seq })
    }
    const view = render(<ArtifactTerminal {...props() as any} />)
    expect(screen.queryByRole('button', { name: 'result.png，点击查看原图' })).toBeNull()
    nodes = [hidden(item)]
    seq = 4
    view.rerender(<ArtifactTerminal {...props() as any} />)
    const image = screen.getByRole('button', { name: 'result.png，点击查看原图' })
    // A later verification failure and model retry do not revoke produced bytes.
    nodes = [...nodes, { key: 'verify', kind: 'tool-call', location: { kind: 'turn', turn: currentTurn }, data: { root: { kind: 'tool-result', isError: true } } }]
    seq = 6
    view.rerender(<ArtifactTerminal {...props() as any} />)
    expect(screen.getByRole('button', { name: 'result.png，点击查看原图' })).toBe(image)
    nodes = [...nodes, { key: 'retry', kind: 'retry', location: { kind: 'turn', turn: currentTurn }, data: {} }]
    seq = 7
    view.rerender(<ArtifactTerminal {...props() as any} />)
    expect(screen.getAllByRole('button', { name: 'result.png，点击查看原图' })).toHaveLength(1)
    currentTurn = { ...turn(data), end: { type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: ending } } } } as any
    seq = 8
    view.rerender(<ArtifactTerminal {...props() as any} />)
    expect(screen.getAllByRole('button', { name: 'result.png，点击查看原图' })).toEqual([image])
  })

  it('reads only its turn and no child receipts across unrelated updates, while a live reader still applies revisions and removals', () => {
    const original = parseImageOutputReceipt(receipt())!
    const rows = new Map<string, any>([['receipt', hidden(original)]])
    const get = vi.fn((key: string) => rows.get(key))
    const values = vi.fn(() => [...rows.values()])
    const getTurn = vi.fn((turn: number) => turn === 1 ? [...rows.keys()] : [])
    const chat = { nodes: { get, values }, locations: { getTurn } }
    let snapshot = { chat }
    const listeners = new Set<() => void>()
    const useSession = bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } } })
    const childProjection = vi.fn(() => { throw new Error('unrelated child must not be read') })
    const sessions = { byId: { 'session-1': {}, child: { get projectionValues() { return childProjection() } } }, subagentsByParent: { 'session-1': { entries: [{ kind: 'child', id: 'child', mode: 'one-shot' }] } } }
    const props = terminalProps([], undefined, {useSession, useSessions: (select: any) => select(sessions)})
    render(<ArtifactTerminal {...props as any} />)
    expect(screen.getByRole('button', {name: 'result.png，点击查看原图'})).toBeTruthy()
    get.mockClear()
    for(let i = 0; i < 20; i++) act(() => { snapshot = {chat}; listeners.forEach(fn => fn()) })
    expect(values).not.toHaveBeenCalled()
    expect(childProjection).not.toHaveBeenCalled()
    expect(get.mock.calls.every(([key]) => key === 'receipt')).toBe(true)
    act(() => {
      rows.set('receipt', hidden({...original, revision: 3, attachment: {...attachment, name: 'updated.png'}}))
      snapshot = {chat}; listeners.forEach(fn => fn())
    })
    expect(screen.getByRole('button', {name: 'updated.png，点击查看原图'})).toBeTruthy()
    act(() => { rows.clear(); snapshot = {chat}; listeners.forEach(fn => fn()) })
    expect(screen.queryByRole('button', {name: /查看原图/})).toBeNull()
  })
})


describe('native typed tool image outputs', () => {
  const native = (callId: string, parts: any[], options: { turn?: number; error?: boolean; subCalls?: any[] } = {}) => ({
    key: callId, kind: 'tool-call', target: 'chat', anchorSeq: 2, visibility: 'visible',
    location: { kind: 'step', turn: turn({}, options.turn ?? 1, 'open') },
    data: { root: { kind: 'tool-result', callId, call: { name: 'arbitrary-plugin-tool', argsRaw: '{}' },
      content: parts, isError: options.error === true, seq: 3, time: 3000, subCalls: options.subCalls ?? [] } },
  } as any)
  const image = (id: string) => ({ type: 'image', attachment: { ...attachment, attachmentId: `sha256:${id.repeat(64)}`, name: `${id}.png` } })

  it('selects typed multi-image outputs across tools and native nested calls, never prose or other turns', () => {
    const nested = native('nested', [image('a'), image('c')]).data.root
    const nodes = [native('one', [image('a'), image('b')]), native('two', [image('a')], { subCalls: [nested] }),
      native('prose', [{ type: 'text', text: JSON.stringify(image('d')) }]),
      native('failed', [image('e')], { error: true }), native('other-turn', [image('f')], { turn: 2 })]
    const matched = selectArtifactTerminal({ turn: turn({}, 1, 'open'), seq: 4, nodes, openFile: vi.fn() } as any)!
    expect(matched.callIds).toEqual(['one', 'two', 'nested'])
    const items = terminalImageItems(nodes, matched.callIds, 1)
    expect(items.map(item => item.attachment?.name)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(selectArtifactTerminal({ turn: turn({}, 1, 'open'), seq: 2, nodes, openFile: vi.fn() } as any)?.callIds).toEqual(matched.callIds)
  })

  it('preserves strict receipts over duplicate native outputs and cannot promote failed or review-required calls', () => {
    const review = parseImageOutputReceipt(receipt({ call_id: 'review', status: 'needs-review', content: [image('a')] }))!
    const failed = parseImageOutputReceipt(receipt({ call_id: 'failed', status: 'failed', content: [], failure_code: 'failed' }))!
    const nodes = [hidden(review, 'review'), hidden(failed, 'failed'), native('review', [image('a')]),
      native('failed', [image('b')]), native('job-output', [image('a')]), native('unrelated', [image('c')])]
    const items = terminalImageItems(nodes, ['review', 'failed', 'job-output', 'unrelated'], 1)
    expect(items.map(item => [item.callId, item.status])).toEqual([
      ['review', 'review-required'], ['failed', 'failed'], ['unrelated', 'completed'],
    ])
    expect(items.filter(item => item.attachment)).toHaveLength(2)
    const completed = parseImageOutputReceipt(receipt({ call_id: 'generated', revision: 2 }))!
    const merged = terminalImageItems([hidden({ ...completed, revision: 1 }, 'old'), hidden(completed, 'new'),
      native('generated', [{ type: 'image', attachment }]), native('nested-owner', [], { subCalls: [native('repeat', [{ type: 'image', attachment }]).data.root] }),
    ], ['generated', 'repeat'], 1)
    expect(merged).toEqual([completed])
  })

  it.each(['failed', 'unknown', 'needs-review', 'completed'])('keeps strict %s receipts authoritative when the assistant echoes a prior successful tool image', status => {
    const adapter = readFileSync(resolve('../../../../../scripts/harness-conversation-adapter.mjs'), 'utf8')
    const start = adapter.indexOf('function emateAssistantImageBlocks(')
    const end = adapter.indexOf('function emateSameAssistantBlocks(', start)
    const filter = new Function(adapter.slice(start, end) + '; return emateAssistantImageBlocks')()
    const original = image('a')
    const strict = parseImageOutputReceipt(receipt({ call_id: 'generated', revision: 3, status,
      content: status === 'completed' || status === 'needs-review' ? [original] : [],
      ...status === 'failed' || status === 'unknown' ? { failure_code: status } : {},
    }))!
    expect(strict).not.toBeNull()
    const rows = [native('generated', [original]), hidden(strict, 'latest')]
    const blocks = [{ kind: 'text', text: '保留说明' }, { kind: 'image', attachment: original.attachment }]
    const assistant = { location: rows[0].location, data: { blocks } }
    const nodes = new Map(rows.map((row, index) => [String(index), row]))
    const filtered = filter({ chat: { nodes, locations: { getTurn: () => [...nodes.keys()] } } }, assistant)
    const terminal = terminalImageItems(rows, ['generated'], 1)
    expect(filtered).toEqual([blocks[0]])
    expect(terminal).toEqual([strict])
    const visible = [...filtered.filter((block: any) => block.kind === 'image'), ...terminal.filter(item => item.attachment)]
    expect(visible).toHaveLength(status === 'completed' || status === 'needs-review' ? 1 : 0)
    expect(terminal[0].status).toBe(status === 'needs-review' ? 'review-required' : status === 'completed' ? 'completed' : 'failed')
  })

  it('displays native images immediately through MessageImage and retains them across retries, cancellation and session changes', async () => {
    nativeImageRendering.enabled = true
    const nodes = [native('native-call', [image('a'), image('b')])]
    const loadImage = vi.fn(async (ref: any) => `blob:first-${ref.name}`)
    const match = selectArtifactTerminal({ turn: turn({}, 1, 'open'), seq: 4, nodes, openFile: vi.fn() } as any)!
    const props = terminalProps(nodes, match, { turn: turn({}, 1, 'open'), loadImage })
    const view = render(<ArtifactTerminal {...props as any} />)
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
    expect(loadImage.mock.calls.map(call => call[0].attachmentId)).toEqual([image('a').attachment.attachmentId, image('b').attachment.attachmentId])
    view.rerender(<ArtifactTerminal {...props as any} seq={8} />)
    expect(screen.getAllByRole('img')).toHaveLength(2)
    view.rerender(<ArtifactTerminal {...props as any} turn={{ ...turn({}), end: { data: { reason: { kind: 'interrupted' } } } } as any} />)
    expect(screen.getAllByRole('img')).toHaveLength(2)
    const otherNodes = [native('native-call', [image('c')])]
    const otherLoad = vi.fn(async () => 'blob:other-session')
    const otherProps = terminalProps(otherNodes, match, { sessionId: 'other-session', loadImage: otherLoad })
    view.rerender(<ArtifactTerminal {...otherProps as any} />)
    await waitFor(() => expect(screen.getAllByRole('img').map(img => img.getAttribute('src'))).toEqual(['blob:other-session']))
    expect(otherLoad.mock.calls[0]?.[0]).toMatchObject({ attachmentId: image('c').attachment.attachmentId })
  })
})


describe('dsh-imagegen native receipt integration', () => {
  it('accepts one atomic multi-image result and rejects malformed metadata without reinterpreting historical receipts', () => {
    const images = 'abcd'.split('').map(digit => ({ ...attachment, attachmentId: `sha256:${digit.repeat(64)}` }))
    expect(parseImageOutputGroup(v3Receipt({ requested_count: 4, returned_count: 4, content: images.map(attachment => ({ type: 'image', attachment })) }))?.items).toHaveLength(4)
    expect(parseImageOutputGroup(v3Receipt({ revision: 1, status: 'running', returned_count: 0, content: [] }))?.items).toEqual([])
    expect(parseImageOutputGroup(v3Receipt({ status: 'failed', returned_count: 0, failed_count: 1, content: [], error: 'unavailable' }))?.items[0]?.status).toBe('failed')
    for (const override of [{ revision: 3 }, { content: Array(5).fill({ type: 'image', attachment }) },
      { content: [{ type: 'image', attachment: { ...attachment, width: 0 } }] },
      { root_call_id: '' }, { turn: -1 }, { output: attachment }, { verification: {} }, { tool_name: 'imagegen' }]) {
      expect(parseImageOutputGroup(v3Receipt(override))).toBeNull()
    }
    expect(parseImageOutputReceipt(v3Receipt())).toBeNull()
  })

  it.each(['generate_image', 'edit_image', 'run_code'])('shows all four %s outputs before the parent tool settles and preserves native cards through close and replay', async name => {
    nativeImageRendering.enabled = true
    const images = 'abcd'.split('').map(digit => ({ ...attachment, attachmentId: `sha256:${digit.repeat(64)}`, name: digit + '.png' }))
    const rootCallId = 'root-image', callId = name === 'run_code' ? 'root-image:code:0' : rootCallId
    const payload = v3Receipt({ call_id: callId, root_call_id: rootCallId,
      tool_name: name === 'edit_image' ? 'edit_image' : 'generate_image', operation: name === 'edit_image' ? 'edit' : 'generate',
      requested_count: 4, returned_count: 4, content: images.map(attachment => ({ type: 'image', attachment })) })
    const events: any[] = []
    const createAssembler = () => new ConversationNodeAssembler({
      entries: () => [assistantDefinition, toolDefinition, adaptedTurnTailDefinition(), imageCallsDefinition, toolImagesDefinition],
      fallbackEntry: () => unknownFallbackDefinition,
    }, { entries: () => [chatViewDefinition] })
    const assembler = createAssembler()
    assembler.replaceWindow([], false); assembler.flush()
    const append = (type: string, data: unknown, surfaceOp?: 'append') => {
      const next = { type, data, seq: events.length + 1, time: 1_789_005_000_000 + events.length, ...surfaceOp === undefined ? {} : { surfaceOp } }
      events.push(next)
      if (assembler.append({ type: 'event', event: next } as never) !== 'none') assembler.flush()
    }
    append('turn/start', { turn: 1 }); append('step/start', { turn: 1, step: 1 })
    append('tool/call', { turn: 1, step: 1, callId: rootCallId, name, arguments: '{}' })
    if (name === 'run_code') append('tool/code-dispatch-start', { rootCallId, parentCallId: rootCallId,
      subCallId: callId, name: 'generate_image', arguments: { prompt: 'four images', count: 4 } })
    append('emate/image-output', { ...payload, revision: 1, status: 'running', returned_count: 0, content: [] })
    append('emate/image-output', payload)
    const projected = () => [...(assembler.snapshot('chat') as any).nodes.values()]
    let nodes = projected()
    const tail = nodes.find(node => node.kind === 'turn-tail')!
    expect(tail).toBeDefined(); expect(tail.location.turn.status).toBe('open')
    expect(tail.data.closing).toBeNull()
    expect(nodes.filter(node => node.kind === 'turn-tail')).toHaveLength(1)
    let matched = selectArtifactTerminal({ turn: tail.location.turn, nodes, seq: 1 } as never)!
    expect(matched.callIds).toEqual([callId])
    expect(terminalImageItems(nodes, matched.callIds, 1).map(item => item.attachment?.attachmentId)).toEqual(images.map(image => image.attachmentId))
    const loadImage = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
    const view = render(<ArtifactTerminal {...terminalProps(nodes, matched, { turn: tail.location.turn, loadImage }) as any} />)
    const buttons = screen.getAllByRole('button', { name: /，点击查看原图$/ })
    expect(buttons).toHaveLength(4)
    await waitFor(() => expect(loadImage).toHaveBeenCalledTimes(4))
    // Code child output has no presentationMeta; the v3 event supplies all four native cards.
    if (name === 'run_code') append('tool/code-dispatch', { rootCallId, parentCallId: rootCallId,
      subCallId: callId, name: 'generate_image', arguments: {}, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ status: 'completed', images }) }] })
    append('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: rootCallId },
      content: [{ type: 'tool-result', toolCallId: rootCallId, isError: false, content: [{ type: 'text', text: 'completed' }] }] } }, 'append')
    append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '图片已完成。' }] } }, 'append')
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }); append('turn/start', { turn: 2 })
    nodes = projected(); const closed = nodes.find(node => node.key === tail.key)!
    expect(closed.location.turn.status).toBe('closed')
    matched = selectArtifactTerminal({ turn: closed.location.turn, nodes, seq: closed.data.seq } as never)!
    view.rerender(<ArtifactTerminal {...terminalProps(nodes, matched, { turn: closed.location.turn, loadImage }) as any} />)
    expect(screen.getAllByRole('button', { name: /，点击查看原图$/ })).toEqual(buttons)
    const nextTurn = (assembler.snapshot('chat') as any).timeline.turns.get(2)
    expect(selectArtifactTerminal({ turn: nextTurn, nodes, seq: events.length } as never)).toBeNull()
    const cold = createAssembler(); cold.replaceWindow(events.map(event => ({ type: 'event', event })), false); cold.flush()
    expect(galleryImageItems([...(cold.snapshot('chat') as any).nodes.values()])).toEqual(galleryImageItems(nodes))
    expect(galleryImageItems(nodes)).toHaveLength(4)
    view.unmount()
  })

  it('background Code completion during the next Turn stays with its root call on live and cold replay', () => {
    const rootCallId = 'background-code', callId = rootCallId + ':code:0'
    const payload = v3Receipt({ call_id: callId, root_call_id: rootCallId })
    const events: any[] = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}' } },
      { type: 'emate/image-output', data: { ...payload, revision: 1, status: 'running', returned_count: 0, content: [] } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'emate/image-output', data: payload },
    ].map((event, index) => ({ ...event, seq: index + 1, time: index + 1 }))
    for (const incremental of [false, true]) {
      const assembler = new ConversationNodeAssembler({
        entries: () => [toolDefinition, adaptedTurnTailDefinition(), imageCallsDefinition, toolImagesDefinition],
        fallbackEntry: () => unknownFallbackDefinition,
      }, { entries: () => [chatViewDefinition] })
      if (incremental) { assembler.replaceWindow([], false); for (const event of events) { assembler.append({ event }); assembler.flush() } }
      else { assembler.replaceWindow(events.map(event => ({ event, view: undefined })), false); assembler.flush() }
      const snapshot = assembler.snapshot('chat') as any, nodes = [...snapshot.nodes.values()]
      const tail = nodes.find(node => node.kind === 'turn-tail' && node.data.turn === 1)
      const matched = selectArtifactTerminal({ turn: tail.location.turn, nodes, seq: 2 } as never)!
      expect(terminalImageItems(nodes, matched.callIds, 1)).toMatchObject([{ callId, attachment }])
      expect(selectArtifactTerminal({ turn: snapshot.timeline.turns.get(2), nodes, seq: 5 } as never)).toBeNull()
      expect(galleryImageItems(nodes)).toHaveLength(1)
    }
  })
})


it('native result presentation restores query images without re-reading JSON text or duplicating Gallery images', () => {
  const original = parseImageOutputGroup(v3Receipt())!
  const query = { key: 'query', kind: 'tool-call', location: { kind: 'turn', turn: turn({}, 2, 'open') }, data: {
    root: { kind: 'tool-result', callId: 'query-call', seq: 12, time: 12, isError: false, subCalls: [],
      content: [{ type: 'text', text: 'model JSON remains text' }],
      resultView: { card: 'generic', content: [{ type: 'image', attachment }] } },
  } }
  const nodes = [{ ...hidden(original.items[0]!), data: original }, query]
  expect(terminalImageItems(nodes as never, ['query-call'], 2)).toMatchObject([{ callId: 'query-call', attachment }])
  expect(galleryImageItems(nodes as never)).toHaveLength(1)
})

it('a child v3 receipt keeps every attachment under the exact native child', () => {
  const images = 'ab'.split('').map(digit => ({ ...attachment, attachmentId: `sha256:${digit.repeat(64)}` }))
  const row = { seq: 9, createdAt: 10, receipt: v3Receipt({ parent_session_id: 'child', requested_count: 2,
    returned_count: 2, content: images.map(attachment => ({ type: 'image', attachment })) }) }
  const sessions = { byId: { child: { projectionValues: { eMateImageReceipts: [row] } } },
    subagentsByParent: { parent: { entries: [{ kind: 'child', id: 'child', mode: 'one-shot', label: '两张图' }] } } }
  expect(childGalleryImageItems(sessions as never, 'parent').map(item => item.attachment?.attachmentId)).toEqual(images.map(image => image.attachmentId))
  expect(childGalleryImageItems(sessions as never, 'other')).toEqual([])
})


it.each(['cancelled', 'failed'])('%s jobs keep saved images editable without manufacturing missing outputs', async status => {
  const group = parseImageOutputGroup(v3Receipt({ status, requested_count: 2, returned_count: 1, failed_count: 1, error: '仅保存 1 张' }))!
  expect(group.items).toHaveLength(1)
  expect(group.items[0]).toMatchObject({ status: 'completed', attachment })
  const nodes = [{ ...hidden(group.items[0]!), data: group }]
  expect(galleryImageItems(nodes as never)).toHaveLength(1)
  expect(terminalImageItems(nodes as never, [group.callId], 1)).toHaveLength(1)
  const addImageToCanvas = vi.fn(async () => {})
  render(<ArtifactTerminal {...terminalProps(nodes, undefined, { addImageToCanvas }) as any} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '加入画布：result.png' })))
  expect(addImageToCanvas).toHaveBeenCalledWith(attachment, undefined)
})


it('a paged history window with only the v3 terminal receipt still restores its saved images', () => {
  const payload = v3Receipt({ request_receipts: [{ client_request_id: 'request-1', task_id: 'request-1', trace_id: 'request-1', provider_request_id: 'provider-1' }] })
  const assembler = new ConversationNodeAssembler({ entries: () => [toolImagesDefinition], fallbackEntry: () => unknownFallbackDefinition },
    { entries: () => [chatViewDefinition] })
  assembler.replaceWindow([{ event: event(payload), view: undefined }] as never, false); assembler.flush()
  const nodes = [...(assembler.snapshot('chat') as any).nodes.values()]
  expect(galleryImageItems(nodes)).toMatchObject([{ callId: payload.call_id, attachment }])
  expect(terminalImageItems(nodes, [payload.call_id], 1)).toHaveLength(1)
})
