import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { imageBatchProjectionDefinition } from '../../../packages/dsh/src/profile/image-batch-events.ts'
import { readDurableImageBatchResult } from '../../../packages/dsh/src/profile/image-batch-recovery.ts'
import { createNativeImageTaskRuntime } from '../../../packages/dsh/src/profile/native-image-task-runner.ts'
import { CLAIM as RELEASE_CLAIM, RELEASE_VERSION, TICKET, DESKTOP_REFERENCE, HARNESS_COMMIT, validateManifest } from './release-evidence-protocol.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const RAW_RELATIVE_PATH = 'work/em218-502/performance-image-batch-raw.json'
const MANIFEST_PATH = new URL('../../../docs/2.0.17/evidence-manifests/performance.json', import.meta.url)
const LEGAL_TERMINALS = new Set(['completed', 'failed', 'cancelled', 'unknown', 'interrupted'])
const chain = new Proxy(function () { return chain }, { get: () => chain, apply: () => chain })
const z = new Proxy({}, { get: () => chain })

function session(id, metadata = {}) {
  const events = []
  return { header: { id, ...metadata }, events,
    append(type, data, options) { events.push({ seq: events.length, time: Date.now(), type, data, options }) } }
}

function project(definition, events) {
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return definition.view(state)
}

function receiptRows(events) {
  return events.filter(event => event.type === 'emate/image-output')
    .map(event => ({ seq: event.seq, createdAt: event.time, receipt: event.data }))
}

function image(ordinal) {
  return { attachmentId: 'sha256:' + ordinal.toString(16).padStart(64, '0'), mediaType: 'image/png',
    bytes: 8, width: 1, height: 1, name: 'evidence-' + ordinal + '.png' }
}

class EvidenceOnlyBytes extends Uint8Array {
  constructor(reportedLength) { super(0); this.reportedLength = reportedLength }
  get byteLength() { return this.reportedLength }
}

