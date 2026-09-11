import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  ATTACHMENT_LIMITS, CLAIM, COMPARISON_SCENARIOS, DESKTOP_REFERENCE, HARNESS_COMMIT, HISTORY_SCENARIO, NORMALIZED_PROMPT, REQUEST_BODY,
  NATIVE_EXECUTION, NATIVE_MODEL, NATIVE_REQUEST_BODY, SCENARIO_NAMES, comparisonSummary, historySummary, nearestRank, sha256,
  createOpenManifest, createPassManifest, createSourcePassManifest, validateAggregate, validateDirectMeasurement, validateDirectProductSource,
  validateGuiEvidence, validateManifest, validateWorkerReport,
} from './protocol.mjs'
import { crc32 } from 'node:zlib'
import { createNativeImageFixture, snakeRef } from './native-fixture.mjs'
import { assertBuiltPrerequisites, sourceSmoke } from './benchmark.mjs'
import { MAX_IMAGE_BYTES, SMALL_PNG, createExactMaxPng } from './fixtures.mjs'
import { createStreamResponse, runtimeNetworkGuardSmoke, workerSourceSmoke, nativeOwnerSmoke } from './worker.mjs'

const ROOT = new URL('../../../', import.meta.url)
const PROJECT_EVIDENCE = fileURLToPath(new URL('./project-evidence.mjs', import.meta.url))
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const GIT_COMMIT = 'c'.repeat(40)
const RESPONSE_SMALL = 'd'.repeat(64)
const RESPONSE_MAX = 'e'.repeat(64)
const clone = value => structuredClone(value)

function lower(total = 30) {
  return {
    total_ms: total,
    stages: { provider_submit_ms: 0, provider_finish_ms: 25, response_complete_ms: 26, cas_begin_ms: 27, cas_end_ms: 29 },
    request_body_sha256: sha256(REQUEST_BODY), response_body_sha256: RESPONSE_SMALL, attachment_sha256: HASH_A,
  }
}
function assembled(total = 35, response = RESPONSE_SMALL, attachment = HASH_A) {
  return {
    total_ms: total,
    stages: {
      provider_submit_ms: 1, provider_finish_ms: 26, response_complete_ms: 27, cas_begin_ms: 28, cas_end_ms: 30,
      verification_begin_ms: 31, verification_end_ms: 32, job_terminal_ms: 33, receipt_append_begin_ms: 33.1,
      projection_handoff_ms: 33.2, receipt_append_return_ms: 33.3, tool_return_ms: 34,
    },
    counts: { subagent_starts: 0, batch_events: 0, jobs: 1, provider_posts: 1, cas_saves: 1, terminal_receipts: 1, attempts: 1, admission_wait_ms: 0 },
    request_body_sha256: sha256(REQUEST_BODY), response_body_sha256: response, attachment_sha256: attachment,
  }
}
function comparison(name) {
  const spec = COMPARISON_SCENARIOS[name]
  const response = name.endsWith('max') ? RESPONSE_MAX : RESPONSE_SMALL
  const attachment = name.endsWith('max') ? HASH_B : HASH_A
  const samples = Array.from({ length: spec.pairs }, (_, index) => ({
    index: index + 1,
    order: index % 4 === 0 || index % 4 === 3 ? 'lower-bound-first' : 'assembled-first',
    lower_bound: { ...lower(), response_body_sha256: response, attachment_sha256: attachment },
    assembled: assembled(35, response, attachment),
  }))
  return { kind: 'lower-bound-vs-assembled', warmups: spec.warmups, pairs: spec.pairs, threshold: clone(spec), samples, percentiles: comparisonSummary(samples, spec) }
}
function history() {
  const samples = Array.from({ length: HISTORY_SCENARIO.pairs }, (_, index) => ({
    index: index + 1,
    order: index % 4 === 0 || index % 4 === 3 ? 'empty-first' : 'loaded-first',
    empty: assembled(35), loaded: assembled(40), delta_ms: 5,
  }))
  return { kind: 'paired-history-slope', warmups: 0, pairs: 30, receipts: [0, 256], bounds: { p95_ms: 75, p99_ms: 150 }, samples, percentiles: historySummary(samples) }
}

