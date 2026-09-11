import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 2
import { RELEASE_VERSION, ticketFor, versionFor } from '../image-batch/release-identity.mjs'
export { RELEASE_VERSION }
export const TICKET = ticketFor(RELEASE_VERSION, '108')
const evidenceContract = ticket => versionFor(ticket, '108') === RELEASE_VERSION ? 'tests/performance/image-single/protocol.mjs' : 'docs/2.0.17/contracts/single-image-latency.md'
export const HARNESS_COMMIT = 'f9e0f1190e4021e63db579ef36b67484028e8c53'
export const DESKTOP_REFERENCE = '166c16cfc38c51d32c2316715548c0f8271db517'
export const MODEL = 'gpt-image-2-pro'
export const FAKE_DELAY_MS = 25
export const REPETITIONS = 3
export const PROMPT = 'Generate one deterministic benchmark image with a plain neutral background.'
export const NORMALIZED_PROMPT = PROMPT.trim()
export const REQUEST_BODY = JSON.stringify({ model: MODEL, prompt: NORMALIZED_PROMPT })
export const NATIVE_MODEL = 'gpt-image-2.5-flare'
export const NATIVE_REQUEST_BODY = JSON.stringify({ prompt: NORMALIZED_PROMPT, model: NATIVE_MODEL })
export const NATIVE_EXECUTION = 'dsh-imagegen-1.5.11-native-tools-jobs-session-v3'
export const CLAIM = 'pinned-owner-lower-bound-not-native-imagegen-parity'
// The pinned 0.1.5 attachment limits (attachment-local/src/index.ts DEFAULT_MAX_*),
// so a silent limit change in the native owner fails this smoke loudly.
export const ATTACHMENT_LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
})

export const COMPARISON_SCENARIOS = Object.freeze({
  'warm-small': { warmups: 20, pairs: 60, p95: { absoluteMs: 75, relative: 0.15 }, p99: { absoluteMs: 150, relative: 0.25 } },
  'warm-max': { warmups: 20, pairs: 60, p95: { absoluteMs: 250, relative: 0.15 }, p99: { absoluteMs: 500, relative: 0.25 } },
  'cold-small': { warmups: 0, pairs: 15, p95: { absoluteMs: 350, relative: 0.25 }, p99: { absoluteMs: 750, relative: 0.50 } },
  'cold-max': { warmups: 0, pairs: 15, p95: { absoluteMs: 750, relative: 0.25 }, p99: { absoluteMs: 1500, relative: 0.50 } },
})
export const HISTORY_SCENARIO = Object.freeze({ warmups: 0, pairs: 30, receipts: [0, 256], p95Ms: 75, p99Ms: 150 })
export const SCENARIO_NAMES = Object.freeze([...Object.keys(COMPARISON_SCENARIOS), 'history-0-vs-256'])

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function nearestRank(values, quantile) {
  expect(Array.isArray(values) && values.length > 0, 'nearest-rank needs a non-empty sample')
  expect(Number.isFinite(quantile) && quantile > 0 && quantile <= 1, 'nearest-rank quantile is invalid')
  const ordered = values.map((value, index) => {
    expect(typeof value === 'number' && Number.isFinite(value), 'sample[' + index + '] must be finite')
    return value
  }).sort((left, right) => left - right)
  return ordered[Math.ceil(quantile * ordered.length) - 1]
}

export function comparisonSummary(samples, threshold) {
  const lower = samples.map(sample => sample.lower_bound.total_ms)
  const assembled = samples.map(sample => sample.assembled.total_ms)
  const lowerP95 = nearestRank(lower, 0.95)
  const lowerP99 = nearestRank(lower, 0.99)
  const assembledP95 = nearestRank(assembled, 0.95)
  const assembledP99 = nearestRank(assembled, 0.99)
  const allowedP95 = lowerP95 + Math.max(threshold.p95.absoluteMs, threshold.p95.relative * lowerP95)
  const allowedP99 = lowerP99 + Math.max(threshold.p99.absoluteMs, threshold.p99.relative * lowerP99)
  return {
    lower_bound: { p95_ms: lowerP95, p99_ms: lowerP99 },
    assembled: { p95_ms: assembledP95, p99_ms: assembledP99 },
    allowed: { p95_ms: allowedP95, p99_ms: allowedP99 },
    pass: assembledP95 <= allowedP95 && assembledP99 <= allowedP99,
  }
}

export function historySummary(samples) {
  const deltas = samples.map(sample => sample.delta_ms)
  const p95 = nearestRank(deltas, 0.95)
  const p99 = nearestRank(deltas, 0.99)
  return { delta: { p95_ms: p95, p99_ms: p99 }, pass: p95 <= HISTORY_SCENARIO.p95Ms && p99 <= HISTORY_SCENARIO.p99Ms }
}

