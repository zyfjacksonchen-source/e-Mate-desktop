import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canonicalAllocationBytes, createOpenManifest, projectManifest, protocolConstants, validateAndAnalyzeStudy, validateManifest } from './noninferiority-protocol.mjs'

const MANIFEST_URL = new URL('../../../docs/2.0.17/evidence-manifests/quality.json', import.meta.url)
const hex = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const categories = protocolConstants.CATEGORIES
const defaultUri = 'https://evidence.invalid/immutable/quality-study.json'

function dimensions(category, value) {
  return Object.fromEntries([
    ['prompt_adherence', value], ['detail', value], ['composition', value],
    ...(category === 'text' ? [['text', value]] : []),
    ...(category === 'reference-edit' ? [['reference_consistency', value]] : []),
  ])
}
function sealAllocations(record) {
  record.protocol.randomization.allocation_manifest_sha256 = hex(canonicalAllocationBytes(record.pairs))
  return record
}
function evidence(record, uri) {
  const raw = JSON.stringify(record)
  const sha256 = hex(raw)
  return { raw, descriptor: { uri: uri ?? `https://evidence.invalid/immutable/${sha256}.json`, sha256 } }
}
function analyze(record = study()) {
  const { raw, descriptor } = evidence(record)
  return validateAndAnalyzeStudy(raw, descriptor)
}
function study({ count = 60, singleScore = 4, batchScore = 4 } = {}) {
  const record = {
    schema_version: 1,
    provenance: { emate_commit: 'a'.repeat(40), harness_commit: '8cc7914c51a063cd2b851a9eb956c72b4c16471b', desktop_reference: '166c16cfc38c51d32c2316715548c0f8271db517', version: '2.0.17' },
    environment: { layer: 'production-provider', environment_name_sha256: hex('production'), gateway_origin_sha256: hex('gateway'), deployment_fingerprint_sha256: hex('deployment') },
    protocol: {
      minimum_pairs: 50,
      maximum_pairs: 1000,
      minimum_per_category: 5,
      categories: [...categories],
      dimensions: [...protocolConstants.ALL_DIMENSIONS],
      category_dimensions: Object.fromEntries(categories.map(category => [category, Object.keys(dimensions(category, 0))])),
      overall_mean_margin: protocolConstants.OVERALL_MEAN_MARGIN,
      ci_lower_margin: protocolConstants.CI_LOWER_MARGIN,
      ci95: { method: 'normal-sample-sd-two-sided', critical_value: protocolConstants.CI_CRITICAL_VALUE },
      blinding: { concealed_side_labels: ['A', 'B'], evaluator_protocol_commitment_sha256: hex('blind-protocol') },
      randomization: {
        method: 'committed-balanced-random-order-v1',
        seed_commitment_sha256: hex('non-secret-seed-commitment'),
        allocation_manifest_sha256: hex('pending-allocation-manifest'),
        assigned_before_scoring: true,
      },
    },
    pairs: Array.from({ length: count }, (_, index) => {
      const pairNumber = index + 1
      const category = categories[index % categories.length]
      const batchOnA = Math.floor(index / categories.length) % 2 === 0
      const request = {
        model: 'opaque-model-class', quality: 'fixed-quality', size: 'fixed-size',
        prompt_hash: hex('prompt-' + pairNumber),
        reference_set_hash: hex(category === 'reference-edit' ? 'reference-set-' + pairNumber : 'empty-reference-set'),
        canonical_provider_request_hash: hex('canonical-request-' + pairNumber),
      }
      const allocation = { A: batchOnA ? 'batch' : 'single', B: batchOnA ? 'single' : 'batch' }
      return {
        pair_id: 'pair-' + String(pairNumber).padStart(4, '0'),
        category,
        reference_hashes: category === 'reference-edit' ? [hex('reference-' + pairNumber)] : [],
        requests: { single: { ...request }, batch: { ...request } },
        artifacts: { A: { sha256: hex('artifact-A-' + pairNumber) }, B: { sha256: hex('artifact-B-' + pairNumber) } },
        allocation: { ...allocation, commitment_sha256: hex('allocation-' + pairNumber), assigned_before_scoring: true },
        scores: [hex('evaluator-one'), hex('evaluator-two')].flatMap(evaluator_hash => ['A', 'B'].map(side => ({
          evaluator_hash, side,
          dimensions: dimensions(category, allocation[side] === 'batch' ? batchScore : singleScore),
        }))),
      }
    }),
  }
  return sealAllocations(record)
}
function expectRejected(base, mutate, { reseal = false, uri } = {}) {
  const value = clone(base)
  mutate(value)
  if (reseal) sealAllocations(value)
  const { raw, descriptor } = evidence(value, uri)
  assert.throws(() => validateAndAnalyzeStudy(raw, descriptor))
}

