import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { createNativeImageTaskRuntime } from '../src/profile/native-image-task-runner.ts'

const deferred = () => {
  let resolve
  const promise = new Promise(complete => { resolve = complete })
  return { promise, resolve }
}

const attachment = ordinal => ({
  attachmentId: 'sha256:' + String(ordinal).padStart(64, '0'),
  mediaType: 'image/png', bytes: 8, width: 1, height: 1, name: 'image-' + ordinal + '.png',
})

function controlledHarness({ outcome = () => 'completed', failTaskFlush } = {}) {
  const log = []
  const parentEvents = []
  const parentSession = {
    header: { id: 'parent' },
    events: parentEvents,
    append(type, data, options) { parentEvents.push({ seq: parentEvents.length, type, data, options }) },
  }
  const parent = { id: 'parent', session: parentSession }
  const jobs = new Map()
  const childSessions = []
  const settles = new Map()
  const disposeReleases = new Map()
  const disposeEntered = new Set()
  const startWaiters = []
  const linked = []
  const linkWaiters = []
  const opened = []
  const openWaiters = []
  const disposeWaiters = new Map()
  const disposers = []
  const starts = []
  const aborted = []
  let runtime
  let live = 0
  let maximum = 0
  let taskFlushFailed = false

  const notifyStarts = () => {
    for (let index = startWaiters.length - 1; index >= 0; index -= 1) {
      if (starts.length >= startWaiters[index].count) startWaiters.splice(index, 1)[0].resolve()
    }
  }
  const waitStarted = count => starts.length >= count ? Promise.resolve() : new Promise(resolve => startWaiters.push({ count, resolve }))
  const waitLinked = count => linked.length >= count ? Promise.resolve() : new Promise(resolve => linkWaiters.push({ count, resolve }))
  const waitOpened = count => opened.length >= count ? Promise.resolve() : new Promise(resolve => openWaiters.push({ count, resolve }))
  const waitDisposeEntered = ordinal => disposeEntered.has(ordinal) ? Promise.resolve() : new Promise(resolve => disposeWaiters.set(ordinal, resolve))

  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    sessions: {
      async flush(current) {
        if (current.header.origin === 'subagent') {
          log.push(['child-flush', Number(current.header.id.slice(6))])
          return true
        }
        const event = parentEvents.at(-1)?.data
        if (event?.kind === 'task-linked') {
          linked.push(event.task.ordinal)
          for (let index = linkWaiters.length - 1; index >= 0; index -= 1) {
            if (linked.length >= linkWaiters[index].count) linkWaiters.splice(index, 1)[0].resolve()
          }
        }
        if (event?.kind === 'task-state') {
          log.push(['parent-task-flush', event.task.ordinal])
          if (!taskFlushFailed && failTaskFlush === event.task.ordinal) {
            taskFlushFailed = true
            return false
          }
        }
        return true
      },
    },
    emateModelPolicy: { async assertModel(model) { assert.equal(model, 'gpt-image2.5-flare') } },
    jobs: { get(id, owner) { const job = jobs.get(id); assert.equal(job?.ownerSession, owner.id); return job } },
    subagents: {
      getProvider() { return { inheritsParentContext: false, capabilities: { toolFilter: true, persona: true } } },
      async start(name, request) {
        assert.equal(name, 'spawn')
        const ordinal = starts.length + 1
        starts.push(ordinal)
        log.push(['start', ordinal])
        live += 1
        maximum = Math.max(maximum, live)
        notifyStarts()
        const backing = []
        let settled = false
        const childSession = {
          header: { id: 'child-' + ordinal, origin: 'subagent', parentSession: 'parent' },
          get events() {
            if (settled) log.push(['inspect', ordinal])
            return backing
          },
          append(type, data, options) { backing.push({ seq: backing.length, type, data, options }) },
        }
        childSessions.push(childSession)
        const descriptor = { version: 2, mode: 'one-shot', provider: 'spawn', label: request.label }
        childSession.append('subagent/descriptor', descriptor)
        const callId = 'call-' + ordinal
        childSession.append('tool/call', { name: 'imagegen', callId })
        const child = { id: 'child-' + ordinal, session: childSession }
        const settle = deferred()
        const abortedGate = deferred()
        settles.set(ordinal, settle)
        request.signal.addEventListener('abort', () => {
          aborted.push(ordinal)
          abortedGate.resolve('aborted')
        }, { once: true })
        const result = (async () => {
          const args = JSON.parse(request.prompt[0].text.split('\n')[2])
          const scope = await runtime.claim(child, args)
          opened.push(ordinal)
          for (let index = openWaiters.length - 1; index >= 0; index -= 1) {
            if (opened.length >= openWaiters[index].count) openWaiters.splice(index, 1)[0].resolve()
          }
          const selected = await Promise.race([settle.promise, abortedGate.promise])
          if (selected === 'aborted') { settled = true; return { stopReason: 'aborted', output: [] } }
          if (selected === 'failed') {
            childSession.append('emate/image-output', {
              schema_version: 2, revision: 2, call_id: callId, operation: 'generate', status: 'failed',
              billing_status: 'not-submitted', parent_session_id: child.id,
              client_request_id: 'image-' + scope.taskId.slice('sha256:'.length), sources: [], content: [],
              failure_code: 'gateway-rejected',
            })
          } else {
            const output = attachment(ordinal)
            const jobId = 'job-' + ordinal
            jobs.set(jobId, { kind: 'emate-image', ownerSession: child.id, status: 'completed' })
            childSession.append('emate/image-output', {
              schema_version: 2, revision: 2, call_id: callId, operation: 'generate', status: 'completed',
              billing_status: 'recorded', parent_session_id: child.id,
              client_request_id: 'image-' + scope.taskId.slice('sha256:'.length), sources: [],
              content: [{ type: 'image', attachment: output }], job_id: jobId, output,
            })
          }
          settled = true
          return { stopReason: selected === 'failed' ? 'error' : 'completed', output: [] }
        })()
        let disposal
        return {
          id: child.id, localAgent: child, result,
          dispose() {
            disposal ??= (async () => {
              await result.catch(() => undefined)
              log.push(['dispose-enter', ordinal])
              disposeEntered.add(ordinal)
              disposeWaiters.get(ordinal)?.()
              const release = deferred()
              disposeReleases.set(ordinal, release)
              await release.promise
              log.push(['dispose-finish', ordinal])
              live -= 1
            })()
            return disposal
          },
        }
      },
    },
  }
  runtime = createNativeImageTaskRuntime(ctx, { deadlineMs: 60_000,
    readDurableResult: async (_parent, batchId) => {
      const terminal = parentEvents.findLast(event => event.data?.kind === 'terminal' && event.data.batch_id === batchId).data
      const images = terminal.tasks.filter(task => task.receipt?.status === 'completed').map(task => {
        const child = childSessions.find(value => value.header.id === task.child_session_id)
        const receipt = child.events.find(event => event.seq === task.receipt.event_seq).data
        return { task_id: task.task_id, ordinal: task.ordinal, child_session_id: task.child_session_id, receipt: task.receipt, attachment: receipt.output }
      })
      const failures = terminal.tasks.filter(task => task.state !== 'completed').map(task => ({ task_id: task.task_id, ordinal: task.ordinal,
        state: task.state, failure_code: task.failure_code, ...(task.child_session_id === undefined ? {} : { child_session_id: task.child_session_id }),
        ...(task.job_id === undefined ? {} : { job_id: task.job_id }), ...(task.receipt === undefined ? {} : { receipt: task.receipt }) }))
      return { schema_version: 1, batch_id: batchId, status: terminal.status, tasks: terminal.tasks, images, failures, terminal_event_id: terminal.event_id }
    },
  })
  return {
    runtime, parent, parentSession, log, starts, aborted,
    stats: () => ({ live, maximum }),
    waitStarted, waitLinked, waitOpened,
    waitDisposeEntered,
    settle(ordinal, selected = outcome(ordinal)) { settles.get(ordinal).resolve(selected) },
    releaseDispose(ordinal) { disposeReleases.get(ordinal).resolve() },
    dispose: () => Promise.all(disposers.map(dispose => dispose())),
  }
}

