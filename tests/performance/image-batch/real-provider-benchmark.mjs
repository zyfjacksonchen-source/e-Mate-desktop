#!/usr/bin/env node
import { RELEASE_VERSION, ticketFor } from './release-identity.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_REFERENCE, HARNESS_COMMIT, validateProviderLayerEvidence } from './release-evidence-protocol.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const MODEL = 'gpt-image-2-pro'
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const SIZES = [4, 5, 8]
const SHA256 = /^[0-9a-f]{64}$/u

const sha256 = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw new Error(`EM218-502 real provider benchmark: ${message}`) }
const requireValue = (condition, message) => { if (!condition) fail(message) }

function gatewayRoot(value) {
  let url
  try { url = new URL(value) } catch { fail('EMATE_EVIDENCE_GATEWAY_URL is invalid') }
  url.pathname = url.pathname.replace(/\/+$/u, '')
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/v1'), 'gateway must be a fixed HTTPS /v1 endpoint')
  return url
}

function boundedInteger(value, label, minimum, maximum) {
  requireValue(/^\d+$/u.test(value), `${label} must be an integer`)
  const parsed = Number(value)
  requireValue(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum, `${label} must be ${minimum}..${maximum}`)
  return parsed
}

export function readConfiguration(env = process.env) {
  const layer = env.EMATE_EVIDENCE_LAYER
  requireValue(layer === 'staging' || layer === 'production', 'EMATE_EVIDENCE_LAYER must be staging or production')
  const token = env.EMATE_EVIDENCE_SESSION_TOKEN
  requireValue(typeof token === 'string' && token.length >= 20 && !/\s/u.test(token), 'EMATE_EVIDENCE_SESSION_TOKEN is unavailable')
  const deployment = env.EMATE_EVIDENCE_DEPLOYMENT_FINGERPRINT_SHA256
  requireValue(typeof deployment === 'string' && SHA256.test(deployment), 'deployment fingerprint must be lowercase SHA-256')
  const environmentName = env.EMATE_EVIDENCE_ENVIRONMENT_NAME
  requireValue(typeof environmentName === 'string' && environmentName.length >= 1 && environmentName.length <= 128, 'environment name is unavailable')
  const promptsFile = env.EMATE_EVIDENCE_PROMPTS_FILE
  const output = env.EMATE_EVIDENCE_OUTPUT
  requireValue(typeof promptsFile === 'string' && promptsFile.length > 0, 'EMATE_EVIDENCE_PROMPTS_FILE is unavailable')
  requireValue(typeof output === 'string' && output.length > 0, 'EMATE_EVIDENCE_OUTPUT is unavailable')
  const runs = boundedInteger(env.EMATE_EVIDENCE_RUNS ?? '3', 'EMATE_EVIDENCE_RUNS', 3, 1_000)
  const probe = env.EMATE_EVIDENCE_429_PROBE === '1'
  requireValue(layer === 'staging' ? probe : !probe, 'the typed 429 probe is required only in controlled staging')
  return { layer, token, deployment, environmentName, promptsFile, output, runs, probe, root: gatewayRoot(env.EMATE_EVIDENCE_GATEWAY_URL) }
}

function privatePrompts(path, runs) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { fail('private prompt set is unreadable JSON') }
  const needed = Array.from({ length: runs }, (_, index) => SIZES[index % SIZES.length]).reduce((sum, count) => sum + count, 0)
  requireValue(Array.isArray(value) && value.length >= Math.max(needed, 5) && value.length <= 8_000, `private prompt set requires at least ${Math.max(needed, 5)} entries`)
  value.forEach((prompt, index) => requireValue(typeof prompt === 'string' && prompt.length >= 1 && prompt.length <= 32_000 && !prompt.includes('\0'), `private prompt ${index + 1} is invalid`))
  return value
}

async function readJson(response) {
  const declared = response.headers.get('content-length')
  requireValue(declared === null || /^\d+$/u.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, 'gateway response exceeds byte limit')
  const bytes = Buffer.from(await response.arrayBuffer())
  requireValue(bytes.byteLength > 0 && bytes.byteLength <= MAX_RESPONSE_BYTES, 'gateway response exceeds byte limit')
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('gateway response is not valid UTF-8 JSON') }
}

