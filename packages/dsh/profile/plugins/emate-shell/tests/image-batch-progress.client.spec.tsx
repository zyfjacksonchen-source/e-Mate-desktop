import { createPetImageFactsReader } from '../src/client/pet-image-facts.ts'
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectionValueStore } from '../../../../../../upstream/deepseek-harness/packages/client/runtime/src/client/sessions/projection-store.ts'
import type { SessionListState, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import { useImageBatchProjection } from '../src/client/image-batch-client.ts'
import {
  ImageBatchProgress,
  type ImageBatchRetryCall,
  type ImageBatchRetryResult,
  type ImageBatchRetryTask,
} from '../src/client/image-batch-progress.tsx'
import { ArtifactTerminal, imageCallsDefinition, selectArtifactTerminal } from '../src/client/image-gallery.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-attachment', async () => {
  const { useEffect } = await import('react')
  return {
    MessageImage: ({ attachment, load, labels }: {
      attachment: { attachmentId?: string; name?: string }
      load: (attachment: unknown) => Promise<string>
      labels: { openNamed: (name: string) => string }
    }) => {
      useEffect(() => { void load(attachment) }, [attachment, load])
      return <button type="button" aria-label={labels.openNamed(attachment.name ?? 'image')}
        data-attachment-id={attachment.attachmentId}>{attachment.name}</button>
    },
  }
})

afterEach(cleanup)

const parentSessionId = 'batch-parent'
const parentCallId = 'batch-call'
const batchId = 'sha256:' + 'a'.repeat(64)
const taskIds = 'bcdef012'.split('').map(character => 'sha256:' + character.repeat(64))
const terminalEventId = 'sha256:' + '3'.repeat(64)
const attachment = {
  attachmentId: 'sha256:' + '9'.repeat(64), mediaType: 'image/png', bytes: 42, width: 2, height: 3, name: 'first.png',
}
const unrelatedAttachment = {
  ...attachment, attachmentId: 'sha256:' + '8'.repeat(64), name: 'unrelated.png',
}

function task(ordinal: number, state: string, revision = 1) {
  const linked = state !== 'queued' && state !== 'interrupted'
  const terminal = ['completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(state)
  const reviewable = state === 'completed' || state === 'needs-review'
  return {
    task_id: taskIds[ordinal - 1], ordinal, revision, state,
    submission_status: linked ? state === 'running' ? 'unknown' : 'submitted' : 'not-submitted',
    prompt_sha256: 'e'.repeat(64), image_url: [],
    ...(linked ? { child_session_id: 'child-' + ordinal, job_id: 'job-' + ordinal } : {}),
    ...(reviewable ? { receipt: {
      owner_session_id: 'child-' + ordinal, call_id: 'call-' + ordinal, revision: 2, event_seq: 9,
      status: state === 'completed' ? 'completed' : 'needs-review',
    } } : {}),
    ...(terminal && state !== 'completed' ? { failure_code: state === 'interrupted' ? 'interrupted' : 'task-' + state } : {}),
  }
}

function projection(states: readonly string[], options: {
  revisions?: readonly number[]; terminal?: boolean; imageBearingFailures?: readonly number[]
} = {}) {
  const tasks = states.map((state, index) => {
    const item = task(index + 1, state, options.revisions?.[index] ?? 1)
    if (state !== 'failed' || !options.imageBearingFailures?.includes(index + 1)) return item
    return { ...item, receipt: {
      owner_session_id: 'child-' + (index + 1), call_id: 'call-' + (index + 1),
      revision: 2, event_seq: 9, status: 'completed',
    } }
  })
  const images = tasks.filter(item => item.receipt?.status === 'completed').length
  const failures = tasks.filter(item => item.state !== 'completed').length
  const status = states.every(state => state === 'completed') && images === states.length
    ? 'completed'
    : images > 0 && failures > 0
      ? 'partial'
      : images === 0 && states.every(state => state === 'cancelled' || state === 'interrupted')
        ? 'cancelled'
        : 'failed'
  return [{
    schema_version: 1, batch_id: batchId, parent_session_id: parentSessionId, parent_call_id: parentCallId,
    concurrency: 3, tasks,
    image_evidence: tasks.filter(item => item.receipt?.status === 'completed').map(item => ({
      task_id: item.task_id, ordinal: item.ordinal, child_session_id: item.child_session_id, receipt: item.receipt,
    })),
    failures: tasks.filter(item => ['failed', 'cancelled', 'unknown', 'interrupted'].includes(item.state)).map(item => ({
      task_id: item.task_id, ordinal: item.ordinal, state: item.state, failure_code: item.failure_code,
      ...(item.child_session_id === undefined ? {} : { child_session_id: item.child_session_id }),
      ...(item.job_id === undefined ? {} : { job_id: item.job_id }),
      ...(item.receipt === undefined ? {} : { receipt: item.receipt }),
    })),
    ...(options.terminal ? { status, terminal_event_id: terminalEventId } : {}),
  }]
}

function imageReceipt(
  sessionId = 'child-1', callId = 'call-1', image: typeof attachment = attachment,
  status: 'completed' | 'needs-review' | 'failed' = 'completed',
) {
  return {
    schema_version: 2, revision: 2, call_id: callId, operation: 'generate', status,
    billing_status: 'recorded', parent_session_id: sessionId, sources: [],
    content: status === 'failed' ? [] : [{ type: 'image', attachment: image }], output: image, job_id: 'job-1',
    provider_request_id: 'provider-1', client_request_id: 'client-1', model: 'gpt-image-2-pro',
    verifier: { structural: 'attachment-cas-v1', semantic: 'not-required' },
    verification: { structural: 'passed', source_output: 'not-applicable', semantic: 'not-applicable' },
  }
}

function useProjectionFrom(store: ProjectionValueStore): UseProjection {
  return ((key: string, selector: (value: unknown) => unknown = value => value) => {
    const face = store.faceOf(key)
    return useSyncExternalStore(face.subscribe, () => selector(face.getSnapshot()))
  }) as UseProjection
}

function sessionHarness(initial: SessionListState) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const useSessions = <T,>(selector: (value: SessionListState) => T, equal: (a: T, b: T) => boolean = Object.is): T => {
    const selected = selector(useSyncExternalStore(
      listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      () => snapshot,
    ))
    const previous = useRef(selected)
    if (!equal(previous.current, selected)) previous.current = selected
    return previous.current
  }
  return {
    useSessions,
    set(next: SessionListState) { snapshot = next; for (const listener of [...listeners]) listener() },
    subscriptions: () => listeners.size,
  }
}