test('exact metadata-only bytes produce a valid 60-pair PASS without self-contained evidence hash', () => {
  const record = study()
  assert.ok(!Object.hasOwn(record, 'raw_evidence'))
  const result = analyze(record)
  assert.equal(result.status, 'PASS')
  assert.equal(result.pair_count, 60)
  assert.deepEqual(result.overall, { n: 60, mean: 0, ci95: { lower: 0, upper: 0 } })
  assert.deepEqual(Object.fromEntries(Object.entries(result.categories).map(([category, summary]) => [category, summary.n])), Object.fromEntries(categories.map(category => [category, 10])))
})

test('exact raw byte hashing and strict evidence URLs fail closed', () => {
  const encoded = evidence(study())
  assert.throws(() => validateAndAnalyzeStudy(encoded.raw + ' ', encoded.descriptor), /hash/u)
  assert.throws(() => validateAndAnalyzeStudy(encoded.raw, { ...encoded.descriptor, sha256: hex('other-bytes') }), /hash/u)
  for (const uri of [
    'http://evidence.invalid/immutable/raw.json',
    'https://user:pass@evidence.invalid/immutable/raw.json',
    'https://evidence.invalid/immutable/raw.json?revision=1',
    'https://evidence.invalid/immutable/raw.json#fragment',
    'https://evidence.invalid',
    'not-a-url',
  ]) assert.throws(() => validateAndAnalyzeStudy(encoded.raw, { ...encoded.descriptor, uri }))
  assert.throws(() => validateAndAnalyzeStudy(' '.repeat(protocolConstants.MAX_RAW_BYTES + 1), { uri: defaultUri, sha256: hex('oversized') }), /4 MiB/u)
})

test('protocol rejects pair/category bounds, arbitrary allocation hashes, and category imbalance', () => {
  const valid = study()
  const mutations = [
    [value => { value.pairs.length = 49 }, true],
    [value => { value.pairs[1].pair_id = value.pairs[0].pair_id }, true],
    [value => { value.pairs[0].pair_id = 'x'.repeat(129) }, true],
    [value => { value.pairs[0].pair_id = 'bad\u0000id' }, true],
    [value => { value.pairs = value.pairs.filter(pair => pair.category !== 'style' || Number(pair.pair_id.slice(5)) > 36) }, true],
    [value => { value.protocol.minimum_per_category = 4 }, false],
    [value => { value.protocol.categories = value.protocol.categories.slice(0, 5) }, false],
    [value => { value.protocol.randomization.allocation_manifest_sha256 = hex('arbitrary') }, false],
    [value => {
      for (const pair of value.pairs) {
        if (pair.category === 'person') { pair.allocation.A = 'batch'; pair.allocation.B = 'single' }
        if (pair.category === 'text') { pair.allocation.A = 'single'; pair.allocation.B = 'batch' }
      }
    }, true],
  ]
  for (const [mutate, reseal] of mutations) expectRejected(valid, mutate, { reseal })
  const tooMany = study({ count: 1001 })
  const encoded = evidence(tooMany)
  assert.throws(() => validateAndAnalyzeStudy(encoded.raw, encoded.descriptor), /50..1000/u)
})

