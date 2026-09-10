import assert from 'node:assert/strict'
import test from 'node:test'
import { imageBatchEventId, imageBatchId, imageBatchTaskId } from '../src/profile/image-batch.ts'
import { imageBatchProjectionDefinition } from '../src/profile/image-batch-events.ts'

const SESSION = 'parent-session'
const TIME = '2026-02-17T12:34:56.000Z'
const PROMPT = 'a'.repeat(64)
const node = (kind, fields = {}) => ({ kind, ...fields, strict() { return this }, optional() { return this }, int() { return this }, min() { return this }, max() { return this }, regex() { return this }, refine() { return this } })
const z = { array: item => node('array', { item }), enum: values => node('enum', { values }), literal: value => node('literal', { value }), number: () => node('number'), object: shape => node('object', { shape }), string: () => node('string') }
const base = (call, eventOrdinal) => ({ schema_version: 1, event_id: imageBatchEventId(SESSION, call, eventOrdinal),
  batch_id: imageBatchId(SESSION, call), parent_session_id: SESSION, parent_call_id: call, occurred_at: TIME })
const queued = (call, ordinal) => ({ task_id: imageBatchTaskId(SESSION, call, ordinal), ordinal, revision: 1,
  state: 'queued', submission_status: 'not-submitted', prompt_sha256: PROMPT, image_url: [] })
const created = call => ({ ...base(call, 1), kind: 'created', concurrency: 2, tasks: [queued(call, 1), queued(call, 2)] })
const linked = (call, ordinal) => ({ ...queued(call, ordinal), revision: 2, child_session_id: call + '-child-' + ordinal, updated_at: TIME })
const running = (call, ordinal) => ({ ...linked(call, ordinal), revision: 3, state: 'running', submission_status: 'submitted', job_id: 'emate-image-' + call + '-' + ordinal })
const completed = (call, ordinal) => ({ ...running(call, ordinal), revision: 4, state: 'completed', receipt: {
  owner_session_id: call + '-child-' + ordinal, call_id: 'imagegen-' + ordinal, revision: 2, event_seq: 7, status: 'completed',
} })
const event = (call, eventOrdinal, kind, task) => ({ ...base(call, eventOrdinal), kind, task })
const sequence = call => [created(call), event(call, 2, 'task-linked', linked(call, 1)), event(call, 3, 'task-linked', linked(call, 2)),
  event(call, 4, 'task-state', running(call, 1)), event(call, 5, 'task-state', running(call, 2)),
  event(call, 6, 'task-state', completed(call, 1)), event(call, 7, 'task-state', completed(call, 2)),
  { ...base(call, 8), kind: 'terminal', status: 'completed', tasks: [completed(call, 1), completed(call, 2)] }]

test('identical prompts and late interleaved batches join only exact child receipt pointers', () => {
  const projection = imageBatchProjectionDefinition(z, SESSION)
  const first = sequence('batch-a')
  const second = sequence('batch-b')
  const interleaved = [first[0], second[0], first[1], second[1], second[2], first[2], ...first.slice(3), ...second.slice(3)]
  const state = interleaved.reduce((value, data) => projection.apply(value, { type: 'emate/image-batch', data }), projection.init())
  const view = projection.view(state)
  assert.deepEqual(view.map(batch => batch.parent_call_id), ['batch-a', 'batch-b'])
  assert.deepEqual(view.map(batch => batch.image_evidence.map(item => item.child_session_id)), [
    ['batch-a-child-1', 'batch-a-child-2'], ['batch-b-child-1', 'batch-b-child-2'],
  ])
  assert(view.every(batch => batch.status === 'completed' && batch.image_evidence.length === 2))
  assert.equal(JSON.stringify(view).includes('filename'), false)
})

test('cold rebuild and replay are deterministic while duplicate and foreign pointers cannot cross-link', () => {
  const projection = imageBatchProjectionDefinition(z, SESSION)
  const events = sequence('cold')
  const rebuild = () => events.reduce((value, data) => projection.apply(value, { type: 'emate/image-batch', data: structuredClone(data) }), projection.init())
  assert.deepEqual(rebuild(), rebuild())
  let state = projection.init()
  for (const data of events) {
    state = projection.apply(state, { type: 'emate/image-batch', data })
    const replayed = projection.apply(state, { type: 'emate/image-batch', data: structuredClone(data) })
    assert.deepEqual(replayed, state)
    assert.equal(replayed[0].accepted_events.length, state[0].accepted_events.length)
  }
  const foreignEvents = sequence('foreign')
  const foreignState = foreignEvents.slice(0, 5).reduce((value, data) => projection.apply(value, { type: 'emate/image-batch', data }), projection.init())
  const foreign = structuredClone(foreignEvents[5])
  foreign.task.receipt.owner_session_id = 'other-child'
  assert.throws(() => projection.apply(foreignState, { type: 'emate/image-batch', data: foreign }), /invalid image batch event/u)
})

test('parent terminal is unique and rejects malformed receipt revision and owner', () => {
  const projection = imageBatchProjectionDefinition(z, SESSION)
  const values = sequence('strict')
  const terminal = values.at(-1)
  const terminalState = values.reduce((state, data) => projection.apply(state, { type: 'emate/image-batch', data }), projection.init())
  assert.throws(() => projection.apply(terminalState, { type: 'emate/image-batch', data: { ...terminal, event_id: imageBatchEventId(SESSION, 'strict', 9) } }), /invalid image batch event/u)
  for (const field of ['owner_session_id', 'revision']) {
    const corrupt = structuredClone(values[5])
    corrupt.task.receipt[field] = field === 'revision' ? 4 : 'foreign'
    assert.throws(() => projection.apply(values.slice(0, 5).reduce((state, data) => projection.apply(state, { type: 'emate/image-batch', data }), projection.init()),
      { type: 'emate/image-batch', data: corrupt }), /invalid image batch event/u)
  }
})
