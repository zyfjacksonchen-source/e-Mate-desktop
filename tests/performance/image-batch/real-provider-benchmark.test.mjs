import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readConfiguration, runProviderBenchmark } from './real-provider-benchmark.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const prompts = Array.from({ length: 30 }, (_, index) => `private-${index + 1}`)
const provenance = { emate_commit: 'a'.repeat(40), harness_commit: '4da69d7c3522ee51de12822c917c503a124f7a7d', desktop_reference: '6074088f5b660206e404b3591fab51fb99c69add', version: '2.0.17' }
const success = id => new Response(JSON.stringify({ id: `result-${id}`, data: [{ b64_json: png }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } })

function config(layer, probe) {
  return { layer, probe, root: new URL(`https://${layer}.example/v1`), token: 'secret-session-token-value', deployment: digest(`${layer}-deployment`), environmentName: layer, runs: 3, provenance }
}

test('real provider runner covers 4/5/8 with four-way batch concurrency and emits hashes only', async () => {
  let calls = 0
  let active = 0
  let maximum = 0
  const fetchImpl = async () => {
    calls += 1; active += 1; maximum = Math.max(maximum, active)
    await Promise.resolve(); active -= 1
    return success(calls)
  }
  const report = await runProviderBenchmark(config('production', false), prompts, fetchImpl)
  assert.deepEqual(report.runs.map(run => run.task_count), [4, 5, 8])
  assert.equal(calls, 20)
  assert(maximum <= 4)
  assert.equal(report.typed_429_retry_probe.status, 'NOT_RUN')
  const raw = JSON.stringify(report)
  assert.doesNotMatch(raw, /private-|secret-session|prompt|b64_json|duplicate_provider_generation|\/Users\//u)
})

test('queued mapLimit waves share one monotonic batch start', async () => {
  let now = 0
  let id = 0
  let scheduled = false
  let waiting = []
  const fetchImpl = async (_url, init) => {
    if (!init.headers['x-e-mate-batch-id']) {
      now += 100
      return success(++id)
    }
    return new Promise(resolve => {
      waiting.push(() => resolve(success(++id)))
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const wave = waiting
        waiting = []
        now += 100
        wave.forEach(complete => complete())
      })
    })
  }

  const report = await runProviderBenchmark(config('production', false), prompts, fetchImpl, () => now)
  const five = report.runs.find(run => run.task_count === 5)
  const eight = report.runs.find(run => run.task_count === 8)
  assert.deepEqual(
    [five.first_terminal_ms, five.all_terminal_ms, eight.first_terminal_ms, eight.all_terminal_ms],
    [100, 200, 100, 200],
  )
  assert.deepEqual(report.runs.map(run => run.direct_single_terminal_ms), [100, 100, 100])
})

test('controlled staging requires one typed pre-provider 429 and one successful identical retry', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 25) return new Response(JSON.stringify({ error: { code: 'TENANT_CONCURRENCY_LIMITED', message: 'bounded', retryAfterMs: 1000 } }), { status: 429, headers: { 'retry-after': '1' } })
    return success(calls)
  }
  const report = await runProviderBenchmark(config('staging', true), prompts, fetchImpl)
  assert.deepEqual(report.typed_429_retry_probe, { status: 'PASS', retry_after_ms: 1000, attempts: 2, accepted_submissions: 1, identical_request: true, pass: true })
  assert.equal(calls, 26)
})

test('configuration keeps credentials in env and rejects aliased or uncontrolled layers', () => {
  const base = {
    EMATE_EVIDENCE_GATEWAY_URL: 'https://production.example/v1', EMATE_EVIDENCE_SESSION_TOKEN: 'x'.repeat(32),
    EMATE_EVIDENCE_DEPLOYMENT_FINGERPRINT_SHA256: digest('deployment'), EMATE_EVIDENCE_ENVIRONMENT_NAME: 'production',
    EMATE_EVIDENCE_PROMPTS_FILE: '/private/input.json', EMATE_EVIDENCE_OUTPUT: '/private/output.json', EMATE_EVIDENCE_RUNS: '3',
    EMATE_EVIDENCE_LAYER: 'production',
  }
  assert.equal(readConfiguration(base).token, 'x'.repeat(32))
  assert.throws(() => readConfiguration({ ...base, EMATE_EVIDENCE_GATEWAY_URL: 'http://production.example/v1' }))
  assert.throws(() => readConfiguration({ ...base, EMATE_EVIDENCE_LAYER: 'staging' }), /429 probe is required/u)
})

test('2.0.18 runner requires output retention before calls and retains each successful response', async () => {
  const current = config('production', false)
  current.provenance = { ...provenance, version: '2.0.18' }
  let calls = 0
  const fetchImpl = async () => success(++calls)
  await assert.rejects(runProviderBenchmark(current, prompts, fetchImpl), /durable private output retention/u)
  assert.equal(calls, 0)
  const retained = new Map()
  current.retainImage = (taskId, image) => {
    assert.equal(retained.has(taskId), false)
    assert.equal(image.digest, digest(image.bytes))
    retained.set(taskId, Buffer.from(image.bytes))
  }
  const report = await runProviderBenchmark(current, prompts, fetchImpl)
  assert.equal(report.ticket, 'EM218-502')
  assert.equal(retained.size, 20)
  assert.deepEqual(report.runs.map(run => run.retained_success_count), [4, 5, 8])
})
