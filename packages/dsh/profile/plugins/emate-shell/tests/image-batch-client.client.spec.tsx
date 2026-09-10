// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectionValueStore } from '../../../../../../upstream/deepseek-harness/packages/api/session-controller/src/client/sessions/projection-store.ts'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { createImageBatchProjectionSelector, useImageBatchProjection } from '../src/client/image-batch-client.ts'
import { selectArtifactTerminal } from '../src/client/image-gallery.tsx'

afterEach(cleanup)

const parentSessionId = 'parent-session'
const batchId = 'sha256:' + 'a'.repeat(64)
const taskIds = 'bcdef012'.split('').map(character => 'sha256:' + character.repeat(64))
const terminalEventId = 'sha256:' + 'd'.repeat(64)

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

function projection(states: readonly string[], options: { parent?: string; revisions?: readonly number[]; terminal?: boolean } = {}) {
  const tasks = states.map((state, index) => task(index + 1, state, options.revisions?.[index] ?? 1))
  const terminal = options.terminal === true
  return [{
    schema_version: 1, batch_id: batchId, parent_session_id: options.parent ?? parentSessionId,
    parent_call_id: 'batch-call', concurrency: 3, tasks,
    image_evidence: tasks.filter(item => item.receipt?.status === 'completed').map(item => ({
      task_id: item.task_id, ordinal: item.ordinal, child_session_id: item.child_session_id, receipt: item.receipt,
    })),
    failures: tasks.filter(item => ['failed', 'cancelled', 'unknown', 'interrupted'].includes(item.state)).map(item => ({
      task_id: item.task_id, ordinal: item.ordinal, state: item.state, failure_code: item.failure_code,
      ...(item.child_session_id === undefined ? {} : { child_session_id: item.child_session_id }),
      ...(item.job_id === undefined ? {} : { job_id: item.job_id }),
      ...(item.receipt === undefined ? {} : { receipt: item.receipt }),
    })),
    ...(terminal ? { status: states.every(state => state === 'completed') ? 'completed' : 'partial', terminal_event_id: terminalEventId } : {}),
  }]
}

function hookFor(store: ProjectionValueStore): UseProjection {
  return ((key: string, selector: (value: unknown) => unknown = value => value) => {
    const face = store.faceOf(key)
    return useSyncExternalStore(face.subscribe, () => selector(face.getSnapshot()))
  }) as UseProjection
}