function fail(message) { throw new Error(TICKET + ' evidence invalid: ' + message) }
function expect(condition, message) { if (!condition) fail(message) }
function record(value, label) { expect(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object'); return value }
function finite(value, label) { expect(typeof value === 'number' && Number.isFinite(value) && value >= 0, label + ' must be a non-negative finite number'); return value }
function integer(value, label, minimum = 0) { expect(Number.isSafeInteger(value) && value >= minimum, label + ' must be an integer >= ' + minimum); return value }
function exactKeys(value, keys, label) {
  record(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  expect(actual.length === expected.length && actual.every((key, index) => key === expected[index]), label + ' fields do not match')
}
function gitCommit(value, label) { expect(typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value), label + ' must be a lowercase 40-hex Git commit'); return value }
function hash(value, label) { expect(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value), label + ' must be lowercase SHA-256'); return value }
function sameNumber(actual, expected, label) { expect(Object.is(actual, expected), label + ' arithmetic mismatch') }

function evidenceDescriptor(uri, digest, label) {
  hash(digest, label + ' hash')
  let value
  try { value = new URL(uri) } catch { fail(label + ' URI is invalid') }
  expect(value.protocol === 'https:' && value.hostname && value.pathname.length > 1, label + ' requires immutable HTTPS')
  expect(!value.username && !value.password && !value.search && !value.hash, label + ' URI cannot contain credentials, query, or fragment')
  expect(value.pathname.includes(digest), label + ' URI path must contain the exact raw hash')
}

function exactRaw(raw, expectedHash, label) {
  expect(typeof raw === 'string' || raw instanceof Uint8Array, label + ' requires exact raw bytes')
  const bytes = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  expect(bytes.byteLength > 0 && bytes.byteLength <= 4 * 1024 * 1024, label + ' raw bytes exceed 4 MiB')
  expect(sha256(bytes) === expectedHash, label + ' raw hash mismatch')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail(label + ' raw bytes must be UTF-8') }
  try { return JSON.parse(text) } catch { fail(label + ' raw bytes must be JSON') }
}

const LOWER_STAGE_KEYS = ['provider_submit_ms', 'provider_finish_ms', 'response_complete_ms', 'cas_begin_ms', 'cas_end_ms']
const ASSEMBLED_STAGE_KEYS = [...LOWER_STAGE_KEYS, 'verification_begin_ms', 'verification_end_ms', 'job_terminal_ms', 'receipt_append_begin_ms', 'projection_handoff_ms', 'receipt_append_return_ms', 'tool_return_ms']
const COUNT_KEYS = ['subagent_starts', 'batch_events', 'jobs', 'provider_posts', 'cas_saves', 'terminal_receipts', 'attempts', 'admission_wait_ms']

function validateStages(stages, keys, label, native = false) {
  exactKeys(stages, keys, label)
  for (const key of keys) {
    if ((key === 'verification_begin_ms' || key === 'verification_end_ms') && stages[key] === null) continue
    finite(stages[key], label + '.' + key)
  }
  expect(stages.provider_submit_ms <= stages.provider_finish_ms, label + ' provider order')
  expect(stages.provider_finish_ms - stages.provider_submit_ms >= FAKE_DELAY_MS - 1, label + ' fake provider delay')
  expect(stages.provider_finish_ms <= stages.response_complete_ms, label + ' response order')
  expect(stages.response_complete_ms <= stages.cas_begin_ms, label + ' CAS begin order')
  expect(stages.cas_begin_ms <= stages.cas_end_ms, label + ' CAS end order')
  if (keys === ASSEMBLED_STAGE_KEYS || keys.length === ASSEMBLED_STAGE_KEYS.length) {
    expect((stages.verification_begin_ms === null) === (stages.verification_end_ms === null), label + ' verification pair')
    if (stages.verification_begin_ms !== null) {
      expect(stages.cas_end_ms <= stages.verification_begin_ms && stages.verification_begin_ms <= stages.verification_end_ms, label + ' verification order')
      expect(stages.verification_end_ms <= stages.job_terminal_ms, label + ' Job after verification')
    } else expect(stages.cas_end_ms <= stages.job_terminal_ms, label + ' Job after CAS')
    if (native) expect(stages.receipt_append_return_ms <= stages.job_terminal_ms, label + ' native Job after durable receipt')
    else expect(stages.job_terminal_ms <= stages.receipt_append_begin_ms, label + ' receipt after Job')
    expect(stages.receipt_append_begin_ms <= stages.projection_handoff_ms, label + ' projection after append begin')
    expect(stages.projection_handoff_ms <= stages.receipt_append_return_ms, label + ' append return after projection')
    expect(stages.receipt_append_return_ms <= stages.tool_return_ms, label + ' Tool return after receipt append')
  }
}

