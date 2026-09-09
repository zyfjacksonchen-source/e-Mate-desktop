import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createNativeImageTaskRuntime } from '../src/profile/native-image-task-runner.ts'

const image = ordinal => ({ attachmentId: 'sha256:' + String(ordinal).padStart(64, '0'), mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'same-image.png' })

function session(id, meta = {}) {
  const events = []
  return { header: { id, ...meta }, events, append(type, data, options) { events.push({ seq: events.length, time: Date.now(), type, data, options }) } }
}

function harness({ flush = async () => true, mutateRun, outcome = 'completed', callCount = 1, parentSessionId = 'parent', onStart, onDispose, descriptorTransform, claimArgs, deadlineMs = 2_000, sourceRefs, receiptMutate, extraReceipt, durableResultMutate } = {}) {
  const disposers = []
  const parentSession = session(parentSessionId)
  const parent = { id: parentSessionId, session: parentSession }
  let runtime
  let live = 0
  let maximum = 0
  let providers = 0
  let durableReads = 0
  let childOrdinal = 0
  const scopes = []
  const starts = []
  const disposedOrder = []
  const aborted = []
  const childPrompts = []
  const childSessions = []
  const sourceResolutions = []
  const returnedStarts = new Set()
  const claimsBeforeReturn = []
  const jobs = new Map()
  const ctx = {
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    sessions: { flush },
    emateModelPolicy: { assertModel: async model => assert.equal(model, 'gpt-image-2.5-flare') },
    jobs: { get(id, owner) { const job = jobs.get(id); assert.equal(job.ownerSession, owner.id); return job } },
    subagents: {
      getProvider: () => ({ inheritsParentContext: false, capabilities: { toolFilter: true, persona: true } }),
      async start(name, request) {
        assert.equal(name, 'spawn')
        assert.deepEqual(request.toolFilter, { allow: ['imagegen'] })
        assert(!request.prompt[0].text.includes(request.label.slice('emate-image-batch:'.length)))
        childPrompts.push(request.prompt)
        const ordinal = ++childOrdinal
        const childSession = session('child-' + ordinal, { origin: 'subagent', parentSession: parentSessionId })
        childSessions.push(childSession)
        starts.push(ordinal)
        if (onStart !== undefined) onStart({ ordinal, request, childSession })
        request.signal.addEventListener('abort', () => aborted.push(ordinal), { once: true })
        const descriptor = { version: 2, mode: 'one-shot', provider: 'spawn', label: request.label }
        childSession.append('subagent/descriptor', descriptorTransform === undefined ? descriptor : descriptorTransform(descriptor))
        const callId = 'call-' + ordinal
        for (let index = 0; index < callCount; index += 1) childSession.append('tool/call', { name: 'imagegen', callId: index === 0 ? callId : callId + '-' + index })
        live += 1; maximum = Math.max(maximum, live)
        let disposed = false
        const args = JSON.parse(request.prompt[0].text.split('\n')[2])
        const child = { id: 'child-' + ordinal, session: childSession }
        const result = (async () => {
          if (callCount === 0) return { stopReason: 'completed', output: [] }
          const scope = await runtime.claim(child, claimArgs === undefined ? args : claimArgs(args, ordinal))
          scopes.push(scope)
          assert.match(scope.batchId, /^sha256:[0-9a-f]{64}$/)
          assert.equal(scope.ordinal, ordinal)
          assert.match(scope.taskId, /^sha256:[0-9a-f]{64}$/)
          const selected = typeof outcome === 'function' ? outcome(ordinal) : outcome
          const ids = Array.isArray(args.image_url) ? args.image_url : args.image_url === undefined ? [] : [args.image_url]
          const operation = ids.length === 0 ? 'generate' : ids.length === 1 ? 'edit' : 'fusion'
          const sources = request.prompt.slice(1).map(block => block.attachment)
          if (selected === 'wait-abort') {
            await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
            return { stopReason: 'aborted', output: [] }
          }
          if (selected === 'crash') {
            providers += 1
            throw new Error('simulated child crash')
          }
          if (selected === 'no-receipt') return { stopReason: 'completed', output: [] }
          if (selected === 'pre-job-failed') {
            childSession.append('emate/image-output', { schema_version: 2, revision: 2, call_id: callId,
              operation, status: 'failed', billing_status: 'not-submitted', parent_session_id: child.id,
              client_request_id: 'image-' + scope.taskId.slice('sha256:'.length), sources, content: [], failure_code: 'validation-failed', verifier: {}, verification: {} })
            return { stopReason: 'error', output: [] }
          }
          providers += 1
          const jobId = 'emate-image-' + ordinal
          jobs.set(jobId, { kind: 'emate-image', ownerSession: child.id, status: 'completed' })
          const output = selected === 'invalid-image' ? { ...image(ordinal), extra: true }
            : selected === 'invalid-hash' ? { ...image(ordinal), attachmentId: 'sha256:no' }
              : selected === 'invalid-bytes' ? { ...image(ordinal), bytes: 0 }
                : selected === 'invalid-dimension' ? { ...image(ordinal), width: 65_536 }
                  : selected === 'invalid-name' ? { ...image(ordinal), name: 'bad/name.png' } : image(ordinal)
          const historicalReview = selected === 'historical-reviewed' || selected === 'review-rejected'
          if (sources.length > 0 && historicalReview) childSession.append('emate/image-output', { schema_version: 2, revision: 2, call_id: callId,
            operation, status: 'needs-review', billing_status: 'recorded', parent_session_id: child.id,
            client_request_id: 'image-' + scope.taskId.slice('sha256:'.length), sources,
            content: [{ type: 'image', attachment: output }], job_id: jobId, output, verifier: {}, verification: {} })
          const finalReceipt = { schema_version: 2,
            revision: selected === 'invalid-revision' ? 4 : sources.length > 0 && historicalReview ? 3 : 2, call_id: callId,
            operation: selected === 'invalid-operation' ? (operation === 'generate' ? 'edit' : 'generate') : operation,
            status: selected === 'bad-status' ? { value: 'completed' } : selected === 'review-rejected' ? 'failed' : 'completed',
            billing_status: 'recorded', parent_session_id: child.id,
            client_request_id: 'image-' + scope.taskId.slice('sha256:'.length), sources: selected === 'invalid-sources' ? [image(99)] : sources,
            content: selected === 'review-rejected' ? [] : [{ type: 'image', attachment: output }], job_id: jobId,
            output, ...(selected === 'review-rejected' ? { failure_code: 'user-rejected' } : {}), verifier: {}, verification: {} }
          childSession.append('emate/image-output', receiptMutate === undefined ? finalReceipt : receiptMutate(finalReceipt, ordinal))
          if (extraReceipt !== undefined) childSession.append('emate/image-output', extraReceipt(finalReceipt, ordinal))
          return { stopReason: 'completed', output: [] }
        })()
        const run = { id: child.id, localAgent: child, result,
          async dispose() { if (!disposed) { disposed = true; await result.catch(() => undefined); try { if (onDispose !== undefined) await onDispose(ordinal) } finally { disposedOrder.push(ordinal); live -= 1 } } } }
        returnedStarts.add(ordinal)
        return mutateRun ? mutateRun(run, ordinal) : run
      },
    },
  }
  const readDurableResult = async (_parent, batchId) => {
    durableReads += 1
    const terminal = parentSession.events.findLast(event => event.type === 'emate/image-batch' && event.data.kind === 'terminal' && event.data.batch_id === batchId).data
    const images = terminal.tasks.filter(task => task.receipt?.status === 'completed').map(task => {
      const child = childSessions.find(value => value.header.id === task.child_session_id)
      const receipt = child.events.find(event => event.seq === task.receipt.event_seq).data
      return { task_id: task.task_id, ordinal: task.ordinal, child_session_id: task.child_session_id,
        receipt: task.receipt, attachment: receipt.output }
    })
    const failures = terminal.tasks.filter(task => task.state !== 'completed').map(task => ({ task_id: task.task_id,
      ordinal: task.ordinal, state: task.state, failure_code: task.failure_code,
      ...(task.child_session_id === undefined ? {} : { child_session_id: task.child_session_id }),
      ...(task.job_id === undefined ? {} : { job_id: task.job_id }), ...(task.receipt === undefined ? {} : { receipt: task.receipt }) }))
    const value = { schema_version: 1, batch_id: batchId, status: terminal.status, tasks: terminal.tasks,
      images, failures, terminal_event_id: terminal.event_id }
    return durableResultMutate === undefined ? value : durableResultMutate(value)
  }
  runtime = createNativeImageTaskRuntime(ctx, { deadlineMs,
    resolveSources: sourceRefs === undefined ? undefined : async (_parent, ids) => { sourceResolutions.push([...ids]); return ids.map(id => sourceRefs.get(id)) },
    readDurableResult,
  })
  const claim = runtime.claim
  runtime.claim = (agent, args) => { claimsBeforeReturn.push(!returnedStarts.has(Number(agent.id.slice('child-'.length)))); return claim(agent, args) }
  return { ctx, runtime, parent, parentSession, stats: () => ({ live, maximum, providers, durableReads, scopes, starts, disposedOrder, aborted, claimsBeforeReturn, childPrompts, childSessions, sourceResolutions }), dispose: async () => Promise.all(disposers.map(fn => fn())) }
}