describe('image batch native projection client', () => {
  it('strictly indexes open queued/running and terminal tasks by exact IDs and ordinal', () => {
    const select = createImageBatchProjectionSelector(parentSessionId)
    const open = select(projection(['queued', 'running']))
    expect(open.batchesById[batchId]?.tasks.map(item => [item.ordinal, item.state, item.terminal])).toEqual([
      [1, 'queued', false], [2, 'running', false],
    ])
    expect(open.batchesById[batchId]?.tasksById[taskIds[1]]?.ordinal).toBe(2)
    const states = ['queued', 'running', 'needs-review', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted']
    expect(createImageBatchProjectionSelector(parentSessionId)(projection(states)).batches[0]?.tasks.map(item => item.state)).toEqual(states)
    expect(Object.isFrozen(open)).toBe(true)
    expect(Object.isFrozen(open.batches[0]?.tasksById)).toBe(true)

    const beforeParentTerminal = select(projection(['completed', 'failed'], { revisions: [3, 4] }))
    expect(beforeParentTerminal.batches[0]?.tasks.map(item => item.terminal)).toEqual([true, true])
    expect(beforeParentTerminal.batches[0]?.terminal).toBe(false)
    expect(beforeParentTerminal.batches[0]?.status).toBeUndefined()

    const terminal = select(projection(['completed', 'failed'], { revisions: [3, 4], terminal: true }))
    expect(terminal.batches[0]?.terminal).toBe(true)
    expect(terminal.batches[0]?.status).toBe('partial')
    expect(terminal.batches[0]?.tasks[0]).toBe(beforeParentTerminal.batches[0]?.tasks[0])
    expect(terminal.batches[0]?.tasks[1]).toBe(beforeParentTerminal.batches[0]?.tasks[1])
  })

  it('reuses exact batch/task references and structurally shares unchanged siblings', () => {
    const select = createImageBatchProjectionSelector(parentSessionId)
    const first = select(projection(['queued', 'running']))
    const duplicate = select(structuredClone(projection(['queued', 'running'])))
    expect(duplicate).toBe(first)

    const updated = select(projection(['queued', 'running'], { revisions: [1, 2] }))
    expect(updated).not.toBe(first)
    expect(updated.batches[0]?.tasks[0]).toBe(first.batches[0]?.tasks[0])
    expect(updated.batches[0]?.tasks[1]).not.toBe(first.batches[0]?.tasks[1])
  })

  it('ignores malformed, foreign, and duplicate batch rows without mutating the wire value', () => {
    const select = createImageBatchProjectionSelector(parentSessionId)
    const valid = projection(['queued', 'running'])[0]!
    const malformed = { ...structuredClone(valid), batch_id: 'not-an-id' }
    const foreign = projection(['queued', 'running'], { parent: 'other-session' })[0]!
    const input = [malformed, foreign, valid, structuredClone(valid)]
    const before = structuredClone(input)
    const view = select(input)
    expect(view.batches).toHaveLength(1)
    expect(view.batches[0]?.batchId).toBe(batchId)
    expect(input).toEqual(before)
    expect(createImageBatchProjectionSelector(parentSessionId)({ nope: true }).batches).toEqual([])
    expect(createImageBatchProjectionSelector(parentSessionId)([]).batches).toEqual([])
    expect(createImageBatchProjectionSelector(parentSessionId)([{ schema_version: 1, batch_id: 'bad' }]).batches).toEqual([])
  })

  it('uses rc.7 higher-seq-wins delivery and cleans the native hook subscription on unmount', async () => {
    const store = new ProjectionValueStore()
    const face = store.faceOf('eMateImageBatches')
    const nativeSubscribe = face.subscribe
    let subscriptions = 0
    face.subscribe = listener => {
      subscriptions += 1
      const dispose = nativeSubscribe(listener)
      return () => { subscriptions -= 1; dispose() }
    }
    const reads: string[][] = []
    let surroundingRenders = 0
    function Reader() {
      const view = useImageBatchProjection(hookFor(store), parentSessionId)
      reads.push(view.batches[0]?.tasks.map(item => item.state) ?? [])
      return null
    }
    function SurroundingConversation() { surroundingRenders += 1; return null }

    store.apply('eMateImageBatches', projection(['queued', 'running']), 10)
    const rendered = render(<><Reader /><SurroundingConversation /></>)
    expect(subscriptions).toBe(1)
    const latest = projection(['completed', 'failed'], { revisions: [3, 4], terminal: true })
    await act(async () => {
      store.apply('eMateImageBatches', latest, 12)
      store.apply('eMateImageBatches', projection(['queued', 'running']), 11)
      expect(store.get('eMateImageBatches')).toBe(latest)
      await Promise.resolve()
    })
    expect(store.get('eMateImageBatches')).toBe(latest)
    expect(reads.at(-1)).toEqual(['completed', 'failed'])
    expect(surroundingRenders).toBe(1)
    rendered.unmount()
    expect(subscriptions).toBe(0)
  })

  it('rehydrates from a replacement native projection store with new wire identities', () => {
    const firstStore = new ProjectionValueStore()
    const secondStore = new ProjectionValueStore()
    firstStore.apply('eMateImageBatches', projection(['completed', 'failed'], { revisions: [3, 4], terminal: true }), 20)
    secondStore.apply('eMateImageBatches', structuredClone(
      projection(['completed', 'failed'], { revisions: [3, 4], terminal: true }),
    ), 20)
    function Reader({ store }: { store: ProjectionValueStore }) {
      const view = useImageBatchProjection(hookFor(store), parentSessionId)
      return <output>{view.batches[0]?.tasks.map(task => [task.ordinal, task.state, task.failureCode].join(':')).join('|')}</output>
    }
    const mounted = render(<Reader store={firstStore} />)
    const live = screen.getByRole('status').textContent
    mounted.rerender(<Reader store={secondStore} />)
    expect(screen.getByRole('status').textContent).toBe(live)
    expect(screen.getByRole('status').textContent).toBe('1:completed:|2:failed:task-failed')
  })

  it('integrates the batch reader while direct imagegen keeps its live tail', () => {
    const owner = (status: 'open' | 'closed', data: unknown) => ({
      turn: { turn: 1, status, start: undefined, end: undefined, steps: [], data: { get: () => data } },
      nodes: [], seq: 10, openFile: () => {},
    })
    const imagegen = { calls: [{ callId: 'single-image', seq: 2 }], foregroundSubagents: [] }
    expect(selectArtifactTerminal(owner('open', imagegen) as never)).toEqual({
      callIds: ['single-image'], paths: [], childSessionIds: [],
    })
    expect(selectArtifactTerminal(owner('closed', imagegen) as never)).toEqual({
      callIds: ['single-image'], paths: [], childSessionIds: [],
    })
    expect(selectArtifactTerminal(owner('open', {
      calls: [], foregroundSubagents: [], batchCalls: [{ callId: 'batch-call', seq: 3 }],
    }) as never)).toEqual({ callIds: [], batchCallIds: ['batch-call'], paths: [], childSessionIds: [] })
  })
})
