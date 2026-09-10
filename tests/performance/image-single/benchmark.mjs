#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyHarnessBuildReceipt } from '../../../scripts/harness-provenance.mjs'
import { CLAIM, HARNESS_COMMIT, REPETITIONS, SCENARIO_NAMES, TICKET, sha256, validateAggregate, validateDirectProductSource } from './protocol.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const BUILT_PREREQUISITES = [
  'packages/dsh-plugin-imagegen/lib/index.js',
  'upstream/deepseek-harness/vendor/cordis/lib/index.js',
  'upstream/deepseek-harness/packages/core/agent/lib/index.js',
  'upstream/deepseek-harness/packages/core/session/lib/index.js',
  'upstream/deepseek-harness/packages/session/session-projection/lib/index.js',
  'upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js',
  'upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js',
  'upstream/deepseek-harness/packages/core/tools/lib/index.js',
  'upstream/deepseek-harness/packages/llm/llm/lib/index.js',
  'upstream/deepseek-harness/packages/storage/storage-domain/lib/index.js',
  'upstream/deepseek-harness/packages/storage/storage-domain/node_modules/zod/index.js',
]
const MAX_WORKER_JSON_BYTES = 2 * 1024 * 1024
const WORKER_TIMEOUT_MS = 30 * 60 * 1000

export function assertBuiltPrerequisites(paths = BUILT_PREREQUISITES) {
  const missing = paths.filter(path => !existsSync(resolve(ROOT, path)))
  if (missing.length > 0) {
    throw new Error('EM218-108 benchmark prerequisites are absent: ' + missing.join(', ')
      + '. Run only the main-agent-authorized existing Harness/e-Mate build prerequisites; benchmark.mjs never installs or builds them.')
  }
}


function newestSourceMtime(directory) {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

export function assertExactBuiltProvenance() {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty !== '') throw new Error('EM218-108 full benchmark requires a clean committed worktree; uncommitted or untracked source cannot be attributed to HEAD')
  verifyHarnessBuildReceipt(ROOT)
  const bundle = join(ROOT, 'packages/dsh-plugin-imagegen/lib/index.js')
  const newestSource = newestSourceMtime(join(ROOT, 'packages/dsh-plugin-imagegen/src'))
  if (statSync(bundle).mtimeMs < newestSource) {
    throw new Error('EM218-108 assembled dsh-imagegen bundle is older than product source; run the authorized @e-mate/dsh-plugin-imagegen build before benchmarking')
  }
}

export function sourceSmoke() {
  const base = JSON.parse(readFileSync(join(ROOT, 'desktop/e-mate-desktop/base-contract.json'), 'utf8'))
  assert.equal(base.harness_version, '0.1.5-rc.1')
  assert.equal(base.harness_commit, HARNESS_COMMIT)
  const contract = readFileSync(join(ROOT, 'docs/2.0.17/contracts/single-image-latency.md'), 'utf8')
  assert.match(contract, /has no native image-generation Tool/u)
  assert.match(contract, /pinned-owner lower bound/u)
  assert.doesNotMatch(contract, /native imagegen parity is (?:proved|achieved|passed)/iu)
  const source = ['index.ts', 'host.ts', 'upstream/agent-image-tools.ts'].map(path => readFileSync(join(ROOT, 'packages/dsh-plugin-imagegen/src', path), 'utf8')).join('\n')
  validateDirectProductSource(source)
  const runtime = readFileSync(join(ROOT, 'packages/dsh-plugin-imagegen/src/upstream/generation-runtime.ts'), 'utf8')
  assert.match(runtime, /GenerationTaskQueue/u)
  const cas = readFileSync(join(ROOT, 'upstream/deepseek-harness/packages/attachment/attachment-local/src/store.ts'), 'utf8')
  for (const required of ['detectImage', 'createHash', 'handle.sync()', 'syncDirectory(bucket)', 'chmod(target, 0o700)']) {
    assert.ok(cas.includes(required), 'pinned CAS source missing ' + required)
  }
  const worker = readFileSync(WORKER, 'utf8')
  assert.match(worker, /setTimeout as delay/u)
  assert.match(worker, /FAKE_DELAY_MS/u)
  for (const guard of ['installNetworkGuard', 'syncBuiltinESMExports', 'globalThis.fetch', "[net, ['connect', 'createConnection']]", "[dns, ['lookup', 'resolve', 'resolve4', 'resolve6']]"]) assert.ok(worker.includes(guard), 'worker network guard missing ' + guard)
  assert.doesNotMatch(worker, /createServer|new WebSocket|EventSource/u)
  return { ticket: TICKET, status: 'source-smoke-passed', harness_commit: HARNESS_COMMIT, comparator: CLAIM, built_prerequisites: 'not-required-for-source-smoke' }
}

