import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { createNativeImageFixture, NATIVE_EXECUTION } from '../image-single/native-fixture.mjs'
import { SMALL_PNG } from '../image-single/fixtures.mjs'
import { CLAIM as RELEASE_CLAIM, RELEASE_VERSION, TICKET, DESKTOP_REFERENCE, HARNESS_COMMIT, validateManifest, validateNativeLocalEvidence } from './release-evidence-protocol.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const MANIFEST_PATH = new URL('../../../docs/2.0.17/evidence-manifests/performance.json', import.meta.url)
const digest = value => createHash('sha256').update(value).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const success = id => new Response(JSON.stringify({ id, data: [{ b64_json: SMALL_PNG.toString('base64') }] }), { headers: { 'content-type': 'application/json' } })
const summarize = values => {
  const ordered = values.toSorted((a, b) => a - b)
  return { p50_ms: ordered[Math.ceil(ordered.length * 0.5) - 1], p95_ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
    exact_observed_interval_ms: [ordered[0], ordered.at(-1)] }
}
export const toolCounts = count => count <= 4 ? [count] : [4, count - 4]

function projectionLowerBound(f, receipt) {
  const started = performance.now()
  const session = f.Session.create(f.SessionId('projection-control'))
  session.append('emate/image-output', receipt, { ignorable: true })
  assert.equal(session.events[0].data.content.length, receipt.content.length)
  assert.equal(session.deriveMessages().length, 0, 'presentation receipt is not model input')
  return performance.now() - started
}