for (const count of [2, 4, 5, 8]) test('runs ' + count + ' tasks with the requested worker bound', async () => {
  const h = harness()
  const concurrency = count === 2 ? 1 : 4
  const result = await h.runtime.execute({ tasks: Array.from({ length: count }, (_, index) => ({ prompt: 'image ' + index })), concurrency },
    { agent: h.parent, callId: 'batch-' + count, signal: new AbortController().signal })
  assert.equal(result.status, 'completed')
  assert.equal(result.images.length, count)
  assert.equal(result.failures.length, 0)
  assert.equal(h.stats().providers, count)
  assert(h.stats().maximum <= concurrency)
  assert.equal(h.stats().live, 0)
  assert.deepEqual(h.parentSession.events.map(event => event.data.kind).filter(Boolean).at(-1), 'terminal')
  const parentLog = JSON.stringify(h.parentSession.events)
  assert.equal(parentLog.includes('image 0'), false)
  assert.equal(parentLog.includes('attachmentId'), false)
  assert.equal(parentLog.includes('mediaType'), false)
  await h.dispose()
})

test('final Tool value comes from durable reader only after terminal flush', async () => {
  const h = harness({ durableResultMutate: value => ({ ...value, status: 'failed', images: [] }) })
  const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] },
    { agent: h.parent, callId: 'durable-result', signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.images, [])
  assert.equal(h.stats().durableReads, 1)
  assert.equal(h.parentSession.events.at(-1).data.kind, 'terminal')
})

