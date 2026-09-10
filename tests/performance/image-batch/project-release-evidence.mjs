#!/usr/bin/env node
import { RELEASE_VERSION, ticketFor } from './release-identity.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM, DESKTOP_REFERENCE, HARNESS_COMMIT, createOpenManifest, projectManifest, protocolConstants, validateGuiEvidence, validateRawEvidence } from './release-evidence-protocol.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeNew = (path, value) => writeFileSync(path, value, { flag: 'wx', mode: 0o600 })

const SHA256 = /^[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const check = (condition, message) => { if (!condition) throw new Error(`EM218-502 GUI evidence: ${message}`) }

// Hash the complete installed bundle, including unpacked Profile bytes and symlink targets.
// This runs once per dataset binding/verification, never once per image or batch.
export function hashInstalledTree(appPath) {
  check(typeof appPath === 'string' && isAbsolute(appPath) && appPath.endsWith('.app'), 'installed app must be an absolute .app path')
  const root = realpathSync(appPath)
  check(lstatSync(appPath).isDirectory(), 'installed app root must be a real directory')
  const digest = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name)
      const before = lstatSync(path)
      const entry = { path: relative(root, path).split(sep).join('/'), mode: before.mode & 0o7777 }
      if (before.isSymbolicLink()) {
        const target = readlinkSync(path)
        const resolved = resolve(dirname(path), target)
        check(resolved === root || resolved.startsWith(root + sep), 'installed symlink escapes the app')
        Object.assign(entry, { kind: 'symlink', target })
      } else if (before.isDirectory()) Object.assign(entry, { kind: 'directory' })
      else {
        check(before.isFile(), 'unsupported installed filesystem entry')
        const file = createHash('sha256'); const fd = openSync(path, 'r')
        try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) file.update(buffer.subarray(0, count)) }
        finally { closeSync(fd) }
        const after = lstatSync(path)
        check(after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.mode === before.mode, 'installed file changed while hashing')
        Object.assign(entry, { kind: 'file', bytes: before.size, sha256: file.digest('hex') })
      }
      digest.update(JSON.stringify(entry) + '\n')
      if (before.isDirectory()) walk(path)
    }
  }
  walk(root)
  return digest.digest('hex')
}

function reviewedInstalledReceipt(receipt) {
  const p = receipt?.provenance
  check(receipt?.schema_version === 1 && p && Object.keys(p).sort().join(',') === 'desktop_reference,emate_commit,harness_commit,version'
    && COMMIT.test(p.emate_commit) && p.harness_commit === HARNESS_COMMIT && p.desktop_reference === DESKTOP_REFERENCE && p.version === RELEASE_VERSION,
  'installed provenance receipt has invalid source identity')
  check(SHA256.test(receipt.installed_tree_sha256) && SHA256.test(receipt.measurements_sha256), 'installed provenance receipt requires content hashes')
  const source = receipt.source_evidence
  check(source && typeof source.path === 'string' && isAbsolute(source.path) && SHA256.test(source.sha256), 'installed provenance receipt requires reviewed source evidence')
  const bytes = readFileSync(source.path)
  check(sha256(bytes) === source.sha256, 'reviewed source receipt hash mismatch')
  const evidence = JSON.parse(bytes)
  check(evidence.source_commit === p.emate_commit && evidence.installed_app === receipt.installed_app && evidence.full_file_hashes_match === true,
    'source receipt does not attest this installed app and source')
  return p
}

export function installedGuiProvenance(measurementsBytes, env = process.env) {
  const path = env.EMATE_EVIDENCE_INSTALLED_RECEIPT
  check(typeof path === 'string' && isAbsolute(path) && SHA256.test(env.EMATE_EVIDENCE_INSTALLED_RECEIPT_SHA256 ?? ''), 'installed provenance receipt and pinned SHA-256 are required')
  const raw = readFileSync(path)
  check(sha256(raw) === env.EMATE_EVIDENCE_INSTALLED_RECEIPT_SHA256, 'installed provenance receipt hash mismatch')
  const receipt = JSON.parse(raw)
  const provenance = reviewedInstalledReceipt(receipt)
  check(sha256(measurementsBytes) === receipt.measurements_sha256, 'measurement file hash mismatch')
  check(hashInstalledTree(receipt.installed_app) === receipt.installed_tree_sha256, 'installed app tree hash mismatch')
  return provenance
}

function bindInstalled([measurementsPath, appPath, provenancePath, sourceEvidencePath, outputPath]) {
  if (!outputPath) throw new Error('usage: project-release-evidence.mjs bind-installed MEASUREMENTS_JSON INSTALLED_APP REVIEWED_PROVENANCE_JSON SOURCE_INSTALL_RECEIPT PRIVATE_OUT')
  const receipt = { schema_version: 1, provenance: readJson(provenancePath), installed_app: resolve(appPath),
    installed_tree_sha256: hashInstalledTree(resolve(appPath)), measurements_sha256: sha256(readFileSync(measurementsPath)),
    source_evidence: { path: resolve(sourceEvidencePath), sha256: sha256(readFileSync(sourceEvidencePath)) } }
  reviewedInstalledReceipt(receipt)
  const raw = JSON.stringify(receipt) + '\n'; writeNew(outputPath, raw)
  process.stdout.write(`${JSON.stringify({ status: 'INSTALLED_BYTES_BOUND_NOT_SOURCE_DISCOVERED', receipt_sha256: sha256(raw), source_commit: receipt.provenance.emate_commit })}\n`)
}

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
  const measurementsBytes = readFileSync(measurementsPath)
  const measurements = JSON.parse(measurementsBytes)
  if (Object.keys(measurements).sort().join(',') !== 'batches,fixed_set_sha256,measured_at') throw new Error('GUI measurements require exactly measured_at, fixed_set_sha256, and batches')
  const provenance = installedGuiProvenance(measurementsBytes)
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
    else if (command === 'bind-installed') bindInstalled(args)
    else if (command === 'gui') gui(args)
    else if (command === 'compose') compose(args)
    else if (command === 'project') project(args)
    else throw new Error('usage: project-release-evidence.mjs <open|bind-installed|gui|compose|project> ...')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
