import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'
import {
  ATTACHMENT_LIMITS, CLAIM, COMPARISON_SCENARIOS, FAKE_DELAY_MS, HARNESS_COMMIT, HISTORY_SCENARIO,
  NATIVE_MODEL as MODEL, NORMALIZED_PROMPT, REPETITIONS, NATIVE_REQUEST_BODY as REQUEST_BODY, SCHEMA_VERSION, TICKET, RELEASE_VERSION, NATIVE_EXECUTION,
  comparisonSummary, historySummary, sha256, validateDirectMeasurement, validateLowerMeasurement, validateWorkerReport,
} from './protocol.mjs'
import { SMALL_PNG, createExactMaxPng, imageResponseBody } from './fixtures.mjs'
import { createNativeImageFixture, nativeModules } from './native-fixture.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const PATHS = Object.freeze({
  imageGenerationBundle: join(ROOT, 'packages/dsh-plugin-imagegen/lib/index.js'),
  imageGenerationSource: join(ROOT, 'packages/dsh-plugin-imagegen/src/host.ts'),
  cordis: join(ROOT, 'upstream/deepseek-harness/vendor/cordis/lib/index.js'),
  agent: join(ROOT, 'upstream/deepseek-harness/packages/core/agent/lib/index.js'),
  session: join(ROOT, 'upstream/deepseek-harness/packages/core/session/lib/index.js'),
  projection: join(ROOT, 'upstream/deepseek-harness/packages/session/session-projection/lib/index.js'),
  jobs: join(ROOT, 'upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'),
  attachment: join(ROOT, 'upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'),
  attachmentStore: join(ROOT, 'upstream/deepseek-harness/packages/attachment/attachment-local/src/store.ts'),
  tools: join(ROOT, 'upstream/deepseek-harness/packages/core/tools/lib/index.js'),
  llm: join(ROOT, 'upstream/deepseek-harness/packages/llm/llm/lib/index.js'),
  storage: join(ROOT, 'upstream/deepseek-harness/packages/storage/storage-domain/lib/index.js'),
  zod: join(ROOT, 'upstream/deepseek-harness/packages/storage/storage-domain/node_modules/zod/index.js'),
  baseContract: join(ROOT, 'desktop/e-mate-desktop/base-contract.json'),
})
const REQUIRED_BUILT = ['imageGenerationBundle', 'cordis', 'agent', 'session', 'projection', 'jobs', 'attachment', 'tools', 'llm', 'storage', 'zod']

function prerequisiteError() {
  const missing = REQUIRED_BUILT.map(key => PATHS[key]).filter(path => !existsSync(path))
  if (missing.length === 0) return undefined
  return new Error('EM218-108 benchmark prerequisites are absent: ' + missing.map(path => path.slice(ROOT.length + 1)).join(', ')
    + '. Run only the main-agent-authorized existing Harness/e-Mate build prerequisites; this benchmark never installs or builds them.')
}
function fileSha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }


