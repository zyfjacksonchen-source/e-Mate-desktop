import { RELEASE_VERSION, ticketFor, versionFor, minimumQualityPairs } from '../../performance/image-batch/release-identity.mjs'
export { RELEASE_VERSION }
export const TICKET = ticketFor(RELEASE_VERSION, '503')
import { createHash } from 'node:crypto'

const CATEGORIES = Object.freeze(['person', 'text', 'product', 'scene', 'style', 'reference-edit'])
const BASE_DIMENSIONS = Object.freeze(['prompt_adherence', 'detail', 'composition'])
const ALL_DIMENSIONS = Object.freeze([...BASE_DIMENSIONS, 'text', 'reference_consistency'])
const SHA256 = /^[0-9a-f]{64}$/u
const CI_CRITICAL_VALUE = 1.959963984540054 // Fixed standard-normal critical value for a deterministic two-sided 95% CI.
const OVERALL_MEAN_MARGIN = -0.2
const CI_LOWER_MARGIN = -0.3
const MAX_RAW_BYTES = 4 * 1024 * 1024
const MAX_PAIRS = 1000
export const HARNESS_COMMIT = '8cc7914c51a063cd2b851a9eb956c72b4c16471b'
export const DESKTOP_REFERENCE = '166c16cfc38c51d32c2316715548c0f8271db517'

function fail(message) { throw new Error(message) }
function require(condition, message) { if (!condition) fail(message) }
function exactKeys(value, keys, label) {
  require(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  require(actual.length === expected.length && actual.every((key, index) => key === expected[index]), label + ' fields mismatch')
}
function finite(value, label) { require(Number.isFinite(value), label + ' must be finite') }
function hash(value, label) { require(typeof value === 'string' && SHA256.test(value), label + ' must be lowercase SHA-256') }
function commit(value, label) { require(typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value), label + ' must be a lowercase 40-hex commit') }
function sameArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
}
function identifier(value, label) {
  require(typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value), label + ' must be a bounded identifier')
}
export function applicableDimensions(category) {
  return category === 'text' ? [...BASE_DIMENSIONS, 'text']
    : category === 'reference-edit' ? [...BASE_DIMENSIONS, 'reference_consistency']
      : [...BASE_DIMENSIONS]
}
function evidenceDescriptor(value, label = 'raw evidence') {
  exactKeys(value, ['uri', 'sha256'], label)
  hash(value.sha256, label + ' hash')
  require(typeof value.uri === 'string', label + ' URI is invalid')
  let uri
  try { uri = new URL(value.uri) } catch { fail(label + ' URI is invalid') }
  require(uri.protocol === 'https:' && uri.hostname.length > 0 && uri.pathname.length > 1, label + ' requires HTTPS with nonempty host and path')
  require(uri.username === '' && uri.password === '' && uri.search === '' && uri.hash === '', label + ' URI must not contain credentials, query, or fragment')
  require(uri.pathname.includes(value.sha256), label + ' URI path must contain the exact raw hash')
  return value
}
function provenance(value) {
  exactKeys(value, ['emate_commit', 'harness_commit', 'desktop_reference', 'version'], 'provenance')
  commit(value.emate_commit, 'e-Mate commit')
  require(value.harness_commit === HARNESS_COMMIT && value.desktop_reference === DESKTOP_REFERENCE && Boolean(ticketFor(value.version, '503')), 'release provenance mismatch')
}
function environment(value) {
  exactKeys(value, ['layer', 'environment_name_sha256', 'gateway_origin_sha256', 'deployment_fingerprint_sha256'], 'environment')
  require(value.layer === 'production-provider', 'quality study requires the production provider environment')
  for (const key of ['environment_name_sha256', 'gateway_origin_sha256', 'deployment_fingerprint_sha256']) hash(value[key], 'environment ' + key)
}
function rawBytes(raw) {
  require(typeof raw === 'string' || raw instanceof Uint8Array, 'raw study must be exact UTF-8 text or bytes')
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  require(bytes.byteLength > 0 && bytes.byteLength <= MAX_RAW_BYTES, 'raw study exceeds the 4 MiB bound')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('raw study must be valid UTF-8') }
  return { bytes, text }
}
function scanSensitive(value, trail = []) {
  if (Array.isArray(value)) return value.forEach((child, index) => scanSensitive(child, [...trail, String(index)]))
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') require(!/^(?:file:)?\/\/|\/Users\/|[A-Za-z]:\\/u.test(value), 'local path is forbidden at ' + trail.join('.'))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
    require(!['task', 'call', 'provider'].some(prefix => compact.startsWith(prefix) && compact.endsWith('id')), 'operational ID is forbidden: ' + key)
    require(!/(?:credential|secret|token|password|imagebytes|sourcebytes|screenshot|video|installer|log)$/u.test(compact), 'sensitive field is forbidden: ' + key)
    if (compact.includes('prompt') && compact !== 'promptadherence') require(compact.endsWith('hash'), 'prompt content is forbidden: ' + key)
    scanSensitive(child, [...trail, key])
  }
}