test('protocol rejects randomization, blinding, operational IDs, and every paired request mismatch', () => {
  const valid = study()
  const mutations = [
    [value => { value.protocol.randomization.assigned_before_scoring = false }, false],
    [value => { value.pairs[0].allocation.assigned_before_scoring = false }, false],
    [value => { value.pairs[0].allocation.commitment_sha256 = value.pairs[1].allocation.commitment_sha256 }, true],
    [value => { value.pairs[0].allocation.score_derived = true }, false],
    [value => { value.pairs[0].allocation.A = 'single'; value.pairs[0].allocation.B = 'single' }, true],
    [value => { value.pairs[0].provider_id = 'forbidden' }, false],
    [value => { value.pairs.find(pair => pair.category === 'reference-edit').reference_hashes = [] }, false],
    [value => { value.pairs.find(pair => pair.category !== 'reference-edit').reference_hashes = [hex('unexpected-reference')] }, false],
    [value => { value.pairs.find(pair => pair.category === 'reference-edit').reference_hashes[0] = 'bad' }, false],
    [value => { value.pairs[0].task_id = 'forbidden' }, false],
    [value => { value.pairs[0].call_id = 'forbidden' }, false],
    [value => { value.raw_evidence = { uri: defaultUri, sha256: hex('self-hash') } }, false],
    [value => { value.protocol.blinding.evaluator_protocol_commitment_sha256 = 'bad' }, false],
    [value => { value.protocol.randomization.seed_commitment_sha256 = 'bad' }, false],
  ]
  for (const [mutate, reseal] of mutations) expectRejected(valid, mutate, { reseal })
  for (const field of ['model', 'quality', 'size', 'prompt_hash', 'reference_set_hash', 'canonical_provider_request_hash']) {
    expectRejected(valid, value => { value.pairs[0].requests.batch[field] = field.endsWith('hash') ? hex('mismatch-' + field) : 'mismatch' })
  }
  for (const field of ['model', 'quality', 'size']) {
    expectRejected(valid, value => { value.pairs[0].requests.single[field] = value.pairs[0].requests.batch[field] = 'x'.repeat(129) })
  }
})

test('protocol rejects incomplete, duplicate, unmatched, excessive, nonfinite, and out-of-range scores', () => {
  const valid = study()
  const textIndex = valid.pairs.findIndex(pair => pair.category === 'text')
  const referenceIndex = valid.pairs.findIndex(pair => pair.category === 'reference-edit')
  const mutations = [
    value => { delete value.pairs[textIndex].scores[0].dimensions.text },
    value => { delete value.pairs[referenceIndex].scores[0].dimensions.reference_consistency },
    value => { value.pairs[0].scores[0].dimensions.detail = Number.NaN },
    value => { value.pairs[0].scores[0].dimensions.detail = 5.01 },
    value => { value.pairs[0].scores[0].dimensions.detail = -0.01 },
    value => { value.pairs[0].scores.push(clone(value.pairs[0].scores[0])) },
    value => { value.pairs[0].scores = value.pairs[0].scores.filter(score => !(score.side === 'B' && score.evaluator_hash === hex('evaluator-two'))) },
    value => { value.pairs[0].scores = [] },
    value => {
      for (let index = 3; index <= 11; index += 1) {
        const evaluator_hash = hex('evaluator-' + index)
        for (const side of ['A', 'B']) value.pairs[0].scores.push({ evaluator_hash, side, dimensions: dimensions(value.pairs[0].category, 4) })
      }
    },
  ]
  for (const mutate of mutations) expectRejected(valid, mutate)
})

test('a true inferior raw sample remains FAIL and caller-supplied analysis cannot close PASS', async () => {
  const failing = evidence(study({ singleScore: 4, batchScore: 3.6 }))
  const result = validateAndAnalyzeStudy(failing.raw, failing.descriptor)
  assert.equal(result.status, 'FAIL')
  assert.ok(result.overall.mean < -0.2)
  const open = JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
  assert.throws(() => projectManifest(open, failing.raw, failing.descriptor))
  assert.throws(() => projectManifest(open, { status: 'PASS', pair_count: 60 }, failing.descriptor))
})