function validateCounts(counts, label) {
  exactKeys(counts, COUNT_KEYS, label)
  for (const key of COUNT_KEYS) integer(counts[key], label + '.' + key)
  expect(counts.subagent_starts === 0, label + ' started a subagent')
  expect(counts.batch_events === 0, label + ' emitted image-batch events')
  expect(counts.jobs === 1, label + ' must start exactly one Job')
  expect(counts.provider_posts === 1, label + ' must send exactly one provider POST')
  expect(counts.cas_saves === 1, label + ' must save exactly one CAS image')
  expect(counts.terminal_receipts === 1, label + ' must append exactly one terminal receipt')
  expect(counts.attempts === 1, label + ' ordinary success must use one attempt')
  expect(counts.admission_wait_ms === 0, label + ' ordinary success must not admission-wait')
}

function validateLower(value, label) {
  exactKeys(value, ['total_ms', 'stages', 'request_body_sha256', 'response_body_sha256', 'attachment_sha256'], label)
  for (const key of ['request_body_sha256', 'response_body_sha256', 'attachment_sha256']) hash(value[key], label + '.' + key)
  finite(value.total_ms, label + '.total_ms')
  validateStages(value.stages, LOWER_STAGE_KEYS, label + '.stages')
  expect(value.stages.cas_end_ms <= value.total_ms, label + ' total precedes CAS completion')
}

function validateAssembled(value, label) {
  const native = value.execution_contract === NATIVE_EXECUTION
  exactKeys(value, ['total_ms', 'stages', 'counts', 'request_body_sha256', 'response_body_sha256', 'attachment_sha256', ...(native ? ['execution_contract'] : [])], label)
  finite(value.total_ms, label + '.total_ms')
  validateStages(value.stages, ASSEMBLED_STAGE_KEYS, label + '.stages', native)
  validateCounts(value.counts, label + '.counts')
  for (const key of ['request_body_sha256', 'response_body_sha256', 'attachment_sha256']) hash(value[key], label + '.' + key)
  expect(value.stages.tool_return_ms <= value.total_ms, label + ' total precedes Tool return')
  expect(value.stages.job_terminal_ms <= value.total_ms, label + ' total precedes Job terminal')
}

export function validateLowerMeasurement(value, label = 'lower_bound') { validateLower(value, label); return value }
export function validateDirectMeasurement(value, label = 'assembled') { validateAssembled(value, label); return value }

function validateComparisonScenario(name, scenario, fixtures, native = false) {
  const expected = COMPARISON_SCENARIOS[name]
  exactKeys(scenario, ['kind', 'warmups', 'pairs', 'threshold', 'samples', 'percentiles'], name)
  expect(scenario.kind === 'lower-bound-vs-assembled', name + ' kind')
  expect(scenario.warmups === expected.warmups && scenario.pairs === expected.pairs, name + ' protocol counts')
  expect(JSON.stringify(scenario.threshold) === JSON.stringify(expected), name + ' threshold contract')
  expect(Array.isArray(scenario.samples) && scenario.samples.length === expected.pairs, name + ' sample count')
  scenario.samples.forEach((sample, index) => {
    exactKeys(sample, ['index', 'order', 'lower_bound', 'assembled'], name + '.samples[' + index + ']')
    expect(sample.index === index + 1, name + ' sample index')
    expect(sample.order === (index % 4 === 0 || index % 4 === 3 ? 'lower-bound-first' : 'assembled-first'), name + ' ABBA order')
    validateLower(sample.lower_bound, name + '.samples[' + index + '].lower_bound')
    validateAssembled(sample.assembled, name + '.samples[' + index + '].assembled')
    expect(sample.assembled.execution_contract === (native ? NATIVE_EXECUTION : undefined), name + ' execution contract mismatch')
    expect(sample.lower_bound.request_body_sha256 === sha256(native ? NATIVE_REQUEST_BODY : REQUEST_BODY) && sample.assembled.request_body_sha256 === sha256(native ? NATIVE_REQUEST_BODY : REQUEST_BODY), name + ' request body changed')
    const fixture = fixtures[name.endsWith('max') ? 'max' : 'small']
    expect(sample.lower_bound.response_body_sha256 === fixture.response_body_sha256 && sample.assembled.response_body_sha256 === fixture.response_body_sha256, name + ' response body changed')
    expect(sample.lower_bound.attachment_sha256 === fixture.sha256 && sample.assembled.attachment_sha256 === fixture.sha256, name + ' attachment changed')
  })
  const calculated = comparisonSummary(scenario.samples, expected)
  exactKeys(scenario.percentiles, ['lower_bound', 'assembled', 'allowed', 'pass'], name + '.percentiles')
  for (const group of ['lower_bound', 'assembled', 'allowed']) {
    exactKeys(scenario.percentiles[group], ['p95_ms', 'p99_ms'], name + '.percentiles.' + group)
    sameNumber(scenario.percentiles[group].p95_ms, calculated[group].p95_ms, name + ' p95')
    sameNumber(scenario.percentiles[group].p99_ms, calculated[group].p99_ms, name + ' p99')
  }
  expect(scenario.percentiles.pass === calculated.pass, name + ' threshold result')
}