function validImage(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'gateway image response is invalid')
  requireValue(typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.id), 'gateway image response ID is invalid')
  requireValue(Array.isArray(value.data) && value.data.length === 1 && value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage), 'gateway image response shape is invalid')
  const encoded = value.data[0]?.b64_json
  requireValue(typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded), 'gateway result is not canonical base64')
  const bytes = Buffer.from(encoded, 'base64')
  requireValue(bytes.byteLength >= 1 && bytes.byteLength <= 5 * 1024 * 1024 && bytes.toString('base64').replace(/=+$/u, '') === encoded.replace(/=+$/u, ''), 'gateway result bytes are invalid')
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  requireValue(png || jpeg || webp, 'gateway result is not PNG, JPEG, or WebP')
  return { responseId: value.id, digest: sha256(bytes), bytes, extension: png ? 'png' : jpeg ? 'jpg' : 'webp' }
}

function scope(seed, batchId, ordinal) {
  const taskHex = sha256(seed)
  const taskId = batchId === undefined ? `evidence-${taskHex.slice(0, 32)}` : `sha256:${taskHex}`
  const clientId = batchId === undefined ? taskId : `image-${taskHex}`
  return {
    taskId,
    headers: {
      session_id: clientId, 'x-client-request-id': clientId, 'x-e-mate-task-id': taskId, 'x-e-mate-trace-id': clientId,
      ...(batchId === undefined ? {} : { 'x-e-mate-batch-id': batchId, 'x-e-mate-batch-ordinal': String(ordinal) }),
    },
  }
}

async function requestImage(config, prompt, requestScope, fetchImpl = fetch, now = () => performance.now()) {
  const body = JSON.stringify({ model: MODEL, prompt })
  const started = now()
  let response
  try {
    response = await fetchImpl(new URL(`${config.root.pathname}/images/generations`, config.root.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000), body,
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json', 'content-type': 'application/json', ...requestScope.headers },
    })
  } catch (error) {
    return { status: 'unknown', elapsed: now() - started, body, requestScope,
      error_name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : 'UnknownError' }
  }
  const value = await readJson(response)
  const elapsed = now() - started
  if (response.status === 429) return { status: 'rate-limited', elapsed, value, response, body, requestScope }
  if (!response.ok) return { status: 'failed', elapsed }
  const image = validImage(value)
  if (config.retainImage !== undefined) await config.retainImage(requestScope.taskId, image)
  return { status: 'completed', elapsed, digest: image.digest, responseId: image.responseId }
}

async function typed429Probe(config, prompts, fetchImpl) {
  if (!config.probe) return { status: 'NOT_RUN', retry_after_ms: null, attempts: 0, accepted_submissions: 0, identical_request: false, pass: false }
  const batchId = `sha256:${sha256('EM217-502-typed-429-probe')}`
  const first = await Promise.all(prompts.slice(0, 5).map((prompt, index) => requestImage(config, prompt, scope(`probe-${index + 1}`, batchId, index + 1), fetchImpl)))
  const limited = first.filter(result => result.status === 'rate-limited')
  requireValue(limited.length === 1 && first.filter(result => result.status === 'completed').length === 4, 'controlled staging must yield exactly four accepted results and one typed 429')
  const rejected = limited[0]
  const retryAfterMs = rejected.value?.error?.retryAfterMs
  requireValue(rejected.value?.error?.code === 'TENANT_CONCURRENCY_LIMITED' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 1_000 && retryAfterMs <= 5_000, 'staging 429 must be typed TENANT_CONCURRENCY_LIMITED with 1..5 second retry')
  requireValue(rejected.response.headers.get('retry-after') === String(Math.ceil(retryAfterMs / 1_000)), 'Retry-After header and typed body disagree')
  await new Promise(resolveWait => setTimeout(resolveWait, retryAfterMs))
  const retried = await requestImage(config, prompts[first.indexOf(rejected)], rejected.requestScope, fetchImpl)
  requireValue(retried.status === 'completed' && rejected.body === JSON.stringify({ model: MODEL, prompt: prompts[first.indexOf(rejected)] }), 'the byte-identical rejected request did not succeed once after Retry-After')
  return { status: 'PASS', retry_after_ms: retryAfterMs, attempts: 2, accepted_submissions: 1, identical_request: true, pass: true }
}

