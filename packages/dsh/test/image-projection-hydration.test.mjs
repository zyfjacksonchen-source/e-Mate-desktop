import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hydrateImageReceiptProjections,
  imageReceiptsProjectionDefinition,
} from '../profile/plugins/image-generation.js'

const schema = {
  finite() { return this },
  int() { return this },
  nonnegative() { return this },
  strict() { return this },
}
const z = {
  array: () => schema,
  number: () => schema,
  object: () => schema,
  record: () => schema,
  string: () => schema,
  unknown: () => schema,
}
const projection = imageReceiptsProjectionDefinition(z)
const header = id => ({ id, origin: 'subagent' })

test('native receipt face exposes running work but terminal state never regresses to running', () => {
  assert.equal(projection.stateVersion, 2)
  const event = (status, revision, seq) => ({type:'emate/image-output',seq,time:seq * 100,
    data:{schema_version:2,revision,call_id:'call',parent_session_id:'a',operation:'edit',status}})
  const running = projection.apply(projection.init(), event('running',1,1))
  assert.equal(projection.view(running)[0].receipt.operation,'edit')
  for (const status of ['completed','needs-review','failed','cancelled','unknown']) {
    const terminal = projection.apply(running,event(status,2,2))
    assert.equal(projection.view(terminal)[0].receipt.status,status)
    assert.equal(projection.apply(terminal,event('running',1,3)),terminal)
    assert.equal(projection.apply(terminal,event('running',3,4)),terminal)
  }
})

function context(headers, cachedSnapshots = new Map(), coldSnapshot = async () => {}) {
  const warnings = []
  return {
    ctx: {
      sessionPersistence: { list: async () => headers },
      sessionProjectionCache: {
        cachedSnapshot: value => cachedSnapshots.get(value.id),
        coldSnapshot,
      },
      logger: { warn: warning => warnings.push(warning) },
    },
    warnings,
  }
}

test('hydrates completed, review-required, and failed receipts on the first pass', async () => {
  const statuses = new Map([
    ['cold-completed', 'completed'],
    ['cold-review-required', 'needs-review'],
    ['cold-failed', 'failed'],
  ])
  const cachedSnapshots = new Map()
  const calls = []
  const { ctx } = context([...statuses.keys()].map(header), cachedSnapshots, async id => {
    calls.push(id)
    const event = {
      type: 'emate/image-output',
      seq: 1,
      time: 100,
      data: { schema_version: 2, revision: 2, call_id: id, status: statuses.get(id) },
    }
    const state = projection.apply(projection.init(), event)
    const snapshot = { asOfSeq: event.seq, values: { [projection.key]: projection.view(state) } }
    cachedSnapshots.set(id, snapshot)
    return snapshot
  })

  await hydrateImageReceiptProjections(ctx)

  assert.deepEqual(calls.sort(), [...statuses.keys()].sort())
  assert.deepEqual([...statuses.keys()].map(id => [
    id,
    cachedSnapshots.get(id).values.eMateImageReceipts[0].receipt.status,
  ]), [...statuses])
})

test('an own projection key skips repeated cold reads even when its value is undefined', async () => {
  const cachedSnapshots = new Map([
    ['own-undefined', { asOfSeq: 0, values: { eMateImageReceipts: undefined } }],
  ])
  const calls = []
  const { ctx } = context([
    header('own-undefined'),
    header('missing-key'),
    { id: 'ordinary-session', origin: 'user' },
  ], cachedSnapshots, async id => {
    calls.push(id)
    cachedSnapshots.set(id, { asOfSeq: 0, values: { eMateImageReceipts: [] } })
  })

  await hydrateImageReceiptProjections(ctx)
  await hydrateImageReceiptProjections(ctx)

  assert.deepEqual(calls, ['missing-key'])
})

test('bounds at least nine cold reads to four concurrent operations', async () => {
  const headers = Array.from({ length: 9 }, (_, index) => header(`cold-${index}`))
  let active = 0
  let peak = 0
  let calls = 0
  const { ctx } = context(headers, new Map(), async () => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    await Promise.resolve()
    active -= 1
  })

  await hydrateImageReceiptProjections(ctx)

  assert.equal(calls, 9)
  assert.equal(peak, 4)
})

test('warns for one failed child and continues hydrating the rest', async () => {
  const calls = []
  const hydrated = []
  const headers = Array.from({ length: 6 }, (_, index) => header(`child-${index}`))
  const { ctx, warnings } = context(headers, new Map(), async id => {
    calls.push(id)
    if (id === 'child-2') throw new Error('broken child log')
    hydrated.push(id)
  })

  await hydrateImageReceiptProjections(ctx)

  assert.deepEqual(calls.sort(), headers.map(value => value.id).sort())
  assert.deepEqual(hydrated.sort(), headers.map(value => value.id).filter(id => id !== 'child-2').sort())
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /child-2.*broken child log/u)
})

test('rejects when the top-level persistence listing fails', async () => {
  const failure = new Error('session listing failed')
  let coldReads = 0
  const warnings = []
  const ctx = {
    sessionPersistence: { list: async () => { throw failure } },
    sessionProjectionCache: {
      cachedSnapshot: () => undefined,
      coldSnapshot: async () => { coldReads += 1 },
    },
    logger: { warn: warning => warnings.push(warning) },
  }

  await assert.rejects(hydrateImageReceiptProjections(ctx), error => error === failure)
  assert.equal(coldReads, 0)
  assert.deepEqual(warnings, [])
})