function validateHistoryScenario(scenario, fixtures, native = false) {
  const name = 'history-0-vs-256'
  exactKeys(scenario, ['kind', 'warmups', 'pairs', 'receipts', 'bounds', 'samples', 'percentiles'], name)
  expect(scenario.kind === 'paired-history-slope', name + ' kind')
  expect(scenario.warmups === 0 && scenario.pairs === 30, name + ' protocol counts')
  expect(JSON.stringify(scenario.receipts) === JSON.stringify([0, 256]), name + ' receipt strata')
  expect(JSON.stringify(scenario.bounds) === JSON.stringify({ p95_ms: 75, p99_ms: 150 }), name + ' bounds')
  expect(Array.isArray(scenario.samples) && scenario.samples.length === 30, name + ' sample count')
  scenario.samples.forEach((sample, index) => {
    exactKeys(sample, ['index', 'order', 'empty', 'loaded', 'delta_ms'], name + '.samples[' + index + ']')
    expect(sample.index === index + 1, name + ' sample index')
    expect(sample.order === (index % 4 === 0 || index % 4 === 3 ? 'empty-first' : 'loaded-first'), name + ' ABBA order')
    validateAssembled(sample.empty, name + '.samples[' + index + '].empty')
    validateAssembled(sample.loaded, name + '.samples[' + index + '].loaded')
    expect(sample.empty.execution_contract === (native ? NATIVE_EXECUTION : undefined) && sample.loaded.execution_contract === (native ? NATIVE_EXECUTION : undefined), name + ' execution contract mismatch')
    expect(sample.empty.response_body_sha256 === fixtures.small.response_body_sha256 && sample.loaded.response_body_sha256 === fixtures.small.response_body_sha256, name + ' response body changed')
    expect(sample.empty.attachment_sha256 === fixtures.small.sha256 && sample.loaded.attachment_sha256 === fixtures.small.sha256, name + ' attachment changed')
    sameNumber(sample.delta_ms, sample.loaded.total_ms - sample.empty.total_ms, name + ' paired delta')
  })
  const calculated = historySummary(scenario.samples)
  exactKeys(scenario.percentiles, ['delta', 'pass'], name + '.percentiles')
  exactKeys(scenario.percentiles.delta, ['p95_ms', 'p99_ms'], name + '.percentiles.delta')
  sameNumber(scenario.percentiles.delta.p95_ms, calculated.delta.p95_ms, name + ' p95')
  sameNumber(scenario.percentiles.delta.p99_ms, calculated.delta.p99_ms, name + ' p99')
  expect(scenario.percentiles.pass === calculated.pass, name + ' threshold result')
}

function rejectSensitiveKeys(value, label = 'evidence') {
  const forbidden = /^(?:prompt|prompt_text|image|image_bytes|b64_json|base64|api_key|authorization|secret|credentials?|logs?|screenshots?|videos?|installers?|absolute_path)$/iu
  if (Array.isArray(value)) return value.forEach((entry, index) => rejectSensitiveKeys(entry, label + '[' + index + ']'))
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    expect(!forbidden.test(key), label + ' contains forbidden field ' + key)
    rejectSensitiveKeys(child, label + '.' + key)
  }
}


function validateAdmissionRetryProbe(probe, fixtures) {
  exactKeys(probe, ['retry_after_ms', 'identical_request_scope', 'measurement', 'pass'], 'admission_retry_probe')
  expect(probe.retry_after_ms === 1000 && probe.identical_request_scope === true, 'admission retry scope contract')
  const value = probe.measurement
  exactKeys(value, ['total_ms', 'stages', 'counts', 'request_body_sha256', 'response_body_sha256', 'attachment_sha256'], 'admission_retry_probe.measurement')
  finite(value.total_ms, 'admission_retry_probe.total_ms')
  for (const key of ['request_body_sha256', 'response_body_sha256', 'attachment_sha256']) hash(value[key], 'admission_retry_probe.' + key)
  validateStages(value.stages, ASSEMBLED_STAGE_KEYS, 'admission_retry_probe.stages')
  exactKeys(value.counts, COUNT_KEYS, 'admission_retry_probe.counts')
  for (const key of COUNT_KEYS) integer(value.counts[key], 'admission_retry_probe.counts.' + key)
  expect(value.counts.subagent_starts === 0 && value.counts.batch_events === 0, 'admission retry entered batch/subagent path')
  expect(value.counts.jobs === 1 && value.counts.provider_posts === 1 && value.counts.cas_saves === 1 && value.counts.terminal_receipts === 1, 'admission retry direct operation counts')
  expect(value.counts.attempts === 2, 'admission retry must use exactly two identical gateway attempts')
  expect(value.counts.admission_wait_ms >= 999 && value.counts.admission_wait_ms <= 5000, 'admission retry wait is outside the bounded timer tolerance')
  expect(value.request_body_sha256 === sha256(REQUEST_BODY), 'admission retry request body changed')
  expect(value.response_body_sha256 === fixtures.small.response_body_sha256 && value.attachment_sha256 === fixtures.small.sha256, 'admission retry result changed')
  const pass = value.counts.attempts === 2 && value.counts.provider_posts === 1
    && value.counts.admission_wait_ms >= 999 && value.counts.admission_wait_ms <= 5000
  expect(probe.pass === pass, 'admission retry pass arithmetic')
}