test('ordinary direct Agent claim returns without reading long session events', async () => {
  const h = harness()
  let eventReads = 0
  const longHistory = Array.from({ length: 100_000 }, (_, seq) => ({ seq, type: 'user/message', data: { seq } }))
  const appended = []
  const directSession = {
    header: { id: 'direct-parent' },
    get events() { eventReads += 1; return longHistory },
    append(type, data) { appended.push({ type, data }) },
  }
  const direct = { id: 'direct-parent', session: directSession }
  assert.equal(await h.runtime.claim(direct, { prompt: 'one direct image' }), undefined)
  assert.equal(eventReads, 0)
  assert.equal(h.stats().starts.length, 0)
  assert.equal(appended.filter(event => event.type === 'emate/image-batch').length, 0)
  assert.equal(h.parentSession.events.filter(event => event.type === 'emate/image-batch').length, 0)
})

test('provider remains closed until the parent child link is durable', async () => {
  let release
  let entered
  const blocked = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let parentSession
  const h = harness({ flush: async current => {
    if (current === parentSession && current.events.at(-1)?.data?.kind === 'task-linked') {
      entered()
      await gate
    }
    return true
  } })
  parentSession = h.parentSession
  const execution = h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
    { agent: h.parent, callId: 'ordering', signal: new AbortController().signal })
  await blocked
  assert.equal(h.stats().providers, 0)
  assert.deepEqual(h.stats().claimsBeforeReturn, [true])
  release()
  const result = await execution
  assert.equal(result.images.length, 2)
  assert.equal(h.stats().providers, 2)
})

test('source route preflights normalized IDs and carries exact ordered ContentBlocks', async () => {
  const first = image(10)
  const second = image(11)
  const h = harness({ sourceRefs: new Map([[first.attachmentId, first], [second.attachmentId, second]]) })
  let questionLookups = 0
  let questionCalls = 0
  h.ctx.get = name => {
    if (name !== 'userQuestions') return undefined
    questionLookups += 1
    return { ask() { questionCalls += 1; throw new Error('must not ask') } }
  }
  const result = await h.runtime.execute({ tasks: [
    { prompt: '  编辑 多字节 🌟  ', image_url: [first.attachmentId, first.attachmentId, second.attachmentId] },
    { prompt: 'new', image_url: [] },
  ], concurrency: 1 }, { agent: h.parent, callId: 'source', signal: new AbortController().signal })
  assert.equal(result.status, 'completed')
  assert.equal(questionLookups, 0)
  assert.equal(questionCalls, 0)
  assert.deepEqual(h.stats().sourceResolutions, [[first.attachmentId, second.attachmentId]])
  assert.deepEqual(h.stats().childPrompts[0].slice(1), [
    { type: 'image', attachment: first }, { type: 'image', attachment: second },
  ])
  assert.deepEqual(JSON.parse(h.stats().childPrompts[0][0].text.split('\n')[2]), {
    prompt: '编辑 多字节 🌟', image_url: [first.attachmentId, second.attachmentId],
  })
  assert.equal(h.stats().childPrompts[1].length, 1)
  for (const child of h.stats().childSessions) {
    const receipts = child.events.filter(event => event.type === 'emate/image-output').map(event => event.data)
    assert.equal(receipts.some(receipt => receipt.status === 'needs-review' || receipt.revision === 3), false)
  }
  assert.deepEqual(h.parentSession.events[0].data.tasks.map(task => task.image_url), [
    [first.attachmentId, second.attachmentId], [],
  ])
})