function emptySessions(): SessionListState {
  return { ids: [], byId: {}, roots: [], subagentsByParent: {}, diagnostics: [], current: undefined } as never
}

function projectedSessions(statuses: readonly ('completed' | 'needs-review' | 'failed')[]): SessionListState {
  const byId: Record<string, unknown> = {}
  statuses.forEach((status, index) => {
    const ordinal = index + 1
    const image = {
      ...attachment,
      attachmentId: 'sha256:' + '456789ab'[index]!.repeat(64),
      name: 'image-' + ordinal + '.png',
    }
    byId['child-' + ordinal] = { projectionValues: { eMateImageReceipts: [{
      seq: 9, createdAt: 10 + ordinal,
      receipt: imageReceipt('child-' + ordinal, 'call-' + ordinal, image, status),
    }] } }
  })
  return { ...emptySessions(), byId } as never
}

function renderProgress(
  store: ProjectionValueStore,
  sessions = sessionHarness(emptySessions()),
  loadImage = vi.fn(async () => 'blob:image'),
  retry: {
    retryCalls?: readonly ImageBatchRetryCall[]
    prepareRetry?: (task: ImageBatchRetryTask) => Promise<ImageBatchRetryResult>
  } = {},
) {
  function Owner() {
    const view = useImageBatchProjection(useProjectionFrom(store), parentSessionId)
    return <ImageBatchProgress
      batches={view.batches.filter(batch => batch.parentCallId === parentCallId)}
      {...retry.retryCalls === undefined ? {} : { retryCalls: retry.retryCalls }}
      {...retry.prepareRetry === undefined ? {} : { prepareRetry: retry.prepareRetry }}
      useSessions={sessions.useSessions}
      loadImage={loadImage}
    />
  }
  const result = render(<Owner />)
  return { ...result, sessions, loadImage }
}