export function validateNativeAdmissionFailure(probe) {
  exactKeys(probe, ['status', 'attempts', 'provider_posts', 'cas_saves', 'terminal_receipts', 'terminal_status', 'job_terminal_status', 'repeated_call_rejected', 'duplicate_provider_generation', 'pass'], 'native admission failure')
  expect(probe.status === 'SUPERSEDED_BY_NATIVE_SAFE_FAILURE', 'native admission mechanism')
  expect(probe.attempts === 1 && probe.provider_posts === 0 && probe.cas_saves === 0 && probe.terminal_receipts === 1, 'native 429 must fail once without retry or fabricated image')
  expect(probe.terminal_status === 'failed' && probe.job_terminal_status === 'failed', 'native rejection must settle failed')
  expect(probe.repeated_call_rejected === true && probe.duplicate_provider_generation === 0 && probe.pass === true, 'native rejection must not resubmit the same call')
  return probe
}

export function validateWorkerReport(report) {
  exactKeys(report, ['schema_version', 'ticket', 'claim', 'repetition', 'protocol', 'provenance', 'runtime', 'model', 'attachment_limits', 'fixtures', 'prompt_sha256', 'request_body_sha256', 'network_calls', 'scenarios', 'admission_retry_probe', 'pass'], 'worker')
  const native = versionFor(report.ticket, '108') === RELEASE_VERSION
  expect(report.schema_version === (native ? 2 : 1) && report.claim === CLAIM, 'worker identity: historical cohort cannot close native execution')
  integer(report.repetition, 'worker.repetition', 1)
  expect(report.repetition <= REPETITIONS, 'worker repetition bound')
  exactKeys(report.protocol, ['fake_delay_ms', 'repetitions', 'clock', 'percentile', 'ordering', 'filesystem', ...(native ? ['execution_contract'] : [])], 'worker.protocol')
  if (native) expect(report.protocol.execution_contract === NATIVE_EXECUTION, 'worker native execution contract')
  expect(report.protocol.fake_delay_ms === 25 && report.protocol.repetitions === 3, 'worker protocol constants')
  expect(report.protocol.clock === 'performance.now monotonic' && report.protocol.percentile === 'nearest-rank-per-repetition' && report.protocol.ordering === 'interleaved-ABBA' && report.protocol.filesystem === 'same-worker-temp-volume', 'worker protocol labels')
  exactKeys(report.provenance, ['emate_commit', 'harness_commit', 'module_sha256'], 'worker.provenance')
  gitCommit(report.provenance.emate_commit, 'worker.provenance.emate_commit')
  expect(report.provenance.harness_commit === HARNESS_COMMIT, 'worker Harness commit')
  record(report.provenance.module_sha256, 'worker.provenance.module_sha256')
  expect(Object.keys(report.provenance.module_sha256).length >= 5, 'worker module hash coverage')
  for (const [key, value] of Object.entries(report.provenance.module_sha256)) hash(value, 'worker module ' + key)
  exactKeys(report.runtime, ['node', 'v8', 'platform', 'arch'], 'worker.runtime')
  expect(report.model === (native ? NATIVE_MODEL : MODEL), 'worker image model')
  expect(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(report.runtime.node), 'worker Node version')
  expect(/^\d+(?:\.\d+){1,4}(?:-[0-9A-Za-z.-]+)?$/u.test(report.runtime.v8), 'worker V8 version')
  expect(['darwin', 'linux', 'win32'].includes(report.runtime.platform), 'worker platform')
  expect(['arm64', 'x64'].includes(report.runtime.arch), 'worker architecture')
  expect(JSON.stringify(report.attachment_limits) === JSON.stringify(ATTACHMENT_LIMITS), 'worker attachment limits')
  exactKeys(report.fixtures, ['small', 'max'], 'worker.fixtures')
  for (const [name, fixture] of Object.entries(report.fixtures)) {
    exactKeys(fixture, ['sha256', 'bytes', 'media_type', 'response_body_sha256'], 'worker.fixtures.' + name)
    hash(fixture.sha256, 'worker fixture ' + name)
    hash(fixture.response_body_sha256, 'worker response fixture ' + name)
    integer(fixture.bytes, 'worker fixture bytes ' + name, 1)
    expect(fixture.media_type === 'image/png', 'worker fixture media type')
  }
  expect(report.fixtures.max.bytes >= Math.floor(5 * 1024 * 1024 * 0.99) && report.fixtures.max.bytes <= 5 * 1024 * 1024, 'max fixture size')
  hash(report.prompt_sha256, 'worker.prompt_sha256')
  expect(report.prompt_sha256 === sha256(NORMALIZED_PROMPT), 'normalized prompt hash')
  hash(report.request_body_sha256, 'worker.request_body_sha256')
  expect(report.request_body_sha256 === sha256(native ? NATIVE_REQUEST_BODY : REQUEST_BODY), 'request body hash')
  expect(report.network_calls === 0, 'network use is forbidden')
  exactKeys(report.scenarios, SCENARIO_NAMES, 'worker.scenarios')
  for (const name of Object.keys(COMPARISON_SCENARIOS)) validateComparisonScenario(name, report.scenarios[name], report.fixtures, native)
  validateHistoryScenario(report.scenarios['history-0-vs-256'], report.fixtures, native)
  if (native) validateNativeAdmissionFailure(report.admission_retry_probe)
  else validateAdmissionRetryProbe(report.admission_retry_probe, report.fixtures)
  const pass = SCENARIO_NAMES.every(name => report.scenarios[name].percentiles.pass) && report.admission_retry_probe.pass
  expect(report.pass === pass, 'worker aggregate pass')
  rejectSensitiveKeys(report)
  return report
}