function retryProbe() {
  const measurement = assembled(1035)
  for (const key of Object.keys(measurement.stages)) {
    if (measurement.stages[key] !== null) measurement.stages[key] += 1000
  }
  measurement.counts.attempts = 2
  measurement.counts.admission_wait_ms = 1000
  return { retry_after_ms: 1000, identical_request_scope: true, measurement, pass: true }
}

function worker(repetition = 1) {
  const scenarios = Object.fromEntries(Object.keys(COMPARISON_SCENARIOS).map(name => [name, comparison(name)]))
  scenarios['history-0-vs-256'] = history()
  return {
    schema_version: 1, ticket: 'EM217-108', claim: CLAIM, repetition,
    protocol: { fake_delay_ms: 25, repetitions: 3, clock: 'performance.now monotonic', percentile: 'nearest-rank-per-repetition', ordering: 'interleaved-ABBA', filesystem: 'same-worker-temp-volume' },
    provenance: { emate_commit: GIT_COMMIT, harness_commit: HARNESS_COMMIT, module_sha256: {
      image_generation_source: HASH_A, image_generation_bundle: HASH_B, attachment_store_source: HASH_C,
      attachment_bundle: HASH_A, jobs_bundle: HASH_B, tools_bundle: HASH_C,
    } },
    runtime: { node: 'v24.0.0', v8: '13.6', platform: 'darwin', arch: 'arm64' },
    model: 'gpt-image-2-pro', attachment_limits: clone(ATTACHMENT_LIMITS),
    fixtures: {
      small: { sha256: HASH_A, bytes: 68, media_type: 'image/png', response_body_sha256: RESPONSE_SMALL },
      max: { sha256: HASH_B, bytes: 5 * 1024 * 1024, media_type: 'image/png', response_body_sha256: RESPONSE_MAX },
    },
    prompt_sha256: sha256(NORMALIZED_PROMPT), request_body_sha256: sha256(REQUEST_BODY), network_calls: 0, scenarios,
    admission_retry_probe: retryProbe(),
    pass: SCENARIO_NAMES.every(name => scenarios[name].percentiles.pass),
  }
}

function aggregate() {
  return { schema_version: 1, ticket: 'EM217-108', claim: CLAIM,
    repetitions: [worker(1), worker(2), worker(3)], all_repetitions_pass: true }
}

function nativeAggregate() {
  const value = aggregate(); value.schema_version = 2; value.ticket = 'EM218-108'
  for (const entry of value.repetitions) {
    entry.schema_version = 2; entry.ticket = value.ticket; entry.model = NATIVE_MODEL
    entry.protocol.execution_contract = NATIVE_EXECUTION
    entry.request_body_sha256 = sha256(NATIVE_REQUEST_BODY)
    const adapt = measurement => {
      measurement.execution_contract = NATIVE_EXECUTION
      measurement.request_body_sha256 = sha256(NATIVE_REQUEST_BODY)
      measurement.stages.job_terminal_ms = 33.4
    }
    for (const name of Object.keys(COMPARISON_SCENARIOS)) for (const sample of entry.scenarios[name].samples) {
      sample.lower_bound.request_body_sha256 = sha256(NATIVE_REQUEST_BODY); adapt(sample.assembled)
    }
    for (const sample of entry.scenarios['history-0-vs-256'].samples) { adapt(sample.empty); adapt(sample.loaded) }
    entry.admission_retry_probe = { status: 'SUPERSEDED_BY_NATIVE_SAFE_FAILURE', attempts: 1, provider_posts: 0,
      cas_saves: 0, terminal_receipts: 1, terminal_status: 'failed', job_terminal_status: 'failed',
      repeated_call_rejected: true, duplicate_provider_generation: 0, pass: true }
  }
  return value
}

