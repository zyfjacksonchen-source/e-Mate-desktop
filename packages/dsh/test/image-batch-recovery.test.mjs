import assert from 'node:assert/strict'
import test from 'node:test'
import { imageBatchEventId, imageBatchId, imageBatchPromptSha256, imageBatchTaskId } from '../src/profile/image-batch.ts'
import { classifyImageBatchCrash, foldImageBatchRecovery, readDurableImageBatchResult, recoverImageBatchSession } from '../src/profile/image-batch-recovery.ts'
import { resolveBatchSources } from '../profile/plugins/image-generation.js'

const SESSION = 'parent'
const CALL = 'batch-call'
const TIME = '2026-02-17T12:00:00.000Z'
const PROMPT = 'same prompt'
const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'same.png' }
const base = ordinal => ({ schema_version: 1, event_id: imageBatchEventId(SESSION, CALL, ordinal), batch_id: imageBatchId(SESSION, CALL),
  parent_session_id: SESSION, parent_call_id: CALL, occurred_at: TIME })
const queued = ordinal => ({ task_id: imageBatchTaskId(SESSION, CALL, ordinal), ordinal, revision: 1, state: 'queued',
  submission_status: 'not-submitted', prompt_sha256: imageBatchPromptSha256(PROMPT), image_url: [] })
const created = () => ({ ...base(1), kind: 'created', concurrency: 2, tasks: [queued(1), queued(2)] })
const linked = () => ({ ...queued(1), revision: 2, child_session_id: 'child-1', updated_at: TIME })
const linkEvent = () => ({ ...base(2), kind: 'task-linked', task: linked() })
const session = events => ({ header: { id: SESSION }, events: structuredClone(events).map((event, seq) => event.type === undefined
  ? { seq, time: Date.now(), type: 'emate/image-batch', data: event } : event), append(type, data, options) {
  this.events.push({ seq: this.events.length, time: Date.now(), type, data, options })
} })
const unavailable = () => ({
  sessions: { flush: async () => true }, sessionProjectionCache: { coldSnapshot: async id => { throw new Error('session \"' + id + '\" not found') } },
  sessionPersistence: { readFrom: async () => { throw new Error('must not read') } },
  agents: { get: () => undefined }, jobs: { get: () => { throw new Error('must not read') } },
  attachments: { readImage: async () => { throw new Error('must not read') } },
})

test('pure crash classification is deterministic and never invents execution authority', () => {
  const [state] = foldImageBatchRecovery([{ type: 'emate/image-batch', data: created() }, { type: 'emate/image-batch', data: linkEvent() }], SESSION)
  const first = classifyImageBatchCrash(state)
  const second = classifyImageBatchCrash(state)
  assert.deepEqual(first, second)
  assert.deepEqual(first.map(task => [task.state, task.submission_status, task.failure_code]), [
    ['unknown', 'unknown', 'provider-outcome-unknown'], ['interrupted', 'not-submitted', 'not-submitted'],
  ])
  assert.equal(first[0].child_session_id, 'child-1')
  assert.equal(first[1].child_session_id, undefined)
})

test('explicit native child not-found conservatively appends unknown/interrupted once with zero execution calls', async () => {
  const parent = session([created(), linkEvent()])
  const ctx = unavailable()
  let starts = 0
  ctx.subagents = { start: () => { starts += 1 } }
  await recoverImageBatchSession(ctx, parent)
  const recovered = foldImageBatchRecovery(parent.events, SESSION)[0]
  assert.deepEqual(recovered.tasks.map(task => task.state), ['unknown', 'interrupted'])
  assert.equal(recovered.status, 'failed')
  assert.equal(parent.events.filter(event => event.data?.kind === 'terminal').length, 1)
  const count = parent.events.length
  await recoverImageBatchSession(ctx, parent)
  assert.equal(parent.events.length, count)
  assert.equal(starts, 0)
})

test('false recovery flush fails closed without terminal and retry remains monotonic', async () => {
  const parent = session([created()])
  let first = true
  const ctx = { ...unavailable(), sessions: { flush: async () => first ? (first = false) : true } }
  await assert.rejects(recoverImageBatchSession(ctx, parent), /parent durability check failed/)
  assert.equal(parent.events.length, 1)
  assert.equal(parent.events.some(event => event.data?.kind === 'terminal'), false)
  await recoverImageBatchSession(ctx, parent)
  const state = foldImageBatchRecovery(parent.events, SESSION)[0]
  assert.equal(state.status, 'cancelled')
  assert.deepEqual(state.tasks.map(task => task.state), ['interrupted', 'interrupted'])
})