function createHarness({ batchNumber, outcome }) {
  const parentId = 'parent-' + batchNumber
  const parentSession = session(parentId)
  const parent = { id: parentId, session: parentSession }
  const children = new Map()
  const jobs = new Map()
  const effects = []
  const providerCalls = new Map()
  const identityCalls = new Map()
  const completedReceiptAt = []
  const terminalAt = []
  const flushedReceipts = new Set()
  const starts = []
  const completions = []
  const startWaiters = []
  const claims = []
  const claimWaiters = []
  let runtime
  let active = 0
  let maximum = 0
  let childOrdinal = 0

  const notifyStarts = () => {
    for (let index = startWaiters.length - 1; index >= 0; index -= 1) {
      if (starts.length >= startWaiters[index].count) startWaiters.splice(index, 1)[0].resolve()
    }
  }
  const waitForStarts = count => starts.length >= count ? Promise.resolve()
    : new Promise(resolveStart => startWaiters.push({ count, resolve: resolveStart }))
  const waitForClaims = count => claims.length >= count ? Promise.resolve()
    : new Promise(resolveClaim => claimWaiters.push({ count, resolve: resolveClaim }))

  const ctx = {
    effect(setup) { const dispose = setup(); effects.push(dispose); return dispose },
    sessions: { async flush(current) {
      if (current !== parentSession) {
        const terminal = current.events.findLast(event => event.type === 'emate/image-output')
        if (terminal && !flushedReceipts.has(current.header.id)) {
          flushedReceipts.add(current.header.id)
          terminalAt.push(performance.now())
          if (terminal.data.status === 'completed') completedReceiptAt.push(performance.now())
        }
      }
      return true
    } },
    emateModelPolicy: { async assertModel(model) { assert.equal(model, 'gpt-image-2-pro') } },
    jobs: { get(id, owner) { const job = jobs.get(id); assert.equal(job?.ownerSession, owner.id); return job } },
    subagents: {
      getProvider(name) {
        assert.equal(name, 'spawn')
        return { inheritsParentContext: false, capabilities: { toolFilter: true, persona: true } }
      },
      async start(name, request) {
        assert.equal(name, 'spawn')
        assert.deepEqual(request.toolFilter, { allow: ['imagegen'] })
        const ordinal = ++childOrdinal
        const args = JSON.parse(request.prompt[0].text.split('\n')[2])
        const childSession = session('child-' + batchNumber + '-' + ordinal,
          { origin: 'subagent', parentSession: parentId })
        childSession.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: request.label })
        const callId = 'call-' + batchNumber + '-' + ordinal
        childSession.append('tool/call', { name: 'imagegen', callId, arguments: JSON.stringify(args) })
        const child = { id: childSession.header.id, session: childSession }
        children.set(child.id, { child, args })
        starts.push(ordinal)
        active += 1
        maximum = Math.max(maximum, active)
        notifyStarts()
        const result = (async () => {
          const scope = await runtime.claim(child, args)
          assert(scope)
          claims.push(ordinal)
          for (let index = claimWaiters.length - 1; index >= 0; index -= 1) {
            if (claims.length >= claimWaiters[index].count) claimWaiters.splice(index, 1)[0].resolve()
          }
          identityCalls.set(scope.taskId, (identityCalls.get(scope.taskId) ?? 0) + 1)
          const selected = outcome(ordinal)
          if (selected === 'hold') {
            await new Promise(resolveAbort => request.signal.addEventListener('abort', resolveAbort, { once: true }))
            return { stopReason: 'aborted', output: [] }
          }
          await Promise.resolve()
          const common = { schema_version: 2, revision: 2, call_id: callId, operation: 'generate',
            parent_session_id: child.id, client_request_id: 'image-' + scope.taskId.slice('sha256:'.length), sources: [] }
          if (selected === 'pre-provider-failed') {
            childSession.append('emate/image-output', { ...common, status: 'failed', billing_status: 'not-submitted',
              content: [], failure_code: 'validation-failed' })
          } else {
            providerCalls.set(scope.taskId, (providerCalls.get(scope.taskId) ?? 0) + 1)
            const jobId = 'job-' + batchNumber + '-' + ordinal
            const output = image(batchNumber * 10 + ordinal)
            if (selected === 'success') {
              jobs.set(jobId, { kind: 'emate-image', ownerSession: child.id, status: 'completed' })
              childSession.append('emate/image-output', { ...common, status: 'completed', billing_status: 'recorded',
                content: [{ type: 'image', attachment: output }], job_id: jobId, output })
            } else {
              jobs.set(jobId, { kind: 'emate-image', ownerSession: child.id, status: 'failed' })
              childSession.append('emate/image-output', { ...common, status: selected === 'unknown' ? 'unknown' : 'failed',
                billing_status: selected === 'unknown' ? 'unknown' : 'recorded', content: [], job_id: jobId,
                failure_code: selected === 'unknown' ? 'provider-outcome-unknown' : 'provider-failed' })
            }
          }
          completions.push(ordinal)
          return { stopReason: selected === 'success' ? 'completed' : 'error', output: [] }
        })()
        let disposed = false
        return { id: child.id, localAgent: child, result,
          async dispose() {
            if (disposed) return
            disposed = true
            await result.catch(() => undefined)
            active -= 1
          } }
      },
    },
    sessionProjections: {
      snapshot(current) {
        assert.equal(current, parentSession)
        const definition = imageBatchProjectionDefinition(z, parentId)
        return { values: { eMateImageBatches: project(definition, parentSession.events) } }
      },
    },
    sessionProjectionCache: {
      async coldSnapshot(childId) {
        const entry = children.get(childId)
        if (!entry) throw new Error('unknown child projection')
        return { values: { eMateImageReceipts: receiptRows(entry.child.session.events) } }
      },
    },
    attachments: {
      async readImage(ref) { return { ref, data: new EvidenceOnlyBytes(ref.bytes) } },
    },
  }
  runtime = createNativeImageTaskRuntime(ctx, {
    deadlineMs: 30_000,
    readDurableResult: (owner, batchId, signal) => readDurableImageBatchResult(ctx, owner, batchId, signal),
  })
  return {
    runtime, parent, parentSession, children, providerCalls, identityCalls, completedReceiptAt, terminalAt, starts, completions, waitForStarts, waitForClaims,
    stats: () => ({ active, maximum }),
    async dispose() { await Promise.all(effects.map(effect => effect())) },
  }
}

