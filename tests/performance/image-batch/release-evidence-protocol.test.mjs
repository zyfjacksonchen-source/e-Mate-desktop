import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CLAIM, DESKTOP_REFERENCE, HARNESS_COMMIT, createOpenManifest, projectManifest, validateManifest, validateRawEvidence } from './release-evidence-protocol.mjs'

const MANIFEST = new URL('../../../docs/2.0.17/evidence-manifests/performance.json', import.meta.url)
const digest = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)

function provider(layer, provenance, origin, deployment, probe) {
  return {
    schema_version: 1, ticket: 'EM217-502', claim: 'real-provider-gateway-layer-v1',
    environment: { layer: `${layer}-provider`, environment_name_sha256: digest(layer), gateway_origin_sha256: digest(origin), deployment_fingerprint_sha256: digest(deployment) },
    provenance, measured_at: '2026-09-04T01:00:00.000Z', fixed_set_sha256: digest('fixed-set'),
    runs: [4, 5, 8].map((taskCount, index) => ({ run: index + 1, task_count: taskCount, first_terminal_ms: 10_000, all_terminal_ms: 20_000,
      direct_single_terminal_ms: 5_000, completed_count: taskCount, failed_count: 0, unknown_count: 0,
      retained_success_count: taskCount })),
    typed_429_retry_probe: probe,
  }
}

function validStudy() {
  const provenance = { emate_commit: 'a'.repeat(40), harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: '2.0.17' }
  const samples = Array.from({ length: 100 }, (_, index) => {
    const taskCount = index < 40 ? 4 : index < 80 ? 5 : 8
    return { sample: index + 1, task_count: taskCount, first_visible_ms: 10_000, all_terminal_ms: 20_000,
      direct_single_ms: 5_000, terminal_counts: { completed: taskCount, failed: 0, cancelled: 0, unknown: 0, interrupted: 0, missing_or_illegal: 0 },
      successful_images: taskCount, retained_successful_images: taskCount,
      provider_submission_counts: Array(taskCount).fill(1) }
  })
  const localSamples = Array.from({ length: 100 }, (_, index) => {
    const taskCount = [4, 5, 8][index % 3]
    return { batch: index + 1, task_count: taskCount, requested_concurrency: 4, terminal_status: 'completed',
      first_child_completed_receipt_ms: 1, all_terminal_ms: 2, per_item_ms: 1,
      receipt_projection_lower_bound_ms: 0.1, success_count: taskCount, failure_count: 0, max_active: 4 }
  })
  const local = {
    schema_version: 2, ticket: 'EM217-502', claim: 'local-source-only-not-provider-latency-not-ui-first-visible-not-direct-single-image-evidence',
    environment: { layer: 'local-test-provider', environment_name_sha256: digest('local'), gateway_origin_sha256: digest('local-origin'), deployment_fingerprint_sha256: digest('local-deployment') },
    provenance, measured_at: '2026-09-04T00:00:00.000Z', source_state: 'CLEAN', batches: 100,
    tasks: localSamples.reduce((sum, sample) => sum + sample.task_count, 0), fully_successful_batches: 100,
    runtime_ms: 200, provider_calls: localSamples.reduce((sum, sample) => sum + sample.task_count, 0),
    typed_429_retry_probe: 'OPEN', source_assertions: { duplicate_provider_generation: 0, legal_terminal_rate: 1, successful_image_retention_rate: 1 },
    metrics: {}, samples: localSamples,
  }
  const passProbe = { status: 'PASS', retry_after_ms: 1000, attempts: 2, accepted_submissions: 1, identical_request: true, pass: true }
  const noProbe = { status: 'NOT_RUN', retry_after_ms: null, attempts: 0, accepted_submissions: 0, identical_request: false, pass: false }
  return {
    schema_version: 1, ticket: 'EM217-502', claim: CLAIM,
    protocol: { percentile: 'nearest-rank', percentile_ci: 'deterministic-bootstrap-percentile-v1', bootstrap_resamples: 10_000,
      bootstrap_seed_sha256: digest('EM217-502-deterministic-bootstrap-percentile-v1'), legal_terminal_ci: 'wilson-score-95',
      minimum_fixed_set_batches: 100, minimum_per_sized_batch: 20, confidence: 0.95 },
    provenance, local,
    staging: provider('staging', provenance, 'staging-origin', 'staging-deployment', passProbe),
    production: provider('production', provenance, 'production-origin', 'production-deployment', noProbe),
    macos_gui: { schema_version: 1, ticket: 'EM217-502', claim: 'macos-gui-image-batch-performance-v1',
      environment: { layer: 'macos-gui', environment_name_sha256: digest('macos-gui'), gateway_origin_sha256: digest('production-origin'), deployment_fingerprint_sha256: digest('production-deployment') },
      provenance, measured_at: '2026-09-04T02:00:00.000Z', fixed_set_sha256: digest('fixed-set'), batches: samples },
  }
}