test('running-only and needs-review-only child projections remain unknown without pointers', async t => {
  for (const status of ['running', 'needs-review']) await t.test(status, async () => {
    const parent = session([created(), linkEvent()])
    const ctx = unavailable()
    ctx.sessionProjectionCache.coldSnapshot = async () => ({ values: { eMateImageReceipts: [{ seq: 4, receipt: { status } }] } })
    await recoverImageBatchSession(ctx, parent)
    const state = foldImageBatchRecovery(parent.events, SESSION)[0]
    assert.equal(state.tasks[0].state, 'unknown')
    assert.equal(state.tasks[0].receipt, undefined)
    assert.equal(state.status, 'failed')
  })
})

test('live failed Job with not-submitted receipt skips running and preserves billing truth', async () => {
  const parent = session([created(), linkEvent()])
  const receipt = { schema_version: 2, revision: 2, call_id: 'image-call', operation: 'generate', status: 'failed',
    billing_status: 'not-submitted', parent_session_id: 'child-1', client_request_id: 'image-' + linked().task_id.slice('sha256:'.length),
    sources: [], job_id: 'job-1', failure_code: 'validation-failed' }
  const child = { id: 'child-1', session: { header: { id: 'child-1', origin: 'subagent', parentSession: SESSION } } }
  const ctx = { sessions: { flush: async () => true },
    sessionProjectionCache: { coldSnapshot: async () => ({ values: { eMateImageReceipts: [{ seq: 4, receipt }] } }) },
    sessionPersistence: { readFrom: async () => ({ events: [
      { seq: 2, type: 'tool/call', data: { name: 'imagegen', callId: 'image-call', arguments: JSON.stringify({ prompt: PROMPT, image_url: [] }) } },
      { seq: 4, type: 'emate/image-output', data: receipt },
    ] }) },
    agents: { get: () => child }, jobs: { get: () => ({ kind: 'emate-image', ownerSession: 'child-1', status: 'failed' }) },
    attachments: { readImage: async () => { throw new Error('must not read failed output') } },
  }
  await recoverImageBatchSession(ctx, parent)
  const state = foldImageBatchRecovery(parent.events, SESSION)[0]
  assert.equal(state.tasks[0].state, 'failed')
  assert.equal(state.tasks[0].submission_status, 'not-submitted')
  assert.equal(parent.events.filter(event => event.data?.task?.ordinal === 1 && event.data.task.state === 'running').length, 0)
})

