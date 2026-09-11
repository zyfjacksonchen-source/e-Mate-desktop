import { createHash } from 'node:crypto'
import { NATIVE_EXECUTION } from '../image-single/native-fixture.mjs'

import { RELEASE_VERSION, ticketFor, versionFor } from './release-identity.mjs'
export { RELEASE_VERSION }
export const TICKET = ticketFor(RELEASE_VERSION, '502')
export const CLAIM = 'image-batch-release-performance-v1'
export const HARNESS_COMMIT = '7882599607eade325e66e7bf28f520a206270727'
export const DESKTOP_REFERENCE = '166c16cfc38c51d32c2316715548c0f8271db517'
export const BOOTSTRAP_RESAMPLES = 10_000
// Retain the statistical protocol seed across releases so old percentile evidence is reproducible.
const BOOTSTRAP_SEED = 'EM217-502-deterministic-bootstrap-percentile-v1'
const BOOTSTRAP_SEED_SHA256 = sha256(BOOTSTRAP_SEED)
const MAX_RAW_BYTES = 4 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const LEGAL_TERMINALS = ['completed', 'failed', 'cancelled', 'unknown', 'interrupted']
const LAYERS = ['local-test-provider', 'staging-provider', 'production-provider', 'macos-gui']

const LEGACY_GATE_SPECS = Object.freeze({
  ui_first_visible_p50_seconds: ['max', 75],
  ui_first_visible_p95_seconds: ['max', 120],
  relative_same_round_direct_single_p95_seconds: ['max', 10],
  four_image_all_terminal_p50_seconds: ['max', 150],
  four_image_all_terminal_p95_seconds: ['max', 240],
  five_image_all_terminal_p50_seconds: ['max', 210],
  five_image_all_terminal_p95_seconds: ['max', 300],
  typed_429_retry_probe_pass: ['exact', 1],
  duplicate_provider_generation: ['exact', 0],
  legal_terminal_rate: ['min', 0.95],
  successful_image_retention_rate: ['exact', 1],
})

export const GATE_SPECS = Object.freeze({ ...LEGACY_GATE_SPECS, effective_image_success_rate: ['min-point', 0.95], duplicate_provider_billing: ['exact', 0] })
const gateSpecs = ticket => versionFor(ticket, '502') === RELEASE_VERSION ? GATE_SPECS : LEGACY_GATE_SPECS
const evidenceTicket = value => ticketFor(value.provenance.version, '502')