function encoded(value = validStudy()) {
  const raw = JSON.stringify(value) + '\n'
  const sha256 = digest(raw)
  return { raw, descriptor: { uri: `https://evidence.example/immutable/em217-502/${sha256}.json`, sha256 } }
}

function currentStudy() {
  const value = validStudy()
  value.provenance.version = '2.0.18'
  for (const layer of [value, value.local, value.staging, value.production, value.macos_gui]) layer.ticket = 'EM218-502'
  for (const batch of value.macos_gui.batches) batch.provider_billing_counts = Array(batch.task_count).fill(1)
  return value
}

test('2.0.18 enforces effective success separately from legal terminal and retains old evidence identity', () => {
  const current = currentStudy()
  const { raw, descriptor } = encoded(current)
  const pass = projectManifest(createOpenManifest(), raw, descriptor)
  assert.equal(pass.ticket, 'EM218-502')
  assert.equal(pass.release_evidence.effective_image_success_rate.value, 1)
  assert.strictEqual(validateManifest(pass, raw), pass)
  const historical = encoded()
  assert.equal(validateRawEvidence(historical.raw, historical.descriptor).ticket, 'EM217-502')
  assert.throws(() => projectManifest(createOpenManifest(), historical.raw, historical.descriptor), /release identities differ/u)
  for (const batch of current.macos_gui.batches) {
    batch.terminal_counts.completed -= 1; batch.terminal_counts.failed += 1
    batch.successful_images -= 1; batch.retained_successful_images -= 1
  }
  const failure = encoded(current)
  assert.throws(() => projectManifest(createOpenManifest(), failure.raw, failure.descriptor), /effective_image_success_rate failed/u)
})

test('2.0.18 requires observed billing counts and rejects duplicate charges or mixed identities', () => {
  for (const mutate of [
    value => { delete value.macos_gui.batches[0].provider_billing_counts },
    value => { value.macos_gui.batches[0].provider_billing_counts[0] = 2 },
    value => { value.production.ticket = 'EM217-502' },
  ]) {
    const value = currentStudy(); mutate(value)
    const { raw, descriptor } = encoded(value)
    assert.throws(() => validateRawEvidence(raw, descriptor))
  }
})

test('only exact multi-environment raw bytes project a complete PASS manifest', () => {
  const open = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const { raw, descriptor } = encoded()
  assert.equal(validateRawEvidence(raw, descriptor).claim, CLAIM)
  const pass = projectManifest(open, raw, descriptor)
  assert.equal(pass.release_gate, 'PASS')
  assert.equal(pass.release_evidence.legal_terminal_rate.status, 'PASS')
  assert.strictEqual(validateManifest(pass, raw), pass)
  assert.throws(() => validateManifest(pass), /exact raw evidence bytes/u)
  assert.throws(() => validateRawEvidence(raw + ' ', descriptor), /SHA-256/u)
})

test('environment aliasing, fake staging probe, undersized GUI, and leaked fields fail closed', () => {
  for (const mutate of [
    value => { value.staging.environment.gateway_origin_sha256 = value.production.environment.gateway_origin_sha256 },
    value => { value.staging.environment.deployment_fingerprint_sha256 = value.production.environment.deployment_fingerprint_sha256 },
    value => { value.staging.typed_429_retry_probe.status = 'NOT_RUN'; value.staging.typed_429_retry_probe.retry_after_ms = null; value.staging.typed_429_retry_probe.attempts = 0; value.staging.typed_429_retry_probe.accepted_submissions = 0; value.staging.typed_429_retry_probe.identical_request = false; value.staging.typed_429_retry_probe.pass = false },
    value => { value.macos_gui.batches.length = 99 },
    value => { value.production.runs[0].prompt = 'forbidden' },
    value => { value.production.runs[0].duplicate_provider_generation = 0 },
    value => { value.production.runs[0].first_terminal_ms = value.production.runs[0].all_terminal_ms + 1 },
  ]) {
    const value = clone(validStudy()); mutate(value)
    const { raw, descriptor } = encoded(value)
    assert.throws(() => validateRawEvidence(raw, descriptor))
  }
})

test('duplicate release gate uses observed macOS GUI provider submissions only', () => {
  const open = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const value = validStudy()
  value.macos_gui.batches[0].provider_submission_counts[0] = 2
  const { raw, descriptor } = encoded(value)
  assert.equal(validateRawEvidence(raw, descriptor).claim, CLAIM)
  assert.throws(() => projectManifest(open, raw, descriptor), /duplicate_provider_generation failed/u)
})

test('strict immutable URI rejects credentials, query strings, and non-HTTPS storage', () => {
  const { raw, descriptor } = encoded()
  for (const uri of ['http://evidence.example/raw.json', 'https://user@evidence.example/raw.json', 'https://evidence.example/raw.json?q=1']) {
    assert.throws(() => validateRawEvidence(raw, { ...descriptor, uri }))
  }
})