test('exact existing child terminal and Job finalize parent without spawn or provider', async () => {
  const parent = session([created(), linkEvent()])
  const childReceipt = { schema_version: 2, revision: 2, call_id: 'image-call', operation: 'generate', status: 'completed',
    billing_status: 'recorded', parent_session_id: 'child-1', client_request_id: 'image-' + linked().task_id.slice('sha256:'.length),
    provider_request_id: 'provider-1', model: 'gpt-image-2.5-flare', sources: [], content: [{ type: 'image', attachment: ref }],
    job_id: 'emate-image-1', output: ref, verifier: {}, verification: {} }
  const row = { seq: 4, receipt: childReceipt }
  const child = { id: 'child-1', session: { header: { id: 'child-1', origin: 'subagent', parentSession: SESSION } } }
  const ctx = { sessions: { flush: async () => true },
    sessionProjectionCache: { coldSnapshot: async id => ({ values: { eMateImageReceipts: id === 'child-1' ? [row] : [] } }) },
    sessionPersistence: { readFrom: async () => ({ events: [
      { seq: 2, type: 'tool/call', data: { name: 'imagegen', callId: 'image-call', arguments: JSON.stringify({ prompt: PROMPT, image_url: [] }) } },
      { seq: 4, type: 'emate/image-output', data: childReceipt },
    ] }) },
    agents: { get: id => id === 'child-1' ? child : undefined },
    jobs: { get: () => ({ kind: 'emate-image', ownerSession: 'child-1', status: 'completed' }) },
    attachments: { readImage: async attachment => ({ ref: attachment, data: new Uint8Array(attachment.bytes) }) },
  }
  await recoverImageBatchSession(ctx, parent)
  const state = foldImageBatchRecovery(parent.events, SESSION)[0]
  assert.deepEqual(state.tasks.map(task => task.state), ['completed', 'interrupted'])
  assert.equal(state.status, 'partial')
  assert.equal(state.tasks[0].receipt.owner_session_id, 'child-1')

  const publicBatch = { ...state, image_evidence: [{ task_id: state.tasks[0].task_id, ordinal: 1,
    child_session_id: 'child-1', receipt: state.tasks[0].receipt }], failures: [{ task_id: state.tasks[1].task_id,
    ordinal: 2, state: 'interrupted', failure_code: 'not-submitted' }] }
  ctx.sessionProjections = { snapshot: () => ({ values: { eMateImageBatches: [publicBatch] } }) }
  const result = await readDurableImageBatchResult(ctx, { id: SESSION, session: parent }, state.batch_id, new AbortController().signal)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.images, [{ task_id: state.tasks[0].task_id, ordinal: 1, child_session_id: 'child-1',
    receipt: state.tasks[0].receipt, attachment: ref }])
  assert.deepEqual(result.failures, publicBatch.failures)
  // A restarted parent has only native batch events, not copied child image-output events.
  const restoredParent = { id: SESSION, session: {
    header: { ...parent.header }, events: structuredClone(parent.events), deriveMessages: () => [],
  } }
  assert.equal(restoredParent.session.events.some(event => event.type === 'emate/image-output'), false)
  const countsBeforeLookup = restoredParent.session.events.length
  assert.deepEqual(await resolveBatchSources(ctx, restoredParent, [ref.attachmentId], new AbortController().signal), [ref])
  assert.equal(restoredParent.session.events.length, countsBeforeLookup)
  await assert.rejects(resolveBatchSources(ctx, restoredParent, ['sha256:' + 'f'.repeat(64)], new AbortController().signal),
    /not a successful current-session image output/)
  const foreignParent = { id: 'foreign-parent', session: { ...restoredParent.session, header: { id: 'foreign-parent' } } }
  await assert.rejects(resolveBatchSources(ctx, foreignParent, [ref.attachmentId], new AbortController().signal),
    /invalid image batch event|durable/)
  for (const mutate of [
    batch => { batch.image_evidence = [] },
    batch => { batch.image_evidence.push(structuredClone(batch.image_evidence[0])) },
    batch => { batch.failures = [] },
    batch => { batch.image_evidence[0].receipt.status = 'failed' },
    batch => { batch.failures[0].job_id = 'foreign-job' },
    batch => { batch.failures[0].receipt = { owner_session_id: 'foreign', call_id: 'x', revision: 2, event_seq: 1, status: 'failed' } },
    batch => { batch.tasks.reverse() },
    batch => { batch.status = 'completed' },
  ]) {
    const invalid = structuredClone(publicBatch); mutate(invalid)
    ctx.sessionProjections = { snapshot: () => ({ values: { eMateImageBatches: [invalid] } }) }
    await assert.rejects(readDurableImageBatchResult(ctx, { id: SESSION, session: parent }, state.batch_id,
      new AbortController().signal), /durable image batch/)
    await assert.rejects(resolveBatchSources(ctx, restoredParent, [ref.attachmentId], new AbortController().signal),
      /durable image batch/)
  }
})

test('wrong call args operation sources bare revision and storage outage never attach receipt', async t => {
  const make = ({ receipt = {}, callArgs = { prompt: PROMPT, image_url: [] }, history, coldError, rows } = {}) => {
    const parent = session([created(), linkEvent()])
    const final = { schema_version: 2, revision: 2, call_id: 'image-call', operation: 'generate', status: 'completed',
      billing_status: 'recorded', parent_session_id: 'child-1', client_request_id: 'image-' + linked().task_id.slice('sha256:'.length),
      sources: [], job_id: 'job-1', output: ref, ...receipt }
    const child = { id: 'child-1', session: { header: { id: 'child-1', origin: 'subagent', parentSession: SESSION } } }
    const ctx = { sessions: { flush: async () => true },
      sessionProjectionCache: { coldSnapshot: async () => {
        if (coldError !== undefined) throw coldError
        return { values: { eMateImageReceipts: rows ?? [{ seq: 4, receipt: final }] } }
      } },
      sessionPersistence: { readFrom: async () => ({ events: history ?? [
        { seq: 2, type: 'tool/call', data: { name: 'imagegen', callId: 'image-call', arguments: JSON.stringify(callArgs) } },
        { seq: 4, type: 'emate/image-output', data: final },
      ] }) },
      agents: { get: () => child }, jobs: { get: () => ({ kind: 'emate-image', ownerSession: 'child-1', status: 'completed' }) },
      attachments: { readImage: async attachment => ({ ref: attachment, data: new Uint8Array(attachment.bytes) }) },
    }
    return { parent, ctx }
  }
  const cases = [
    ['wrong args', make({ callArgs: { prompt: 'wrong', image_url: [] } })],
    ['wrong operation', make({ receipt: { operation: 'edit' } })],
    ['wrong sources', make({ receipt: { sources: [ref] } })],
    ['bare revision three', make({ receipt: { revision: 3 } })],
    ['foreign owner', make({ receipt: { parent_session_id: 'foreign-child' } })],
  ]
  for (const [name, value] of cases) await t.test(name, async () => {
    await assert.rejects(recoverImageBatchSession(value.ctx, value.parent), /recovery child/)
    assert.equal(value.parent.events.some(event => event.data?.kind === 'terminal'), false)
    assert.equal(value.parent.events.some(event => event.data?.kind === 'task-state'), false)
  })
  await t.test('projection outage', async () => {
    const value = make({ coldError: new Error('database /private/path unavailable') })
    await assert.rejects(recoverImageBatchSession(value.ctx, value.parent), /projection read failed/)
    assert.equal(value.parent.events.length, 2)
  })
  await t.test('malformed projection', async () => {
    const value = make({ rows: 'bad' })
    await assert.rejects(recoverImageBatchSession(value.ctx, value.parent), /projection is malformed/)
    assert.equal(value.parent.events.length, 2)
  })
})