test('claimed source gate rejects reordered IDs and extra fields before provider', async t => {
  const refs = [image(12), image(13)]
  for (const [name, claimArgs] of [
    ['reordered', args => ({ ...args, image_url: [...args.image_url].reverse() })],
    ['extra', args => ({ ...args, model: 'forbidden' })],
  ]) await t.test(name, async () => {
    const h = harness({ sourceRefs: new Map(refs.map(ref => [ref.attachmentId, ref])), claimArgs })
    const result = await h.runtime.execute({ tasks: [
      { prompt: 'edit', image_url: refs.map(ref => ref.attachmentId) },
      { prompt: 'edit again', image_url: refs.map(ref => ref.attachmentId) },
    ], concurrency: 1 }, { agent: h.parent, callId: 'source-' + name, signal: new AbortController().signal })
    assert.equal(result.status, 'failed')
    assert.equal(h.stats().providers, 0)
    assert.deepEqual(h.stats().sourceResolutions, [refs.map(ref => ref.attachmentId)])
    assert.equal(result.tasks[0].submission_status, 'not-submitted')
  })
})

test('rejected source review keeps revision-two and revision-three output evidence child-owned', async () => {
  const source = image(15)
  const h = harness({ sourceRefs: new Map([[source.attachmentId, source]]), outcome: 'review-rejected' })
  const result = await h.runtime.execute({ tasks: [
    { prompt: 'edit', image_url: source.attachmentId }, { prompt: 'edit again', image_url: source.attachmentId },
  ] }, { agent: h.parent, callId: 'source-rejected', signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(result.images.length, 0)
  for (const child of h.stats().childSessions) {
    const receipts = child.events.filter(event => event.type === 'emate/image-output').map(event => event.data)
    assert.deepEqual(receipts.map(receipt => [receipt.revision, receipt.status]), [[2, 'needs-review'], [3, 'failed']])
    assert(receipts.every(receipt => receipt.output !== undefined))
  }
  assert.equal(JSON.stringify(h.parentSession.events).includes('attachmentId'), false)
})

test('source validation failure before Job remains terminal without review', async () => {
  const source = image(14)
  const h = harness({ sourceRefs: new Map([[source.attachmentId, source]]), outcome: 'pre-job-failed' })
  const result = await h.runtime.execute({ tasks: [
    { prompt: 'edit', image_url: source.attachmentId }, { prompt: 'edit again', image_url: source.attachmentId },
  ] }, { agent: h.parent, callId: 'source-pre-job', signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(h.stats().providers, 0)
  assert(result.failures.every(failure => failure.receipt.status === 'failed' && failure.job_id === undefined))
  assert(h.stats().childPrompts.every(content => content.length === 2))
})

test('unavailable source resolution and failed created durability stop before provider', async () => {
  const source = harness()
  await assert.rejects(source.runtime.execute({ tasks: [{ prompt: 'a', image_url: image(1).attachmentId }, { prompt: 'b' }] },
    { agent: source.parent, callId: 'source-unavailable', signal: new AbortController().signal }), /source resolution is unavailable/)
  assert.equal(source.parentSession.events.length, 0)
  assert.equal(source.stats().providers, 0)

  const failed = harness({ flush: async () => false })
  await assert.rejects(failed.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] },
    { agent: failed.parent, callId: 'flush', signal: new AbortController().signal }), /did not reach durable storage/)
  assert.equal(failed.stats().providers, 0)
  assert.deepEqual(failed.parentSession.events.map(event => event.data.kind), ['created'])
})

test('remote or mismatched local runs never open the provider gate', async () => {
  const h = harness({ mutateRun: run => ({ ...run, localAgent: undefined }) })
  const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
    { agent: h.parent, callId: 'remote', signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(result.images.length, 0)
  assert.equal(h.stats().providers, 0)
})

test('created, link, child, task, and terminal flush false or rejection fail closed', async t => {
  for (const phase of ['created', 'link', 'child', 'task', 'terminal']) {
    for (const mode of ['false', 'reject']) await t.test(phase + ' ' + mode, async () => {
      let parentSession
      let tripped = false
      const h = harness({ flush: async current => {
        const kind = current.events.at(-1)?.data?.kind
        const currentPhase = current !== parentSession ? 'child'
          : kind === 'created' ? 'created' : kind === 'task-linked' ? 'link'
            : kind === 'task-state' ? 'task' : kind === 'terminal' ? 'terminal' : 'other'
        if (!tripped && currentPhase === phase) {
          tripped = true
          if (mode === 'reject') throw new Error('simulated ' + phase + ' persistence rejection')
          return false
        }
        return true
      } })
      parentSession = h.parentSession
      await assert.rejects(h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
        { agent: h.parent, callId: 'flush-' + phase + '-' + mode, signal: new AbortController().signal }), /flush/)
      assert.equal(tripped, true)
      if (phase === 'created') assert.equal(h.stats().starts.length, 0)
      if (phase === 'link') assert.equal(h.stats().providers, 0)
      if (phase === 'terminal') assert.equal(h.stats().durableReads, 0)
      assert.equal(h.stats().live, 0)
    })
  }
})

test('deterministic replay guard refuses an existing batch before another start', async () => {
  const h = harness()
  const exec = { agent: h.parent, callId: 'replay', signal: new AbortController().signal }
  await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] }, exec)
  const before = h.stats().starts.length
  await assert.rejects(h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] }, exec), /automatic replay is disabled/)
  assert.equal(h.stats().starts.length, before)
  assert.equal(h.stats().providers, 2)
})