function openManifest() {
  return JSON.parse(readFileSync(new URL('../../../docs/2.0.17/evidence-manifests/single-image-latency.json', import.meta.url), 'utf8'))
}
function guiEvidence({ commit = GIT_COMMIT, latency = 100 } = {}) {
  const value = {
    schema_version: 1, ticket: 'EM217-108', claim: 'macos-dev-cached-terminal-projection-first-visible-v1',
    protocol: { clock: 'performance.now monotonic', stimulus: 'cached-local-bytes', start: 'terminal-projection-handoff',
      end: 'first-visible-image', percentile: 'nearest-rank', minimum_samples: 100, p95_limit_ms: 500 },
    provenance: { emate_commit: commit, harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: '2.0.17' },
    environment: { class: 'macos-app-directory-dev', machine_sha256: HASH_A, app_bundle_sha256: HASH_B },
    measured_at: '2026-09-04T00:00:00.000Z',
    samples: Array.from({ length: 100 }, (_, index) => ({ sample: index + 1, latency_ms: latency })), p95_ms: latency,
  }
  const raw = JSON.stringify(value) + '\n'
  const digest = sha256(raw)
  return { value, raw, descriptor: { uri: `https://evidence.example/em217-108/${digest}.json`, sha256: digest } }
}
function rejectsMutation(mutate, pattern) {
  const value = worker()
  mutate(value)
  assert.throws(() => validateWorkerReport(value), pattern)
}


test('fixtures are deterministic valid PNG containers at small and exact max sizes', () => {
  assert.deepEqual(SMALL_PNG.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const image = createExactMaxPng()
  assert.equal(image.byteLength, MAX_IMAGE_BYTES)
  assert.equal(sha256(createExactMaxPng()), sha256(image))
  let offset = 8
  const types = []
  while (offset < image.byteLength) {
    const length = image.readUInt32BE(offset)
    const type = image.subarray(offset + 4, offset + 8)
    const data = image.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = image.readUInt32BE(offset + 8 + length)
    assert.equal(crc32(Buffer.concat([type, data])) >>> 0, expectedCrc)
    types.push(type.toString('ascii'))
    if (type.toString('ascii') === 'IHDR') {
      assert.equal(data.readUInt32BE(0), 1279)
      assert.equal(data.readUInt32BE(4), 1024)
      assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0])
    }
    offset += 12 + length
  }
  assert.equal(offset, image.byteLength)
  assert.deepEqual(types, ['IHDR', 'tEXt', 'IDAT', 'IEND'])
})


test('assembled measurement accepts only the contract fields', () => {
  const value = assembled()
  assert.strictEqual(validateDirectMeasurement(value), value)
  assert.equal(Object.hasOwn(value, 'request_scope_sha256'), false)
  assert.throws(() => validateDirectMeasurement({ ...value, request_scope_sha256: HASH_C }), /fields do not match/u)
})

test('response completion is marked only by the close pull after both chunks', async () => {
  const marks = {}
  const reader = createStreamResponse(Buffer.from('abcd'), marks).body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  assert.equal(Buffer.from(first.value).toString(), 'ab')
  assert.equal(marks.responseComplete, undefined)
  const second = await reader.read()
  assert.equal(second.done, false)
  assert.equal(Buffer.from(second.value).toString(), 'cd')
  assert.equal(marks.responseComplete, undefined)
  const closed = await reader.read()
  assert.equal(closed.done, true)
  assert.equal(typeof marks.responseComplete, 'number')
})

test('nearest-rank is deterministic at p95 and p99', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1)
  assert.equal(nearestRank(values, 0.95), 95)
  assert.equal(nearestRank(values, 0.99), 99)
  assert.equal(nearestRank([-5, 0, 10], 0.95), 10)
})