describe('live image batch progress', () => {
  it('binds only image_batch calls to an open Turn tail while preserving legacy imagegen closure', () => {
    const start = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
    const initial = imageCallsDefinition.start({} as never, { event: start } as never, {} as never)
    const sourceId = 'sha256:' + '7'.repeat(64)
    const loggedTasks = [
      { prompt: ' 第一张海报 ', image_url: [] },
      { prompt: '修改参考图', image_url: [sourceId, sourceId] },
    ]
    const call = { type: 'tool/call', seq: 2, time: 2, data: {
      turn: 1, step: 1, callId: parentCallId, name: 'image_batch',
      arguments: JSON.stringify({ tasks: loggedTasks, concurrency: 3 }),
    } }
    expect(imageCallsDefinition.match(call as never)).toEqual({ id: '1', role: 'update' })
    const state = imageCallsDefinition.update({ state: initial } as never, { event: call } as never)
    expect(state.batchCalls).toEqual([{
      callId: parentCallId, seq: 2, retryTasks: [
        { ordinal: 1, prompt: '第一张海报', imageIds: [] },
        { ordinal: 2, prompt: '修改参考图', imageIds: [sourceId] },
      ],
    }])
    const owner = { turn: { turn: 1, status: 'open', data: { get: () => state }, steps: [] }, nodes: [], seq: 2 }
    expect(selectArtifactTerminal(owner as never)).toEqual({
      callIds: [], batchCallIds: [parentCallId], batchRetryCalls: [{
        parentCallId, tasks: state.batchCalls![0]!.retryTasks!,
      }], paths: [], childSessionIds: [],
    })
    expect(selectArtifactTerminal({ ...owner, turn: { ...owner.turn, data: { get: () => ({ calls: [] }) } } } as never)).toBeNull()
  })

  it('renders fixed ordinal cards for every state and preserves sibling DOM identity across updates', async () => {
    const store = new ProjectionValueStore()
    const face = store.faceOf('eMateImageBatches')
    const nativeSubscribe = face.subscribe
    let projectionSubscriptions = 0
    face.subscribe = listener => {
      projectionSubscriptions += 1
      const dispose = nativeSubscribe(listener)
      return () => { projectionSubscriptions -= 1; dispose() }
    }
    store.apply('eMateImageBatches', projection(['queued', 'queued']), 1)
    const view = renderProgress(store)
    expect(projectionSubscriptions).toBe(1)
    expect(screen.getByText('如需取消，请使用输入框旁的“停止生成”按钮。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /取消/u })).toBeNull()
    const progress = screen.getByLabelText('图片批次进度')
    expect(progress.getAttribute('aria-live')).toBeNull()
    const liveSummary = within(progress).getByText('批次进度，排队 2，生成中 0，待确认 0，完成 0，未完成 0')
    expect(liveSummary.getAttribute('aria-live')).toBe('polite')
    expect(liveSummary.getAttribute('aria-atomic')).toBe('true')
    const first = screen.getByRole('article', { name: '第 1 张图片：排队中' })
    const second = screen.getByRole('article', { name: '第 2 张图片：排队中' })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    await act(async () => {
      store.apply('eMateImageBatches', projection(['running', 'queued'], { revisions: [2, 1] }), 2)
      await Promise.resolve()
    })
    expect(screen.getByRole('article', { name: '第 1 张图片：正在生成' })).toBe(first)
    expect(screen.getByRole('article', { name: '第 2 张图片：排队中' })).toBe(second)
    expect(liveSummary.textContent).toBe('批次进度，排队 1，生成中 1，待确认 0，完成 0，未完成 0')
    await act(async () => {
      store.apply('eMateImageBatches', projection(['running', 'queued'], { revisions: [3, 1] }), 3)
      await Promise.resolve()
    })
    expect(within(progress).getByText(liveSummary.textContent!)).toBe(liveSummary)

    const states = ['queued', 'running', 'needs-review', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted']
    await act(async () => { store.apply('eMateImageBatches', projection(states), 4); await Promise.resolve() })
    expect(screen.getAllByRole('article').map(node => node.getAttribute('data-state'))).toEqual(states)
    view.unmount()
    expect(projectionSubscriptions).toBe(0)
    expect(view.sessions.subscriptions()).toBe(0)
  })

  it('shows an exact child receipt preview while the parent batch remains open', async () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(['completed', 'running'], { revisions: [3, 2] }), 1)
    const sessions = sessionHarness(emptySessions())
    const loadImage = vi.fn(async () => 'blob:image')
    renderProgress(store, sessions, loadImage)
    expect(screen.queryByRole('button', { name: '查看原图：first.png' })).toBeNull()

    await act(async () => {
      sessions.set({ ...emptySessions(), byId: { 'child-1': { projectionValues: { eMateImageReceipts: [{
        seq: 9, createdAt: 10, receipt: imageReceipt(),
      }] } } } } as never)
    })
    const preview = screen.getByRole('button', { name: '查看原图：first.png' })
    expect(screen.getByLabelText('图片批次，共 2 张').getAttribute('aria-busy')).toBe('true')
    preview.click()
    expect(loadImage).toHaveBeenCalledWith(attachment, 'child-1')
  })

  it('keeps one exact batch card and preserves unrelated explicit children across open-close', () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(['completed', 'failed'], { revisions: [3, 3], terminal: true }), 1)
    const sessions = sessionHarness({ ...emptySessions(), byId: {
      [parentSessionId]: { title: '批次', cwd: '/work' },
      'child-1': { projectionValues: { eMateImageReceipts: [{ seq: 9, createdAt: 10, receipt: imageReceipt() }] } },
      'child-unrelated': { projectionValues: { eMateImageReceipts: [{
        seq: 12, createdAt: 12, receipt: imageReceipt('child-unrelated', 'call-unrelated', unrelatedAttachment),
      }] } },
    }, subagentsByParent: { [parentSessionId]: { entries: [
      { kind: 'child', id: 'child-1', label: '批次任务', mode: 'one-shot' },
      { kind: 'child', id: 'child-unrelated', label: '独立任务', mode: 'one-shot' },
    ] } } } as never)
    const common = {
      sessionId: parentSessionId, seq: 20, openFile: vi.fn(),
      useSession: (selector: (value: unknown) => unknown) => selector({ chat: { nodes: { values: () => [][Symbol.iterator]() } } }),
      useSessions: sessions.useSessions,
      useInput: (selector: (value: unknown) => unknown) => selector({ imageIds: [], phase: 'plain' }),
      useProjection: useProjectionFrom(store), loadImage: vi.fn(async () => 'blob:image'),
      addImageToDraft: vi.fn(async () => {}), draftBytes: () => 0, notify: vi.fn(), runResource: vi.fn(async () => {}),
    }
    const openMatch = { callIds: [], batchCallIds: [parentCallId], paths: [], childSessionIds: [] }
    const view = render(<ArtifactTerminal {...common as never} matched={openMatch} turn={{
      turn: 1, status: 'open', start: undefined, end: undefined, steps: [], data: { get: () => undefined },
    } as never} />)
    const batchCard = screen.getByRole('article', { name: '第 1 张图片：已完成' })
    expect(screen.getAllByRole('button', { name: '查看原图：first.png' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '查看原图：unrelated.png' })).toBeNull()

    view.rerender(<ArtifactTerminal {...common as never} matched={{
      ...openMatch, childSessionIds: ['child-1', 'child-unrelated'],
    }} turn={{
      turn: 1, status: 'closed', start: undefined, end: undefined, steps: [], data: { get: () => undefined },
    } as never} />)
    expect(screen.getByRole('article', { name: '第 1 张图片：已完成' })).toBe(batchCard)
    expect(screen.getAllByRole('button', { name: '查看原图：first.png' })).toHaveLength(1)
    const unrelated = within(screen.getByRole('region', { name: '图片结果' }))
      .getByRole('button', { name: /^查看原图：/u })
    expect(unrelated.getAttribute('data-attachment-id')).toBe(unrelatedAttachment.attachmentId)
    expect(unrelated.getAttribute('aria-label')).toMatch(/子任务02-生成/u)

    view.rerender(<ArtifactTerminal {...common as never} matched={{
      ...openMatch, childSessionIds: ['child-1', 'child-unrelated'],
    }} turn={{
      turn: 1, status: 'closed', start: undefined, end: undefined, steps: [], data: { get: () => undefined },
    } as never} seq={21} />)
    expect(screen.getAllByRole('button', { name: '查看原图：first.png' })).toHaveLength(1)
    expect(screen.getAllByLabelText('图片批次进度')).toHaveLength(1)
  })

  it('hides foreign or malformed receipt pointers and does not duplicate on parent terminal', async () => {
    const store = new ProjectionValueStore()
    const sessions = sessionHarness({ ...emptySessions(), byId: { 'child-1': { projectionValues: {
      eMateImageReceipts: [{ seq: 8, createdAt: 10, receipt: imageReceipt('foreign-child') }],
    } } } } as never)
    store.apply('eMateImageBatches', projection(['completed', 'failed'], { revisions: [3, 3] }), 1)
    const view = renderProgress(store, sessions)
    const cards = screen.getAllByRole('article')
    expect(screen.queryByRole('button', { name: '查看原图：first.png' })).toBeNull()

    await act(async () => {
      store.apply('eMateImageBatches', projection(['completed', 'failed'], { revisions: [3, 3], terminal: true }), 2)
      await Promise.resolve()
    })
    const progress = screen.getByLabelText('图片批次进度')
    expect(screen.getAllByLabelText('图片批次进度')).toHaveLength(1)
    const batch = within(progress).getByRole('region', { name: '图片批次，共 2 张，部分完成' })
    expect(batch.getAttribute('data-batch-id')).toBe(batchId)
    expect(progress.querySelectorAll('[role="list"]')).toHaveLength(1)
    expect(within(batch).getAllByRole('article')).toHaveLength(2)
    expect(screen.getAllByRole('article')[0]).toBe(cards[0])
    expect(screen.getAllByRole('article')[1]).toBe(cards[1])
    expect(within(batch).getAllByRole('region', { name: '批次未完成项目：1 项' })).toHaveLength(1)
    expect(batch.getAttribute('aria-busy')).toBe('false')
    view.unmount()
  })

  it('converges live and cold terminal batches to identical accessible markup', async () => {
    const terminal = projection(['completed', 'failed'], { revisions: [3, 3], terminal: true })
    const sessions = projectedSessions(['completed', 'failed'])
    const liveStore = new ProjectionValueStore()
    liveStore.apply('eMateImageBatches', projection(['queued', 'queued']), 1)
    const live = renderProgress(liveStore, sessionHarness(sessions))
    const section = screen.getByLabelText('图片批次，共 2 张')
    const firstCard = screen.getByRole('article', { name: '第 1 张图片：排队中' })
    await act(async () => {
      liveStore.apply('eMateImageBatches', projection(['running', 'running'], { revisions: [2, 2] }), 2)
      liveStore.apply('eMateImageBatches', terminal, 3)
      await Promise.resolve()
    })
    expect(screen.getByLabelText('图片批次，共 2 张，部分完成')).toBe(section)
    expect(screen.getByRole('article', { name: '第 1 张图片：已完成' })).toBe(firstCard)
    const liveMarkup = section.outerHTML
    live.unmount()

    const coldStore = new ProjectionValueStore()
    coldStore.apply('eMateImageBatches', terminal, 3)
    const cold = renderProgress(coldStore, sessionHarness(sessions))
    expect(screen.getByLabelText('图片批次，共 2 张，部分完成').outerHTML).toBe(liveMarkup)
    cold.unmount()
  })

  it('keeps four successful previews and summarizes one bounded failure', () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(
      ['completed', 'completed', 'completed', 'completed', 'failed'],
      { revisions: [3, 3, 3, 3, 3], terminal: true },
    ), 1)
    const view = renderProgress(store, sessionHarness(projectedSessions([
      'completed', 'completed', 'completed', 'completed', 'failed',
    ])))
    expect(screen.getAllByRole('button', { name: /^查看原图：/u })).toHaveLength(4)
    expect(screen.getAllByRole('article')).toHaveLength(5)
    const summary = screen.getByRole('region', { name: '批次未完成项目：1 项' })
    expect(summary.textContent).toBe('未完成 1 项图片 5：生成失败（代码：task-failed）')
    expect(summary.textContent).not.toMatch(/[\/]|provider|prompt/iu)
    expect(summary.getAttribute('role')).toBeNull()
    expect(summary.getAttribute('aria-live')).toBeNull()
    expect(summary.getAttribute('tabindex')).toBe('0')
    summary.focus()
    expect(document.activeElement).toBe(summary)
    expect(within(screen.getByLabelText('图片批次进度')).queryByRole('status')).toBeNull()
    view.unmount()
  })

  it('retains an image-bearing failed receipt exactly once with its failure summary', () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(
      ['completed', 'failed'],
      { revisions: [3, 3], terminal: true, imageBearingFailures: [2] },
    ), 1)
    const view = renderProgress(store, sessionHarness(projectedSessions(['completed', 'completed'])))
    expect(screen.getAllByRole('button', { name: /^查看原图：/u })).toHaveLength(2)
    expect(screen.getByRole('article', { name: '第 2 张图片：生成失败' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '批次未完成项目：1 项' })).toBeTruthy()
    view.unmount()
  })

  it.each([
    [['completed', 'completed'], '全部完成', 0],
    [['failed', 'failed'], '失败', 2],
    [['cancelled', 'interrupted'], '已取消', 2],
    [['unknown', 'failed'], '失败', 2],
  ] as const)('renders terminal status %s as %s with %i failures', (states, label, count) => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(states, { revisions: [3, 3], terminal: true }), 1)
    const view = renderProgress(store, sessionHarness(projectedSessions(
      states.map(state => state === 'completed' ? 'completed' : 'failed'),
    )))
    expect(screen.getByLabelText('图片批次，共 2 张，' + label).getAttribute('aria-busy')).toBe('false')
    expect(screen.queryAllByRole('region', { name: '批次未完成项目：' + count + ' 项' })).toHaveLength(count === 0 ? 0 : 1)
    view.unmount()
  })

  it('prepares a fresh retry draft from the exact logged task without reusing control IDs', async () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(['failed', 'completed'], { revisions: [3, 3], terminal: true }), 1)
    const prepareRetry = vi.fn(async () => ({
      prepared: true, message: '已准备到输入框，请确认内容后发送；发送后系统才会创建新的任务。',
    }))
    const retryTask = { ordinal: 1, prompt: '精确原始提示', imageIds: [] }
    const view = renderProgress(store, sessionHarness(projectedSessions(['failed', 'completed'])), undefined, {
      retryCalls: [{ parentCallId, tasks: [retryTask] }], prepareRetry,
    })
    const button = screen.getByRole('button', { name: '准备重新生成此项' })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.click(button)
    await waitFor(() => { expect(prepareRetry).toHaveBeenCalledWith(retryTask) })
    expect(document.activeElement).toBe(button)
    expect(prepareRetry.mock.calls[0]?.[0]).toEqual({ ordinal: 1, prompt: '精确原始提示', imageIds: [] })
    expect(JSON.stringify(prepareRetry.mock.calls[0]?.[0])).not.toMatch(/batch_id|task_id|client_request_id|child_session_id/u)
    expect(screen.getByText('已准备到输入框，请确认内容后发送；发送后系统才会创建新的任务。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^查看原图：/u })).toBeTruthy()
    view.unmount()
  })

  it('disables source-image retry without mutating attachments and explains unknown outcomes', () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(['unknown', 'completed'], { revisions: [3, 3], terminal: true }), 1)
    const prepareRetry = vi.fn()
    const sourceId = 'sha256:' + '7'.repeat(64)
    const view = renderProgress(store, sessionHarness(projectedSessions(['failed', 'completed'])), undefined, {
      retryCalls: [{ parentCallId, tasks: [{ ordinal: 1, prompt: '参考图任务', imageIds: [sourceId] }] }],
      prepareRetry,
    })
    expect(screen.getByText('结果不确定，未自动重复生成')).toBeTruthy()
    const button = screen.getByRole('button', { name: '准备重新生成此项' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('带参考图的任务暂不能安全准备重试，请重新附图后发送。')).toBeTruthy()
    fireEvent.click(button)
    expect(prepareRetry).not.toHaveBeenCalled()
    view.unmount()
  })

  it('keeps eight card subscriptions bounded and delegates URL lifecycle to native owners', async () => {
    const store = new ProjectionValueStore()
    store.apply('eMateImageBatches', projection(Array(8).fill('completed'), {
      revisions: Array(8).fill(3), terminal: true,
    }), 1)
    const sessions = sessionHarness(projectedSessions(Array(8).fill('completed')))
    const view = renderProgress(store, sessions)
    await waitFor(() => { expect(view.loadImage).toHaveBeenCalledTimes(8) })
    const cards = screen.getAllByRole('article')
    expect(cards).toHaveLength(8)
    expect(sessions.subscriptions()).toBe(8)
    await act(async () => {
      store.apply('eMateImageBatches', projection(Array(8).fill('completed'), {
        revisions: [4, 3, 3, 3, 3, 3, 3, 3], terminal: true,
      }), 2)
      await Promise.resolve()
    })
    expect(screen.getAllByRole('article').every((card, index) => card === cards[index])).toBe(true)
    expect(view.loadImage).toHaveBeenCalledTimes(8)
    expect(sessions.subscriptions()).toBe(8)
    view.unmount()
    expect(sessions.subscriptions()).toBe(0)

    const batchSource = readFileSync(resolve('src/client/image-batch-progress.tsx'), 'utf8')
    const messageImage = readFileSync(resolve('../../../../../upstream/deepseek-harness/packages/client/ui-attachment/src/MessageImage.tsx'), 'utf8')
    const conversation = readFileSync(resolve('../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/service.ts'), 'utf8')
    const batchCss = readFileSync(resolve('src/client/image-batch-progress.module.css'), 'utf8')
    const gallerySource = readFileSync(resolve('src/client/image-gallery.tsx'), 'utf8')
    expect(batchSource).toContain('variant="tile"')
    expect(batchSource).not.toMatch(/createObjectURL|revokeObjectURL|IntersectionObserver|imageUrls/u)
    expect(messageImage).toContain('onClick={request}')
    expect(messageImage).toContain('if (live) setSrc(url)')
    expect(conversation).toContain('private readonly imageUrls = new Map')
    expect(conversation).toContain('releaseSessionImages(sessionId')
    expect(conversation).toContain('revokePreview(url)')
    expect(batchCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(batchCss).toContain('.failures:focus-visible')
    expect(gallerySource).toContain('snapshot.chat.timeline.turnOrder.at(-1)')
    expect(gallerySource).not.toContain('for (const turn of snapshot')
  })

  it('shows needs-review live, then updates the same card for accepted and rejected outcomes', async () => {
    const acceptedStore = new ProjectionValueStore()
    acceptedStore.apply('eMateImageBatches', projection(['needs-review', 'running'], { revisions: [2, 2] }), 1)
    const acceptedSessions = sessionHarness(projectedSessions(['needs-review', 'failed']))
    const accepted = renderProgress(acceptedStore, acceptedSessions)
    const acceptedCard = screen.getByRole('article', { name: '第 1 张图片：待确认' })
    expect(screen.getByRole('button', { name: '查看原图：image-1.png' })).toBeTruthy()
    await act(async () => {
      acceptedSessions.set(projectedSessions(['completed', 'failed']))
      acceptedStore.apply('eMateImageBatches', projection(['completed', 'failed'], { revisions: [3, 3], terminal: true }), 2)
      await Promise.resolve()
    })
    expect(screen.getByRole('article', { name: '第 1 张图片：已完成' })).toBe(acceptedCard)
    expect(screen.getAllByRole('button', { name: '查看原图：image-1.png' })).toHaveLength(1)
    accepted.unmount()

    const rejectedStore = new ProjectionValueStore()
    rejectedStore.apply('eMateImageBatches', projection(['needs-review', 'running'], { revisions: [2, 2] }), 1)
    const rejectedSessions = sessionHarness(projectedSessions(['needs-review', 'failed']))
    const rejected = renderProgress(rejectedStore, rejectedSessions)
    const rejectedCard = screen.getByRole('article', { name: '第 1 张图片：待确认' })
    expect(screen.getByRole('button', { name: '查看原图：image-1.png' })).toBeTruthy()
    await act(async () => {
      rejectedSessions.set(projectedSessions(['failed', 'failed']))
      rejectedStore.apply('eMateImageBatches', projection(['failed', 'failed'], { revisions: [3, 3], terminal: true }), 2)
      await Promise.resolve()
    })
    expect(screen.getByRole('article', { name: '第 1 张图片：生成失败' })).toBe(rejectedCard)
    expect(screen.getByRole('region', { name: '批次未完成项目：2 项' })).toBeTruthy()
    rejected.unmount()
  })
})