let networkCalls = 0
function installNetworkGuard() {
  const originals = []
  const block = (target, key) => {
    const original = target[key]
    originals.push(() => { target[key] = original })
    target[key] = () => { networkCalls += 1; throw new Error('EM218-108 benchmark forbids network access: ' + key) }
  }
  for (const [target, keys] of [
    [net, ['connect', 'createConnection']], [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']],
    [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']], [dgram, ['createSocket']],
  ]) for (const key of keys) block(target, key)
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { networkCalls += 1; throw new Error('EM218-108 benchmark forbids fetch') }
  syncBuiltinESMExports()
  return () => {
    for (const restore of originals.reverse()) restore()
    globalThis.fetch = originalFetch
    syncBuiltinESMExports()
  }
}

async function modules() {
  const m = await nativeModules()
  return { Context: m.Context, LocalAttachmentStore: m.Attachments }
}
export function createStreamResponse(bytes, marks) {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2))
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        marks.responseComplete = performance.now()
        return
      }
      const end = offset === 0 ? split : bytes.byteLength
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) } })
}
function fakeRequest(fixture, active) {
  return async (url, init = {}) => {
    active.counts.attempts += 1
    assert.equal(url.origin, 'https://model.example')
    assert.equal(url.pathname, '/e-mate/model-api/v1/images/generations')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(String(init.body), REQUEST_BODY)
    assert.equal(init.headers.get('content-type'), 'application/json')
    assert.equal(init.headers.get('accept'), 'application/json')
    assert.equal(init.headers.get('x-e-mate-batch-id'), null)
    assert.equal(init.headers.get('x-e-mate-batch-ordinal'), null)
    const requestId = init.headers.get('x-client-request-id')
    active.requestId ??= requestId
    assert.equal(requestId, active.requestId)
    assert.match(requestId ?? '', /^image-[0-9a-f]{32}(?:-[1-4])?$/u)
    assert.ok(init.headers.get('x-e-mate-task-id'))
    assert.equal(init.headers.get('x-e-mate-trace-id'), requestId)
    assert.equal(init.headers.get('session_id'), requestId)
    const bodySha256 = sha256(String(init.body))
    active.requestBodySha256 ??= bodySha256
    assert.equal(bodySha256, active.requestBodySha256)
    if (active.admissionRejectsRemaining > 0) {
      active.admissionRejectsRemaining -= 1
      active.admissionRejectedAt = performance.now()
      return new Response(JSON.stringify({ error: { code: 'TENANT_CONCURRENCY_LIMITED', message: 'admission rejected', retryAfterMs: 1000 } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' },
      })
    }
    if (active.admissionRejectedAt !== undefined) active.counts.admission_wait_ms = Math.round(performance.now() - active.admissionRejectedAt)
    active.counts.provider_posts += 1
    active.marks.providerSubmit = performance.now()
    await delay(FAKE_DELAY_MS, undefined, { signal: init.signal })
    active.marks.providerFinish = performance.now()
    assert.ok(active.marks.providerFinish - active.marks.providerSubmit >= FAKE_DELAY_MS - 1)
    return createStreamResponse(fixture.response, active.marks)
  }
}
function emptyActive(admissionRejects = 0) {
  return {
    marks: {},
    counts: { subagent_starts: 0, batch_events: 0, jobs: 0, provider_posts: 0, cas_saves: 0, terminal_receipts: 0, attempts: 0, admission_wait_ms: 0 },
    requestBodySha256: undefined,
    savedAttachmentId: undefined,
    admissionRejectsRemaining: admissionRejects,
    admissionRejectedAt: undefined,
    requestId: undefined,
  }
}
function relativeMark(value, start) { return value === undefined ? null : value - start }
function assembledMeasurement(active, start, end, fixture) {
  const marks = active.marks
  return {
    execution_contract: NATIVE_EXECUTION,
    total_ms: end - start,
    stages: {
      provider_submit_ms: relativeMark(marks.providerSubmit, start), provider_finish_ms: relativeMark(marks.providerFinish, start),
      response_complete_ms: relativeMark(marks.responseComplete, start), cas_begin_ms: relativeMark(marks.casBegin, start),
      cas_end_ms: relativeMark(marks.casEnd, start), verification_begin_ms: relativeMark(marks.verificationBegin, start),
      verification_end_ms: relativeMark(marks.verificationEnd, start), job_terminal_ms: relativeMark(marks.jobTerminal, start),
      receipt_append_begin_ms: relativeMark(marks.receiptAppendBegin, start), projection_handoff_ms: relativeMark(marks.projectionHandoff, start),
      receipt_append_return_ms: relativeMark(marks.receiptAppendReturn, start), tool_return_ms: relativeMark(marks.toolReturn, start),
    },
    counts: active.counts,
    request_body_sha256: active.requestBodySha256,
    response_body_sha256: fixture.responseSha256,
    attachment_sha256: fixture.sha256,
  }
}
function historicalReceipt(sessionId, index, attachment) {
  return { schema_version: 3, revision: 2, call_id: 'history-' + index, root_call_id: 'history-' + index,
    tool_name: 'generate_image', operation: 'generate', status: 'completed', parent_session_id: String(sessionId), sources: [],
    content: [{ type: 'image', attachment }], job_id: 'history-job-' + index, task_id: 'history-task-' + index,
    client_request_ids: ['history-client-' + index], provider_request_ids: ['history-provider-' + index],
    model: MODEL, requested_count: 1, returned_count: 1, failed_count: 0 }
}

async function createLower(root) {
  const { Context, LocalAttachmentStore } = await modules()
  const context = new Context()
  await context.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
  assert.equal(JSON.stringify(context.attachments.imageLimits), JSON.stringify(ATTACHMENT_LIMITS))
  return {
    async run(fixture) {
      const marks = {}
      const counts = { provider_posts: 0, attempts: 0 }
      const active = { marks, counts, requestBodySha256: undefined }
      const start = performance.now()
      const request = fakeRequest(fixture, active)
      const response = await request(new URL('https://model.example/e-mate/model-api/v1/images/generations'), {
        method: 'POST', headers: new Headers({
          accept: 'application/json', 'content-type': 'application/json',
          'x-client-request-id': 'image-' + sha256('lower-bound').slice(0, 32),
          'x-e-mate-task-id': 'image-' + sha256('lower-bound').slice(0, 32),
          'x-e-mate-trace-id': 'image-' + sha256('lower-bound').slice(0, 32),
          session_id: 'image-' + sha256('lower-bound').slice(0, 32),
        }),
        body: REQUEST_BODY, redirect: 'error', signal: new AbortController().signal,
      })
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()))
      const data = Buffer.from(parsed.data[0].b64_json, 'base64')
      assert.equal(sha256(data), fixture.sha256)
      marks.casBegin = performance.now()
      await context.attachments.saveImage({ data, mediaType: 'image/png', name: 'e-Mate-image.png' })
      marks.casEnd = performance.now()
      const end = performance.now()
      assert.equal(counts.provider_posts, 1)
      assert.equal(counts.attempts, 1)
      return validateLowerMeasurement({
        total_ms: end - start,
        stages: { provider_submit_ms: marks.providerSubmit - start, provider_finish_ms: marks.providerFinish - start,
          response_complete_ms: marks.responseComplete - start, cas_begin_ms: marks.casBegin - start, cas_end_ms: marks.casEnd - start },
        request_body_sha256: active.requestBodySha256, response_body_sha256: fixture.responseSha256, attachment_sha256: fixture.sha256,
      })
    },
    dispose: () => context.fiber.dispose(),
  }
}

