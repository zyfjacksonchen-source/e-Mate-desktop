#!/usr/bin/env node
import { RELEASE_VERSION, ticketFor, minimumQualityPairs, imageModelFor } from '../../performance/image-batch/release-identity.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_REFERENCE, HARNESS_COMMIT, applicableDimensions, canonicalAllocationBytes, projectManifest,
  protocolConstants, validateAndAnalyzeStudy, createOpenManifest,
} from './noninferiority-protocol.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const SHA256 = /^[0-9a-f]{64}$/u
const CATEGORIES = protocolConstants.CATEGORIES
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw new Error(`EM218-503 real study: ${message}`) }
const requireValue = (condition, message) => { if (!condition) fail(message) }
const exactKeys = (value, keys, label) => {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  requireValue(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} fields mismatch`)
}
const hash = (value, label) => requireValue(typeof value === 'string' && SHA256.test(value), `${label} must be lowercase SHA-256`)

function gatewayRoot(value) {
  let url
  try { url = new URL(value) } catch { fail('EMATE_EVIDENCE_GATEWAY_URL is invalid') }
  url.pathname = url.pathname.replace(/\/+$/u, '')
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/v1'), 'gateway must be a fixed HTTPS /v1 endpoint')
  return url
}

function sourceContext(env = process.env, tokenRequired = false) {
  const root = gatewayRoot(env.EMATE_EVIDENCE_GATEWAY_URL)
  const deployment = env.EMATE_EVIDENCE_DEPLOYMENT_FINGERPRINT_SHA256
  const environmentName = env.EMATE_EVIDENCE_ENVIRONMENT_NAME
  const upstreamModel = env.EMATE_EVIDENCE_UPSTREAM_MODEL_ID
  hash(deployment, 'deployment fingerprint')
  requireValue(typeof environmentName === 'string' && environmentName.length >= 1 && environmentName.length <= 128, 'environment name is unavailable')
  requireValue(typeof upstreamModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(upstreamModel), 'upstream model ID is unavailable')
  const token = env.EMATE_EVIDENCE_SESSION_TOKEN
  if (tokenRequired) requireValue(typeof token === 'string' && token.length >= 20 && !/\s/u.test(token), 'session token is unavailable')
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()
  requireValue(dirty === '', 'real study requires a clean committed worktree')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  return {
    root, token, upstreamModel,
    provenance: { emate_commit: commit, harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: RELEASE_VERSION },
    environment: { layer: 'production-provider', environment_name_sha256: sha256(environmentName), gateway_origin_sha256: sha256(root.href), deployment_fingerprint_sha256: deployment },
  }
}

function readBytes(path, label) {
  requireValue(typeof path === 'string' && path.length > 0, `${label} path is invalid`)
  try { return readFileSync(path) } catch { fail(`${label} is unavailable`) }
}

function detect(bytes, label) {
  requireValue(bytes.byteLength >= 1 && bytes.byteLength <= 5 * 1024 * 1024, `${label} bytes exceed image bounds`)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mediaType: 'image/png', extension: 'png' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mediaType: 'image/jpeg', extension: 'jpg' }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mediaType: 'image/webp', extension: 'webp' }
  fail(`${label} is not PNG, JPEG, or WebP`)
}

function requestHashes(prompt, references, upstreamModel, version) {
  const prompt_hash = sha256(prompt)
  const reference_set_hash = sha256(JSON.stringify(references.map(reference => ({ media_type: reference.media_type, bytes: reference.bytes, sha256: reference.sha256 }))))
  const digest = createHash('sha256')
  if (references.length === 0) digest.update(JSON.stringify({ model: upstreamModel, prompt, n: 1, response_format: 'b64_json' }))
  else {
    digest.update(JSON.stringify({ model: upstreamModel, prompt, operation: 'edit' }))
    for (const reference of references) digest.update('\0').update(reference.media_type).update('\0').update(String(reference.bytes)).update('\0').update(Buffer.from(reference.sha256, 'hex'))
  }
  return { model: imageModelFor(version), quality: 'provider-default', size: 'provider-default', prompt_hash, reference_set_hash, canonical_provider_request_hash: digest.digest('hex') }
}

function assigned(cases, seed) {
  let batchOnA = 0
  let assignedCount = 0
  const allocation = new Map()
  const categoryOrder = [...CATEGORIES].sort((left, right) => sha256(`${seed}\0${left}`).localeCompare(sha256(`${seed}\0${right}`)))
  for (const category of categoryOrder) {
    const group = cases.filter(value => value.category === category).sort((left, right) => sha256(`${seed}\0${left.pair_id}`).localeCompare(sha256(`${seed}\0${right.pair_id}`)))
    const tieBatch = parseInt(sha256(`${seed}\0${category}`).slice(0, 2), 16) % 2 === 0
    const startBatch = group.length % 2 === 1 ? batchOnA < assignedCount - batchOnA || batchOnA === assignedCount - batchOnA && tieBatch : tieBatch
    group.forEach((value, index) => {
      const batchA = index % 2 === 0 ? startBatch : !startBatch
      const A = batchA ? 'batch' : 'single'; const B = batchA ? 'single' : 'batch'
      allocation.set(value.pair_id, { A, B, commitment_sha256: sha256(`${seed}\0${value.pair_id}\0${A}\0${B}`), assigned_before_scoring: true })
      if (batchA) batchOnA += 1
      assignedCount += 1
    })
  }
  return allocation
}

export function prepareStudy(input, seed, context) {
  requireValue(context.provenance.version !== RELEASE_VERSION || context.upstreamModel === imageModelFor(context.provenance.version), 'current upstream model must match the fixed image route')
  exactKeys(input, ['schema_version', 'evaluator_protocol_commitment_sha256', 'cases'], 'case input')
  requireValue(input.schema_version === 1, 'case input schema mismatch')
  hash(input.evaluator_protocol_commitment_sha256, 'evaluator protocol commitment')
  requireValue(typeof seed === 'string' && /^[0-9a-f]{64}$/u.test(seed), 'seed must be 32-byte lowercase hex')
  requireValue(Array.isArray(input.cases) && input.cases.length >= minimumQualityPairs(context.provenance.version) && input.cases.length <= 1000, 'study requires 30..1000 cases for 2.0.18 (50 for historical 2.0.17)')
  const ids = new Set()
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, 0]))
  const cases = input.cases.map((value, index) => {
    exactKeys(value, ['pair_id', 'category', 'prompt', 'references'], `case ${index + 1}`)
    requireValue(typeof value.pair_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.pair_id) && !ids.has(value.pair_id), `case ${index + 1} pair_id is invalid or duplicate`)
    ids.add(value.pair_id)
    requireValue(CATEGORIES.includes(value.category), `case ${value.pair_id} category is invalid`); counts[value.category] += 1
    requireValue(typeof value.prompt === 'string' && value.prompt.length >= 1 && value.prompt.length <= 32_000 && !value.prompt.includes('\0'), `case ${value.pair_id} prompt is invalid`)
    requireValue(Array.isArray(value.references) && value.references.length <= 8 && value.references.every(path => typeof path === 'string' && path.length > 0), `case ${value.pair_id} references are invalid`)
    requireValue(value.category === 'reference-edit' ? value.references.length >= 1 : value.references.length === 0, `case ${value.pair_id} reference/category mismatch`)
    const references = value.references.map(path => {
      const bytes = readBytes(path, `case ${value.pair_id} reference`); const type = detect(bytes, `case ${value.pair_id} reference`)
      return { path, media_type: type.mediaType, bytes: bytes.byteLength, sha256: sha256(bytes) }
    })
    return { pair_id: value.pair_id, category: value.category, prompt: value.prompt, references,
      request: requestHashes(value.prompt, references, context.upstreamModel, context.provenance.version) }
  })
  for (const category of CATEGORIES) requireValue(counts[category] >= 5, `category ${category} requires at least five cases`)
  const allocations = assigned(cases, seed)
  const stateCases = cases.map(value => ({ ...value, allocation: allocations.get(value.pair_id) }))
  const allocationManifest = sha256(canonicalAllocationBytes(stateCases))
  return {
    schema_version: 1, ticket: ticketFor(context.provenance.version, '503'), created_at: new Date().toISOString(), provenance: context.provenance,
    environment: context.environment, upstream_model: context.upstreamModel,
    evaluator_protocol_commitment_sha256: input.evaluator_protocol_commitment_sha256,
    seed, seed_commitment_sha256: sha256(seed), allocation_manifest_sha256: allocationManifest,
    allocations_created_before_collection: true, cases: stateCases,
  }
}

function stateShape(state) {
  exactKeys(state, ['schema_version', 'ticket', 'created_at', 'provenance', 'environment', 'upstream_model', 'evaluator_protocol_commitment_sha256',
    'seed', 'seed_commitment_sha256', 'allocation_manifest_sha256', 'allocations_created_before_collection', 'cases'], 'precommit state')
  requireValue(state.schema_version === 1 && state.ticket === ticketFor(state.provenance.version, '503') && state.allocations_created_before_collection === true, 'precommit state identity mismatch')
  hash(state.evaluator_protocol_commitment_sha256, 'evaluator protocol commitment'); hash(state.seed_commitment_sha256, 'seed commitment'); hash(state.allocation_manifest_sha256, 'allocation manifest')
  requireValue(sha256(state.seed) === state.seed_commitment_sha256 && sha256(canonicalAllocationBytes(state.cases)) === state.allocation_manifest_sha256, 'precommit state commitments mismatch')
  if (state.provenance.version === RELEASE_VERSION) {
    requireValue(state.upstream_model === imageModelFor(state.provenance.version), 'current upstream model must match the fixed image route')
    requireValue(state.cases.every(value => JSON.stringify(value.request) === JSON.stringify(requestHashes(value.prompt, value.references, state.upstream_model, state.provenance.version))), 'precommitted request differs from the fixed image route or inputs')
  }
  return state
}

function scope(seed, batchId, ordinal) {
  const taskHex = sha256(seed)
  const taskId = batchId ? `sha256:${taskHex}` : `quality-${taskHex.slice(0, 32)}`
  const client = batchId ? `image-${taskHex}` : taskId
  return { session_id: client, 'x-client-request-id': client, 'x-e-mate-task-id': taskId, 'x-e-mate-trace-id': client,
    ...(batchId ? { 'x-e-mate-batch-id': batchId, 'x-e-mate-batch-ordinal': String(ordinal) } : {}) }
}

async function responseJson(response) {
  const declared = response.headers.get('content-length')
  requireValue(declared === null || /^\d+$/u.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, 'gateway response exceeds byte limit')
  const bytes = Buffer.from(await response.arrayBuffer())
  requireValue(bytes.byteLength > 0 && bytes.byteLength <= MAX_RESPONSE_BYTES, 'gateway response exceeds byte limit')
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('gateway response is not valid UTF-8 JSON') }
}

async function generate(context, value, headers, fetchImpl) {
  let body
  let contentType
  if (value.references.length === 0) { body = JSON.stringify({ model: imageModelFor(context.provenance.version), prompt: value.prompt }); contentType = 'application/json' }
  else {
    const form = new FormData(); form.set('model', imageModelFor(context.provenance.version)); form.set('prompt', value.prompt)
    const field = value.references.length === 1 ? 'image' : 'image[]'
    value.references.forEach((reference, index) => {
      const bytes = readBytes(reference.path, `reference for ${value.pair_id}`)
      requireValue(bytes.byteLength === reference.bytes && sha256(bytes) === reference.sha256, `reference bytes changed for ${value.pair_id}`)
      form.append(field, new Blob([bytes], { type: reference.media_type }), `reference-${index + 1}${extname(reference.path) || '.bin'}`)
    })
    body = form
  }
  let response
  try {
    response = await fetchImpl(new URL(`${context.root.pathname}/images/${value.references.length ? 'edits' : 'generations'}`, context.root.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000), body,
      headers: { authorization: `Bearer ${context.token}`, accept: 'application/json', ...(contentType ? { 'content-type': contentType } : {}), ...headers },
    })
  } catch { fail(`provider outcome is unknown for ${value.pair_id}`) }
  requireValue(response.ok, `gateway rejected ${value.pair_id} with HTTP ${response.status}`)
  const result = await responseJson(response)
  requireValue(result && typeof result.id === 'string' && Array.isArray(result.data) && result.data.length === 1 && result.usage && typeof result.usage === 'object', `gateway response shape is invalid for ${value.pair_id}`)
  const encoded = result.data[0]?.b64_json
  requireValue(typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded), `gateway result is not canonical base64 for ${value.pair_id}`)
  const bytes = Buffer.from(encoded, 'base64')
  requireValue(bytes.toString('base64').replace(/=+$/u, '') === encoded.replace(/=+$/u, ''), `gateway result base64 is invalid for ${value.pair_id}`)
  return { bytes, ...detect(bytes, `gateway result for ${value.pair_id}`), request: requestHashes(value.prompt, value.references, context.upstreamModel, context.provenance.version) }
}

function groups(values) {
  const output = []
  for (let index = 0; index < values.length;) {
    const remaining = values.length - index
    const count = remaining === 5 ? 3 : Math.min(4, remaining)
    output.push(values.slice(index, index + count)); index += count
  }
  requireValue(output.every(group => group.length >= 2 && group.length <= 4), 'batch study groups must contain 2..4 cases')
  return output
}

export async function collectStudy(state, precommitSha256, context, outputDirectory, fetchImpl = fetch) {
  stateShape(state); hash(precommitSha256, 'precommit file hash')
  requireValue(JSON.stringify(state.provenance) === JSON.stringify(context.provenance) && JSON.stringify(state.environment) === JSON.stringify(context.environment) && state.upstream_model === context.upstreamModel, 'collection environment differs from the precommit')
  mkdirSync(outputDirectory, { mode: 0o700 })
  const controlledCases = state.cases.map((value, caseIndex) => ({
    ...value,
    references: value.references.map((reference, referenceIndex) => {
      const bytes = readBytes(reference.path, `case ${value.pair_id} reference`)
      const type = detect(bytes, `case ${value.pair_id} reference`)
      requireValue(type.mediaType === reference.media_type && bytes.byteLength === reference.bytes && sha256(bytes) === reference.sha256, `reference bytes changed for ${value.pair_id}`)
      const path = resolve(outputDirectory, `reference-${String(caseIndex + 1).padStart(4, '0')}-${String(referenceIndex + 1).padStart(2, '0')}.${type.extension}`)
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
      return { ...reference, path }
    }),
  }))
  const artifacts = new Map()
  for (const [groupIndex, group] of groups(controlledCases).entries()) {
    const batchId = `sha256:${sha256(`${precommitSha256}\0batch\0${groupIndex + 1}`)}`
    const collect = async condition => {
      const one = async (value, index) => {
        const result = await generate(context, value, scope(`${precommitSha256}\0${value.pair_id}\0${condition}`, condition === 'batch' ? batchId : undefined, index + 1), fetchImpl)
        const side = value.allocation.A === condition ? 'A' : 'B'
        const path = resolve(outputDirectory, `${value.pair_id}-${side}.${result.extension}`)
        writeFileSync(path, result.bytes, { flag: 'wx', mode: 0o600, flush: true })
        return { ...result, path }
      }
      if (condition === 'single') {
        const results = []
        for (const [index, value] of group.entries()) results.push(await one(value, index))
        return results
      }
      const results = await Promise.allSettled(group.map(one))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      return results.map(result => result.value)
    }
    const batch = () => collect('batch')
    const single = () => collect('single')
    const batchFirst = parseInt(sha256(`${state.seed}\0order\0${groupIndex + 1}`).slice(0, 2), 16) % 2 === 0
    const first = await (batchFirst ? batch() : single()); const second = await (batchFirst ? single() : batch())
    const batchResults = batchFirst ? first : second; const singleResults = batchFirst ? second : first
    for (const [index, value] of group.entries()) {
      const byCondition = { batch: batchResults[index], single: singleResults[index] }
      const sides = {}
      for (const side of ['A', 'B']) {
        const result = byCondition[value.allocation[side]]
        sides[side] = { path: result.path, sha256: sha256(result.bytes) }
      }
      artifacts.set(value.pair_id, {
        references: value.references.map(reference => ({ path: reference.path, media_type: reference.media_type, sha256: reference.sha256 })),
        requests: { single: { ...byCondition.single.request }, batch: { ...byCondition.batch.request } },
        artifacts: sides,
      })
    }
  }
  return {
    schema_version: 1, ticket: state.ticket, evaluator_protocol_commitment_sha256: state.evaluator_protocol_commitment_sha256,
    precommit_sha256: precommitSha256,
    pairs: state.cases.map(value => ({ pair_id: value.pair_id, category: value.category, prompt: value.prompt, ...artifacts.get(value.pair_id) })),
  }
}

export function evaluatorHash(evaluator) {
  exactKeys(evaluator, ['model', 'implementation_sha256', 'protocol_sha256'], 'evaluator descriptor')
  requireValue(typeof evaluator.model === 'string' && evaluator.model.length >= 1 && evaluator.model.length <= 128, 'evaluator model is invalid')
  hash(evaluator.implementation_sha256, 'evaluator implementation'); hash(evaluator.protocol_sha256, 'evaluator protocol')
  return sha256(JSON.stringify({ model: evaluator.model, implementation_sha256: evaluator.implementation_sha256, protocol_sha256: evaluator.protocol_sha256 }))
}

export function finalizeStudy(state, precommitSha256, packet, scoreSheets) {
  stateShape(state); hash(precommitSha256, 'precommit file hash')
  exactKeys(packet, ['schema_version', 'ticket', 'evaluator_protocol_commitment_sha256', 'precommit_sha256', 'pairs'], 'blind packet')
  requireValue(packet.schema_version === 1 && packet.ticket === state.ticket && packet.precommit_sha256 === precommitSha256
    && packet.evaluator_protocol_commitment_sha256 === state.evaluator_protocol_commitment_sha256, 'blind packet commitment mismatch')
  requireValue(Array.isArray(packet.pairs) && packet.pairs.length === state.cases.length, 'blind packet pair count mismatch')
  const blindById = new Map(packet.pairs.map(value => [value.pair_id, value]))
  requireValue(blindById.size === packet.pairs.length, 'blind packet pair IDs must be unique')
  let controlledOutputDirectory
  for (const [caseIndex, source] of state.cases.entries()) {
    const blind = blindById.get(source.pair_id)
    exactKeys(blind, ['pair_id', 'category', 'prompt', 'references', 'requests', 'artifacts'], `blind pair ${source.pair_id}`)
    requireValue(blind.category === source.category && blind.prompt === source.prompt, `blind pair ${source.pair_id} input mismatch`)
    requireValue(Array.isArray(blind.references) && blind.references.length === source.references.length, `blind pair ${source.pair_id} reference count mismatch`)
    requireValue(source.category === 'reference-edit' ? blind.references.length >= 1 && blind.references.length <= 8 : blind.references.length === 0, `blind pair ${source.pair_id} reference/category mismatch`)
    exactKeys(blind.artifacts, ['A', 'B'], `blind pair ${source.pair_id} artifacts`)
    for (const side of ['A', 'B']) {
      exactKeys(blind.artifacts[side], ['path', 'sha256'], `blind ${source.pair_id} ${side}`); hash(blind.artifacts[side].sha256, `blind ${source.pair_id} ${side}`)
      requireValue(typeof blind.artifacts[side].path === 'string' && resolve(blind.artifacts[side].path) === blind.artifacts[side].path, `blind ${source.pair_id} ${side} path is invalid`)
      const bytes = readBytes(blind.artifacts[side].path, `blind ${source.pair_id} ${side}`)
      requireValue(sha256(bytes) === blind.artifacts[side].sha256, `blind ${source.pair_id} ${side} bytes changed`)
      controlledOutputDirectory ??= dirname(blind.artifacts[side].path)
      requireValue(dirname(blind.artifacts[side].path) === controlledOutputDirectory, `blind ${source.pair_id} artifact directory mismatch`)
    }
    for (const [referenceIndex, reference] of blind.references.entries()) {
      exactKeys(reference, ['path', 'media_type', 'sha256'], `blind ${source.pair_id} reference ${referenceIndex + 1}`)
      const expected = source.references[referenceIndex]; hash(reference.sha256, `blind ${source.pair_id} reference ${referenceIndex + 1}`)
      const extension = expected.media_type === 'image/png' ? 'png' : expected.media_type === 'image/jpeg' ? 'jpg' : 'webp'
      const expectedPath = resolve(controlledOutputDirectory, `reference-${String(caseIndex + 1).padStart(4, '0')}-${String(referenceIndex + 1).padStart(2, '0')}.${extension}`)
      requireValue(reference.path === expectedPath && reference.media_type === expected.media_type && reference.sha256 === expected.sha256, `blind ${source.pair_id} reference metadata mismatch`)
      const bytes = readBytes(reference.path, `blind ${source.pair_id} reference ${referenceIndex + 1}`)
      requireValue(bytes.byteLength === expected.bytes && sha256(bytes) === expected.sha256, `blind ${source.pair_id} reference bytes changed`)
    }
    exactKeys(blind.requests, ['single', 'batch'], `blind pair ${source.pair_id} requests`)
    for (const condition of ['single', 'batch']) {
      exactKeys(blind.requests[condition], ['model', 'quality', 'size', 'prompt_hash', 'reference_set_hash', 'canonical_provider_request_hash'], `${source.pair_id} ${condition} request`)
      requireValue(JSON.stringify(blind.requests[condition]) === JSON.stringify(source.request), `${source.pair_id} ${condition} request differs from precommit`)
    }
    requireValue(JSON.stringify(blind.requests.single) === JSON.stringify(blind.requests.batch), `${source.pair_id} paired request mismatch`)
  }
  requireValue(Array.isArray(scoreSheets) && scoreSheets.length >= 1 && scoreSheets.length <= 10, '1..10 evaluator score sheets are required')
  const evaluatorHashes = new Set()
  const sheets = scoreSheets.map((sheet, sheetIndex) => {
    exactKeys(sheet, ['schema_version', 'evaluator', 'evaluator_hash', 'pairs'], `score sheet ${sheetIndex + 1}`)
    requireValue(sheet.schema_version === 1 && sheet.evaluator_hash === evaluatorHash(sheet.evaluator) && sheet.evaluator.protocol_sha256 === state.evaluator_protocol_commitment_sha256, `score sheet ${sheetIndex + 1} evaluator hash/protocol mismatch`)
    requireValue(!evaluatorHashes.has(sheet.evaluator_hash), 'evaluator hashes must be unique'); evaluatorHashes.add(sheet.evaluator_hash)
    requireValue(Array.isArray(sheet.pairs) && sheet.pairs.length === state.cases.length, `score sheet ${sheetIndex + 1} pair count mismatch`)
    const byId = new Map(sheet.pairs.map(value => [value.pair_id, value]))
    requireValue(byId.size === sheet.pairs.length, `score sheet ${sheetIndex + 1} pair IDs must be unique`)
    for (const source of state.cases) {
      const scored = byId.get(source.pair_id); const blind = blindById.get(source.pair_id)
      exactKeys(scored, ['pair_id', 'reference_hashes', 'artifacts', 'scores'], `score ${source.pair_id}`)
      requireValue(JSON.stringify(scored.reference_hashes) === JSON.stringify(blind.references.map(reference => reference.sha256)), `score ${source.pair_id} reference hash mismatch`)
      requireValue(JSON.stringify(scored.artifacts) === JSON.stringify({ A: { sha256: blind.artifacts.A.sha256 }, B: { sha256: blind.artifacts.B.sha256 } }), `score ${source.pair_id} artifact hash mismatch`)
      exactKeys(scored.scores, ['A', 'B'], `score ${source.pair_id} sides`)
      for (const side of ['A', 'B']) {
        exactKeys(scored.scores[side], applicableDimensions(source.category), `score ${source.pair_id} ${side}`)
        for (const value of Object.values(scored.scores[side])) requireValue(Number.isFinite(value) && value >= 0 && value <= 5, `score ${source.pair_id} ${side} must be 0..5`)
      }
    }
    return { ...sheet, byId }
  })
  const pairs = state.cases.map(source => {
    const blind = blindById.get(source.pair_id)
    return {
      pair_id: source.pair_id, category: source.category,
      reference_hashes: blind.references.map(reference => reference.sha256),
      requests: { single: { ...blind.requests.single }, batch: { ...blind.requests.batch } },
      artifacts: { A: { sha256: blind.artifacts.A.sha256 }, B: { sha256: blind.artifacts.B.sha256 } },
      allocation: { ...source.allocation },
      scores: sheets.flatMap(sheet => ['A', 'B'].map(side => ({ evaluator_hash: sheet.evaluator_hash, side, dimensions: sheet.byId.get(source.pair_id).scores[side] }))),
    }
  })
  const record = {
    schema_version: 1, provenance: state.provenance, environment: state.environment,
    protocol: {
      minimum_pairs: minimumQualityPairs(state.provenance.version), maximum_pairs: 1000, minimum_per_category: 5, categories: [...CATEGORIES], dimensions: [...protocolConstants.ALL_DIMENSIONS],
      category_dimensions: Object.fromEntries(CATEGORIES.map(category => [category, applicableDimensions(category)])),
      overall_mean_margin: protocolConstants.OVERALL_MEAN_MARGIN, ci_lower_margin: protocolConstants.CI_LOWER_MARGIN,
      ci95: { method: 'normal-sample-sd-two-sided', critical_value: protocolConstants.CI_CRITICAL_VALUE },
      blinding: { concealed_side_labels: ['A', 'B'], evaluator_protocol_commitment_sha256: state.evaluator_protocol_commitment_sha256 },
      randomization: { method: 'committed-balanced-random-order-v1', seed_commitment_sha256: state.seed_commitment_sha256,
        allocation_manifest_sha256: state.allocation_manifest_sha256, assigned_before_scoring: true },
    },
    pairs,
  }
  const raw = JSON.stringify(record) + '\n'; const digest = sha256(raw)
  const analysis = validateAndAnalyzeStudy(raw, { uri: `https://pre-upload.invalid/immutable/${digest}.json`, sha256: digest })
  return { raw, analysis }
}