// Canonical allocation serialization is UTF-8 JSON.stringify of the raw pair order,
// retaining exactly pair_id, A, B, and commitment_sha256 in that property order.
export function canonicalAllocationBytes(pairs) {
  return JSON.stringify(pairs.map(pair => ({
    pair_id: pair.pair_id,
    A: pair.allocation.A,
    B: pair.allocation.B,
    commitment_sha256: pair.allocation.commitment_sha256,
  })))
}

// For observations x_i, CI = mean(x) +/- 1.959963984540054 * s/sqrt(n),
// where s = sqrt(sum((x_i - mean)^2)/(n - 1)). The fixed normal critical
// value makes calculation deterministic; the protocol requires >=5 per category.
export function summarize(values) {
  require(Array.isArray(values) && values.length >= 2, 'CI requires at least two observations')
  values.forEach((value, index) => finite(value, 'observation ' + index))
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  const halfWidth = CI_CRITICAL_VALUE * Math.sqrt(variance / values.length)
  return { n: values.length, mean, ci95: { lower: mean - halfWidth, upper: mean + halfWidth } }
}

export function validateAndAnalyzeStudy(raw, descriptor) {
  const exactRaw = rawBytes(raw)
  evidenceDescriptor(descriptor)
  require(createHash('sha256').update(exactRaw.bytes).digest('hex') === descriptor.sha256, 'raw evidence hash does not match exact bytes')
  let record
  try { record = JSON.parse(exactRaw.text) } catch { fail('raw study must be valid JSON') }

  exactKeys(record, ['schema_version', 'provenance', 'environment', 'protocol', 'pairs'], 'study')
  require(record.schema_version === 1, 'unsupported study schema')
  provenance(record.provenance)
  environment(record.environment)
  const protocol = record.protocol
  exactKeys(protocol, ['minimum_pairs', 'maximum_pairs', 'minimum_per_category', 'categories', 'dimensions', 'category_dimensions', 'overall_mean_margin', 'ci_lower_margin', 'ci95', 'blinding', 'randomization'], 'protocol')
  require(protocol.minimum_pairs === minimumQualityPairs(record.provenance.version) && protocol.maximum_pairs === MAX_PAIRS, 'pair bounds must match the declared release protocol')
  require(Number.isInteger(protocol.minimum_per_category) && protocol.minimum_per_category >= 5, 'minimum per category must be at least 5')
  require(sameArray(protocol.categories, CATEGORIES), 'six categories must be predeclared')
  require(sameArray(protocol.dimensions, ALL_DIMENSIONS), 'score dimensions must be predeclared')
  exactKeys(protocol.category_dimensions, CATEGORIES, 'category dimensions')
  for (const category of CATEGORIES) require(sameArray(protocol.category_dimensions[category], applicableDimensions(category)), 'applicable dimensions mismatch for ' + category)
  require(protocol.overall_mean_margin === OVERALL_MEAN_MARGIN && protocol.ci_lower_margin === CI_LOWER_MARGIN, 'noninferiority margins changed')
  exactKeys(protocol.ci95, ['method', 'critical_value'], 'CI declaration')
  require(protocol.ci95.method === 'normal-sample-sd-two-sided' && protocol.ci95.critical_value === CI_CRITICAL_VALUE, 'CI declaration changed')
  exactKeys(protocol.blinding, ['concealed_side_labels', 'evaluator_protocol_commitment_sha256'], 'blinding declaration')
  require(sameArray(protocol.blinding.concealed_side_labels, ['A', 'B']), 'side labels must be concealed A/B')
  hash(protocol.blinding.evaluator_protocol_commitment_sha256, 'evaluator protocol commitment')
  exactKeys(protocol.randomization, ['method', 'seed_commitment_sha256', 'allocation_manifest_sha256', 'assigned_before_scoring'], 'randomization declaration')
  require(protocol.randomization.method === 'committed-balanced-random-order-v1', 'randomization method changed')
  require(protocol.randomization.assigned_before_scoring === true, 'allocation must precede scoring')
  hash(protocol.randomization.seed_commitment_sha256, 'seed commitment') // Opaque precommitment only; this does not claim the seed was audited.
  hash(protocol.randomization.allocation_manifest_sha256, 'allocation manifest hash')

  require(Array.isArray(record.pairs) && record.pairs.length >= protocol.minimum_pairs && record.pairs.length <= protocol.maximum_pairs, `pair count must be within ${protocol.minimum_pairs}..1000`)
  const pairIds = new Set()
  const allocationCommitments = new Set()
  const categoryCounts = Object.fromEntries(CATEGORIES.map(category => [category, 0]))
  const categoryBatchOnA = Object.fromEntries(CATEGORIES.map(category => [category, 0]))
  const differences = []
  const byCategory = Object.fromEntries(CATEGORIES.map(category => [category, []]))
  let batchOnA = 0

  for (const pair of record.pairs) {
    exactKeys(pair, ['pair_id', 'category', 'reference_hashes', 'requests', 'artifacts', 'allocation', 'scores'], 'pair')
    identifier(pair.pair_id, 'pair ID')
    require(!pairIds.has(pair.pair_id), 'pair IDs must be unique')
    pairIds.add(pair.pair_id)
    require(CATEGORIES.includes(pair.category), 'unknown category')
    categoryCounts[pair.category] += 1
    require(Array.isArray(pair.reference_hashes) && pair.reference_hashes.length <= 8, 'reference hashes must contain 0..8 entries')
    require(pair.category === 'reference-edit' ? pair.reference_hashes.length >= 1 : pair.reference_hashes.length === 0, 'reference hash/category mismatch')
    pair.reference_hashes.forEach(value => hash(value, 'reference hash'))

    exactKeys(pair.requests, ['single', 'batch'], 'paired requests')
    for (const side of ['single', 'batch']) {
      exactKeys(pair.requests[side], ['model', 'quality', 'size', 'prompt_hash', 'reference_set_hash', 'canonical_provider_request_hash'], side + ' request')
      identifier(pair.requests[side].model, 'model')
      identifier(pair.requests[side].quality, 'quality')
      identifier(pair.requests[side].size, 'size')
      hash(pair.requests[side].prompt_hash, 'prompt hash')
      hash(pair.requests[side].reference_set_hash, 'reference-set hash')
      hash(pair.requests[side].canonical_provider_request_hash, 'canonical provider request hash')
    }
    for (const field of Object.keys(pair.requests.single)) require(pair.requests.single[field] === pair.requests.batch[field], 'paired request mismatch: ' + field)

    exactKeys(pair.artifacts, ['A', 'B'], 'blind artifacts')
    for (const side of ['A', 'B']) {
      exactKeys(pair.artifacts[side], ['sha256'], 'blind artifact ' + side)
      hash(pair.artifacts[side].sha256, 'blind artifact ' + side)
    }

    exactKeys(pair.allocation, ['A', 'B', 'commitment_sha256', 'assigned_before_scoring'], 'allocation')
    require(new Set([pair.allocation.A, pair.allocation.B]).size === 2 && ['single', 'batch'].includes(pair.allocation.A) && ['single', 'batch'].includes(pair.allocation.B), 'allocation must map A/B to opposite conditions')
    require(pair.allocation.assigned_before_scoring === true, 'pair allocation must precede scoring')
    hash(pair.allocation.commitment_sha256, 'allocation commitment')
    require(!allocationCommitments.has(pair.allocation.commitment_sha256), 'allocation commitments must be unique')
    allocationCommitments.add(pair.allocation.commitment_sha256)
    if (pair.allocation.A === 'batch') { batchOnA += 1; categoryBatchOnA[pair.category] += 1 }

    require(Array.isArray(pair.scores) && pair.scores.length >= 2 && pair.scores.length <= 20, 'scores must contain 1..10 evaluators on both sides')
    const applicable = applicableDimensions(pair.category)
    const seen = new Set()
    const evaluators = { A: new Set(), B: new Set() }
    const totals = { single: [], batch: [] }
    for (const score of pair.scores) {
      exactKeys(score, ['evaluator_hash', 'side', 'dimensions'], 'score')
      hash(score.evaluator_hash, 'blind evaluator hash')
      require(score.side === 'A' || score.side === 'B', 'score side must be A or B')
      const scoreKey = score.evaluator_hash + ':' + score.side
      require(!seen.has(scoreKey), 'one score per evaluator/pair/side is required')
      seen.add(scoreKey)
      evaluators[score.side].add(score.evaluator_hash)
      exactKeys(score.dimensions, applicable, 'applicable score dimensions')
      const values = applicable.map(dimension => {
        const value = score.dimensions[dimension]
        finite(value, 'score ' + dimension)
        require(value >= 0 && value <= 5, 'scores must be within 0..5')
        return value
      })
      totals[pair.allocation[score.side]].push(values.reduce((sum, value) => sum + value, 0) / values.length)
    }
    require(evaluators.A.size >= 1 && evaluators.A.size <= 10 && evaluators.A.size === evaluators.B.size && [...evaluators.A].every(value => evaluators.B.has(value)), '1..10 matched evaluator hashes are required per side')
    const sideMean = side => totals[side].reduce((sum, value) => sum + value, 0) / totals[side].length
    const difference = sideMean('batch') - sideMean('single')
    finite(difference, 'paired difference')
    differences.push(difference)
    byCategory[pair.category].push(difference)
  }

  scanSensitive(record) // Structure and collection bounds are proven before this recursive defense-in-depth scan.
  require(createHash('sha256').update(canonicalAllocationBytes(record.pairs)).digest('hex') === protocol.randomization.allocation_manifest_sha256, 'allocation manifest hash mismatch')
  require(Math.abs(batchOnA - (record.pairs.length - batchOnA)) <= 1, 'concealed side order must be globally balanced')
  for (const category of CATEGORIES) {
    require(categoryCounts[category] >= protocol.minimum_per_category, 'category is underrepresented: ' + category)
    require(Math.abs(categoryBatchOnA[category] - (categoryCounts[category] - categoryBatchOnA[category])) <= 1, 'concealed side order must be balanced within category: ' + category)
  }

  const overall = summarize(differences)
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, summarize(byCategory[category])]))
  const passes = summary => summary.mean >= OVERALL_MEAN_MARGIN && summary.ci95.lower >= CI_LOWER_MARGIN
  return {
    status: passes(overall) && CATEGORIES.every(category => passes(categories[category])) ? 'PASS' : 'FAIL',
    pair_count: record.pairs.length,
    overall,
    categories,
    protocol_checks: {
      request_hashes_match: true,
      randomized_concealed_balanced_order: true,
      matched_blind_evaluators: true,
      scores_complete_and_finite: true,
    },
    raw_evidence: { ...descriptor },
    provenance: record.provenance,
    environment: record.environment,
  }
}

