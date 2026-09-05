#!/usr/bin/env node
import { RELEASE_VERSION, ticketFor } from './release-identity.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM, DESKTOP_REFERENCE, HARNESS_COMMIT, createOpenManifest, projectManifest, protocolConstants, validateGuiEvidence, validateRawEvidence } from './release-evidence-protocol.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeNew = (path, value) => writeFileSync(path, value, { flag: 'wx', mode: 0o600 })

function gui([measurementsPath, outputPath]) {
  if (!outputPath) throw new Error('usage: project-release-evidence.mjs gui MEASUREMENTS_JSON GUI_LAYER_OUT')
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty) throw new Error('EM218-502 GUI evidence requires a clean committed worktree')
  const gateway = new URL(process.env.EMATE_EVIDENCE_GATEWAY_URL)
  gateway.pathname = gateway.pathname.replace(/\/+$/u, '')
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || !gateway.pathname.endsWith('/v1')) throw new Error('gateway must be a fixed HTTPS /v1 endpoint')
  const deployment = process.env.EMATE_EVIDENCE_DEPLOYMENT_FINGERPRINT_SHA256
  const name = process.env.EMATE_EVIDENCE_ENVIRONMENT_NAME
  if (!/^[0-9a-f]{64}$/u.test(deployment ?? '') || !name || name.length > 128) throw new Error('environment name and deployment fingerprint are required')
  const measurements = readJson(measurementsPath)
  if (Object.keys(measurements).sort().join(',') !== 'batches,fixed_set_sha256,measured_at') throw new Error('GUI measurements require exactly measured_at, fixed_set_sha256, and batches')
  const provenance = { emate_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    harness_commit: HARNESS_COMMIT, desktop_reference: DESKTOP_REFERENCE, version: RELEASE_VERSION }
  const value = { schema_version: 1, ticket: ticketFor(RELEASE_VERSION, '502'), claim: 'macos-gui-image-batch-performance-v1',
    environment: { layer: 'macos-gui', environment_name_sha256: sha256(name), gateway_origin_sha256: sha256(gateway.href), deployment_fingerprint_sha256: deployment },
    provenance, measured_at: measurements.measured_at, fixed_set_sha256: measurements.fixed_set_sha256,
    batches: measurements.batches.map((batch, index) => {
      if (Object.hasOwn(batch, 'sample')) throw new Error('GUI measurement sample IDs are assigned by the collector')
      return { ...batch, sample: index + 1 }
    }) }
  validateGuiEvidence(value, provenance)
  const raw = `${JSON.stringify(value)}\n`; writeNew(outputPath, raw)
  process.stdout.write(`${JSON.stringify({ ticket: ticketFor(RELEASE_VERSION, '502'), status: 'GUI_LAYER_READY', batches: value.batches.length, layer_sha256: sha256(raw) })}\n`)
}

function compose([localPath, stagingPath, productionPath, guiPath, outputPath]) {
  if (!outputPath) throw new Error('usage: project-release-evidence.mjs compose LOCAL STAGING PRODUCTION GUI RAW_OUT')
  const [local, staging, production, macos_gui] = [localPath, stagingPath, productionPath, guiPath].map(readJson)
  const value = {
    schema_version: 1, ticket: ticketFor(RELEASE_VERSION, '502'), claim: CLAIM,
    protocol: {
      percentile: 'nearest-rank', percentile_ci: 'deterministic-bootstrap-percentile-v1', bootstrap_resamples: 10_000,
      bootstrap_seed_sha256: protocolConstants.BOOTSTRAP_SEED_SHA256, legal_terminal_ci: 'wilson-score-95',
      minimum_fixed_set_batches: 100, minimum_per_sized_batch: 20, confidence: 0.95,
    },
    provenance: local.provenance, local, staging, production, macos_gui,
  }
  const raw = JSON.stringify(value) + '\n'
  const digest = sha256(raw)
  validateRawEvidence(raw, { uri: `https://pre-upload.invalid/immutable/${digest}.json`, sha256: digest })
  writeNew(outputPath, raw)
  process.stdout.write(`${JSON.stringify({ ticket: ticketFor(RELEASE_VERSION, '502'), status: 'VALIDATED_PENDING_UPLOAD', raw_sha256: digest })}\n`)
}

function project([rawPath, uri, openPath, outputPath]) {
  if (!outputPath) throw new Error('usage: project-release-evidence.mjs project RAW HTTPS_URI OPEN_MANIFEST PASS_OUT')
  const raw = readFileSync(rawPath)
  const descriptor = { uri, sha256: sha256(raw) }
  const pass = projectManifest(readJson(openPath), raw, descriptor)
  writeNew(outputPath, `${JSON.stringify(pass, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ticket: pass.ticket, status: 'PASS', raw_sha256: descriptor.sha256 })}\n`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'open' && args.length === 1) writeNew(args[0], JSON.stringify(createOpenManifest(), null, 2) + '\n')
    else if (command === 'gui') gui(args)
    else if (command === 'compose') compose(args)
    else if (command === 'project') project(args)
    else throw new Error('usage: project-release-evidence.mjs <open|gui|compose|project> ...')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