test('late child evidence after terminal unknown never mutates parent and legacy sessions are no-op', async () => {
  const parent = session([created(), linkEvent()])
  const ctx = unavailable()
  await recoverImageBatchSession(ctx, parent)
  const count = parent.events.length
  ctx.sessionProjectionCache.coldSnapshot = async () => ({ values: { eMateImageReceipts: [{ seq: 9, receipt: {} }] } })
  await recoverImageBatchSession(ctx, parent)
  assert.equal(parent.events.length, count)

  const legacy = session([{ seq: 0, type: 'emate/image-output', data: { schema_version: 2 } }])
  await recoverImageBatchSession(ctx, legacy)
  assert.equal(legacy.events.length, 1)
})

test('durable result rejects foreign child pointer and never reads labels or timestamps', async () => {
  const pointer = { owner_session_id: 'child-1', call_id: 'wanted', revision: 2, event_seq: 7, status: 'completed' }
  const first = { ...queued(1), state: 'completed', child_session_id: 'child-1', job_id: 'job-1', receipt: pointer }
  const second = { ...queued(2), state: 'failed', failure_code: 'validation-failed' }
  const batch = { batch_id: imageBatchId(SESSION, CALL), parent_session_id: SESSION, status: 'partial',
    terminal_event_id: imageBatchEventId(SESSION, CALL, 9), tasks: [first, second],
    failures: [{ task_id: second.task_id, ordinal: 2, state: 'failed', failure_code: 'validation-failed' }],
    image_evidence: [{ task_id: first.task_id, ordinal: 1, child_session_id: 'child-1', receipt: pointer }] }
  const ctx = { sessionProjections: { snapshot: () => ({ values: { eMateImageBatches: [batch] } }) },
    sessionProjectionCache: { coldSnapshot: async () => ({ values: { eMateImageReceipts: [{ seq: 7,
      receipt: { call_id: 'foreign', revision: 2, status: 'completed', parent_session_id: 'child-1', output: ref } }] } }) },
    attachments: { readImage: async () => { throw new Error('must not read foreign output') } },
  }
  const parent = { id: SESSION, session: { header: { id: SESSION } } }
  await assert.rejects(readDurableImageBatchResult(ctx, parent, batch.batch_id, new AbortController().signal), /does not resolve exactly once/)
})

test('old and Flare parent receipts remain usable references without invoking a provider', async () => {
  for (const model of ['gpt-image-2-pro', 'gpt-image-2.5-flare']) {
    const receipt = { schema_version: 2, revision: 2, call_id: 'image-call', operation: 'generate', status: 'completed',
      billing_status: 'recorded', parent_session_id: SESSION, client_request_id: 'client-request-1',
      provider_request_id: 'provider-request-1', model, sources: [], content: [{ type: 'image', attachment: ref }],
      job_id: 'image-job-1', output: ref,
      verifier: { structural: 'attachment-cas-v1', semantic: 'not-required' },
      verification: { structural: 'passed', source_output: 'not-applicable', semantic: 'not-applicable' } }
    const parent = { id: SESSION, session: { header: { id: SESSION }, events: [{ type: 'emate/image-output', data: receipt }], deriveMessages: () => [] } }
    let reads = 0
    const ctx = { attachments: { readImage: async attachment => { reads++; return { ref: attachment, data: new Uint8Array(attachment.bytes) } } } }
    assert.deepEqual(await resolveBatchSources(ctx, parent, [ref.attachmentId], new AbortController().signal), [ref])
    assert.equal(reads, 1)
    receipt.model = 'unadmitted-image-model'
    await assert.rejects(resolveBatchSources(ctx, parent, [ref.attachmentId], new AbortController().signal), /not a successful current-session/)
    assert.equal(reads, 1)
  }
})