test('each task receives a distinct deterministic gateway identity', async () => {
  const h = harness()
  await h.runtime.execute({ tasks: [{ prompt: 'same' }, { prompt: 'same' }, { prompt: 'same' }], concurrency: 3 },
    { agent: h.parent, callId: 'scope', signal: new AbortController().signal })
  assert.equal(h.stats().scopes.length, 3)
  assert.equal(new Set(h.stats().scopes.map(scope => scope.taskId)).size, 3)
  assert.equal(new Set(h.stats().scopes.map(scope => scope.batchId)).size, 1)
  assert.deepEqual(h.stats().scopes.map(scope => scope.ordinal), [1, 2, 3])
})

test('opened linked crashes and missing receipts become unknown, while pre-open failures remain not-submitted', async t => {
  for (const outcome of ['crash', 'no-receipt']) await t.test(outcome, async () => {
    const h = harness({ outcome })
    const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
      { agent: h.parent, callId: 'ambiguous-' + outcome, signal: new AbortController().signal })
    assert(result.tasks.every(task => task.state === 'unknown' && task.submission_status === 'unknown'
      && task.failure_code === 'provider-outcome-unknown' && task.child_session_id !== undefined))
  })
  const preOpen = harness({ claimArgs: args => ({ ...args, prompt: 'wrong' }) })
  const result = await preOpen.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
    { agent: preOpen.parent, callId: 'pre-open', signal: new AbortController().signal })
  assert(result.tasks.every(task => task.state === 'failed' && task.submission_status === 'not-submitted'
    && task.child_session_id === undefined))
})

test('parent Agent identity must exactly own the parent Session before created', async () => {
  const h = harness()
  h.parent.id = 'other-agent'
  await assert.rejects(h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] },
    { agent: h.parent, callId: 'parent-mismatch', signal: new AbortController().signal }), /does not own its Session/)
  assert.equal(h.parentSession.events.length, 0)
  assert.equal(h.stats().starts.length, 0)
})

test('child receipt status and attachment references require canonical primitive data', async t => {
  for (const outcome of ['bad-status', 'invalid-image', 'invalid-operation', 'invalid-sources',
    'invalid-hash', 'invalid-bytes', 'invalid-dimension', 'invalid-name', 'invalid-revision']) await t.test(outcome, async () => {
    const h = harness({ outcome })
    const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
      { agent: h.parent, callId: 'strict-' + outcome, signal: new AbortController().signal })
    assert.equal(result.status, 'failed')
    assert.equal(result.images.length, 0)
    assert.equal(result.failures.length, 2)
  })
})

test('pre-Job validation receipt is retained without inventing a Job', async () => {
  const h = harness({ outcome: 'pre-job-failed' })
  const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] },
    { agent: h.parent, callId: 'pre-job', signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(result.failures.length, 2)
  assert(result.failures.every(failure => failure.receipt?.status === 'failed' && failure.job_id === undefined))
  assert.equal(h.stats().providers, 0)
})