async function createAssembled(root, fixture, historyCount = 0) {
  mkdirSync(root, { recursive: true })
  let active = emptyActive(), latestJob
  const native = await createNativeImageFixture({ home: join(root, 'dsh-home'),
    request: (url, init) => fakeRequest(fixture, active)(url, init),
    hooks: {
      casBegin(at, count) { active.counts.cas_saves += count; active.marks.casBegin = at },
      casEnd(at) { active.marks.casEnd = at },
      jobStart() { active.counts.jobs += 1 },
      jobTerminal({ at, snapshot }) { active.marks.jobTerminal = at; latestJob = snapshot },
      receiptBegin(at) { active.counts.terminal_receipts += 1; active.marks.receiptAppendBegin = at },
      receiptHandoff({ at }) { active.marks.projectionHandoff = at },
      receiptReturn(at) { active.marks.receiptAppendReturn = at },
    },
  })
  assert.deepEqual(native.ctx.attachments.imageLimits, ATTACHMENT_LIMITS)
  const seed = await native.ctx.attachments.saveImage({ data: fixture.data, mediaType: 'image/png', name: 'history.png' })
  for (let index = 0; index < historyCount; index += 1) native.agent.session.append('emate/image-output', historicalReceipt(native.agent.id, index, seed), { ignorable: true })
  let call = 0
  return {
    async run(options = {}) {
      active = emptyActive(options.admissionRejects ?? 0)
      const start = performance.now(), callId = 'single-image-' + ++call
      const result = await native.call('generate_image', { prompt: NORMALIZED_PROMPT }, { callId })
      active.marks.toolReturn = performance.now()
      const receipt = native.receipts.at(-1).receipt
      await native.ctx.jobs.wait(receipt.job_id, 1000, native.agent)
      if (options.admissionRejects) {
        assert.equal(result.value.status, 'failed')
        const repeated = await native.call('generate_image', { prompt: NORMALIZED_PROMPT }, { callId })
        return { status: 'SUPERSEDED_BY_NATIVE_SAFE_FAILURE', attempts: active.counts.attempts,
          provider_posts: active.counts.provider_posts, cas_saves: active.counts.cas_saves,
          terminal_receipts: active.counts.terminal_receipts, terminal_status: receipt.status,
          job_terminal_status: latestJob.status, repeated_call_rejected: repeated.isError,
          duplicate_provider_generation: Math.max(0, active.counts.provider_posts - 1),
          pass: active.counts.attempts === 1 && active.counts.provider_posts === 0 && repeated.isError }
      }
      assert.equal(result.isError, false)
      assert.equal(result.value.status, 'completed')
      assert.equal(result.value.images.length, 1)
      // 0.1.5's attachment store normalises on save (an alpha PNG becomes WebP), so the
      // stored artifact is deliberately not byte-identical to the provider's PNG. Record
      // and verify the two separately instead of comparing them: the provider receipt
      // digests the bytes the image service returned, and the artifact the tool reports
      // must describe exactly the stored bytes it points at.
      assert.equal(receipt.request_receipts[0].image_sha256, fixture.sha256)
      const storedRef = receipt.content[0].attachment
      const stored = await native.ctx.attachments.readImage(storedRef)
      assert.equal(result.value.images[0].attachment_id, storedRef.attachmentId)
      assert.equal(storedRef.attachmentId, 'sha256:' + sha256(stored.data))
      assert.equal(storedRef.bytes, stored.data.byteLength)
      assert.deepEqual(storedRef, stored.ref)
      assert.deepEqual(result.content.map(block => block.type), ['text'])
      return validateDirectMeasurement(assembledMeasurement(active, start, performance.now(), fixture))
    },
    dispose: () => native.dispose(),
  }
}