function outcomeFor(batchNumber, ordinal) {
  if (batchNumber % 10 === 0 || ordinal === 1) return 'success'
  return ['success', 'submitted-failed', 'pre-provider-failed', 'unknown'][(batchNumber + ordinal) % 4]
}

function nearestRank(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * quantile) - 1]
}

function summary(values) {
  return { p50_ms: nearestRank(values, 0.5), p95_ms: nearestRank(values, 0.95),
    exact_observed_interval_ms: [Math.min(...values), Math.max(...values)] }
}

function runReceiptProjectionLowerBound(ordinal) {
  const started = performance.now()
  const child = session('control-' + ordinal, { origin: 'subagent', parentSession: 'control-parent' })
  const output = image(900_000 + ordinal)
  const callId = 'control-call-' + ordinal
  child.append('tool/call', { name: 'imagegen', callId, arguments: '{}' })
  child.append('emate/image-output', { schema_version: 2, revision: 2, call_id: callId, operation: 'generate',
    status: 'completed', billing_status: 'recorded', parent_session_id: child.header.id,
    client_request_id: 'image-' + 'a'.repeat(64), sources: [], content: [{ type: 'image', attachment: output }],
    job_id: 'control-job-' + ordinal, output })
  const rows = receiptRows(child.events)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].receipt.output.attachmentId, output.attachmentId)
  const evidence = new EvidenceOnlyBytes(output.bytes)
  assert(evidence instanceof Uint8Array)
  assert.equal(evidence.byteLength, output.bytes)
  return performance.now() - started
}

const clone = value => structuredClone(value)

let benchmarkReport