export function validateAggregate(report) {
  exactKeys(report, ['schema_version', 'ticket', 'claim', 'repetitions', 'all_repetitions_pass'], 'aggregate')
  expect(report.schema_version === (versionFor(report.ticket, '108') === RELEASE_VERSION ? 2 : 1) && report.claim === CLAIM, 'aggregate identity: historical cohort cannot close native execution')
  expect(Array.isArray(report.repetitions) && report.repetitions.length === 3, 'aggregate must contain exactly three repetitions')
  report.repetitions.forEach((entry, index) => {
    validateWorkerReport(entry)
    expect(entry.ticket === report.ticket, 'aggregate release identities differ')
    expect(entry.repetition === index + 1, 'aggregate repetition order')
  })
  const first = report.repetitions[0]
  for (const entry of report.repetitions.slice(1)) {
    expect(entry.provenance.emate_commit === first.provenance.emate_commit, 'aggregate e-Mate provenance mismatch')
    expect(JSON.stringify(entry.provenance.module_sha256) === JSON.stringify(first.provenance.module_sha256), 'aggregate module provenance mismatch')
    expect(JSON.stringify(entry.runtime) === JSON.stringify(first.runtime), 'aggregate runtime mismatch')
    expect(entry.model === first.model, 'aggregate model mismatch')
    expect(JSON.stringify(entry.attachment_limits) === JSON.stringify(first.attachment_limits), 'aggregate attachment limits mismatch')
    expect(JSON.stringify(entry.fixtures) === JSON.stringify(first.fixtures), 'aggregate fixture mismatch')
    expect(entry.prompt_sha256 === first.prompt_sha256, 'aggregate prompt hash mismatch')
    expect(entry.request_body_sha256 === first.request_body_sha256, 'aggregate request mismatch')
  }
  expect(report.all_repetitions_pass === report.repetitions.every(entry => entry.pass), 'aggregate pass arithmetic')
  rejectSensitiveKeys(report)
  return report
}


export function validateDirectProductSource(source) {
  expect(typeof source === 'string' && source.length > 0, 'product source is missing')
  expect(!/EMATE_(?:IMAGE_)?BENCHMARK|single-image-latency|benchmarkMode|benchmarkFlag|BENCHMARK_DELAY/u.test(source), 'product benchmark sleep or flag is forbidden')
  for (const owner of ['registerAgentImageTools', 'ctx.jobs.start', 'ctx.attachments.saveImage', 'renderTaskResult', 'imagePresentationMeta']) expect(source.includes(owner), 'native image owner is missing: ' + owner)
  expect(!/agent\/pre-step|subagents?\.start|name: ['"]image_batch['"]/u.test(source), 'native image plugin cannot restore catalog, batch or subagent execution')
  expect(source.includes("return [{ type: 'text', text: JSON.stringify(value) }]"), 'model-facing generation result must remain textual')
  return true
}


function aggregateOperationCounts(aggregate) {
  const totals = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]))
  let direct_samples = 0
  for (const repetition of aggregate.repetitions) {
    const measurements = []
    for (const name of Object.keys(COMPARISON_SCENARIOS)) measurements.push(...repetition.scenarios[name].samples.map(sample => sample.assembled))
    for (const sample of repetition.scenarios['history-0-vs-256'].samples) measurements.push(sample.empty, sample.loaded)
    if (repetition.schema_version === 1) measurements.push(repetition.admission_retry_probe.measurement)
    direct_samples += measurements.length
    for (const measurement of measurements) for (const key of COUNT_KEYS) totals[key] += measurement.counts[key]
  }
  return { direct_samples, ...totals }
}

function aggregateManifestProjection(aggregate) {
  const first = aggregate.repetitions[0]
  return {
    provenance: {
      ...first.provenance,
      runtime: first.runtime,
      model: first.model,
      attachment_limits: first.attachment_limits,
      fixtures: first.fixtures,
      prompt_sha256: first.prompt_sha256,
      request_body_sha256: first.request_body_sha256,
    },
    results: {
      fresh_processes: aggregate.repetitions.length,
      all_repetitions_pass: aggregate.all_repetitions_pass,
      scenario_percentiles: Object.fromEntries(SCENARIO_NAMES.map(name => [name, aggregate.repetitions.map(entry => entry.scenarios[name].percentiles)])),
      admission_retry_probes: aggregate.repetitions.map(entry => entry.admission_retry_probe),
      operation_counts: aggregateOperationCounts(aggregate),
    },
  }
}