function runWorker(repetition, commit) {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, [WORKER], {
      cwd: ROOT,
      env: { ...process.env, EMATE_BENCHMARK_REPETITION: String(repetition), EMATE_BENCHMARK_COMMIT: commit },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = []
    const errors = []
    let outputBytes = 0
    let errorBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectOnce(new Error('EM218-108 worker ' + repetition + ' exceeded the 30-minute protocol deadline'))
    }, WORKER_TIMEOUT_MS)
    timer.unref()
    const rejectOnce = error => { if (!settled) { settled = true; clearTimeout(timer); rejectWorker(error) } }
    child.stdout.on('data', chunk => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_WORKER_JSON_BYTES) {
        child.kill('SIGKILL')
        rejectOnce(new Error('EM218-108 worker JSON exceeded 2 MiB'))
      } else output.push(chunk)
    })
    child.stderr.on('data', chunk => {
      errorBytes += chunk.byteLength
      if (errorBytes <= 64 * 1024) errors.push(chunk)
    })
    child.once('error', rejectOnce)
    child.once('close', code => {
      if (settled) return
      if (code !== 0) {
        rejectOnce(new Error('EM218-108 worker ' + repetition + ' failed: ' + Buffer.concat(errors).toString('utf8').trim()))
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(output).toString('utf8'))
        settled = true
        clearTimeout(timer)
        resolveWorker(parsed)
      } catch (error) {
        rejectOnce(new Error('EM218-108 worker ' + repetition + ' returned invalid JSON', { cause: error }))
      }
    })
  })
}

async function fullBenchmark() {
  assertBuiltPrerequisites()
  assertExactBuiltProvenance()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  assert.match(commit, /^[0-9a-f]{40}$/u)
  const repetitions = []
  for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) repetitions.push(await runWorker(repetition, commit))
  const aggregate = { schema_version: 2, ticket: TICKET, claim: CLAIM, repetitions, all_repetitions_pass: repetitions.every(entry => entry.pass) }
  validateAggregate(aggregate)
  const directory = join(ROOT, 'work/em218-108/image-single')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const raw = Buffer.from(JSON.stringify(aggregate) + '\n')
  const rawPath = join(directory, 'raw-' + commit.slice(0, 12) + '-' + String(Date.now()) + '.json')
  writeFileSync(rawPath, raw, { flag: 'wx', mode: 0o600 })
  const summary = {
    ticket: TICKET,
    status: aggregate.all_repetitions_pass ? 'SOURCE_PASS_PENDING_EXTERNAL_EVIDENCE' : 'FAILED',
    raw_result: relative(ROOT, rawPath),
    raw_sha256: sha256(raw),
    repetitions: repetitions.length,
    all_repetitions_pass: aggregate.all_repetitions_pass,
    scenarios: Object.fromEntries(SCENARIO_NAMES.map(name => [name, repetitions.map(entry => entry.scenarios[name].percentiles)])),
    tracked_manifest: 'unchanged; remains OPEN until an immutable external URI and this raw SHA-256 are recorded',
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  if (!aggregate.all_repetitions_pass) process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--source-smoke') {
    process.stdout.write(JSON.stringify(sourceSmoke()) + '\n')
  } else if (args.length === 0) {
    fullBenchmark().catch(error => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
      process.exitCode = 1
    })
  } else {
    process.stderr.write('usage: node tests/performance/image-single/benchmark.mjs [--source-smoke]\n')
    process.exitCode = 2
  }
}