function seeded(seed) {
  let state = seed >>> 0
  return maximum => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % maximum
  }
}

async function runInterleaving(seed, count, concurrency) {
  const reject = ordinal => (ordinal + seed) % 4 === 0 ? 'failed' : 'completed'
  const h = controlledHarness({ outcome: reject })
  const raw = { tasks: Array.from({ length: count }, (_, index) => ({ prompt: 'seed ' + seed + ' task ' + (index + 1) })) }
  if (concurrency !== undefined) raw.concurrency = concurrency
  const bound = Math.min(concurrency ?? 3, count)
  const execution = h.runtime.execute(raw, { agent: h.parent, callId: 'seed-' + seed, signal: new AbortController().signal })
  await h.waitStarted(bound)
  assert.deepEqual(h.starts, Array.from({ length: bound }, (_, index) => index + 1))
  assert.equal(h.stats().maximum <= bound, true)

  const choose = seeded(seed)
  const active = Array.from({ length: bound }, (_, index) => index + 1)
  let started = bound
  while (active.length > 0) {
    const selectedIndex = choose(active.length)
    const ordinal = active.splice(selectedIndex, 1)[0]
    h.settle(ordinal)
    await h.waitDisposeEntered(ordinal)
    assert.equal(h.starts.length, started, 'refilled before disposal for task ' + ordinal)
    assert.equal(h.stats().live <= bound, true)
    const phases = h.log.filter(([, value]) => value === ordinal).map(([phase]) => phase)
    assert(phases.indexOf('child-flush') < phases.indexOf('inspect'))
    assert(phases.indexOf('inspect') < phases.lastIndexOf('parent-task-flush'))
    assert(phases.lastIndexOf('parent-task-flush') < phases.indexOf('dispose-enter'))
    h.releaseDispose(ordinal)
    if (started < count) {
      started += 1
      await h.waitStarted(started)
      assert.equal(h.starts.at(-1), started)
      assert(h.log.findIndex(([phase, value]) => phase === 'dispose-finish' && value === ordinal)
        < h.log.findIndex(([phase, value]) => phase === 'start' && value === started))
      active.push(started)
    }
  }

  const result = await execution
  assert.equal(h.stats().live, 0)
  assert.equal(h.stats().maximum <= bound, true)
  assert.deepEqual(h.starts, Array.from({ length: count }, (_, index) => index + 1))
  assert.deepEqual(result.images.map(item => item.ordinal), result.images.map(item => item.ordinal).toSorted((a, b) => a - b))
  assert.deepEqual(result.failures.map(item => item.ordinal), result.failures.map(item => item.ordinal).toSorted((a, b) => a - b))
  assert.deepEqual(result.failures.map(item => item.failure_code), Array(result.failures.length).fill('gateway-rejected'))
  assert.equal(result.images.length + result.failures.length, count)
  assert.equal(result.images.length > 0, true)
  await h.dispose()
}