function fail(message) { throw new Error(`image-batch evidence invalid: ${message}`) }
function require(condition, message) { if (!condition) fail(message) }
function record(value, label) {
  require(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}
function exactKeys(value, keys, label) {
  record(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  require(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} fields mismatch`)
}
function finite(value, label, minimum = 0) {
  require(Number.isFinite(value) && value >= minimum, `${label} must be finite and >= ${minimum}`)
  return value
}
function integer(value, label, minimum = 0) {
  require(Number.isSafeInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`)
  return value
}
function hash(value, label) { require(typeof value === 'string' && SHA256.test(value), `${label} must be lowercase SHA-256`); return value }
function commit(value, label) { require(typeof value === 'string' && COMMIT.test(value), `${label} must be a lowercase 40-hex commit`); return value }
function timestamp(value, label) { require(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`); return value }
function same(left, right, label) { require(JSON.stringify(left) === JSON.stringify(right), `${label} mismatch`) }

export function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function evidenceDescriptor(value, label = 'raw evidence') {
  exactKeys(value, ['uri', 'sha256'], label)
  hash(value.sha256, `${label} sha256`)
  let uri
  try { uri = new URL(value.uri) } catch { fail(`${label} URI is invalid`) }
  require(uri.protocol === 'https:' && uri.hostname && uri.pathname.length > 1, `${label} URI must be immutable HTTPS`)
  require(!uri.username && !uri.password && !uri.search && !uri.hash, `${label} URI cannot contain credentials, query, or fragment`)
  require(uri.pathname.includes(value.sha256), `${label} URI path must contain the exact raw hash`)
  return value
}

function rawBytes(raw) {
  require(typeof raw === 'string' || raw instanceof Uint8Array, 'raw evidence must be exact UTF-8 bytes')
  const bytes = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  require(bytes.byteLength > 0 && bytes.byteLength <= MAX_RAW_BYTES, 'raw evidence exceeds the 4 MiB bound')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('raw evidence must be UTF-8') }
  return { bytes, text }
}

function scanSensitive(value, trail = []) {
  if (Array.isArray(value)) return value.forEach((child, index) => scanSensitive(child, [...trail, String(index)]))
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') require(!/^(?:file:)?\/\/|\/Users\/|[A-Za-z]:\\/u.test(value), `local path is forbidden at ${trail.join('.')}`)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
    require(!/(?:prompt|imagebytes|b64json|base64|credential|secret|token|password|screenshot|video|installer|logpath)$/u.test(compact), `sensitive field is forbidden: ${key}`)
    scanSensitive(child, [...trail, key])
  }
}

function provenance(value, label) {
  exactKeys(value, ['emate_commit', 'harness_commit', 'desktop_reference', 'version'], label)
  commit(value.emate_commit, `${label}.emate_commit`)
  require(value.harness_commit === HARNESS_COMMIT, `${label}.harness_commit changed`)
  require(value.desktop_reference === DESKTOP_REFERENCE, `${label}.desktop_reference changed`)
  ticketFor(value.version, '502')
  return value
}

function environment(value, layer, label) {
  exactKeys(value, ['layer', 'environment_name_sha256', 'gateway_origin_sha256', 'deployment_fingerprint_sha256'], label)
  require(value.layer === layer, `${label}.layer mismatch`)
  for (const key of ['environment_name_sha256', 'gateway_origin_sha256', 'deployment_fingerprint_sha256']) hash(value[key], `${label}.${key}`)
  return value
}

function validateLocal(value, expectedProvenance) {
  if (expectedProvenance.version === RELEASE_VERSION) return validateNativeLocalEvidence(value, expectedProvenance)
  exactKeys(value, ['schema_version', 'ticket', 'claim', 'environment', 'provenance', 'measured_at', 'source_state', 'batches', 'tasks', 'fully_successful_batches', 'runtime_ms', 'provider_calls', 'typed_429_retry_probe', 'source_assertions', 'metrics', 'samples'], 'local')
  environment(value.environment, 'local-test-provider', 'local.environment')
  provenance(value.provenance, 'local.provenance'); same(value.provenance, expectedProvenance, 'local provenance')
  timestamp(value.measured_at, 'local.measured_at')
  require(value.source_state === 'CLEAN', 'local source evidence requires a clean committed tree')
  const report = value
  require(report.schema_version === 2 && report.ticket === evidenceTicket(report), 'local report identity mismatch')
  require(report.claim === 'local-source-only-not-provider-latency-not-ui-first-visible-not-direct-single-image-evidence', 'local report claim mismatch')
  integer(report.batches, 'local.report.batches', 100); integer(report.tasks, 'local.report.tasks', report.batches * 4)
  integer(report.fully_successful_batches, 'local.report.fully_successful_batches')
  finite(report.runtime_ms, 'local.report.runtime_ms'); integer(report.provider_calls, 'local.report.provider_calls')
  require(report.typed_429_retry_probe === 'OPEN', 'local fixture cannot claim a real 429 probe')
  exactKeys(report.source_assertions, ['duplicate_provider_generation', 'legal_terminal_rate', 'successful_image_retention_rate'], 'local.report.source_assertions')
  require(report.source_assertions.duplicate_provider_generation === 0, 'local duplicate generation detected')
  require(report.source_assertions.legal_terminal_rate === 1, 'local illegal terminal detected')
  require(report.source_assertions.successful_image_retention_rate === 1, 'local successful image lost')
  require(Array.isArray(report.samples) && report.samples.length === report.batches, 'local sample count mismatch')
  const seen = new Set()
  let tasks = 0
  for (const sample of report.samples) {
    exactKeys(sample, ['batch', 'task_count', 'requested_concurrency', 'terminal_status', 'first_child_completed_receipt_ms', 'all_terminal_ms', 'per_item_ms', 'receipt_projection_lower_bound_ms', 'success_count', 'failure_count', 'max_active'], 'local sample')
    integer(sample.batch, 'local sample batch', 1); require(!seen.has(sample.batch), 'local batch IDs must be unique'); seen.add(sample.batch)
    require([4, 5, 8].includes(sample.task_count), 'local task_count must be 4, 5, or 8'); tasks += sample.task_count
    integer(sample.requested_concurrency, 'local requested concurrency', 1); require(sample.requested_concurrency <= 4, 'local concurrency exceeded four')
    require(['completed', 'partial'].includes(sample.terminal_status), 'local terminal status is invalid')
    for (const key of ['first_child_completed_receipt_ms', 'all_terminal_ms', 'per_item_ms', 'receipt_projection_lower_bound_ms']) finite(sample[key], `local sample ${key}`)
    integer(sample.success_count, 'local success_count'); integer(sample.failure_count, 'local failure_count')
    require(sample.success_count + sample.failure_count === sample.task_count, 'local terminal count mismatch')
    integer(sample.max_active, 'local max_active'); require(sample.max_active <= Math.min(sample.requested_concurrency, 4), 'local concurrency bound failed')
  }
  require(tasks === report.tasks, 'local task total mismatch')
  return value
}

export function validateNativeLocalEvidence(value, expectedProvenance = value.provenance, { requireClean = true } = {}) {
  exactKeys(value, ['schema_version', 'execution_contract', 'ticket', 'claim', 'environment', 'provenance', 'measured_at', 'source_state',
    'batches', 'tasks', 'fully_successful_batches', 'runtime_ms', 'provider_calls', 'typed_429_retry_probe', 'source_assertions', 'metrics', 'samples'], 'native local')
  require(value.schema_version === 3 && value.execution_contract === NATIVE_EXECUTION && value.ticket === TICKET, 'historical local cohort cannot close native execution')
  require(value.claim === 'local-source-only-not-provider-latency-not-ui-first-visible-not-direct-single-image-evidence', 'native local claim')
  environment(value.environment, 'local-test-provider', 'native local.environment')
  provenance(value.provenance, 'native local.provenance'); same(value.provenance, expectedProvenance, 'native local provenance')
  timestamp(value.measured_at, 'native local.measured_at')
  require(['CLEAN', 'DIRTY'].includes(value.source_state), 'native local source state')
  if (requireClean) require(value.source_state === 'CLEAN', 'local source evidence requires a clean committed tree')
  integer(value.batches, 'native local batches', 100); integer(value.tasks, 'native local tasks', value.batches * 2)
  integer(value.fully_successful_batches, 'native local fully successful batches'); finite(value.runtime_ms, 'native local runtime')
  integer(value.provider_calls, 'native local provider calls')
  require(value.typed_429_retry_probe === 'OPEN', 'local fixture cannot claim the real provider probe')
  exactKeys(value.source_assertions, ['duplicate_provider_generation', 'legal_terminal_rate', 'successful_image_retention_rate'], 'native local assertions')
  same(value.source_assertions, { duplicate_provider_generation: 0, legal_terminal_rate: 1, successful_image_retention_rate: 1 }, 'native local invariants')
  require(Array.isArray(value.samples) && value.samples.length === value.batches, 'native local sample count')
  const seen = new Set(), sizes = new Map()
  let tasks = 0, completed = 0
  for (const sample of value.samples) {
    exactKeys(sample, ['batch', 'task_count', 'tool_counts', 'terminal_status', 'first_completed_receipt_ms', 'all_terminal_ms', 'tool_terminal_ms',
      'receipt_projection_lower_bound_ms', 'success_count', 'failure_count', 'max_active'], 'native local sample')
    integer(sample.batch, 'native sample batch', 1); require(!seen.has(sample.batch), 'native batch IDs must be unique'); seen.add(sample.batch)
    require([2, 4, 5, 8].includes(sample.task_count), 'native sample task count'); tasks += sample.task_count
    sizes.set(sample.task_count, (sizes.get(sample.task_count) ?? 0) + 1)
    same(sample.tool_counts, sample.task_count <= 4 ? [sample.task_count] : [4, sample.task_count - 4], 'native 5/8 must compose real count<=4 Tools')
    require(['completed', 'partial'].includes(sample.terminal_status), 'native sample terminal status')
    for (const key of ['first_completed_receipt_ms', 'all_terminal_ms', 'receipt_projection_lower_bound_ms']) finite(sample[key], `native sample ${key}`)
    require(sample.first_completed_receipt_ms <= sample.all_terminal_ms, 'native receipt follows terminal')
    require(Array.isArray(sample.tool_terminal_ms) && sample.tool_terminal_ms.length === sample.tool_counts.length, 'native per-tool timing count')
    for (const elapsed of sample.tool_terminal_ms) { finite(elapsed, 'native tool terminal'); require(elapsed <= sample.all_terminal_ms, 'native tool follows all-terminal') }
    integer(sample.success_count, 'native success count'); integer(sample.failure_count, 'native failure count')
    require(sample.success_count + sample.failure_count === sample.task_count, 'native outcome counts')
    require((sample.terminal_status === 'completed') === (sample.failure_count === 0), 'native completion must mean all images succeeded')
    completed += sample.failure_count === 0 ? 1 : 0
    integer(sample.max_active, 'native peak requests', 1); require(sample.max_active <= 4, 'native HTTP concurrency exceeded four')
  }
  require([2, 4, 5, 8].every(size => (sizes.get(size) ?? 0) >= 20), 'native fixed set requires >=20 runs of 2/4/5/8')
  require(tasks === value.tasks && completed === value.fully_successful_batches, 'native aggregate counts')
  require(value.provider_calls === tasks, 'native fixture must attempt each admitted image once')
  exactKeys(value.metrics, ['first_completed_receipt', 'all_terminal', 'tool_terminal', 'receipt_projection_lower_bound'], 'native metrics')
  const summarize = values => {
    const ordered = values.toSorted((a, b) => a - b)
    return { p50_ms: ordered[Math.ceil(ordered.length * 0.5) - 1], p95_ms: ordered[Math.ceil(ordered.length * 0.95) - 1], exact_observed_interval_ms: [ordered[0], ordered.at(-1)] }
  }
  for (const [key, values] of Object.entries({ first_completed_receipt: value.samples.map(s => s.first_completed_receipt_ms),
    all_terminal: value.samples.map(s => s.all_terminal_ms), tool_terminal: value.samples.flatMap(s => s.tool_terminal_ms),
    receipt_projection_lower_bound: value.samples.map(s => s.receipt_projection_lower_bound_ms) })) same(value.metrics[key], summarize(values), 'native timing arithmetic ' + key)
  require(value.metrics.all_terminal.p95_ms < 250, 'source-only all-terminal p95 exceeded 250 ms')
  return value
}

export function validateProviderLayerEvidence(value, layer, expectedProvenance) {
  exactKeys(value, ['schema_version', 'ticket', 'claim', 'environment', 'provenance', 'measured_at', 'fixed_set_sha256', 'runs', 'typed_429_retry_probe'], layer)
  require(value.schema_version === 1 && value.ticket === evidenceTicket(value) && value.claim === 'real-provider-gateway-layer-v1', `${layer} identity mismatch`)
  environment(value.environment, `${layer}-provider`, `${layer}.environment`)
  provenance(value.provenance, `${layer}.provenance`); same(value.provenance, expectedProvenance, `${layer} provenance`)
  timestamp(value.measured_at, `${layer}.measured_at`)
  hash(value.fixed_set_sha256, `${layer}.fixed_set_sha256`)
  require(Array.isArray(value.runs) && value.runs.length >= 3 && value.runs.length <= 1_000, `${layer} runs are missing or excessive`)
  const runIds = new Set()
  const sizes = new Set()
  for (const run of value.runs) {
    exactKeys(run, ['run', 'task_count', 'first_terminal_ms', 'all_terminal_ms', 'direct_single_terminal_ms', 'completed_count', 'failed_count', 'unknown_count', 'retained_success_count'], `${layer} run`)
    integer(run.run, `${layer} run index`, 1); require(!runIds.has(run.run), `${layer} run IDs must be unique`); runIds.add(run.run)
    require([4, 5, 8].includes(run.task_count), `${layer} task_count must be 4, 5, or 8`); sizes.add(run.task_count)
    for (const key of ['first_terminal_ms', 'all_terminal_ms', 'direct_single_terminal_ms']) finite(run[key], `${layer}.${key}`)
    require(run.first_terminal_ms <= run.all_terminal_ms, `${layer} first terminal cannot follow all-terminal`)
    for (const key of ['completed_count', 'failed_count', 'unknown_count', 'retained_success_count']) integer(run[key], `${layer}.${key}`)
    require(run.completed_count + run.failed_count + run.unknown_count === run.task_count, `${layer} terminal count mismatch`)
    require(run.retained_success_count === run.completed_count, `${layer} successful response was not retained for validation`)
  }
  require([4, 5, 8].every(size => sizes.has(size)), `${layer} must exercise 4, 5, and 8 image batches`)
  const probe = value.typed_429_retry_probe
  exactKeys(probe, ['status', 'retry_after_ms', 'attempts', 'accepted_submissions', 'identical_request', 'pass'], `${layer}.typed_429_retry_probe`)
  require(['PASS', 'NOT_RUN'].includes(probe.status), `${layer} 429 probe status is invalid`)
  if (probe.status === 'PASS') {
    integer(probe.retry_after_ms, `${layer} retry_after_ms`, 1_000); require(probe.retry_after_ms <= 5_000, `${layer} retry_after_ms exceeded bound`)
    require(probe.attempts === 2 && probe.accepted_submissions === 1 && probe.identical_request === true && probe.pass === true, `${layer} 429 probe failed`)
  } else {
    require(probe.retry_after_ms === null && probe.attempts === 0 && probe.accepted_submissions === 0 && probe.identical_request === false && probe.pass === false, `${layer} NOT_RUN probe must be empty`)
  }
  return value
}

export function validateGuiEvidence(value, expectedProvenance) {
  exactKeys(value, ['schema_version', 'ticket', 'claim', 'environment', 'provenance', 'measured_at', 'fixed_set_sha256', 'batches'], 'macos_gui')
  require(value.schema_version === 1 && value.ticket === evidenceTicket(value) && value.claim === 'macos-gui-image-batch-performance-v1', 'macos GUI identity mismatch')
  environment(value.environment, 'macos-gui', 'macos_gui.environment')
  provenance(value.provenance, 'macos_gui.provenance'); same(value.provenance, expectedProvenance, 'macos GUI provenance')
  timestamp(value.measured_at, 'macos_gui.measured_at')
  hash(value.fixed_set_sha256, 'macos_gui.fixed_set_sha256')
  require(Array.isArray(value.batches) && value.batches.length >= 100 && value.batches.length <= 1_000, 'macos GUI requires 100..1000 fixed-set batches')
  const counts = { 4: 0, 5: 0, 8: 0 }
  const seen = new Set()
  for (const batch of value.batches) {
    exactKeys(batch, ['sample', 'task_count', 'first_visible_ms', 'all_terminal_ms', 'direct_single_ms', 'terminal_counts', 'successful_images', 'retained_successful_images', 'provider_submission_counts', ...(value.provenance.version === RELEASE_VERSION ? ['provider_billing_counts'] : [])], 'macos GUI batch')
    integer(batch.sample, 'macos GUI sample', 1); require(!seen.has(batch.sample), 'macos GUI sample IDs must be unique'); seen.add(batch.sample)
    require([4, 5, 8].includes(batch.task_count), 'macos GUI task_count must be 4, 5, or 8'); counts[batch.task_count] += 1
    for (const key of ['first_visible_ms', 'all_terminal_ms', 'direct_single_ms']) finite(batch[key], `macos GUI ${key}`)
    require(batch.first_visible_ms <= batch.all_terminal_ms, 'first visible cannot follow all-terminal')
    exactKeys(batch.terminal_counts, [...LEGAL_TERMINALS, 'missing_or_illegal'], 'macos GUI terminal_counts')
    for (const key of [...LEGAL_TERMINALS, 'missing_or_illegal']) integer(batch.terminal_counts[key], `macos GUI terminal_counts.${key}`)
    const terminalTotal = Object.values(batch.terminal_counts).reduce((sum, count) => sum + count, 0)
    require(terminalTotal === batch.task_count, 'macos GUI terminal count mismatch')
    integer(batch.successful_images, 'macos GUI successful_images'); integer(batch.retained_successful_images, 'macos GUI retained_successful_images')
    require(batch.successful_images === batch.terminal_counts.completed, 'macos GUI successful image count mismatch')
    require(batch.retained_successful_images <= batch.successful_images, 'macos GUI retained count exceeds successes')
    require(Array.isArray(batch.provider_submission_counts) && batch.provider_submission_counts.length === batch.task_count, 'macos GUI provider submission counts mismatch')
    batch.provider_submission_counts.forEach((count, index) => integer(count, `macos GUI provider_submission_counts[${index}]`))
    if (value.provenance.version === RELEASE_VERSION) {
      require(Array.isArray(batch.provider_billing_counts) && batch.provider_billing_counts.length === batch.task_count, 'macos GUI provider billing counts mismatch')
      batch.provider_billing_counts.forEach((count, index) => {
        integer(count, `macos GUI provider_billing_counts[${index}]`)
        require(count <= 1, 'duplicate provider billing observed')
      })
    }
    require(batch.provider_submission_counts.reduce((sum, count) => sum + count, 0) >= batch.successful_images, 'macos GUI successful tasks require observed provider submissions')
  }
  require(counts[4] >= 20 && counts[5] >= 20 && counts[8] >= 1, 'macos GUI needs >=20 four-image, >=20 five-image, and >=1 eight-image batches')
  return value
}

export function validateRawEvidence(raw, descriptor) {
  const exact = rawBytes(raw)
  evidenceDescriptor(descriptor)
  require(sha256(exact.bytes) === descriptor.sha256, 'raw evidence SHA-256 does not match exact bytes')
  let value
  try { value = JSON.parse(exact.text) } catch { fail('raw evidence is not JSON') }
  exactKeys(value, ['schema_version', 'ticket', 'claim', 'protocol', 'provenance', 'local', 'staging', 'production', 'macos_gui'], 'raw evidence')
  require(value.schema_version === 1 && value.ticket === evidenceTicket(value) && value.claim === CLAIM, 'raw evidence identity mismatch')
  exactKeys(value.protocol, ['percentile', 'percentile_ci', 'bootstrap_resamples', 'bootstrap_seed_sha256', 'legal_terminal_ci', 'minimum_fixed_set_batches', 'minimum_per_sized_batch', 'confidence'], 'protocol')
  same(value.protocol, {
    percentile: 'nearest-rank', percentile_ci: 'deterministic-bootstrap-percentile-v1', bootstrap_resamples: BOOTSTRAP_RESAMPLES,
    bootstrap_seed_sha256: BOOTSTRAP_SEED_SHA256, legal_terminal_ci: 'wilson-score-95', minimum_fixed_set_batches: 100,
    minimum_per_sized_batch: 20, confidence: 0.95,
  }, 'protocol')
  provenance(value.provenance, 'provenance')
  validateLocal(value.local, value.provenance)
  validateProviderLayerEvidence(value.staging, 'staging', value.provenance)
  validateProviderLayerEvidence(value.production, 'production', value.provenance)
  validateGuiEvidence(value.macos_gui, value.provenance)
  require(value.staging.environment.gateway_origin_sha256 !== value.production.environment.gateway_origin_sha256, 'staging and production gateway origins must differ')
  require(value.staging.environment.deployment_fingerprint_sha256 !== value.production.environment.deployment_fingerprint_sha256, 'staging and production deployments must differ')
  require(value.macos_gui.environment.gateway_origin_sha256 === value.production.environment.gateway_origin_sha256, 'macOS GUI must use the production gateway origin')
  require(value.macos_gui.environment.deployment_fingerprint_sha256 === value.production.environment.deployment_fingerprint_sha256, 'macOS GUI must use the production deployment')
  require(value.staging.fixed_set_sha256 === value.production.fixed_set_sha256 && value.production.fixed_set_sha256 === value.macos_gui.fixed_set_sha256, 'staging, production, and macOS GUI must use the same fixed task set')
  require(value.staging.typed_429_retry_probe.status === 'PASS', 'typed 429 probe requires a controlled staging PASS')
  scanSensitive(value)
  return value
}

export function nearestRank(values, quantile) {
  require(Array.isArray(values) && values.length > 0, 'percentile samples are missing')
  values.forEach((value, index) => finite(value, `percentile sample ${index}`, Number.NEGATIVE_INFINITY))
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]
}

function random(seedText) {
  let state = createHash('sha256').update(seedText).digest().readUInt32LE(0) || 1
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function bootstrapQuantile(values, quantile, label) {
  const point = nearestRank(values, quantile)
  const rng = random(`${BOOTSTRAP_SEED}\0${label}\0${values.length}`)
  const estimates = new Array(BOOTSTRAP_RESAMPLES)
  const sample = new Array(values.length)
  for (let repetition = 0; repetition < BOOTSTRAP_RESAMPLES; repetition += 1) {
    for (let index = 0; index < values.length; index += 1) sample[index] = values[Math.floor(rng() * values.length)]
    estimates[repetition] = nearestRank(sample, quantile)
  }
  return { value: point, ci95: { lower: nearestRank(estimates, 0.025), upper: nearestRank(estimates, 0.975) } }
}

function wilson(successes, total) {
  integer(successes, 'Wilson successes'); integer(total, 'Wilson total', 1); require(successes <= total, 'Wilson successes exceed total')
  const z = 1.959963984540054
  const ratio = successes / total
  const denominator = 1 + z ** 2 / total
  const center = (ratio + z ** 2 / (2 * total)) / denominator
  const half = z * Math.sqrt(ratio * (1 - ratio) / total + z ** 2 / (4 * total ** 2)) / denominator
  return { value: ratio, ci95: { lower: Math.max(0, center - half), upper: Math.min(1, center + half) } }
}

function summarizeRaw(value) {
  const batches = value.macos_gui.batches
  const first = batches.map(batch => batch.first_visible_ms / 1_000)
  const relative = batches.map(batch => (batch.first_visible_ms - batch.direct_single_ms) / 1_000)
  const four = batches.filter(batch => batch.task_count === 4).map(batch => batch.all_terminal_ms / 1_000)
  const five = batches.filter(batch => batch.task_count === 5).map(batch => batch.all_terminal_ms / 1_000)
  const terminal = batches.reduce((totals, batch) => {
    for (const key of LEGAL_TERMINALS) totals.legal += batch.terminal_counts[key]
    totals.total += Object.values(batch.terminal_counts).reduce((sum, count) => sum + count, 0)
    totals.successful += batch.successful_images
    totals.retained += batch.retained_successful_images
    totals.billingDuplicates += (batch.provider_billing_counts ?? []).reduce((sum, count) => sum + Math.max(0, count - 1), 0)
    totals.duplicates += batch.provider_submission_counts.reduce((sum, count) => sum + Math.max(0, count - 1), 0)
    return totals
  }, { legal: 0, total: 0, successful: 0, retained: 0, duplicates: 0, billingDuplicates: 0 })
  require(terminal.successful > 0, 'macOS GUI has no successful image')
  const gates = {
    ui_first_visible_p50_seconds: bootstrapQuantile(first, 0.5, 'ui-first-p50'),
    ui_first_visible_p95_seconds: bootstrapQuantile(first, 0.95, 'ui-first-p95'),
    relative_same_round_direct_single_p95_seconds: bootstrapQuantile(relative, 0.95, 'relative-single-p95'),
    four_image_all_terminal_p50_seconds: bootstrapQuantile(four, 0.5, 'four-terminal-p50'),
    four_image_all_terminal_p95_seconds: bootstrapQuantile(four, 0.95, 'four-terminal-p95'),
    five_image_all_terminal_p50_seconds: bootstrapQuantile(five, 0.5, 'five-terminal-p50'),
    five_image_all_terminal_p95_seconds: bootstrapQuantile(five, 0.95, 'five-terminal-p95'),
    typed_429_retry_probe_pass: { value: 1, ci95: { lower: 1, upper: 1 } },
    duplicate_provider_generation: { value: terminal.duplicates, ci95: { lower: terminal.duplicates, upper: terminal.duplicates } },
    legal_terminal_rate: wilson(terminal.legal, terminal.total),
    ...(value.provenance.version === RELEASE_VERSION ? { effective_image_success_rate: wilson(terminal.successful, terminal.total), duplicate_provider_billing: { value: terminal.billingDuplicates, ci95: { lower: terminal.billingDuplicates, upper: terminal.billingDuplicates } } } : {}),
    successful_image_retention_rate: {
      value: terminal.retained / terminal.successful,
      ci95: { lower: terminal.retained / terminal.successful, upper: terminal.retained / terminal.successful },
    },
  }
  for (const [name, [comparison, threshold]] of Object.entries(gateSpecs(value.ticket))) {
    const gate = gates[name]
    require(comparison === 'max' ? gate.ci95.upper <= threshold
      : comparison === 'min-point' ? gate.value >= threshold
        : comparison === 'min' ? gate.ci95.lower >= threshold
        : gate.value === threshold && gate.ci95.lower === threshold && gate.ci95.upper === threshold,
    `${name} failed its release threshold`)
  }
  return gates
}

function openManifest(value) {
  exactKeys(value, ['schema_version', 'ticket', 'claim', 'release_gate', 'local', 'staging', 'production', 'external_raw_evidence', 'macos_gui_first_visible', 'release_evidence'], 'manifest')
  require(value.schema_version === 2 && versionFor(value.ticket, '502') && value.claim === CLAIM, 'manifest identity mismatch')
  require(value.release_gate === 'OPEN', 'projection requires an OPEN manifest')
  for (const name of ['local', 'staging', 'production', 'macos_gui_first_visible']) {
    same(value[name], { status: 'OPEN', environment: null, result: null, raw_evidence: { uri: null, sha256: null } }, `${name} OPEN state`)
  }
  same(value.external_raw_evidence, { status: 'OPEN', uri: null, sha256: null }, 'external raw OPEN state')
  require(Object.keys(value.release_evidence).sort().join('|') === Object.keys(gateSpecs(value.ticket)).sort().join('|'), 'manifest gate keys mismatch')
  for (const [name, [comparison, threshold]] of Object.entries(gateSpecs(value.ticket))) {
    same(value.release_evidence[name], { comparison, threshold, status: 'OPEN', value: null, ci95: null, raw_evidence: { uri: null, sha256: null } }, `${name} OPEN state`)
  }
  scanSensitive(value)
  return value
}

function expectedPass(open, value, descriptor) {
  require(open.ticket === value.ticket, 'manifest and raw evidence release identities differ')
  const gates = summarizeRaw(value)
  const entry = (environmentLabel, sampleCount, measuredAt) => ({
    status: 'PASS', environment: environmentLabel,
    result: { sample_count: sampleCount, measured_at: measuredAt }, raw_evidence: { ...descriptor },
  })
  return {
    ...open,
    release_gate: 'PASS',
    local: entry('local-test-provider', value.local.batches, value.local.measured_at),
    staging: entry('staging-provider', value.staging.runs.length, value.staging.measured_at),
    production: entry('production-provider', value.production.runs.length, value.production.measured_at),
    external_raw_evidence: { status: 'PASS', ...descriptor },
    macos_gui_first_visible: entry('macos-gui-production', value.macos_gui.batches.length, value.macos_gui.measured_at),
    release_evidence: Object.fromEntries(Object.entries(gateSpecs(value.ticket)).map(([name, [comparison, threshold]]) => [name, {
      comparison, threshold, status: 'PASS', value: gates[name].value, ci95: gates[name].ci95, raw_evidence: { ...descriptor },
    }])),
  }
}

export function projectManifest(open, raw, descriptor) {
  openManifest(open)
  const value = validateRawEvidence(raw, descriptor)
  return expectedPass(open, value, descriptor)
}

export function validateManifest(manifest, raw) {
  if (manifest.release_gate === 'OPEN') return openManifest(manifest)
  require(manifest.release_gate === 'PASS', 'manifest release_gate must be OPEN or PASS')
  require(raw !== undefined, 'PASS manifest requires exact raw evidence bytes')
  const descriptor = { uri: manifest.external_raw_evidence.uri, sha256: manifest.external_raw_evidence.sha256 }
  evidenceDescriptor(descriptor)
  const value = validateRawEvidence(raw, descriptor)
  const open = structuredClone(manifest)
  open.release_gate = 'OPEN'
  for (const name of ['local', 'staging', 'production', 'macos_gui_first_visible']) open[name] = { status: 'OPEN', environment: null, result: null, raw_evidence: { uri: null, sha256: null } }
  open.external_raw_evidence = { status: 'OPEN', uri: null, sha256: null }
  for (const [name, [comparison, threshold]] of Object.entries(gateSpecs(manifest.ticket))) open.release_evidence[name] = { comparison, threshold, status: 'OPEN', value: null, ci95: null, raw_evidence: { uri: null, sha256: null } }
  openManifest(open)
  same(manifest, expectedPass(open, value, descriptor), 'PASS manifest projection')
  scanSensitive(manifest)
  return manifest
}

export const protocolConstants = Object.freeze({
  BOOTSTRAP_SEED_SHA256, LAYERS, LEGAL_TERMINALS, MAX_RAW_BYTES,
})

export function createOpenManifest() {
  const empty = () => ({ status: 'OPEN', environment: null, result: null, raw_evidence: { uri: null, sha256: null } })
  return openManifest({ schema_version: 2, ticket: TICKET, claim: CLAIM, release_gate: 'OPEN',
    local: empty(), staging: empty(), production: empty(), macos_gui_first_visible: empty(),
    external_raw_evidence: { status: 'OPEN', uri: null, sha256: null },
    release_evidence: Object.fromEntries(Object.entries(GATE_SPECS).map(([name, [comparison, threshold]]) => [name,
      { comparison, threshold, status: 'OPEN', value: null, ci95: null, raw_evidence: { uri: null, sha256: null } }])),
  })
}