function firstArm(index) { return index % 4 === 0 || index % 4 === 3 }
async function runComparison(name, fixture, workerRoot) {
  const spec = COMPARISON_SCENARIOS[name]
  const warm = name.startsWith('warm-')
  let lower
  let assembled
  if (warm) {
    lower = await createLower(join(workerRoot, name, 'lower'))
    assembled = await createAssembled(join(workerRoot, name, 'assembled'), fixture)
    for (let index = 0; index < spec.warmups; index += 1) {
      if (firstArm(index)) { await lower.run(fixture); await assembled.run() } else { await assembled.run(); await lower.run(fixture) }
    }
  }
  const samples = []
  try {
    for (let index = 0; index < spec.pairs; index += 1) {
      const pairRoot = join(workerRoot, name, 'pair-' + String(index + 1))
      if (!warm) {
        lower = await createLower(join(pairRoot, 'lower'))
        assembled = await createAssembled(join(pairRoot, 'assembled'), fixture)
      }
      let lowerResult
      let assembledResult
      if (firstArm(index)) { lowerResult = await lower.run(fixture); assembledResult = await assembled.run() }
      else { assembledResult = await assembled.run(); lowerResult = await lower.run(fixture) }
      samples.push({ index: index + 1, order: firstArm(index) ? 'lower-bound-first' : 'assembled-first', lower_bound: lowerResult, assembled: assembledResult })
      if (!warm) {
        await assembled.dispose(); await lower.dispose(); assembled = undefined; lower = undefined
        rmSync(pairRoot, { recursive: true, force: true })
      }
    }
  } finally {
    if (assembled !== undefined) await assembled.dispose()
    if (lower !== undefined) await lower.dispose()
  }
  return { kind: 'lower-bound-vs-assembled', warmups: spec.warmups, pairs: spec.pairs, threshold: spec, samples, percentiles: comparisonSummary(samples, spec) }
}
async function runHistory(fixture, workerRoot) {
  const samples = []
  for (let index = 0; index < HISTORY_SCENARIO.pairs; index += 1) {
    const pairRoot = join(workerRoot, 'history', 'pair-' + String(index + 1))
    const empty = await createAssembled(join(pairRoot, 'empty'), fixture, 0)
    const loaded = await createAssembled(join(pairRoot, 'loaded'), fixture, 256)
    let emptyResult
    let loadedResult
    try {
      if (firstArm(index)) { emptyResult = await empty.run(); loadedResult = await loaded.run() }
      else { loadedResult = await loaded.run(); emptyResult = await empty.run() }
    } finally {
      await loaded.dispose(); await empty.dispose(); rmSync(pairRoot, { recursive: true, force: true })
    }
    samples.push({ index: index + 1, order: firstArm(index) ? 'empty-first' : 'loaded-first', empty: emptyResult, loaded: loadedResult, delta_ms: loadedResult.total_ms - emptyResult.total_ms })
  }
  return {
    kind: 'paired-history-slope', warmups: 0, pairs: 30, receipts: [0, 256], bounds: { p95_ms: 75, p99_ms: 150 },
    samples, percentiles: historySummary(samples),
  }
}