test('120 complete native batches preserve terminal, receipt, identity, concurrency, refill, and local timing invariants', async () => {
  const samples = []
  const allTaskIds = new Set()
  const allChildIds = new Set()
  let taskTotal = 0
  let providerTotal = 0
  let duplicateProviderGeneration = 0
  let successfulImages = 0
  let retainedSuccessfulImages = 0
  let fullySuccessfulBatches = 0
  const perItemSamples = []
  const suiteStarted = performance.now()
  for (let batchNumber = 1; batchNumber <= 120; batchNumber += 1) {
    const taskCount = [4, 5, 8][(batchNumber - 1) % 3]
    const concurrency = [1, 2, 3, 4][(batchNumber - 1) % 4]
    const h = createHarness({ batchNumber, outcome: ordinal => outcomeFor(batchNumber, ordinal) })
    const receiptProjectionLowerBoundMs = runReceiptProjectionLowerBound(batchNumber)
    const started = performance.now()
    const result = await h.runtime.execute({
      tasks: Array.from({ length: taskCount }, (_, index) => ({ prompt: 'stress-' + batchNumber + '-' + (index + 1) })),
      concurrency,
    }, { agent: h.parent, callId: 'batch-' + batchNumber, signal: new AbortController().signal })
    const finished = performance.now()
    taskTotal += taskCount
    assert.equal(result.tasks.length, taskCount)
    assert(result.tasks.every(task => LEGAL_TERMINALS.has(task.state)))
    assert.equal(new Set(result.tasks.map(task => task.task_id)).size, taskCount)
    assert.equal(h.parentSession.events.filter(event => event.type === 'emate/image-batch' && event.data.kind === 'terminal').length, 1)
    assert.deepEqual(h.starts, Array.from({ length: taskCount }, (_, index) => index + 1))
    assert.equal(h.stats().maximum <= Math.min(concurrency, 4), true)
    assert.equal(h.stats().active, 0)
    if (taskCount >= 5) assert.deepEqual(h.completions.toSorted((a, b) => a - b), h.starts)
    const completed = result.tasks.filter(task => task.state === 'completed')
    successfulImages += completed.length
    retainedSuccessfulImages += result.images.length
    if (result.status === 'completed') {
      fullySuccessfulBatches += 1
      assert.equal(result.images.length, taskCount)
      assert.equal(result.failures.length, 0)
    }
    assert.deepEqual(result.images.map(entry => entry.task_id), completed.map(task => task.task_id))
    assert(result.images.every(entry => entry.receipt.status === 'completed' && entry.attachment.attachmentId.startsWith('sha256:')))
    assert.equal(result.images.length + result.failures.length, taskCount)
    for (const task of result.tasks) {
      assert.equal(allTaskIds.has(task.task_id), false, 'cross-batch task receipt')
      allTaskIds.add(task.task_id)
    }
    for (const [childId, entry] of h.children) {
      assert.equal(allChildIds.has(childId), false, 'cross-batch child receipt')
      allChildIds.add(childId)
      await assert.rejects(h.runtime.claim(entry.child, entry.args), /authorization is unavailable or already claimed/)
    }
    for (const calls of h.providerCalls.values()) {
      providerTotal += calls
      if (calls > 1) duplicateProviderGeneration += calls - 1
      assert(calls <= 1)
    }
    assert([...h.identityCalls.values()].every(calls => calls <= 1))
    const firstChildCompletedReceiptMs = Math.min(...h.completedReceiptAt) - started
    const allTerminalMs = finished - started
    const itemLatencies = h.terminalAt.map(mark => mark - started)
    assert.equal(itemLatencies.length, taskCount)
    perItemSamples.push(...itemLatencies)
    samples.push({ batch: batchNumber, task_count: taskCount, requested_concurrency: concurrency,
      terminal_status: result.status, first_child_completed_receipt_ms: firstChildCompletedReceiptMs, all_terminal_ms: allTerminalMs,
      per_item_ms: itemLatencies.reduce((sum, value) => sum + value, 0) / taskCount,
      receipt_projection_lower_bound_ms: receiptProjectionLowerBoundMs,
      success_count: result.images.length, failure_count: result.failures.length, max_active: h.stats().maximum })
    await h.dispose()
    assert.equal(h.stats().active, 0)
  }
  const runtimeMs = performance.now() - suiteStarted
  const metrics = {
    first_child_completed_receipt: summary(samples.map(sample => sample.first_child_completed_receipt_ms)),
    all_terminal: summary(samples.map(sample => sample.all_terminal_ms)),
    per_item: summary(perItemSamples),
    receipt_projection_lower_bound: summary(samples.map(sample => sample.receipt_projection_lower_bound_ms)),
  }
  assert(metrics.all_terminal.p95_ms < 250, 'source-only all-terminal p95 exceeded 250 ms')
  assert.equal(fullySuccessfulBatches, 12)
  assert.equal(duplicateProviderGeneration, 0)
  assert.equal(retainedSuccessfulImages, successfulImages)
  const emateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const sourceState = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim() === '' ? 'CLEAN' : 'DIRTY'
  const digest = value => createHash('sha256').update(value).digest('hex')
  benchmarkReport = { schema_version: 2, ticket: TICKET,
    claim: 'local-source-only-not-provider-latency-not-ui-first-visible-not-direct-single-image-evidence',
    environment: {
      layer: 'local-test-provider', environment_name_sha256: digest('local-test-provider'),
      gateway_origin_sha256: digest('no-gateway-local-fixture'), deployment_fingerprint_sha256: digest(emateCommit),
    },
    provenance: { emate_commit: emateCommit, harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: RELEASE_VERSION },
    measured_at: new Date().toISOString(), source_state: sourceState,
    batches: samples.length, tasks: taskTotal, fully_successful_batches: fullySuccessfulBatches, runtime_ms: runtimeMs,
    provider_calls: providerTotal, typed_429_retry_probe: 'OPEN',
    source_assertions: { duplicate_provider_generation: duplicateProviderGeneration, legal_terminal_rate: 1,
      successful_image_retention_rate: successfulImages === 0 ? 0 : retainedSuccessfulImages / successfulImages },
    metrics, samples }
  const rawPath = resolve(ROOT, RAW_RELATIVE_PATH)
  mkdirSync(dirname(rawPath), { recursive: true })
  const bytes = JSON.stringify(benchmarkReport, null, 2) + '\n'
  assert.doesNotMatch(bytes, /prompt|attachment(?:id|_id|_name|s)?|base64|credential|secret|\/Users\//iu)
  writeFileSync(rawPath, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  console.log(JSON.stringify({ batches: samples.length, tasks: taskTotal, fully_successful_batches: fullySuccessfulBatches,
    runtime_ms: runtimeMs, source_assertions: benchmarkReport.source_assertions, typed_429_retry_probe: 'OPEN', metrics,
    raw_relative_path: RAW_RELATIVE_PATH, raw_sha256: sha256, release_gates: 'OPEN' }))
})

test('abort cancellation settles active and queued tasks without live runs or retained gates', async () => {
  const controller = new AbortController()
  const h = createHarness({ batchNumber: 1001, outcome: () => 'hold' })
  const execution = h.runtime.execute({ tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: 'cancel-' + index })), concurrency: 3 },
    { agent: h.parent, callId: 'cancel', signal: controller.signal })
  await h.waitForStarts(3)
  await h.waitForClaims(3)
  controller.abort(new Error('test cancellation'))
  await assert.rejects(execution, /test cancellation/)
  const result = project(imageBatchProjectionDefinition(z, h.parent.id), h.parentSession.events)[0]
  assert.equal(result.status, 'cancelled')
  assert(result.tasks.slice(0, 3).every(task => task.state === 'cancelled' && task.submission_status === 'unknown'))
  assert(result.tasks.slice(3).every(task => task.state === 'cancelled' && task.submission_status === 'not-submitted'))
  assert.equal(h.stats().active, 0)
  assert.deepEqual(h.starts, [1, 2, 3])
  await h.dispose()
})