test('tracked manifest stays sanitized OPEN/null and only revalidated raw bytes project future PASS', async () => {
  const source = await readFile(MANIFEST_URL, 'utf8')
  const manifest = validateManifest(JSON.parse(source))
  assert.equal(manifest.status, 'OPEN')
  assert.equal(manifest.release_gate, 'OPEN')
  assert.equal(manifest.result, null)
  assert.deepEqual(manifest.raw_evidence, { uri: null, sha256: null })
  assert.doesNotMatch(source, /https?:\/\/|file:|\/Users\/|[A-Za-z]:\\/u)
  assert.doesNotMatch(source, /prompt|image|source.bytes|screenshot|video|credential|secret|token|password|logs?|installer/iu)

  const encoded = evidence(study())
  const future = projectManifest(manifest, encoded.raw, encoded.descriptor)
  assert.equal(validateManifest(future, encoded.raw).release_gate, 'PASS')
  assert.throws(() => validateManifest(future), /exact raw evidence bytes/u)
  assert.throws(() => projectManifest(manifest, encoded.raw + '\n', encoded.descriptor))
})

test('manifest rejects partial OPEN and incomplete or threshold-missing PASS projections', async () => {
  const open = JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
  const encoded = evidence(study())
  const complete = projectManifest(open, encoded.raw, encoded.descriptor)
  for (const mutate of [
    value => { value.status = 'PASS' }, value => { value.release_gate = 'PASS' },
    value => { value.raw_evidence.sha256 = hex('premature') }, value => { value.result = {} },
  ]) { const value = clone(open); mutate(value); assert.throws(() => validateManifest(value)) }
  for (const mutate of [
    value => { value.raw_evidence.uri = 'https://user@evidence.invalid/raw.json' },
    value => { value.raw_evidence.uri = 'https://evidence.invalid/raw.json?q=1' },
    value => { value.raw_evidence.sha256 = null },
    value => { value.result.pair_count = 49 },
    value => { value.result.overall.n = 59 },
    value => { value.result.overall.mean = -0.201 },
    value => { value.result.overall.ci95.lower = -0.301 },
    value => { value.result.overall.ci95.lower = Number.NaN },
    value => { value.result.categories.person.mean = -0.201 },
    value => { value.result.categories.text.ci95.lower = -0.301 },
    value => { value.result.categories['reference-edit'].n = 4 },
    value => { delete value.result.categories.style },
    value => { value.result.protocol_checks.request_hashes_match = false },
    value => { value.result.protocol_checks.randomized_concealed_balanced_order = false },
    value => { value.result.protocol_checks.matched_blind_evaluators = false },
    value => { value.result.protocol_checks.scores_complete_and_finite = false },
  ]) { const value = clone(complete); mutate(value); assert.throws(() => validateManifest(value, encoded.raw)) }
})


test('2.0.18 accepts 30 balanced pairs across six categories and cannot relabel historical evidence', () => {
  const value = study({ count: 30 })
  value.provenance.version = '2.0.18'
  value.protocol.minimum_pairs = 30
  // Five pairs per category need opposite extra-side allocation in alternate categories.
  for (const pair of value.pairs) if (categories.indexOf(pair.category) % 2 === 1) {
    const previous = pair.allocation.A
    pair.allocation.A = pair.allocation.B; pair.allocation.B = previous
  }
  sealAllocations(value)
  const { raw, descriptor } = evidence(value)
  const pass = projectManifest(createOpenManifest(), raw, descriptor)
  assert.equal(pass.ticket, 'EM218-503')
  assert.equal(pass.result.pair_count, 30)
  assert.equal(pass.result.overall.mean, 0)
  assert.equal(pass.result.overall.ci95.lower, 0)
  const old = evidence(study())
  assert.equal(validateAndAnalyzeStudy(old.raw, old.descriptor).provenance.version, '2.0.17')
  assert.throws(() => projectManifest(createOpenManifest(), old.raw, old.descriptor), /release identities differ/u)
  const mislabeled = structuredClone(value); mislabeled.provenance.version = '2.0.17'
  assert.throws(() => analyze(mislabeled), /pair bounds/u)
})