async function runAdmissionRetryProbe(fixture, workerRoot) {
  const assembled = await createAssembled(join(workerRoot, 'admission-safe-failure'), fixture)
  try { return await assembled.run({ admissionRejects: 1 }) }
  finally { await assembled.dispose() }
}

export function runtimeNetworkGuardSmoke() {
  const before = networkCalls
  const restore = installNetworkGuard()
  restore()
  assert.equal(networkCalls, before)
  return { status: 'network-guard-smoke-passed' }
}

export function workerSourceSmoke() {
  assert.equal(Object.keys(PATHS).length, 14)
  assert.equal(REQUIRED_BUILT.length, 11)
  assert.ok(REQUIRED_BUILT.every(key => typeof PATHS[key] === 'string' && PATHS[key].startsWith(ROOT)))
  assert.equal(typeof prerequisiteError, 'function')
  assert.equal(typeof fileSha256, 'function')
  return { status: 'worker-source-smoke-passed' }
}

export async function nativeOwnerSmoke({ maximum = false, historyCount = 0 } = {}) {
  const restoreNetwork = installNetworkGuard()
  const root = mkdtempSync(join(tmpdir(), 'emate-native-owner-smoke-'))
  const data = maximum ? createExactMaxPng() : SMALL_PNG
  const fixture = { data, sha256: sha256(data), bytes: data.byteLength,
    response: imageResponseBody(data), responseSha256: sha256(imageResponseBody(data)) }
  try {
    const assembled = await createAssembled(join(root, 'single'), fixture, historyCount)
    let measurement
    try { measurement = await assembled.run() } finally { await assembled.dispose() }
    const failure = await runAdmissionRetryProbe(fixture, root)
    return { claim: 'one-offline-native-owner-smoke-not-full-performance-evidence', measurement, failure, network_calls: networkCalls }
  } finally {
    rmSync(root, { recursive: true, force: true })
    restoreNetwork()
  }
}