test('160 real native Tool groups preserve 2/4/5/8, queue bounds, receipts, actual CAS bytes and unchanged local latency threshold', async () => {
  const samples = [], requestIds = new Set(), taskIds = new Set(), jobIds = new Set()
  let providerCalls = 0, successes = 0, retained = 0
  const suiteStart = performance.now()
  for (let batch = 1; batch <= 160; batch += 1) {
    const count = [2, 4, 5, 8][(batch - 1) % 4], counts = toolCounts(count)
    let active = 0, peak = 0
    const intervals = []
    const f = await createNativeImageFixture({ request: async (_url, init, ordinal) => {
      const body = JSON.parse(init.body)
      assert.equal(body.model, 'gpt-image-2.5-flare'); assert.equal('n' in body, false)
      const id = new Headers(init.headers).get('x-client-request-id')
      assert.ok(id); assert.equal(requestIds.has(id), false, 'duplicate provider submission identity'); requestIds.add(id)
      providerCalls += 1; active += 1; peak = Math.max(peak, active)
      const interval = { group: id.replace(/-[1-4]$/u, ''), start: performance.now() }; intervals.push(interval)
      try {
        await Promise.resolve()
        if (batch % 10 !== 0 && ordinal !== 1 && (batch + ordinal) % 3 === 0)
          return new Response(JSON.stringify({ error: { message: 'local provider rejection' } }), { status: 503, headers: { 'content-type': 'application/json' } })
        if (batch % 10 !== 0 && ordinal !== 1 && (batch + ordinal) % 7 === 0) throw new Error('local transport outcome unknown')
        return success('native-stress-' + batch + '-' + ordinal)
      } finally { active -= 1; interval.end = performance.now() }
    } })
    try {
      const started = performance.now()
      // Only real public Tools are composed. The production queue owns admission
      // and refill: 5/8 use [4,1]/[4,4], not a synthetic batch endpoint.
      const results = await Promise.all(counts.map((n, index) => f.call('generate_image',
        { prompt: 'offline group ' + batch, count: n }, { callId: 'batch-' + batch + '-tool-' + index })))
      const receipts = f.receipts.map(row => row.receipt)
      await Promise.all(receipts.map(receipt => f.ctx.jobs.wait(receipt.job_id, 1000, f.agent)))
      const finished = performance.now()
      assert.equal(f.calls.length, count); assert.equal(active, 0); assert.ok(peak <= 4)
      assert.equal(results.length, counts.length); assert.equal(receipts.length, counts.length)
      assert.equal(f.jobTerminals.length, counts.length)
      if (count > 4) {
        const firstGroup = intervals[0].group
        const first = intervals.filter(item => item.group === firstGroup), second = intervals.filter(item => item.group !== firstGroup)
        assert.ok(Math.min(...second.map(item => item.start)) >= Math.max(...first.map(item => item.end)), '5/8 must form two real queue waves')
      }
      let good = 0, failed = 0
      for (const [index, result] of results.entries()) {
        assert.equal(result.isError, false); assert.deepEqual(result.content.map(block => block.type), ['text'])
        assert.equal(result.value.requested_count, counts[index])
        assert.equal(result.value.returned_count + result.value.failed_count, counts[index])
        good += result.value.returned_count; failed += result.value.failed_count
      }
      for (const receipt of receipts) {
        assert.equal(receipt.schema_version, 3); assert.equal(receipt.revision, 2)
        assert.equal(taskIds.has(receipt.task_id), false); taskIds.add(receipt.task_id)
        const ownedJob = f.agent.id + '/' + receipt.job_id
        assert.equal(jobIds.has(ownedJob), false); jobIds.add(ownedJob)
        assert.equal(receipt.parent_session_id, f.agent.id)
        assert.equal(f.ctx.jobs.get(receipt.job_id, f.agent).id, receipt.job_id)
        assert.ok(['completed', 'failed'].includes(receipt.status))
        assert.equal(receipt.content.length, receipt.returned_count)
        assert.equal(new Set(receipt.client_request_ids).size, receipt.requested_count)
        assert.equal(receipt.provider_request_ids.length, receipt.returned_count)
        for (const block of receipt.content) {
          // The store normalizes on save, so identity is the stored artifact the
          // ref describes, not the provider's original PNG encoding.
          const stored = await f.ctx.attachments.readImage(block.attachment)
          assert.deepEqual(block.attachment, stored.ref); retained += 1
        }
      }
      successes += good
      const completed = f.receipts.filter(row => row.receipt.returned_count > 0)
      assert.ok(completed.length > 0)
      samples.push({ batch, task_count: count, tool_counts: counts, terminal_status: failed === 0 ? 'completed' : 'partial',
        first_completed_receipt_ms: Math.min(...completed.map(row => row.at)) - started,
        all_terminal_ms: finished - started, tool_terminal_ms: f.jobTerminals.map(row => row.at - started),
        receipt_projection_lower_bound_ms: projectionLowerBound(f, receipts[0]), success_count: good, failure_count: failed, max_active: peak })
    } finally { await f.dispose() }
  }
  assert.equal(retained, successes)
  const metrics = { first_completed_receipt: summarize(samples.map(s => s.first_completed_receipt_ms)),
    all_terminal: summarize(samples.map(s => s.all_terminal_ms)), tool_terminal: summarize(samples.flatMap(s => s.tool_terminal_ms)),
    receipt_projection_lower_bound: summarize(samples.map(s => s.receipt_projection_lower_bound_ms)) }
  assert.ok(metrics.all_terminal.p95_ms < 250, 'source-only all-terminal p95 exceeded 250 ms')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const state = await new Promise((resolveState, reject) => {
    const child = spawn('git', ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    let dirty = false
    child.stdout.on('data', chunk => { if (chunk.length) dirty = true })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolveState(dirty ? 'DIRTY' : 'CLEAN') : reject(new Error('git status failed with exit ' + code)))
  })
  const report = { schema_version: 3, execution_contract: NATIVE_EXECUTION, ticket: TICKET,
    claim: 'local-source-only-not-provider-latency-not-ui-first-visible-not-direct-single-image-evidence',
    environment: { layer: 'local-test-provider', environment_name_sha256: digest('local-test-provider'),
      gateway_origin_sha256: digest('no-gateway-local-fixture'), deployment_fingerprint_sha256: digest(commit) },
    provenance: { emate_commit: commit, harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: RELEASE_VERSION },
    measured_at: new Date().toISOString(), source_state: state, batches: samples.length,
    tasks: samples.reduce((sum, sample) => sum + sample.task_count, 0), fully_successful_batches: samples.filter(s => s.failure_count === 0).length,
    runtime_ms: performance.now() - suiteStart, provider_calls: providerCalls, typed_429_retry_probe: 'OPEN',
    source_assertions: { duplicate_provider_generation: 0, legal_terminal_rate: 1, successful_image_retention_rate: 1 }, metrics, samples }
  validateNativeLocalEvidence(report, report.provenance, { requireClean: false })
  if (state !== 'CLEAN') assert.throws(() => validateNativeLocalEvidence(report), /clean committed tree/u)
  const path = resolve(ROOT, 'work/imagegen-performance-migration-0910/native-batch-source-' + Date.now() + '.json')
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(report, null, 2) + '\n'
  assert.doesNotMatch(bytes, /prompt|base64|credential|secret|\/Users\//iu)
  writeFileSync(path, bytes, { flag: 'wx' })
  console.log(JSON.stringify({ batches: report.batches, tasks: report.tasks, metrics, source_state: state,
    raw_sha256: digest(bytes), raw_relative_path: path.slice(ROOT.length + 1), release_gates: 'OPEN' }))
})

test('native cancellation settles four active requests and queued work without refill or duplicate submission', async () => {
  const started = deferred(), cleanup = deferred()
  let active = 0
  const f = await createNativeImageFixture({ request: async (_url, init, ordinal) => {
    active += 1; if (ordinal === 4) started.resolve()
    await new Promise(resolveAbort => init.signal.aborted ? resolveAbort() : init.signal.addEventListener('abort', resolveAbort, { once: true }))
    await cleanup.promise; active -= 1; throw new Error('local cancellation')
  } })
  try {
    const tasks = await Promise.all(Array.from({ length: 5 }, (_, index) => f.call('generate_image',
      { prompt: 'cancel fixture', wait_for_completion: false }, { callId: 'cancel-' + index })))
    await started.promise
    const cancellations = tasks.map(task => f.call('cancel_image_generation_task', { task_id: task.value.task_id }))
    await Promise.resolve(); assert.equal(f.calls.length, 4)
    cleanup.resolve()
    await Promise.all(cancellations)
    assert.equal(active, 0); assert.equal(f.calls.length, 4)
    const receipts = f.receipts.map(row => row.receipt)
    assert.equal(receipts.length, 5); assert.ok(receipts.every(receipt => receipt.status === 'cancelled'))
    await Promise.all(receipts.map(receipt => f.ctx.jobs.wait(receipt.job_id, 1000, f.agent)))
    assert.ok(receipts.every(receipt => f.ctx.jobs.get(receipt.job_id, f.agent).status === 'killed'))
  } finally { cleanup.resolve(); await f.dispose() }
})

test('native preflight and replay refuse duplicate work; durable query survives host recreation', async () => {
  const f = await createNativeImageFixture({ request: async (_url, _init, ordinal) => success('replay-' + ordinal) })
  try {
    for (const count of [0, 5, 8]) assert.equal((await f.call('generate_image', { prompt: 'invalid count', count })).isError, true)
    assert.equal(f.calls.length, 0)
    const first = await f.call('generate_image', { prompt: 'one', count: 2 }, { callId: 'one-native-call' })
    const repeated = await f.call('generate_image', { prompt: 'one', count: 2 }, { callId: 'one-native-call' })
    assert.equal(repeated.isError, true); assert.equal(f.calls.length, 2)
    const restored = f.Session.create(f.agent.id, f.agent.session.snapshotEvents(), f.agent.session.header)
    const { host } = f.ImageGen.createImageHost(f.ctx, f.ImageGen.managedRoot('https://model.example/e-mate/model-api/v1'))
    const task = await host.find(first.value.task_id, { agent: { ...f.agent, session: restored }, callId: 'restore', rootCallId: 'restore' })
    assert.equal((await host.images(task)).length, 2); assert.equal(f.calls.length, 2)
    const foreign = await f.owner('foreign')
    await assert.rejects(host.find(task.id, { agent: foreign, callId: 'foreign', rootCallId: 'foreign' }))
  } finally { await f.dispose() }
})

test('plugin-owner disposal cancels active native Jobs and prevents queued provider dispatch', { timeout: 3000 }, async () => {
  const started = deferred()
  let active = 0
  const f = await createNativeImageFixture({ request: async (_url, init, ordinal) => {
    active += 1; if (ordinal === 4) started.resolve()
    await new Promise(resolveAbort => init.signal.aborted ? resolveAbort() : init.signal.addEventListener('abort', resolveAbort, { once: true }))
    active -= 1; throw new Error('owner disposed')
  } })
  await Promise.all(Array.from({ length: 5 }, (_, index) => f.call('generate_image',
    { prompt: 'dispose fixture', wait_for_completion: false }, { callId: 'dispose-' + index })))
  await started.promise
  await f.dispose()
  assert.equal(active, 0); assert.equal(f.calls.length, 4)
})

test('release thresholds stay OPEN without real provider, billing, installed UI and same-source evidence', () => {
  const manifest = validateManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')))
  assert.equal(manifest.claim, RELEASE_CLAIM)
  for (const mutate of [
    value => { value.production.status = 'PASS' }, value => { value.external_raw_evidence.status = 'PASS' },
    value => { value.release_gate = 'PASS' }, value => { value.release_evidence.duplicate_provider_generation.status = 'PASS' },
  ]) { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => validateManifest(copy)) }
})

test('source remains on the selected upstream queue and public Tools, with no deleted runner import or extra endpoint', () => {
  const source = readFileSync(new URL('../../../packages/dsh-plugin-imagegen/src/index.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../../packages/dsh-plugin-imagegen/src/host.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../../packages/dsh-plugin-imagegen/src/upstream/agent-image-tools.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('registerAgentImageTools')); assert.ok(source.includes('ctx.jobs.start'))
  assert.doesNotMatch(source, /name: 'image_batch'|subagents\.start|agent\/pre-step/u)
  assert.equal(source.includes(['/images', 'batch'].join('/')), false)
})
