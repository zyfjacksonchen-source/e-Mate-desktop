import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { protocolConstants, validateAndAnalyzeStudy } from './noninferiority-protocol.mjs'
import { collectStudy, evaluatorHash, finalizeStudy, prepareStudy } from './real-study.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const categories = protocolConstants.CATEGORIES

function context() {
  return {
    root: new URL('https://production.example/v1'), token: 'private-session-token-value', upstreamModel: 'upstream-image-model',
    provenance: { emate_commit: 'a'.repeat(40), harness_commit: '4da69d7c3522ee51de12822c917c503a124f7a7d', desktop_reference: '6074088f5b660206e404b3591fab51fb99c69add', version: '2.0.18' },
    environment: { layer: 'production-provider', environment_name_sha256: hash('production'), gateway_origin_sha256: hash('https://production.example/v1'), deployment_fingerprint_sha256: hash('deployment') },
  }
}

function dimensions(category, value = 4) {
  return Object.fromEntries([['prompt_adherence', value], ['detail', value], ['composition', value],
    ...(category === 'text' ? [['text', value]] : []), ...(category === 'reference-edit' ? [['reference_consistency', value]] : [])])
}

test('precommit balances A/B before collection; blind packet and finalized raw bind evaluator and artifact hashes', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'emate-em217-503-'))
  try {
    const reference = join(temporary, 'reference.png'); writeFileSync(reference, png, { mode: 0o600 })
    const input = {
      schema_version: 1, evaluator_protocol_commitment_sha256: hash('evaluator protocol v1'),
      cases: Array.from({ length: 30 }, (_, index) => {
        const category = categories[index % categories.length]
        return { pair_id: `pair-${String(index + 1).padStart(3, '0')}`, category,
          prompt: `private test prompt ${index + 1}`, references: category === 'reference-edit' ? Array(index === categories.indexOf('reference-edit') ? 8 : 1).fill(reference) : [] }
      }),
    }
    const state = prepareStudy(input, '1'.repeat(64), context())
    const globalBatchA = state.cases.filter(value => value.allocation.A === 'batch').length
    assert(Math.abs(globalBatchA - (state.cases.length - globalBatchA)) <= 1)
    for (const category of categories) {
      const values = state.cases.filter(value => value.category === category)
      const batchA = values.filter(value => value.allocation.A === 'batch').length
      assert(Math.abs(batchA - (values.length - batchA)) <= 1)
    }
    const stateRaw = JSON.stringify(state) + '\n'; const precommit = hash(stateRaw)
    const output = join(temporary, 'outputs')
    let calls = 0
    const seenBatch = new Map()
    const active = { single: 0, batch: 0 }; const maximum = { single: 0, batch: 0 }
    const packet = await collectStudy(state, precommit, context(), output, async (_url, options) => {
      calls += 1
      const headers = options.headers
      const condition = headers['x-e-mate-batch-id'] ? 'batch' : 'single'
      active[condition]++; maximum[condition] = Math.max(maximum[condition], active[condition])
      await new Promise(resolve => setImmediate(resolve))
      active[condition]--
      if (headers['x-e-mate-batch-id']) {
        const ordinals = seenBatch.get(headers['x-e-mate-batch-id']) ?? []
        ordinals.push(Number(headers['x-e-mate-batch-ordinal'])); seenBatch.set(headers['x-e-mate-batch-id'], ordinals)
      }
      return new Response(JSON.stringify({ id: `result-${calls}`, data: [{ b64_json: png.toString('base64') }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    assert.equal(calls, 60)
    assert.equal(maximum.single, 1)
    assert.equal(maximum.batch, 4)
    assert([...seenBatch.values()].every(ordinals => ordinals.length >= 2 && ordinals.length <= 4 && ordinals.every((ordinal, index) => ordinal === index + 1)))
    assert.equal(Object.hasOwn(packet.pairs[0], 'allocation'), false)
    assert.equal(Object.hasOwn(packet.pairs[0], 'condition'), false)
    for (const [index, value] of packet.pairs.entries()) {
      const expectedCount = state.cases[index].references.length
      assert.equal(value.references.length, expectedCount)
      assert(value.category === 'reference-edit' ? expectedCount >= 1 && expectedCount <= 8 : expectedCount === 0)
      assert.notStrictEqual(value.requests.single, value.requests.batch)
      assert.deepEqual(value.requests.single, state.cases[index].request)
      assert.deepEqual(value.requests.batch, state.cases[index].request)
      for (const item of value.references) {
        assert.deepEqual(Object.keys(item).sort(), ['media_type', 'path', 'sha256'])
        assert.match(item.path, /\/outputs\/reference-\d{4}-\d{2}\.(?:png|jpg|webp)$/u)
        assert.doesNotMatch(item.path, /(?:single|batch|-[AB]\.)/u)
        assert.equal(item.path.includes(value.pair_id), false)
        assert.equal(hash(readFileSync(item.path)), item.sha256)
      }
    }

    const evaluator = { model: 'automatic-blind-evaluator-v1', implementation_sha256: hash('evaluator implementation'), protocol_sha256: input.evaluator_protocol_commitment_sha256 }
    const scoreSheet = {
      schema_version: 1, evaluator, evaluator_hash: evaluatorHash(evaluator),
      pairs: packet.pairs.map(value => ({ pair_id: value.pair_id,
        reference_hashes: value.references.map(reference => reference.sha256),
        artifacts: { A: { sha256: value.artifacts.A.sha256 }, B: { sha256: value.artifacts.B.sha256 } },
        scores: { A: dimensions(value.category), B: dimensions(value.category) } })),
    }
    const result = finalizeStudy(state, precommit, packet, [scoreSheet])
    assert.equal(result.analysis.status, 'PASS')
    const descriptor = { uri: `https://evidence.example/immutable/${hash(result.raw)}.json`, sha256: hash(result.raw) }
    assert.equal(validateAndAnalyzeStudy(result.raw, descriptor).status, 'PASS')
    assert.doesNotMatch(result.raw, /private test prompt|private-session-token-value|"path"|iVBORw0KGgo/u)
    assert.equal(result.raw.includes(temporary), false)
    const raw = JSON.parse(result.raw)
    assert.deepEqual(raw.pairs.find(value => value.category !== 'reference-edit').reference_hashes, [])
    const rawReferenceHashes = raw.pairs.find(value => value.category === 'reference-edit').reference_hashes
    assert.equal(rawReferenceHashes.length, 8)
    assert(rawReferenceHashes.every(value => value === hash(png)))

    for (const condition of ['single', 'batch']) {
      const badRequest = structuredClone(packet); badRequest.pairs[0].requests[condition].canonical_provider_request_hash = hash(`wrong ${condition} request`)
      assert.throws(() => finalizeStudy(state, precommit, badRequest, [scoreSheet]), new RegExp(`${condition} request differs from precommit`, 'u'))
    }
    const badReferenceHash = structuredClone(packet); const referencePair = badReferenceHash.pairs.find(value => value.references.length > 0)
    referencePair.references[0].sha256 = hash('wrong reference')
    assert.throws(() => finalizeStudy(state, precommit, badReferenceHash, [scoreSheet]), /reference metadata mismatch/u)
    const badSeenReference = structuredClone(scoreSheet); badSeenReference.pairs.find(value => value.reference_hashes.length > 0).reference_hashes[0] = hash('not seen')
    assert.throws(() => finalizeStudy(state, precommit, packet, [badSeenReference]), /reference hash mismatch/u)

    const copiedReference = packet.pairs.find(value => value.references.length > 0).references[0].path
    writeFileSync(copiedReference, Buffer.concat([png, Buffer.from('tampered')]))
    assert.throws(() => finalizeStudy(state, precommit, packet, [scoreSheet]), /reference bytes changed/u)
    writeFileSync(copiedReference, png)
    rmSync(copiedReference)
    assert.throws(() => finalizeStudy(state, precommit, packet, [scoreSheet]), /reference 1 is unavailable/u)
    writeFileSync(copiedReference, png)

    const copiedArtifact = packet.pairs[0].artifacts.A.path
    writeFileSync(copiedArtifact, Buffer.concat([png, Buffer.from('tampered')]))
    assert.throws(() => finalizeStudy(state, precommit, packet, [scoreSheet]), /bytes changed/u)
    writeFileSync(copiedArtifact, png)

    const badEvaluator = structuredClone(scoreSheet); badEvaluator.evaluator_hash = hash('unmatched evaluator')
    assert.throws(() => finalizeStudy(state, precommit, packet, [badEvaluator]), /evaluator hash\/protocol mismatch/u)
    const badArtifact = structuredClone(scoreSheet); badArtifact.pairs[0].artifacts.A.sha256 = hash('wrong artifact')
    assert.throws(() => finalizeStudy(state, precommit, packet, [badArtifact]), /artifact hash mismatch/u)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('collection fails closed when a precommitted source reference changes', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'emate-em217-503-reference-'))
  try {
    const reference = join(temporary, 'source.png'); writeFileSync(reference, png)
    const input = { schema_version: 1, evaluator_protocol_commitment_sha256: hash('protocol'),
      cases: Array.from({ length: 30 }, (_, index) => {
        const category = categories[index % categories.length]
        return { pair_id: `pair-${index + 1}`, category, prompt: `prompt ${index + 1}`, references: category === 'reference-edit' ? [reference] : [] }
      }) }
    const state = prepareStudy(input, '3'.repeat(64), context())
    writeFileSync(reference, Buffer.concat([png, Buffer.from('changed')]))
    let calls = 0
    await assert.rejects(collectStudy(state, hash(JSON.stringify(state) + '\n'), context(), join(temporary, 'output'), async () => { calls += 1 }), /reference bytes changed/u)
    assert.equal(calls, 0)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('prepare rejects category gaps and reference edits without an actual reference', () => {
  const base = { schema_version: 1, evaluator_protocol_commitment_sha256: hash('protocol'),
    cases: Array.from({ length: 50 }, (_, index) => ({ pair_id: `pair-${index + 1}`, category: categories[index % categories.length], prompt: 'private', references: [] })) }
  assert.throws(() => prepareStudy(base, '2'.repeat(64), context()), /reference\/category mismatch|at least five/u)
})

test('partial provider failure retains successful siblings immediately and refuses automatic replay', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'emate-quality-partial-'))
  try {
    const reference = join(temporary, 'reference.png'); writeFileSync(reference, png)
    const input = { schema_version: 1, evaluator_protocol_commitment_sha256: hash('protocol'),
      cases: Array.from({ length: 30 }, (_, index) => {
        const category = categories[index % categories.length]
        return { pair_id: `pair-${index + 1}`, category, prompt: `prompt ${index + 1}`, references: category === 'reference-edit' ? [reference] : [] }
      }) }
    const seed = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(64, '0')).find(value => parseInt(hash(`${value}\0order\0${1}`).slice(0, 2), 16) % 2 === 0)
    const state = prepareStudy(input, seed, context())
    const precommit = hash(JSON.stringify(state) + '\n')
    const output = join(temporary, 'outputs')
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      if (calls === 2) throw new Error('unknown provider outcome')
      return new Response(JSON.stringify({ id: `result-${calls}`, data: [{ b64_json: png.toString('base64') }], usage: {} }), { status: 200 })
    }
    await assert.rejects(collectStudy(state, precommit, context(), output, fetchImpl), /outcome is unknown/u)
    assert.equal(calls, 4)
    const retained = readdirSync(output).filter(name => /^pair-/u.test(name))
    assert.equal(retained.length, 3)
    for (const name of retained) assert.deepEqual(readFileSync(join(output, name)), png)
    await assert.rejects(collectStudy(state, precommit, context(), output, fetchImpl), /EEXIST/u)
    assert.equal(calls, 4)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('unknown serial single stops before the next case and preserves its successful predecessor', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'emate-quality-single-stop-'))
  try {
    const reference = join(temporary, 'reference.png'); writeFileSync(reference, png)
    const input = { schema_version: 1, evaluator_protocol_commitment_sha256: hash('protocol'),
      cases: Array.from({ length: 30 }, (_, index) => {
        const category = categories[index % categories.length]
        return { pair_id: `pair-${index + 1}`, category, prompt: `prompt ${index + 1}`, references: category === 'reference-edit' ? [reference] : [] }
      }) }
    const seed = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(64, '0')).find(value => parseInt(hash(`${value}\0order\0${1}`).slice(0, 2), 16) % 2 !== 0)
    const state = prepareStudy(input, seed, context())
    const precommit = hash(JSON.stringify(state) + '\n')
    const output = join(temporary, 'outputs')
    let calls = 0
    const fetchImpl = async (_url, options) => {
      assert.equal(options.headers['x-e-mate-batch-id'], undefined)
      calls++
      if (calls === 2) throw new Error('unknown')
      return new Response(JSON.stringify({ id: 'first', data: [{ b64_json: png.toString('base64') }], usage: {} }))
    }
    await assert.rejects(collectStudy(state, precommit, context(), output, fetchImpl), /outcome is unknown/u)
    assert.equal(calls, 2)
    const files = readdirSync(output).filter(name => /^pair-/u.test(name))
    assert.equal(files.length, 1)
    assert.deepEqual(readFileSync(join(output, files[0])), png)
    await assert.rejects(collectStudy(state, precommit, context(), output, fetchImpl), /EEXIST/u)
    assert.equal(calls, 2)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