function petStore(value: any) { return {getSnapshot:()=>value,set:(next: any)=>{value=next}} }
function petContext() {
  const faces: Record<string, ReturnType<typeof petStore>>={goal:petStore(undefined),todos:petStore(undefined),eMateImageReceipts:petStore(undefined),eMateImageBatches:petStore(undefined)}
  const turn: any={status:'open',start:{time:100},data:{get:()=>undefined}}
  const conversation=petStore({sessionId:'a',openState:'open',composerPhase:'active',running:false,lastAgentError:null,runningCalls:[],pending:[],queue:[],chat:{timeline:{turnOrder:[1],turns:new Map([[1,turn]])},locations:{getTurn:()=>[]},nodes:new Map()}})
  const session={...conversation,projections:{faceOf:(key: string)=>faces[key]}}
  const list=petStore({current:'a',phase:'ready',byId:{a:{running:false}},jobsBySession:{}})
  const read=createPetImageFactsReader({sessions:{list,binding:()=>({session})}} as never)
  return {a:{turn,conversation,goal:faces.goal,images:faces.eMateImageReceipts,batches:faces.eMateImageBatches},list,read}
}

const petImageRef={attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',width:2,height:2,bytes:42}
function petImageRow({owner='a',call='image',operation='generate',status='running',seq=9}={}) {
  return {seq,createdAt:100,receipt:{schema_version:2,revision:status==='running'?1:2,call_id:call,parent_session_id:owner,
    operation,status,billing_status:status==='running'?'unknown':'recorded',sources:[],
    content:status==='completed'||status==='needs-review'?[{type:'image',attachment:petImageRef}]:[],
    output:petImageRef,verifier:{structural:'attachment-cas-v1'},verification:{structural:status==='running'?'not-run':'passed',semantic:'not-applicable'}}}
}
function petImageTurn(a,{running=true,batch=false}={}) {
  a.turn.data={get:key=>key==='e-mate-image-calls'?{calls:batch?[]:[{callId:'image',seq:1}],batchCalls:batch?[{callId:'batch',seq:1}]:[]}:undefined}
  a.turn.status=running?'open':'closed';a.turn.end=running?undefined:{data:{reason:{kind:'completed'}}}
  a.conversation.set({...a.conversation.getSnapshot(),running,runningCalls:running?[{callId:batch?'batch':'image',turn:1,callView:null}]:[]})
}
function petBatchRows(state='running',imageIds=[[],[]]) {
  const tasks=[1,2].map(ordinal=>({task_id:'sha256:'+String(ordinal).repeat(64),ordinal,revision:1,state,
    submission_status:state==='running'?'unknown':'submitted',prompt_sha256:'b'.repeat(64),image_url:imageIds[ordinal-1],
    child_session_id:'child-'+ordinal,job_id:'job-'+ordinal,
    ...(state==='completed'?{receipt:{owner_session_id:'child-'+ordinal,call_id:'call-'+ordinal,revision:2,event_seq:9,status:'completed'}}:{})}))
  return [{schema_version:1,batch_id:'sha256:'+'c'.repeat(64),parent_session_id:'a',parent_call_id:'batch',concurrency:2,tasks,
    image_evidence:tasks.filter(task=>task.receipt).map(task=>({task_id:task.task_id,ordinal:task.ordinal,child_session_id:task.child_session_id,receipt:task.receipt})),failures:[],
    ...(state==='completed'?{status:'completed',terminal_event_id:'sha256:'+'d'.repeat(64)}:{})}]
}
it('image facts require the exact native running call and owner',()=>{
  const {a,list,read}=petContext();petImageTurn(a);a.goal.set({goal:{phase:'active'}})
  for(const operation of ['generate','edit','fusion']) {
    a.images.set([petImageRow({operation})]);expect(read('a').operation).toBe(operation==='generate'?'image-generate':'image-edit')
  }
  for(const wrong of [{owner:'b'},{call:'other'},{status:'unknown'},{operation:'invented'}]) {
    a.images.set([petImageRow(wrong)]);expect(read('a').operation).toBeUndefined()
  }
  a.images.set([petImageRow()]);list.set({...list.getSnapshot(),current:'b'});expect(read('a').delivered).toBe(false)

})
it('only this completed turn exact successful attachment can show image delivery',()=>{
  const {a,read}=petContext();petImageTurn(a,{running:false});a.images.set([petImageRow({status:'completed'})]);expect(read('a').delivered).toBe(true)
  for(const wrong of [{call:'old'},{owner:'other'},{status:'needs-review'},{status:'unknown'},{status:'failed'}]) {
    a.images.set([petImageRow({status:'completed',...wrong})]);expect(read('a').delivered).toBe(false)
  }
  const invalid=petImageRow({status:'completed'});invalid.receipt.output={...petImageRef,attachmentId:'sha256:'+'e'.repeat(64)}
  a.images.set([invalid]);expect(read('a').delivered).toBe(false)
  a.images.set([petImageRow({status:'completed'})]);a.turn.end={data:{reason:{kind:'aborted'}}};a.conversation.set({...a.conversation.getSnapshot()});expect(read('a').delivered).toBe(false);
})
it('batch activity uses admitted source identities, current parent call and exact terminal child pointers',()=>{
  const {a,list,read}=petContext();petImageTurn(a,{batch:true})
  a.batches.set(petBatchRows());expect(read('a').operation).toBe('image-generate')
  a.batches.set(petBatchRows('running',[[petImageRef.attachmentId],[petImageRef.attachmentId]]));expect(read('a').operation).toBe('image-edit')
  a.batches.set(petBatchRows('running',[[],[petImageRef.attachmentId]]));expect(read('a').operation).toBeUndefined()
  a.batches.set([{parent_session_id:'foreign',parent_call_id:'batch',get tasks(){throw new Error('foreign tasks accessed')}}]);expect(read('a').operation).toBeUndefined()
  petImageTurn(a,{running:false,batch:true});a.batches.set(petBatchRows('completed'))
  const children=Object.fromEntries([1,2].map(n=>['child-'+n,{running:false,projectionValues:{eMateImageReceipts:[petImageRow({owner:'child-'+n,call:'call-'+n,status:'completed'})]}}]))
  list.set({...list.getSnapshot(),byId:{...list.getSnapshot().byId,...children}});expect(read('a').delivered).toBe(true)
  for(const wrong of [{seq:10},{receipt:{...petImageRow({owner:'child-1',call:'call-1',status:'completed'}).receipt,revision:3}},{receipt:petImageRow({owner:'foreign',call:'call-1',status:'completed'}).receipt}]) {
    children['child-1'].projectionValues.eMateImageReceipts=[{...petImageRow({owner:'child-1',call:'call-1',status:'completed'}),...wrong}]
    list.set({...list.getSnapshot(),byId:{...list.getSnapshot().byId,...children}});expect(read('a').delivered).toBe(false)
  }
  a.turn.data={get:()=>undefined};a.conversation.set({...a.conversation.getSnapshot()});expect(read('a').delivered).toBe(false);
})