export function validateManifest(manifest, raw) {
  exactKeys(manifest, ['schema_version', 'ticket', 'claim', 'status', 'provenance', 'environment', 'raw_evidence', 'result', 'release_gate'], 'manifest')
  require(manifest.schema_version === 1 && Boolean(versionFor(manifest.ticket, '503')), 'manifest identity mismatch')
  require(manifest.claim === 'quality-noninferiority-blind-paired-study', 'manifest claim mismatch')
  exactKeys(manifest.raw_evidence, ['uri', 'sha256'], 'manifest raw evidence')
  if (manifest.status === 'OPEN') {
    require(manifest.release_gate === 'OPEN' && manifest.provenance === null && manifest.environment === null
      && manifest.raw_evidence.uri === null && manifest.raw_evidence.sha256 === null && manifest.result === null, 'OPEN manifest must contain only null evidence')
    scanSensitive(manifest)
    return manifest
  }
  require(manifest.status === 'PASS' && manifest.release_gate === 'PASS', 'only complete PASS may close the manifest')
  evidenceDescriptor(manifest.raw_evidence, 'manifest raw evidence')
  require(raw !== undefined, 'PASS manifest requires exact raw evidence bytes')
  const analysis = validateAndAnalyzeStudy(raw, manifest.raw_evidence)
  require(manifest.ticket === ticketFor(analysis.provenance.version, '503'), 'manifest and raw evidence release identities differ')
  require(analysis.status === 'PASS', 'PASS raw evidence failed its release thresholds')
  provenance(manifest.provenance); environment(manifest.environment)
  require(JSON.stringify(manifest.provenance) === JSON.stringify(analysis.provenance), 'manifest provenance does not match raw evidence')
  require(JSON.stringify(manifest.environment) === JSON.stringify(analysis.environment), 'manifest environment does not match raw evidence')
  const result = manifest.result
  exactKeys(result, ['pair_count', 'overall', 'categories', 'protocol_checks'], 'manifest result')
  require(Number.isInteger(result.pair_count) && result.pair_count >= minimumQualityPairs(analysis.provenance.version) && result.pair_count <= MAX_PAIRS, 'PASS pair count must match the release protocol')
  const validateSummary = (summary, label, minimum) => {
    exactKeys(summary, ['n', 'mean', 'ci95'], label)
    exactKeys(summary.ci95, ['lower', 'upper'], label + ' CI')
    require(Number.isInteger(summary.n) && summary.n >= minimum, label + ' n is insufficient')
    finite(summary.mean, label + ' mean'); finite(summary.ci95.lower, label + ' CI lower'); finite(summary.ci95.upper, label + ' CI upper')
    require(summary.ci95.lower <= summary.mean && summary.mean <= summary.ci95.upper, label + ' CI ordering is invalid')
    require(summary.mean >= OVERALL_MEAN_MARGIN && summary.ci95.lower >= CI_LOWER_MARGIN, label + ' is inferior')
  }
  validateSummary(result.overall, 'overall', minimumQualityPairs(analysis.provenance.version))
  require(result.overall.n === result.pair_count, 'overall n must equal pair count')
  exactKeys(result.categories, CATEGORIES, 'manifest categories')
  let categoryN = 0
  for (const category of CATEGORIES) { validateSummary(result.categories[category], category, 5); categoryN += result.categories[category].n }
  require(categoryN === result.pair_count, 'category counts must sum to pair count')
  exactKeys(result.protocol_checks, ['request_hashes_match', 'randomized_concealed_balanced_order', 'matched_blind_evaluators', 'scores_complete_and_finite'], 'protocol checks')
  require(Object.values(result.protocol_checks).every(value => value === true), 'every protocol check must pass')
  require(JSON.stringify(result) === JSON.stringify({ pair_count: analysis.pair_count, overall: analysis.overall,
    categories: analysis.categories, protocol_checks: analysis.protocol_checks }), 'manifest result is not the exact raw projection')
  scanSensitive(manifest)
  return manifest
}