test('HMR-style effect disposal aborts active children, prevents refill, and leaves no live run', async () => {
  const h = createHarness({ batchNumber: 1002, outcome: () => 'hold' })
  const execution = h.runtime.execute({ tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: 'hmr-' + index })), concurrency: 4 },
    { agent: h.parent, callId: 'hmr', signal: new AbortController().signal })
  await h.waitForStarts(4)
  await h.dispose()
  const result = await execution
  assert.deepEqual(h.starts, [1, 2, 3, 4])
  assert.equal(h.stats().active, 0)
  assert(result.tasks.slice(4).every(task => task.state === 'failed' && task.submission_status === 'not-submitted'))
})

test('tracked manifest stays OPEN now, accepts only complete future evidence, and rejects partial or forged PASS', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')))
  assert.equal(manifest.claim, RELEASE_CLAIM)
  const openMutations = [
    value => { value.production.status = 'PASS' },
    value => { value.staging.result = { sample_count: 1, measured_at: '2026-01-01T00:00:00Z' } },
    value => { value.local.raw_evidence = { uri: 'https://evidence.example/x', sha256: 'a'.repeat(64) } },
    value => { value.external_raw_evidence.status = 'PASS' },
    value => { value.release_gate = 'PASS' },
    value => { value.release_evidence.duplicate_provider_generation.status = 'PASS' },
  ]
  for (const mutate of openMutations) {
    const value = clone(manifest)
    mutate(value)
    assert.throws(() => validateManifest(value))
  }
  const serialized = JSON.stringify(manifest)
  assert.doesNotMatch(serialized, /prompt|base64|credential|secret|screenshot|video|installer|\/Users\//iu)
})

test('source scan rejects network, sleeps, batch endpoints, and a second scheduler owner', () => {
  const source = readFileSync(new URL('./stress.test.mjs', import.meta.url), 'utf8')
  const network = new RegExp('node:(?:ht' + 'tp|ht' + 'tps|n' + 'et|t' + 'ls|d' + 'ns|d' + 'gram)|\\bfet' + 'ch\\s*\\(', 'u')
  const sleep = new RegExp(['set', 'Timeout'].join('') + '|timers/' + 'promises|Atomics' + '\\.wait', 'u')
  assert.doesNotMatch(source, network)
  assert.doesNotMatch(source, sleep)
  const production = readFileSync(new URL('../../../packages/dsh/src/profile/native-image-task-runner.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../../packages/dsh/src/profile/image-generation.ts', import.meta.url), 'utf8')
  const batchEndpoint = new RegExp(['/images', 'batch'].join('/'), 'u')
  assert.doesNotMatch(production, batchEndpoint)
  assert.equal((production.match(/name: 'image_batch'/g) ?? []).length, 1)
  assert.equal((production.match(/createNativeImageTaskRuntime\(/g) ?? []).length, 2)
  assert(benchmarkReport === undefined || benchmarkReport.source_assertions.duplicate_provider_generation === 0)
})