test('Git commit provenance accepts exactly 40 lowercase hex characters', () => {
  const valid = worker()
  assert.strictEqual(validateWorkerReport(valid), valid)
  for (const invalid of ['a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'a'.repeat(64)]) {
    rejectsMutation(value => { value.provenance.emate_commit = invalid }, /lowercase 40-hex Git commit/u)
  }
})

test('validates exact protocol, counts, hashes, stages, arithmetic, and three repetitions', () => {
  const report = worker()
  assert.strictEqual(validateWorkerReport(report), report)
  const combined = aggregate()
  assert.strictEqual(validateAggregate(combined), combined)
})

test('rejects missing samples, stages, counts, hashes, thresholds, and percentile arithmetic', () => {
  rejectsMutation(value => value.scenarios['warm-small'].samples.pop(), /sample count/u)
  rejectsMutation(value => { delete value.scenarios['warm-small'].samples[0].assembled.stages.job_terminal_ms }, /fields do not match/u)
  rejectsMutation(value => { delete value.scenarios['warm-small'].samples[0].assembled.counts }, /fields do not match/u)
  rejectsMutation(value => { value.scenarios['warm-small'].samples[0].assembled.counts.jobs = 2 }, /exactly one Job/u)
  rejectsMutation(value => { delete value.scenarios['warm-small'].samples[0].assembled.request_body_sha256 }, /fields do not match/u)
  rejectsMutation(value => { value.scenarios['warm-small'].samples[0].assembled.request_body_sha256 = 'bad' }, /SHA-256/u)
  rejectsMutation(value => { delete value.scenarios['warm-small'].threshold }, /fields do not match/u)
  rejectsMutation(value => { value.scenarios['warm-small'].threshold.p95.absoluteMs = 76 }, /threshold contract/u)
  rejectsMutation(value => { value.scenarios['warm-small'].percentiles.assembled.p95_ms += 1 }, /arithmetic mismatch/u)
  rejectsMutation(value => { value.scenarios['history-0-vs-256'].samples[0].delta_ms = 4 }, /paired delta/u)
})

test('rejects fake native parity, retries, network use, batch events, and subagents', () => {
  rejectsMutation(value => { value.claim = 'native-imagegen-parity' }, /worker identity/u)
  rejectsMutation(value => { value.network_calls = 1 }, /network use/u)
  rejectsMutation(value => { value.scenarios['warm-small'].samples[0].assembled.stages.provider_finish_ms = 10 }, /fake provider delay/u)
  rejectsMutation(value => { value.scenarios['warm-small'].samples[0].assembled.counts.attempts = 2 }, /one attempt/u)
  rejectsMutation(value => { value.admission_retry_probe.measurement.counts.attempts = 1 }, /exactly two/u)
  rejectsMutation(value => { value.admission_retry_probe.measurement.counts.admission_wait_ms = 0 }, /bounded timer tolerance/u)
  rejectsMutation(value => { value.scenarios['warm-small'].samples[0].assembled.counts.batch_events = 1 }, /image-batch events/u)
  rejectsMutation(value => { value.scenarios['warm-small'].samples[0].assembled.counts.subagent_starts = 1 }, /subagent/u)
})

test('native product source excludes catalog, subagents and benchmark flags while provider calls remain single-image', () => {
  const source = ['index.ts', 'host.ts', 'upstream/agent-image-tools.ts'].map(path => readFileSync(new URL('../../../packages/dsh-plugin-imagegen/src/' + path, import.meta.url), 'utf8')).join('\n')
  assert.equal(validateDirectProductSource(source), true)
  assert.throws(() => validateDirectProductSource(source + '\nconst benchmarkMode = true'), /benchmark sleep or flag/u)
  assert.throws(() => validateDirectProductSource(source + '\nsubagents.start()'), /batch or subagent/u)
  assert.throws(() => validateDirectProductSource(source.replace("return [{ type: 'text', text: JSON.stringify(value) }]", "return [{ type: 'image', attachment: value }]")), /must remain textual/u)
})

test('OPEN manifest cannot claim source or GUI results', () => {
  const manifest = openManifest()
  assert.strictEqual(validateManifest(manifest), manifest)
  const missing = clone(manifest)
  delete missing.external_raw.sha256
  assert.throws(() => validateManifest(missing), /fields do not match/u)
  const forged = clone(manifest)
  forged.results = { fresh_processes: 3 }
  assert.throws(() => validateManifest(forged), /OPEN manifest cannot claim results/u)
  const gui = clone(manifest)
  gui.gui_first_visible.status = 'PASS'
  assert.throws(() => validateManifest(gui), /OPEN manifest cannot claim GUI evidence/u)
})

test('project CLI requires the supplied manifest to be exact OPEN state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'emate-em217-108-project-'))
  try {
    const combined = aggregate()
    const sourceRaw = JSON.stringify(combined) + '\n'
    const sourceUri = `https://evidence.example/em217-108/${sha256(sourceRaw)}.json`
    const gui = guiEvidence()
    const paths = { source: join(directory, 'source.json'), gui: join(directory, 'gui.json'), open: join(directory, 'open.json') }
    writeFileSync(paths.source, sourceRaw)
    writeFileSync(paths.gui, gui.raw)
    writeFileSync(paths.open, JSON.stringify(openManifest()))
    const run = output => spawnSync(process.execPath, [PROJECT_EVIDENCE, 'project', paths.source, sourceUri, paths.gui, gui.descriptor.uri, paths.open, output], { encoding: 'utf8' })

    const passPath = join(directory, 'pass.json')
    const valid = run(passPath)
    assert.equal(valid.status, 0, valid.stderr)
    assert.strictEqual(validateManifest(JSON.parse(readFileSync(passPath, 'utf8')), sourceRaw, gui.raw).status, 'PASS')

    rmSync(paths.source)
    rmSync(paths.gui)
    const tampered = openManifest()
    tampered.results = { forged: true }
    writeFileSync(paths.open, JSON.stringify(tampered))
    const tamperedPath = join(directory, 'tampered-pass.json')
    const rejectedTamper = run(tamperedPath)
    assert.notEqual(rejectedTamper.status, 0)
    assert.match(rejectedTamper.stderr, /OPEN manifest cannot claim results/u)
    assert.throws(() => readFileSync(tamperedPath), /ENOENT/u)

    writeFileSync(paths.open, JSON.stringify(createSourcePassManifest(combined, sourceUri, sourceRaw)))
    const nonOpenPath = join(directory, 'non-open-pass.json')
    const rejectedNonOpen = run(nonOpenPath)
    assert.notEqual(rejectedNonOpen.status, 0)
    assert.match(rejectedNonOpen.stderr, /OPEN_MANIFEST must be an exact OPEN manifest/u)
    assert.throws(() => readFileSync(nonOpenPath), /ENOENT/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('PASS is projected only from exact source and 100-sample macOS dev GUI raw bytes', () => {
  const combined = aggregate()
  const sourceRaw = JSON.stringify(combined) + '\n'
  const sourceUri = `https://evidence.example/em217-108/${sha256(sourceRaw)}.json`
  const gui = guiEvidence()
  assert.deepEqual(validateGuiEvidence(gui.raw, gui.descriptor), gui.value)
  const pass = createPassManifest(combined, sourceUri, sourceRaw, gui.raw, gui.descriptor.uri)
  assert.equal(pass.status, 'PASS')
  assert.equal(pass.gui_first_visible.sample_count, 100)
  assert.strictEqual(validateManifest(pass, sourceRaw, gui.raw), pass)
  assert.throws(() => validateManifest(pass, sourceRaw), /exact raw bytes/u)
  assert.throws(() => validateManifest(pass, sourceRaw, gui.raw + ' '), /raw hash mismatch/u)
  const slow = guiEvidence({ latency: 501 })
  assert.throws(() => validateGuiEvidence(slow.raw, slow.descriptor), /exceeds 500/u)
  const otherCommit = guiEvidence({ commit: 'b'.repeat(40) })
  assert.throws(() => createPassManifest(combined, sourceUri, sourceRaw, otherCommit.raw, otherCommit.descriptor.uri), /commits differ/u)
})


test('SOURCE_PASS manifest is a strict projection of exact validated raw bytes', () => {
  const combined = aggregate()
  const raw = JSON.stringify(combined) + '\n'
  const manifest = createSourcePassManifest(combined, `https://evidence.example/em217-108/${sha256(raw)}.json`, raw)
  assert.strictEqual(validateManifest(manifest, raw), manifest)
  assert.throws(() => validateManifest(manifest), /requires the exact raw aggregate bytes/u)
  const fakeCommit = clone(manifest)
  fakeCommit.provenance.emate_commit = HASH_C
  assert.throws(() => validateManifest(fakeCommit, raw), /lowercase 40-hex Git commit/u)
  const wrongHash = clone(manifest)
  wrongHash.external_raw.sha256 = HASH_A
  assert.throws(() => validateManifest(wrongHash, raw), /raw.*hash/u)
  const leaked = clone(manifest)
  leaked.results.scenario_percentiles['warm-small'][0].innocent = 'private prompt or base64 payload'
  assert.throws(() => validateManifest(leaked, raw), /results do not match raw aggregate/u)
})

test('source-only smoke requires no build while full benchmark prerequisite failure is actionable', () => {
  assert.equal(sourceSmoke().status, 'source-smoke-passed')
  assert.equal(workerSourceSmoke().status, 'worker-source-smoke-passed')
  assert.equal(runtimeNetworkGuardSmoke().status, 'network-guard-smoke-passed')
  const parentSource = readFileSync(new URL('./benchmark.mjs', import.meta.url), 'utf8')
  assert.match(parentSource, /status.*--porcelain=v1.*--untracked-files=all/su)
  assert.match(parentSource, /verifyHarnessBuildReceipt\(ROOT\)/u)
  assert.match(parentSource, /WORKER_TIMEOUT_MS = 30 \* 60 \* 1000/u)
  assert.throws(() => assertBuiltPrerequisites(['definitely/missing/built-output.js']), /prerequisites are absent.*never installs or builds/u)
})

test('current single evidence preserves EM218 identity and cannot mix historical worker or GUI results', () => {
  const retagged = aggregate(); retagged.ticket = 'EM218-108'; retagged.repetitions.forEach(entry => { entry.ticket = retagged.ticket })
  assert.throws(() => validateAggregate(retagged), /historical cohort/u)
  const value = nativeAggregate()
  const raw = JSON.stringify(value)
  const source = createSourcePassManifest(value, `https://evidence.invalid/${sha256(raw)}.json`, raw)
  assert.equal(createOpenManifest().ticket, 'EM218-108')
  assert.equal(source.ticket, 'EM218-108')
  assert.equal(source.contract, 'tests/performance/image-single/protocol.mjs')
  const mixed = structuredClone(value); mixed.repetitions[0].ticket = 'EM217-108'
  assert.throws(() => validateAggregate(mixed), /EM218-108 evidence invalid: .*historical cohort/u)
  const historicalGui = guiEvidence()
  assert.throws(() => createPassManifest(value, source.external_raw.uri, raw, historicalGui.raw, historicalGui.descriptor.uri), /identities or commits differ/u)
})

test('real native owner smoke measures actual Tool/Job/CAS and safely refuses a repeated rejected call', async () => {
  const result = await nativeOwnerSmoke()
  assert.equal(result.network_calls, 0)
  assert.equal(result.measurement.execution_contract, NATIVE_EXECUTION)
  assert.equal(result.measurement.counts.jobs, 1)
  assert.equal(result.measurement.counts.provider_posts, 1)
  assert.equal(result.failure.attempts, 1)
  assert.equal(result.failure.provider_posts, 0)
  assert.equal(result.failure.repeated_call_rejected, true)
  const loaded = await nativeOwnerSmoke({ maximum: true, historyCount: 256 })
  assert.equal(loaded.measurement.counts.cas_saves, 1)
  assert.equal(loaded.network_calls, 0)
  assert.equal(loaded.measurement.attachment_sha256, sha256(createExactMaxPng()))
  const value = nativeAggregate()
  assert.strictEqual(validateAggregate(value), value)
  value.repetitions[0].admission_retry_probe.attempts = 2
  assert.throws(() => validateAggregate(value), /fail once without retry/u)
})

test('three native steps preserve the real user image, omit generated model images/catalog and retain explicit edit references', async () => {
  const f = await createNativeImageFixture({ request: async (_url, _init, ordinal) => new Response(JSON.stringify({
    id: 'context-provider-' + ordinal, data: [{ b64_json: SMALL_PNG.toString('base64') }],
  }), { headers: { 'content-type': 'application/json' } }) })
  const imageBlocks = content => content.flatMap(block => block.type === 'image' ? [block]
    : block.type === 'tool-result' ? imageBlocks(block.content) : [])
  try {
    const uploaded = await f.ctx.attachments.saveImage({ data: SMALL_PNG, mediaType: 'image/png', name: 'actual-user-upload.png' })
    f.agent.session.append('user/message', f.createUserMessage({ content: [{ type: 'image', attachment: uploaded }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assertContext = () => {
      const messages = f.agent.session.deriveMessages()
      const images = messages.flatMap(message => imageBlocks(message.content))
      assert.deepEqual(images.map(block => block.attachment), [uploaded])
      assert.equal(messages.filter(message => message.source?.kind === 'user').length, 1)
      assert.equal(messages.some(message => message.source?.plugin === '@e-mate/dsh-image-generation' || message.source?.form === 'catalog'), false)
    }
    assertContext()
    const generated = await f.call('generate_image', { prompt: 'offline new image' }, { step: 1 })
    assert.deepEqual(generated.content.map(block => block.type), ['text'])
    assertContext()
    const queried = await f.call('get_image_generation_task', { task_id: generated.value.task_id }, { step: 2 })
    assert.equal(queried.value.images.length, 1)
    assert.equal(f.calls.length, 1)
    assertContext()
    const edited = await f.call('edit_image', { prompt: 'offline explicit generated edit', source_image: generated.value.images[0] }, { step: 3 })
    assert.equal(edited.value.status, 'completed')
    assertContext()
    assert.equal(f.calls[1].url.endsWith('/images/edits'), true)
    assert.deepEqual(snakeRef(uploaded).attachment_id, generated.value.images[0].attachment_id)
    for (const result of [generated, queried, edited]) {
      assert.equal(result.isError, false)
      assert.equal(result.meta.images.length, 1)
    }
    const view = f.ctx.tools.get('generate_image').presentResult({ prompt: 'offline new image' }, generated)
    assert.equal(view.content[0].type, 'image')
    // The store normalizes on save (an alpha PNG becomes WebP), so the provider
    // receives the stored bytes and the presented ref must describe exactly them.
    const presented = await f.ctx.attachments.readImage(view.content[0].attachment)
    assert.equal(presented.ref.mediaType, 'image/webp')
    assert.equal(presented.ref.bytes, presented.data.byteLength)
    assert.deepEqual(view.content[0].attachment, presented.ref)
    assert.deepEqual(Buffer.from(await f.calls[1].init.body.get('image').arrayBuffer()), Buffer.from(presented.data))
    const restored = f.Session.create(f.agent.id, f.agent.session.snapshotEvents(), f.agent.session.header)
    assert.deepEqual(restored.deriveMessages(), f.agent.session.deriveMessages())
  } finally { await f.dispose() }
})