export function createSourcePassManifest(aggregate, externalUri, rawAggregate) {
  validateAggregate(aggregate)
  expect(aggregate.all_repetitions_pass === true, 'SOURCE_PASS requires every repetition to pass')
  const raw = typeof rawAggregate === 'string' ? Buffer.from(rawAggregate) : Buffer.from(rawAggregate)
  const projected = aggregateManifestProjection(aggregate)
  const manifest = {
    schema_version: 1,
    ticket: aggregate.ticket,
    status: 'SOURCE_PASS',
    contract: evidenceContract(aggregate.ticket),
    claim: CLAIM,
    protocol: { fake_delay_ms: 25, fresh_processes: 3, percentile: 'nearest-rank-per-repetition', all_repetitions_must_pass: true },
    provenance: projected.provenance,
    results: projected.results,
    external_raw: { uri: externalUri, sha256: sha256(raw) },
    gui_first_visible: { status: 'OPEN', environment: null, p95_limit_ms: 500, p95_ms: null, sample_count: null, evidence_uri: null, sha256: null },
  }
  validateManifest(manifest, raw)
  return manifest
}

export function validateGuiEvidence(rawGui, descriptor) {
  evidenceDescriptor(descriptor.uri, descriptor.sha256, 'GUI evidence')
  const value = exactRaw(rawGui, descriptor.sha256, 'GUI evidence')
  exactKeys(value, ['schema_version', 'ticket', 'claim', 'protocol', 'provenance', 'environment', 'measured_at', 'samples', 'p95_ms'], 'GUI evidence')
  expect(value.schema_version === 1 && Boolean(versionFor(value.ticket, '108')) && value.claim === 'macos-dev-cached-terminal-projection-first-visible-v1', 'GUI evidence identity')
  expect(JSON.stringify(value.protocol) === JSON.stringify({ clock: 'performance.now monotonic', stimulus: 'cached-local-bytes', start: 'terminal-projection-handoff', end: 'first-visible-image', percentile: 'nearest-rank', minimum_samples: 100, p95_limit_ms: 500 }), 'GUI evidence protocol')
  exactKeys(value.provenance, ['emate_commit', 'harness_commit', 'desktop_reference', 'version'], 'GUI evidence provenance')
  gitCommit(value.provenance.emate_commit, 'GUI evidence provenance commit')
  expect(value.provenance.harness_commit === HARNESS_COMMIT && value.provenance.desktop_reference === DESKTOP_REFERENCE && value.provenance.version === versionFor(value.ticket, '108'), 'GUI evidence provenance mismatch')
  exactKeys(value.environment, ['class', 'machine_sha256', 'app_bundle_sha256'], 'GUI evidence environment')
  expect(value.environment.class === 'macos-app-directory-dev', 'GUI evidence must remain macOS app-directory/dev')
  hash(value.environment.machine_sha256, 'GUI evidence machine hash'); hash(value.environment.app_bundle_sha256, 'GUI evidence app bundle hash')
  expect(typeof value.measured_at === 'string' && Number.isFinite(Date.parse(value.measured_at)), 'GUI evidence timestamp')
  expect(Array.isArray(value.samples) && value.samples.length >= 100 && value.samples.length <= 10_000, 'GUI evidence requires 100..10000 samples')
  const ids = new Set()
  for (const sample of value.samples) {
    exactKeys(sample, ['sample', 'latency_ms'], 'GUI sample')
    integer(sample.sample, 'GUI sample index', 1); expect(!ids.has(sample.sample), 'GUI sample IDs must be unique'); ids.add(sample.sample)
    finite(sample.latency_ms, 'GUI sample latency')
  }
  sameNumber(value.p95_ms, nearestRank(value.samples.map(sample => sample.latency_ms), 0.95), 'GUI p95')
  expect(value.p95_ms <= 500, 'GUI first-visible p95 exceeds 500 ms')
  rejectSensitiveKeys(value)
  return value
}

export function createPassManifest(aggregate, sourceUri, rawAggregate, rawGui, guiUri) {
  const manifest = createSourcePassManifest(aggregate, sourceUri, rawAggregate)
  const guiDescriptor = { uri: guiUri, sha256: sha256(typeof rawGui === 'string' ? Buffer.from(rawGui) : rawGui) }
  const gui = validateGuiEvidence(rawGui, guiDescriptor)
  expect(gui.ticket === manifest.ticket && gui.provenance.emate_commit === manifest.provenance.emate_commit, 'GUI and source evidence identities or commits differ')
  manifest.status = 'PASS'
  manifest.gui_first_visible = { status: 'PASS', environment: gui.environment, p95_limit_ms: 500, p95_ms: gui.p95_ms,
    sample_count: gui.samples.length, evidence_uri: guiUri, sha256: guiDescriptor.sha256 }
  validateManifest(manifest, rawAggregate, rawGui)
  return manifest
}