test('seeded controlled interleavings preserve the shared worker bound, fairness, refill order, and partial results', async () => {
  const modes = [undefined, 1, 2, 3, 4]
  for (let seed = 1; seed <= 140; seed += 1) {
    await runInterleaving(seed, 2 + seed % 7, modes[seed % modes.length])
  }
})

test('signal cancellation aborts active gates, starts no queued child, disposes all live runs, and settles truthfully', async () => {
  const controller = new AbortController()
  const h = controlledHarness()
  const execution = h.runtime.execute({ tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: 'cancel ' + index })), concurrency: 3 },
    { agent: h.parent, callId: 'cancel', signal: controller.signal })
  await h.waitStarted(3)
  await h.waitLinked(3)
  await h.waitOpened(3)
  controller.abort(new Error('controlled cancellation'))
  await Promise.all([1, 2, 3].map(ordinal => h.waitDisposeEntered(ordinal)))
  assert.deepEqual(h.starts, [1, 2, 3])
  assert.deepEqual(h.aborted.toSorted((a, b) => a - b), [1, 2, 3])
  for (const ordinal of [1, 2, 3]) h.releaseDispose(ordinal)
  const result = await execution
  assert.equal(h.stats().live, 0)
  assert.deepEqual(h.starts, [1, 2, 3])
  assert(result.tasks.slice(0, 3).every(task => task.state === 'cancelled' && task.submission_status === 'unknown'),
    JSON.stringify(result.tasks.slice(0, 3)))
  assert(result.tasks.slice(3).every(task => task.state === 'cancelled' && task.submission_status === 'not-submitted'))
})

test('HMR disposal and persistence fatality quiesce active runs before settlement without queued refill', async t => {
  await t.test('HMR', async () => {
    const h = controlledHarness()
    const execution = h.runtime.execute({ tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: 'hmr ' + index })), concurrency: 4 },
      { agent: h.parent, callId: 'hmr', signal: new AbortController().signal })
    await h.waitStarted(4)
    await h.waitLinked(4)
    await h.waitOpened(4)
    const disposal = h.dispose()
    await Promise.all([1, 2, 3, 4].map(ordinal => h.waitDisposeEntered(ordinal)))
    assert.deepEqual(h.starts, [1, 2, 3, 4])
    for (const ordinal of [1, 2, 3, 4]) h.releaseDispose(ordinal)
    await disposal
    const result = await execution
    assert.equal(h.stats().live, 0)
    assert.deepEqual(h.starts, [1, 2, 3, 4])
    assert(result.tasks.slice(4).every(task => task.state === 'failed' && task.submission_status === 'not-submitted'))
  })

  await t.test('persistence fatal', async () => {
    const h = controlledHarness({ failTaskFlush: 1 })
    const execution = h.runtime.execute({ tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: 'fatal ' + index })), concurrency: 3 },
      { agent: h.parent, callId: 'fatal', signal: new AbortController().signal })
    await h.waitStarted(3)
    h.settle(1, 'completed')
    await Promise.all([1, 2, 3].map(ordinal => h.waitDisposeEntered(ordinal)))
    assert.deepEqual(h.starts, [1, 2, 3])
    for (const ordinal of [1, 2, 3]) h.releaseDispose(ordinal)
    await assert.rejects(execution, /flush did not reach durable storage/)
    assert.equal(h.stats().live, 0)
    assert.deepEqual(h.starts, [1, 2, 3])
  })
})

test('batch worker adds no gateway scheduling protocol, batch endpoint, second owner, or registration', () => {
  const runner = readFileSync(new URL('../src/profile/native-image-task-runner.ts', import.meta.url), 'utf8')
  const generation = readFileSync(new URL('../src/profile/image-generation.ts', import.meta.url), 'utf8')
  assert.equal(existsSync(new URL('../src/profile/image-batch-admission.ts', import.meta.url)), false)
  assert.doesNotMatch(runner + generation, /\/images\/batch|['"]n['"]\s*:\s*[2-9]|x-[^'"\n]*(?:queue|priority|schedul)/iu)
  assert.equal((generation.match(/name: 'image_batch'/g) ?? []).length, 1)
  assert.equal((generation.match(/name: 'imagegen'/g) ?? []).length, 1)
})