test('partial result retains successful image and child pointer beside failure', async () => {
  const h = harness({ outcome: ordinal => ordinal === 2 ? 'pre-job-failed' : 'completed' })
  const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 2 },
    { agent: h.parent, callId: 'partial', signal: new AbortController().signal })
  assert.equal(result.status, 'partial')
  assert.equal(result.images.length, 1)
  assert.equal(result.failures.length, 1)
  assert.equal(result.images[0].ordinal, 1)
  assert.equal(result.failures[0].ordinal, 2)
})

test('foreign receipt identities never become proven images', async t => {
  for (const [name, receiptMutate] of [
    ['call', receipt => ({ ...receipt, call_id: 'foreign-call' })],
    ['client', receipt => ({ ...receipt, client_request_id: 'image-foreign' })],
    ['owner', receipt => ({ ...receipt, parent_session_id: 'foreign-child' })],
  ]) await t.test(name, async () => {
    const h = harness({ callCount: 2, receiptMutate })
    const result = await h.runtime.execute({ tasks: [{ prompt: 'same' }, { prompt: 'same' }], concurrency: 2 },
      { agent: h.parent, callId: 'foreign-' + name, signal: new AbortController().signal })
    assert.equal(result.status, 'failed')
    assert.equal(result.images.length, 0)
    assert.equal(result.failures.length, 2)
  })
})

test('illegal completed final revisions are never preserved after later contract failure', async t => {
  await t.test('new-image revision one', async () => {
    const h = harness({ callCount: 2, receiptMutate: receipt => ({ ...receipt, revision: 1 }) })
    const result = await h.runtime.execute({ tasks: [{ prompt: 'same' }, { prompt: 'same' }], concurrency: 2 },
      { agent: h.parent, callId: 'revision-one', signal: new AbortController().signal })
    assert.equal(result.status, 'failed')
    assert.equal(result.images.length, 0)
  })
  await t.test('review final repeats revision two', async () => {
    const source = image(21)
    const h = harness({ callCount: 2, sourceRefs: new Map([[source.attachmentId, source]]), outcome: 'historical-reviewed',
      receiptMutate: receipt => ({ ...receipt, revision: 2 }) })
    const result = await h.runtime.execute({ tasks: [
      { prompt: 'same', image_url: source.attachmentId }, { prompt: 'same', image_url: source.attachmentId },
    ], concurrency: 2 }, { agent: h.parent, callId: 'review-revision-two', signal: new AbortController().signal })
    assert.equal(result.status, 'failed')
    assert.equal(result.images.length, 0)
  })
})

test('legal revision two and reviewed revision three survive one later call failure exactly once', async t => {
  await t.test('revision two', async () => {
    const h = harness({ callCount: 2 })
    const result = await h.runtime.execute({ tasks: [{ prompt: 'same' }, { prompt: 'same' }], concurrency: 2 },
      { agent: h.parent, callId: 'legal-two', signal: new AbortController().signal })
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.images.map(item => item.ordinal), [1, 2])
    assert.deepEqual(result.failures.map(item => item.ordinal), [1, 2])
  })
  await t.test('reviewed revision three', async () => {
    const source = image(22)
    const h = harness({ callCount: 2, sourceRefs: new Map([[source.attachmentId, source]]), outcome: 'historical-reviewed' })
    const result = await h.runtime.execute({ tasks: [
      { prompt: 'same', image_url: source.attachmentId }, { prompt: 'same', image_url: source.attachmentId },
    ], concurrency: 2 }, { agent: h.parent, callId: 'legal-three', signal: new AbortController().signal })
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.images.map(item => item.ordinal), [1, 2])
    assert.deepEqual(result.failures.map(item => item.ordinal), [1, 2])
  })
})

test('duplicate or foreign late receipt cannot replace first exact completed evidence', async () => {
  const h = harness({ callCount: 2, extraReceipt: (receipt, ordinal) => ({
    ...receipt, call_id: 'foreign-' + ordinal, client_request_id: 'image-foreign-' + ordinal,
    output: { ...receipt.output, attachmentId: 'sha256:' + 'f'.repeat(64) },
    content: [{ type: 'image', attachment: { ...receipt.output, attachmentId: 'sha256:' + 'f'.repeat(64) } }],
  }) })
  const result = await h.runtime.execute({ tasks: [{ prompt: 'same' }, { prompt: 'same' }], concurrency: 2 },
    { agent: h.parent, callId: 'late-foreign', signal: new AbortController().signal })
  assert.equal(result.status, 'partial')
  assert.equal(result.images.length, 2)
  assert.equal(result.failures.length, 2)
  assert.deepEqual(result.images.map(item => item.attachment.attachmentId), [image(1).attachmentId, image(2).attachmentId])
})

