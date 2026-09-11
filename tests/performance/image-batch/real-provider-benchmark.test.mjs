import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { after } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProviderExecution, readConfiguration, runProviderBenchmark } from './real-provider-benchmark.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const prompts = Array.from({ length: 30 }, (_, index) => `private-${index + 1}`)
const provenance = { emate_commit: 'a'.repeat(40), harness_commit: 'e841a5c4add3f7e34c3f7efc8742313debf54922', desktop_reference: '166c16cfc38c51d32c2316715548c0f8271db517', version: '2.0.17' }
const success = id => new Response(JSON.stringify({ id: `result-${id}`, data: [{ b64_json: png }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } })

const directories = []
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }) })
function config(layer, probe, version = provenance.version) {
  const directory = mkdtempSync(join(tmpdir(), 'emate-provider-execution-')); directories.push(directory)
  const value = { layer, probe, root: new URL(`https://${layer}.example/v1`), token: 'secret-session-token-value', deployment: digest(`${layer}-deployment`), environmentName: layer, runs: 3, provenance: { ...provenance, version }, output: join(directory, 'raw.json') }
  value.execution = prepareProviderExecution(value, prompts)
  return value
}

test('real provider runner covers 4/5/8 with four-way batch concurrency and emits hashes only', async () => {
  let calls = 0
  let active = 0
  let maximum = 0
  const fetchImpl = async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, 'gpt-image-2-pro')
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
  const attempted = []
  const fetchImpl = async (_url, init) => {
    calls += 1
    assert.equal(JSON.parse(init.body).model, 'gpt-image-2.5-flare')
    attempted.push({ body: init.body, headers: init.headers })
    if (calls === 25) return new Response(JSON.stringify({ error: { code: 'TENANT_CONCURRENCY_LIMITED', message: 'bounded', retryAfterMs: 1000 } }), { status: 429, headers: { 'retry-after': '1' } })
    return success(calls)
  }
  const current = config('staging', true, '2.0.18'); current.retainImage = () => {}
  const report = await runProviderBenchmark(current, prompts, fetchImpl)
  assert.deepEqual(report.typed_429_retry_probe, { status: 'PASS', retry_after_ms: 1000, attempts: 2, accepted_submissions: 1, identical_request: true, pass: true })
  assert.equal(calls, 26)
  assert.deepEqual(attempted[24], attempted[25])
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
  const current = config('production', false, '2.0.18')
  let calls = 0
  const fetchImpl = async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, 'gpt-image-2.5-flare')
    assert.equal(JSON.parse(readFileSync(current.execution.path)).image_model, 'gpt-image-2.5-flare')
    return success(++calls)
  }
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

test('fresh executions persist independent scope before any request and correlate all planned control/batch/probe IDs', async () => {
  const first = config('staging', true)
  const second = config('staging', true)
  const firstReceipt = JSON.parse(readFileSync(first.execution.path, 'utf8'))
  const secondReceipt = JSON.parse(readFileSync(second.execution.path, 'utf8'))
  assert.notEqual(first.execution.id, second.execution.id)
  assert.equal(firstReceipt.fixed_set_sha256, secondReceipt.fixed_set_sha256)
  const firstIds = new Set(firstReceipt.requests.map(item => item.headers['x-client-request-id']))
  assert.equal(firstIds.size, 25)
  assert.equal(secondReceipt.requests.some(item => firstIds.has(item.headers['x-client-request-id'])), false)
  assert.deepEqual([...new Set(firstReceipt.requests.map(item => item.kind))], ['direct', 'batch', 'typed-429-probe'])
  const seen = []
  let rejected
  const fetchImpl = async (_url, init) => {
    assert.equal(digest(readFileSync(first.execution.path)), first.execution.sha256)
    assert.equal(JSON.parse(readFileSync(join(`${first.output}.images`, 'started.json'))).execution_sha256, first.execution.sha256)
    const committed = firstReceipt.requests.find(item => item.headers['x-client-request-id'] === init.headers['x-client-request-id'])
    assert.ok(committed, 'every submitted identity must have been committed before dispatch')
    for (const [key, value] of Object.entries(committed.headers)) assert.equal(init.headers[key], value)
    assert.equal(committed.prompt_sha256, digest(JSON.parse(init.body).prompt))
    seen.push(init.headers['x-client-request-id'])
    if (seen.length === 25) {
      rejected = { ...init.headers }
      return new Response(JSON.stringify({ error: { code: 'TENANT_CONCURRENCY_LIMITED', retryAfterMs: 1000 } }), { status: 429, headers: { 'retry-after': '1' } })
    }
    if (seen.length === 26) assert.deepEqual(init.headers, rejected)
    return success(seen.length)
  }
  await runProviderBenchmark(first, prompts, fetchImpl)
  assert.equal(new Set(seen).size, firstIds.size)
  await assert.rejects(runProviderBenchmark(first, prompts, fetchImpl), /EEXIST/u)
  assert.equal(seen.length, 26)
  assert.doesNotMatch(readFileSync(first.execution.path, 'utf8'), /secret-session-token|private-\d/u)
})

test('lost/tampered execution receipt and an unknown outcome cannot trigger an automatic replay', async () => {
  let calls = 0
  for (const damage of ['missing', 'changed']) {
    const value = config('production', false)
    if (damage === 'missing') rmSync(value.execution.path)
    else writeFileSync(value.execution.path, '{}')
    await assert.rejects(runProviderBenchmark(value, prompts, async () => { calls++; return success(calls) }))
  }
  assert.equal(calls, 0)
  const value = config('production', false)
  const unknown = async () => { calls++; throw new Error('unknown submission outcome') }
  await assert.rejects(runProviderBenchmark(value, prompts, unknown), /direct control.*unknown|direct control.*Error/u)
  assert.equal(calls, 1)
  assert.ok(readdirSync(`${value.output}.images`).includes('execution.json'))
  assert.ok(readdirSync(`${value.output}.images`).includes('started.json'))
  await assert.rejects(runProviderBenchmark(value, prompts, unknown), /EEXIST/u)
  assert.equal(calls, 1)
  await assert.rejects(runProviderBenchmark({ ...config('production', false), execution: undefined }, prompts, unknown), /precommitted execution/u)
  assert.equal(calls, 1)
})

test('a bad batch response stops queued dispatch and waits for active successes to be retained', async () => {
  const value = config('production', false, '2.0.18')
  const retained = []
  value.retainImage = (id, image) => {
    const file = join(`${value.output}.images`, `${digest(id)}.${image.extension}`)
    writeFileSync(file, image.bytes, { flag: 'wx' })
    retained.push(file)
  }
  let calls = 0
  let active = 0
  const fetchImpl = async (_url, init) => {
    const index = ++calls
    if (!init.headers['x-e-mate-batch-id']) return success(index)
    active++
    await new Promise(resolve => setTimeout(resolve, index === 2 ? 0 : 20))
    active--
    return index === 2 ? new Response('invalid JSON') : success(index)
  }
  await assert.rejects(runProviderBenchmark(value, prompts, fetchImpl), /not valid UTF-8 JSON/u)
  assert.equal(calls, 5)
  assert.equal(active, 0)
  assert.equal(retained.length, 4)
  for (const file of retained) assert.deepEqual(readFileSync(file), Buffer.from(png, 'base64'))
})