export function projectManifest(openManifest, raw, descriptor) {
  validateManifest(openManifest)
  require(openManifest.status === 'OPEN', 'projection requires an OPEN manifest')
  const analysis = validateAndAnalyzeStudy(raw, descriptor)
  require(analysis.status === 'PASS', 'only revalidated passing raw evidence can be projected')
  return validateManifest({
    ...openManifest,
    status: 'PASS',
    release_gate: 'PASS',
    provenance: analysis.provenance,
    environment: analysis.environment,
    raw_evidence: { ...descriptor },
    result: {
      pair_count: analysis.pair_count,
      overall: analysis.overall,
      categories: analysis.categories,
      protocol_checks: analysis.protocol_checks,
    },
  }, raw)
}

export const protocolConstants = Object.freeze({ CATEGORIES, ALL_DIMENSIONS, CI_CRITICAL_VALUE, OVERALL_MEAN_MARGIN, CI_LOWER_MARGIN, MAX_RAW_BYTES, MAX_PAIRS })

export function createOpenManifest() {
  return validateManifest({ schema_version: 1, ticket: TICKET, claim: 'quality-noninferiority-blind-paired-study',
    status: 'OPEN', provenance: null, environment: null, raw_evidence: { uri: null, sha256: null }, result: null, release_gate: 'OPEN' })
}