test('four completed and one failed returns partial with exactly four images', async () => {
  const h = harness({ outcome: ordinal => ordinal === 5 ? 'pre-job-failed' : 'completed' })
  const result = await h.runtime.execute({ tasks: Array.from({ length: 5 }, (_, index) => ({ prompt: 'same name ' + index })), concurrency: 4 },
    { agent: h.parent, callId: 'four-plus-one', signal: new AbortController().signal })
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.images.map(item => item.ordinal), [1, 2, 3, 4])
  assert.deepEqual(result.failures.map(item => item.ordinal), [5])
})

test('wrong, zero, multiple, sibling, continuable, and remote children cannot authorize another provider call', async t => {
  const cases = [
    ['wrong args', { claimArgs: args => ({ ...args, prompt: 'wrong' }) }],
    ['zero calls', { callCount: 0 }],
    ['multiple calls', { callCount: 2 }],
    ['sibling parent', { onStart: ({ childSession }) => { childSession.header.parentSession = 'sibling' } }],
    ['continuable descriptor', { descriptorTransform: value => ({ ...value, mode: 'continuable' }) }],
    ['remote run', { mutateRun: run => ({ ...run, localAgent: undefined }) }],
  ]
  for (const [name, options] of cases) await t.test(name, async () => {
    const h = harness(options)
    const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
      { agent: h.parent, callId: 'guard-' + name, signal: new AbortController().signal })
    if (name === 'multiple calls') {
      assert.equal(result.status, 'partial')
      assert.equal(result.images.length, 2)
      assert.equal(result.failures.length, 2)
      assert.equal(h.stats().providers, 2)
    } else {
      assert.equal(result.images.length, 0)
      assert.equal(h.stats().providers, 0)
    }
  })
})

test('cancellation, timeout, and HMR abort claimed gates and dispose every run', async t => {
  await t.test('cancel', async () => {
    const controller = new AbortController()
    const h = harness({ outcome: 'wait-abort' })
    const execution = h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 2 },
      { agent: h.parent, callId: 'cancel', signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('cancel test'))
    const result = await execution
    assert.equal(result.status, 'cancelled')
    assert(result.tasks.every(task => task.state === 'cancelled' && task.submission_status === 'unknown'))
    assert.deepEqual(h.stats().aborted.sort(), [1, 2])
    assert.equal(h.stats().live, 0)
  })
  await t.test('timeout', async () => {
    const h = harness({ outcome: 'wait-abort', deadlineMs: 10 })
    const result = await h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
      { agent: h.parent, callId: 'timeout', signal: new AbortController().signal })
    assert.equal(result.status, 'failed')
    assert(result.tasks.every(task => task.state === 'unknown' && task.submission_status === 'unknown'))
    assert.equal(h.stats().live, 0)
    assert(h.stats().aborted.length >= 1)
  })
  await t.test('HMR dispose', async () => {
    const h = harness({ outcome: 'wait-abort' })
    const execution = h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 2 },
      { agent: h.parent, callId: 'hmr', signal: new AbortController().signal })
    await new Promise(resolve => setImmediate(resolve))
    await h.dispose()
    await execution
    assert.equal(h.stats().live, 0)
    assert.deepEqual(h.stats().aborted.sort(), [1, 2])
  })
})

test('worker refills only after prior native run disposal completes', async () => {
  let entered
  let release
  const blocked = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const h = harness({ onDispose: async ordinal => { if (ordinal === 1) { entered(); await gate } } })
  const execution = h.runtime.execute({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 1 },
    { agent: h.parent, callId: 'dispose-refill', signal: new AbortController().signal })
  await blocked
  assert.deepEqual(h.stats().starts, [1])
  release()
  await execution
  assert.deepEqual(h.stats().starts, [1, 2])
  assert.deepEqual(h.stats().disposedOrder, [1, 2])
})

test('fatal task persistence aborts siblings immediately and stops queued admission', async () => {
  let parentSession
  let tripped = false
  const h = harness({
    outcome: ordinal => ordinal === 1 ? 'completed' : 'wait-abort',
    flush: async current => {
      if (!tripped && current === parentSession && current.events.at(-1)?.data?.kind === 'task-state') {
        tripped = true
        return false
      }
      return true
    },
  })
  parentSession = h.parentSession
  await assert.rejects(h.runtime.execute({ tasks: Array.from({ length: 5 }, (_, index) => ({ prompt: 'task ' + index })), concurrency: 2 },
    { agent: h.parent, callId: 'fatal-abort', signal: new AbortController().signal }), /flush/)
  assert.equal(tripped, true)
  assert(h.stats().aborted.includes(2))
  assert(h.stats().starts.length <= 2)
  assert.equal(h.stats().live, 0)
})

