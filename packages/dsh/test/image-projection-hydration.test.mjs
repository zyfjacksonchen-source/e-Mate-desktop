import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hydrateImageReceiptProjections,
  imageReceiptsProjectionDefinition,
} from '../profile/plugins/image-history.js'

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

for (const schemaVersion of [2, 3]) test(`schema ${schemaVersion} receipt exposes running work but terminal state never regresses`, () => {
  assert.equal(projection.stateVersion, 3)
  const event = (status, revision, seq) => ({type:'emate/image-output',seq,time:seq * 100,
    data:{schema_version:schemaVersion,revision,call_id:'call',parent_session_id:'a',operation:'edit',status}})
  const running = projection.apply(projection.init(), event('running',1,1))
  assert.equal(projection.view(running)[0].receipt.operation,'edit')
  for (const status of ['completed','needs-review','failed','cancelled','unknown']) {
    const terminal = projection.apply(running,event(status,2,2))
    assert.equal(projection.view(terminal)[0].receipt.status,status)
    assert.equal(projection.apply(terminal,event('running',1,3)),terminal)
    assert.equal(projection.apply(terminal,event('running',3,4)),terminal)
  }
})

test('new multi-image Code receipts coexist with historical receipts through replay without changing attachment ownership', () => {
  const image = value => ({ type: 'image', attachment: { attachmentId: `sha256:${value.repeat(64)}`, mediaType: 'image/png', bytes: 8, width: 1, height: 1 } })
  const old = { type: 'emate/image-output', seq: 1, time: 100,
    data: { schema_version: 2, revision: 2, call_id: 'old', status: 'completed',
      parent_session_id: 'session', content: [image('a')] } }
  const running = { type: 'emate/image-output', seq: 2, time: 200,
    data: { schema_version: 3, revision: 1, call_id: 'nested', root_call_id: 'code',
      parent_session_id: 'session', tool_name: 'generate_image', task_id: 'task', turn: 2,
      status: 'running', sources: [], content: [] } }
  const completed = { ...running, seq: 3, time: 300,
    data: { ...running.data, revision: 2, status: 'completed', content: [
      image('b'),
      image('c'),
    ] } }
  const log = [old, running, completed]
  const before = JSON.stringify(log)
  const replay = () => log.reduce((state, event) => projection.apply(state, event), projection.init())
  const state = replay()
  assert.deepEqual(projection.view(state), [
    { seq: 1, createdAt: 100, receipt: old.data },
    { seq: 3, createdAt: 200, receipt: completed.data },
  ])
  assert.deepEqual(replay(), state)
  assert.equal(projection.apply(state, completed), state)
  assert.equal(projection.apply(state, { ...running, seq: 4 }), state)
  assert.equal(JSON.stringify(log), before)
})

// rc.1 lists { header, revision } snapshots and serves the durable log through an
// open read handle carrying the exact inherited cut the cold-read ladder needs.
function context(headers, cachedSnapshots = new Map(), coldSnapshot = async () => {}, logs = new Map()) {
  const warnings = []
  const closed = []
  return {
    ctx: {
      sessionPersistence: {
        list: async () => headers.map(value => ({ header: value, revision: 1 })),
        open: async (id, access) => {
          assert.equal(access, 'read')
          return {
            inheritedEventCount: 0,
            read: async offset => {
              assert.equal(offset, 0)
              return { events: logs.get(id) ?? [] }
            },
            close: async () => { closed.push(id) },
          }
        },
      },
      sessionProjectionCache: {
        cachedSnapshot: (meta, inheritedEventCount) => {
          assert.equal(inheritedEventCount, 0)
          return cachedSnapshots.get(meta.id)
        },
        coldSnapshot,
      },
      logger: { warn: warning => warnings.push(warning) },
    },
    warnings,
    closed,
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
  const logs = new Map([...statuses.keys()].map(id => [id, [{
    type: 'emate/image-output',
    seq: 1,
    time: 100,
    data: { schema_version: 2, revision: 2, call_id: id, status: statuses.get(id) },
  }]]))
  const { ctx, closed } = context([...statuses.keys()].map(header), cachedSnapshots, async (meta, inheritedEventCount, events) => {
    calls.push(meta.id)
    assert.equal(inheritedEventCount, 0)
    // The cold read folds the caller-supplied log, so the handle must have
    // delivered this child's own events.
    assert.deepEqual(events, logs.get(meta.id))
    const state = events.reduce((folded, event) => projection.apply(folded, event), projection.init())
    const snapshot = { asOfSeq: events.at(-1).seq, values: { [projection.key]: projection.view(state) } }
    cachedSnapshots.set(meta.id, snapshot)
    return snapshot
  }, logs)

  await hydrateImageReceiptProjections(ctx)

  assert.deepEqual(calls.sort(), [...statuses.keys()].sort())
  assert.deepEqual(closed.sort(), [...statuses.keys()].sort())
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
  const { ctx, closed } = context([
    header('own-undefined'),
    header('missing-key'),
    { id: 'ordinary-session', origin: 'user' },
  ], cachedSnapshots, async meta => {
    calls.push(meta.id)
    cachedSnapshots.set(meta.id, { asOfSeq: 0, values: { eMateImageReceipts: [] } })
  })

  await hydrateImageReceiptProjections(ctx)
  await hydrateImageReceiptProjections(ctx)

  assert.deepEqual(calls, ['missing-key'])
  // Only the listed subagent children are hydrated; the ordinary session is never opened.
  assert.equal(closed.includes('ordinary-session'), false)
  // A skipped cold read still closes the handle it opened.
  assert.equal(closed.includes('own-undefined'), true)
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
  const { ctx, warnings, closed } = context(headers, new Map(), async meta => {
    calls.push(meta.id)
    if (meta.id === 'child-2') throw new Error('broken child log')
    hydrated.push(meta.id)
  })

  await hydrateImageReceiptProjections(ctx)

  assert.deepEqual(calls.sort(), headers.map(value => value.id).sort())
  assert.deepEqual(hydrated.sort(), headers.map(value => value.id).filter(id => id !== 'child-2').sort())
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /child-2.*broken child log/u)
  // Every handle is closed, including the child whose cold read failed.
  assert.deepEqual(closed.sort(), headers.map(value => value.id).sort())
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