function writeNew(path, value) { writeFileSync(path, value, { flag: 'wx', mode: 0o600 }) }

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'open' && args.length === 1) writeNew(args[0], JSON.stringify(createOpenManifest(), null, 2) + '\n')
  else if (command === 'prepare') {
    const [inputPath, statePath] = args; if (!statePath) fail('usage: real-study.mjs prepare CASES_JSON PRIVATE_STATE_OUT')
    const state = prepareStudy(JSON.parse(readFileSync(inputPath, 'utf8')), randomBytes(32).toString('hex'), sourceContext())
    const raw = JSON.stringify(state) + '\n'; writeNew(statePath, raw)
    process.stdout.write(`${JSON.stringify({ ticket: ticketFor(RELEASE_VERSION, '503'), status: 'PRECOMMITTED', pairs: state.cases.length, precommit_sha256: sha256(raw), allocation_manifest_sha256: state.allocation_manifest_sha256 })}\n`)
  } else if (command === 'collect') {
    const [statePath, outputDirectory, packetPath] = args; if (!packetPath) fail('usage: real-study.mjs collect PRIVATE_STATE OUTPUT_DIRECTORY BLIND_PACKET_OUT')
    const stateRaw = readFileSync(statePath); const expected = process.env.EMATE_EVIDENCE_PRECOMMIT_SHA256
    hash(expected, 'EMATE_EVIDENCE_PRECOMMIT_SHA256'); requireValue(sha256(stateRaw) === expected, 'private state bytes do not match the precommit')
    const packet = await collectStudy(JSON.parse(stateRaw), expected, sourceContext(process.env, true), outputDirectory)
    const raw = JSON.stringify(packet) + '\n'; writeNew(packetPath, raw)
    process.stdout.write(`${JSON.stringify({ ticket: ticketFor(RELEASE_VERSION, '503'), status: 'BLIND_PACKET_READY', pairs: packet.pairs.length, blind_packet_sha256: sha256(raw) })}\n`)
  } else if (command === 'finalize') {
    const [statePath, packetPath, outputPath, ...scorePaths] = args; if (!outputPath || scorePaths.length < 1) fail('usage: real-study.mjs finalize PRIVATE_STATE BLIND_PACKET RAW_OUT SCORE_JSON...')
    const stateRaw = readFileSync(statePath); const expected = process.env.EMATE_EVIDENCE_PRECOMMIT_SHA256
    hash(expected, 'EMATE_EVIDENCE_PRECOMMIT_SHA256'); requireValue(sha256(stateRaw) === expected, 'private state bytes do not match the precommit')
    const result = finalizeStudy(JSON.parse(stateRaw), expected, JSON.parse(readFileSync(packetPath, 'utf8')), scorePaths.map(path => JSON.parse(readFileSync(path, 'utf8'))))
    writeNew(outputPath, result.raw)
    process.stdout.write(`${JSON.stringify({ ticket: ticketFor(result.analysis.provenance.version, '503'), status: result.analysis.status, pairs: result.analysis.pair_count, raw_sha256: sha256(result.raw) })}\n`)
    if (result.analysis.status !== 'PASS') process.exitCode = 1
  } else if (command === 'project') {
    const [rawPath, uri, openPath, outputPath] = args; if (!outputPath) fail('usage: real-study.mjs project RAW HTTPS_URI OPEN_MANIFEST PASS_OUT')
    const raw = readFileSync(rawPath); const descriptor = { uri, sha256: sha256(raw) }
    const manifest = projectManifest(JSON.parse(readFileSync(openPath, 'utf8')), raw, descriptor)
    writeNew(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ ticket: manifest.ticket, status: 'PASS', raw_sha256: descriptor.sha256 })}\n`)
  } else fail('usage: real-study.mjs <open|prepare|collect|finalize|project> ...')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