async function mapLimit(values, limit, action) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await action(values[index], index)
    }
  }))
  return results
}

export async function runProviderBenchmark(config, prompts, fetchImpl = fetch, now = () => performance.now()) {
  requireValue(config.provenance.version !== RELEASE_VERSION || typeof config.retainImage === 'function', '2.0.18 evidence requires durable private output retention')
  let offset = 0
  const schedule = Array.from({ length: config.runs }, (_, index) => {
    const taskCount = SIZES[index % SIZES.length]
    const selected = prompts.slice(offset, offset + taskCount); offset += taskCount
    return { taskCount, selected }
  })
  const fixedSetSha256 = sha256(JSON.stringify(schedule.map(({ taskCount, selected }) => ({ task_count: taskCount, prompt_sha256: selected.map(sha256) }))))
  const runs = []
  for (const [index, { taskCount, selected }] of schedule.entries()) {
    const batchId = `sha256:${sha256(`${fixedSetSha256}\0${index + 1}`)}`
    const control = await requestImage(config, selected[0], scope(`${fixedSetSha256}\0direct\0${index + 1}`), fetchImpl, now)
    requireValue(control.status === 'completed', `same-round direct control ${index + 1} did not complete (${control.error_name ?? control.status})`)
    const batchStarted = now()
    const results = await mapLimit(selected, 4, async (prompt, ordinal) => {
      const result = await requestImage(config, prompt, scope(`${fixedSetSha256}\0${index + 1}\0${ordinal + 1}`, batchId, ordinal + 1), fetchImpl, now)
      return { ...result, batchElapsed: now() - batchStarted }
    })
    requireValue(!results.some(result => result.status === 'rate-limited'), `ordinary ${config.layer} batch ${index + 1} was rate limited`)
    runs.push({
      run: index + 1, task_count: taskCount,
      first_terminal_ms: Math.min(...results.map(result => result.batchElapsed)), all_terminal_ms: Math.max(...results.map(result => result.batchElapsed)),
      direct_single_terminal_ms: control.elapsed,
      completed_count: results.filter(result => result.status === 'completed').length,
      failed_count: results.filter(result => result.status === 'failed').length,
      unknown_count: results.filter(result => result.status === 'unknown').length,
      retained_success_count: results.filter(result => result.status === 'completed').length,
    })
  }
  const report = {
    schema_version: 1, ticket: ticketFor(config.provenance.version, '502'), claim: 'real-provider-gateway-layer-v1',
    environment: { layer: `${config.layer}-provider`, environment_name_sha256: sha256(config.environmentName), gateway_origin_sha256: sha256(config.root.href), deployment_fingerprint_sha256: config.deployment },
    provenance: config.provenance, measured_at: new Date().toISOString(), fixed_set_sha256: fixedSetSha256,
    runs, typed_429_retry_probe: await typed429Probe(config, prompts, fetchImpl),
  }
  return validateProviderLayerEvidence(report, config.layer, config.provenance)
}

async function main() {
  const config = readConfiguration()
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()
  requireValue(dirty === '', 'real evidence requires a clean committed worktree')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  config.provenance = { emate_commit: commit, harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: RELEASE_VERSION }
  const prompts = privatePrompts(config.promptsFile, config.runs)
  const outputDirectory = `${config.output}.images`
  // Exclusive directory creation prevents replay after partial or unknown provider outcomes.
  mkdirSync(outputDirectory, { mode: 0o700 })
  config.retainImage = (taskId, image) => {
    const path = resolve(outputDirectory, `${sha256(taskId)}.${image.extension}`)
    writeFileSync(path, image.bytes, { flag: 'wx', mode: 0o600, flush: true })
    requireValue(sha256(readFileSync(path)) === image.digest, 'private image readback hash mismatch')
  }
  const report = await runProviderBenchmark(config, prompts)
  const bytes = JSON.stringify(report) + '\n'
  writeFileSync(config.output, bytes, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ticket: report.ticket, layer: config.layer, runs: report.runs.length, fixed_set_sha256: report.fixed_set_sha256, raw_sha256: sha256(bytes) })}\n`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