async function main() {
  const restoreNetwork = installNetworkGuard()
  const missing = prerequisiteError()
  if (missing !== undefined) throw missing
  const repetition = Number(process.env.EMATE_BENCHMARK_REPETITION)
  const emateCommit = process.env.EMATE_BENCHMARK_COMMIT
  assert.ok(Number.isSafeInteger(repetition) && repetition >= 1 && repetition <= REPETITIONS, 'worker repetition is invalid')
  assert.match(emateCommit ?? '', /^[0-9a-f]{40}$/u)
  const base = JSON.parse(readFileSync(PATHS.baseContract, 'utf8'))
  assert.equal(base.harness_version, '0.1.5-rc.1')
  assert.equal(base.harness_commit, HARNESS_COMMIT)
  const fixtures = { small: { data: SMALL_PNG }, max: { data: createExactMaxPng() } }
  for (const fixture of Object.values(fixtures)) {
    fixture.sha256 = sha256(fixture.data)
    fixture.bytes = fixture.data.byteLength
    fixture.response = imageResponseBody(fixture.data)
    fixture.responseSha256 = sha256(fixture.response)
  }
  const workerRoot = mkdtempSync(join(tmpdir(), 'emate-image-latency-'))
  try {
    const scenarios = {}
    scenarios['warm-small'] = await runComparison('warm-small', fixtures.small, workerRoot)
    scenarios['warm-max'] = await runComparison('warm-max', fixtures.max, workerRoot)
    scenarios['cold-small'] = await runComparison('cold-small', fixtures.small, workerRoot)
    scenarios['cold-max'] = await runComparison('cold-max', fixtures.max, workerRoot)
    scenarios['history-0-vs-256'] = await runHistory(fixtures.small, workerRoot)
    const admissionRetryProbe = await runAdmissionRetryProbe(fixtures.small, workerRoot)
    const report = {
      schema_version: SCHEMA_VERSION, ticket: TICKET, claim: CLAIM, repetition,
      protocol: { fake_delay_ms: 25, repetitions: 3, clock: 'performance.now monotonic', percentile: 'nearest-rank-per-repetition', ordering: 'interleaved-ABBA', filesystem: 'same-worker-temp-volume', execution_contract: NATIVE_EXECUTION },
      provenance: { emate_commit: emateCommit, harness_commit: HARNESS_COMMIT, module_sha256: {
        image_generation_source: fileSha256(PATHS.imageGenerationSource), native_tool_source: fileSha256(join(ROOT, 'packages/dsh-plugin-imagegen/src/upstream/agent-image-tools.ts')), native_queue_source: fileSha256(join(ROOT, 'packages/dsh-plugin-imagegen/src/upstream/task-queue.ts')), image_generation_bundle: fileSha256(PATHS.imageGenerationBundle),
        attachment_store_source: fileSha256(PATHS.attachmentStore), attachment_bundle: fileSha256(PATHS.attachment),
        jobs_bundle: fileSha256(PATHS.jobs), tools_bundle: fileSha256(PATHS.tools),
      } },
      runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
      model: MODEL, attachment_limits: ATTACHMENT_LIMITS,
      fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, {
        sha256: fixture.sha256, bytes: fixture.bytes, media_type: 'image/png', response_body_sha256: fixture.responseSha256,
      }])),
      prompt_sha256: sha256(NORMALIZED_PROMPT), request_body_sha256: sha256(REQUEST_BODY), network_calls: networkCalls, scenarios,
      admission_retry_probe: admissionRetryProbe,
      pass: Object.values(scenarios).every(scenario => scenario.percentiles.pass) && admissionRetryProbe.pass,
    }
    validateWorkerReport(report)
    const output = JSON.stringify(report)
    assert.ok(Buffer.byteLength(output) <= 2 * 1024 * 1024, 'worker JSON exceeds 2 MiB')
    process.stdout.write(output)
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
    restoreNetwork()
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n')
    process.exitCode = 1
  })
}