test('cleanup fatal aborts siblings immediately and prevents refill', async () => {
  const h = harness({
    outcome: ordinal => ordinal === 1 ? 'completed' : 'wait-abort',
    onDispose: async ordinal => { if (ordinal === 1) throw new Error('simulated cleanup failure') },
  })
  await assert.rejects(h.runtime.execute({ tasks: Array.from({ length: 5 }, (_, index) => ({ prompt: 'cleanup ' + index })), concurrency: 2 },
    { agent: h.parent, callId: 'cleanup-fatal', signal: new AbortController().signal }), /cleanup failure/)
  assert(h.stats().aborted.includes(2))
  assert(h.stats().starts.length <= 2)
  assert.equal(h.stats().live, 0)
})

test('public activation has one registration, Tool Search aliases, audit trust, and sessions injection', () => {
  const generation = readFileSync(new URL('../src/profile/image-generation.ts', import.meta.url), 'utf8')
  const audit = readFileSync(new URL('../src/profile/audit.ts', import.meta.url), 'utf8')
  const profile = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
  const search = readFileSync(new URL('../../dsh-plugin-tool-search/cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal((generation.match(/name: 'image_batch'/g) ?? []).length, 1)
  assert.match(generation, /imageBatchProjectionDefinition\(z\)/)
  const batchRegistration = generation.slice(generation.indexOf("name: 'image_batch'"), generation.indexOf("name: 'image_pack'"))
  assert.doesNotMatch(batchRegistration, /presentationMeta|\$eMateDeliverables|attachment_id/)
  assert.match(batchRegistration, /IMAGE_BATCH_TIMEOUT_MS/)
  assert.match(audit, /\['image_batch',[\s\S]*scenario: 'ASSET_PRODUCTION'/u)
  assert.match(profile, /sessionPersistence, sessions, agents, subagents/u)
  assert.match(search, /^\s+- image_batch$/mu)
  assert.match(search, /image_batch:[\s\S]*批量生图[\s\S]*生成多张图片/u)
})

test('one parent persistence failure does not abort or dispose another active batch', async () => {
  const parents = ['broken', 'healthy'].map(id => ({ id, session: session(id) }))
  let releaseBrokenLink
  const brokenLink = new Promise(resolve => { releaseBrokenLink = resolve })
  let healthyOpened
  const opened = new Promise(resolve => { healthyOpened = resolve })
  const runs = []
  let runtime
  const ctx = {
    effect() {},
    sessions: { async flush(current) {
      if (current.header.id === 'broken' && current.events.at(-1)?.data.kind === 'task-linked') {
        await brokenLink
        return false
      }
      return true
    } },
    emateModelPolicy: { async assertModel() {} },
    jobs: { get() { throw new Error('no Job was submitted') } },
    subagents: {
      getProvider: () => ({ inheritsParentContext: false, capabilities: { toolFilter: true, persona: true } }),
      async start(_name, request) {
        const childId = `child-${request.parent.id}-${runs.length}`
        const child = { id: childId, session: session(childId, { origin: 'subagent', parentSession: request.parent.id }) }
        child.session.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: request.label })
        const args = JSON.parse(request.prompt[0].text.split('\n')[2])
        let disposed = false
        const result = (async () => {
          await runtime.claim(child, args)
          if (request.parent.id === 'healthy') healthyOpened()
          if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
        })()
        const run = { id: child.id, localAgent: child, result, signal: request.signal,
          get disposed() { return disposed }, async dispose() { disposed = true; await result.catch(() => {}) } }
        runs.push(run)
        return run
      },
    },
  }
  runtime = createNativeImageTaskRuntime(ctx)
  const broken = runtime.execute({ tasks: [{ prompt: 'one' }, { prompt: 'two' }], concurrency: 1 },
    { agent: parents[0], callId: 'call', signal: new AbortController().signal })
  const brokenRejected = assert.rejects(broken, /flush did not reach durable storage/u)
  const controller = new AbortController()
  const healthy = runtime.execute({ tasks: [{ prompt: 'three' }, { prompt: 'four' }], concurrency: 2 },
    { agent: parents[1], callId: 'call', signal: controller.signal })
  const healthyRejected = assert.rejects(healthy)
  await opened
  releaseBrokenLink()
  await brokenRejected
  const independent = runs.find(run => run.id.startsWith('child-healthy-'))
  try {
    assert.equal(independent.signal.aborted, false)
    assert.equal(independent.disposed, false)
  } finally {
    controller.abort(new Error('test cleanup'))
    await healthyRejected
  }
  assert.equal(independent.disposed, true)
})