export function validateManifest(manifest, rawAggregate, rawGui) {
  exactKeys(manifest, ['schema_version', 'ticket', 'status', 'contract', 'claim', 'protocol', 'provenance', 'results', 'external_raw', 'gui_first_visible'], 'manifest')
  expect(manifest.schema_version === 1 && Boolean(versionFor(manifest.ticket, '108')) && manifest.claim === CLAIM, 'manifest identity')
  expect(manifest.contract === evidenceContract(manifest.ticket), 'manifest contract path')
  expect(['OPEN', 'SOURCE_PASS', 'PASS'].includes(manifest.status), 'manifest status')
  expect(JSON.stringify(manifest.protocol) === JSON.stringify({ fake_delay_ms: 25, fresh_processes: 3, percentile: 'nearest-rank-per-repetition', all_repetitions_must_pass: true }), 'manifest protocol')
  exactKeys(manifest.external_raw, ['uri', 'sha256'], 'manifest.external_raw')
  exactKeys(manifest.gui_first_visible, ['status', 'environment', 'p95_limit_ms', 'p95_ms', 'sample_count', 'evidence_uri', 'sha256'], 'manifest.gui_first_visible')
  const guiOpen = { status: 'OPEN', environment: null, p95_limit_ms: 500, p95_ms: null, sample_count: null, evidence_uri: null, sha256: null }
  if (manifest.status === 'OPEN') {
    expect(manifest.provenance === null && manifest.results === null, 'OPEN manifest cannot claim results')
    expect(manifest.external_raw.uri === null && manifest.external_raw.sha256 === null, 'OPEN manifest cannot claim raw evidence')
    expect(JSON.stringify(manifest.gui_first_visible) === JSON.stringify(guiOpen), 'OPEN manifest cannot claim GUI evidence')
  } else {
    record(manifest.provenance, 'manifest.provenance')
    gitCommit(manifest.provenance.emate_commit, 'manifest.provenance.emate_commit')
    expect(manifest.provenance.harness_commit === HARNESS_COMMIT, 'manifest Harness commit')
    evidenceDescriptor(manifest.external_raw.uri, manifest.external_raw.sha256, 'manifest external raw')
    expect(typeof rawAggregate === 'string' || rawAggregate instanceof Uint8Array, 'SOURCE_PASS manifest requires the exact raw aggregate bytes')
    const aggregate = exactRaw(rawAggregate, manifest.external_raw.sha256, 'manifest external')
    validateAggregate(aggregate)
    expect(aggregate.ticket === manifest.ticket, 'manifest and raw evidence release identities differ')
    expect(aggregate.all_repetitions_pass === true, 'manifest raw aggregate did not pass every repetition')
    const expected = aggregateManifestProjection(aggregate)
    expect(JSON.stringify(manifest.provenance) === JSON.stringify(expected.provenance), 'manifest provenance does not match raw aggregate')
    expect(JSON.stringify(manifest.results) === JSON.stringify(expected.results), 'manifest results do not match raw aggregate')
    if (manifest.status === 'SOURCE_PASS') expect(JSON.stringify(manifest.gui_first_visible) === JSON.stringify(guiOpen), 'SOURCE_PASS cannot claim GUI evidence')
    else {
      expect(manifest.gui_first_visible.status === 'PASS' && manifest.gui_first_visible.p95_limit_ms === 500, 'PASS requires GUI evidence')
      const descriptor = { uri: manifest.gui_first_visible.evidence_uri, sha256: manifest.gui_first_visible.sha256 }
      const gui = validateGuiEvidence(rawGui, descriptor)
      expect(gui.ticket === manifest.ticket && gui.provenance.emate_commit === manifest.provenance.emate_commit, 'GUI and source evidence identities or commits differ')
      expect(JSON.stringify(manifest.gui_first_visible) === JSON.stringify({ status: 'PASS', environment: gui.environment, p95_limit_ms: 500,
        p95_ms: gui.p95_ms, sample_count: gui.samples.length, evidence_uri: descriptor.uri, sha256: descriptor.sha256 }), 'manifest GUI projection mismatch')
    }
  }
  rejectSensitiveKeys(manifest)
  return manifest
}

export function createOpenManifest() {
  return validateManifest({ schema_version: 1, ticket: TICKET, status: 'OPEN', contract: evidenceContract(TICKET), claim: CLAIM,
    protocol: { fake_delay_ms: 25, fresh_processes: 3, percentile: 'nearest-rank-per-repetition', all_repetitions_must_pass: true },
    provenance: null, results: null, external_raw: { uri: null, sha256: null },
    gui_first_visible: { status: 'OPEN', environment: null, p95_limit_ms: 500, p95_ms: null, sample_count: null, evidence_uri: null, sha256: null } })
}
