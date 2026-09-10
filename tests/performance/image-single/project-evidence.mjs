#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_REFERENCE, HARNESS_COMMIT, RELEASE_VERSION, TICKET, createOpenManifest, createPassManifest, nearestRank, sha256, validateGuiEvidence, validateManifest } from './protocol.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const SHA256 = /^[0-9a-f]{64}$/u
const writeNew = (path, value) => writeFileSync(path, value, { flag: 'wx', mode: 0o600 })

async function gui([measurementsPath, outputPath]) {
  if (!outputPath) throw new Error('usage: project-evidence.mjs gui MEASUREMENTS_JSON GUI_RAW_OUT')
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty) throw new Error('EM218-108 GUI evidence requires a clean committed worktree')
  const machine = process.env.EMATE_EVIDENCE_MACHINE_NAME
  const appBundle = process.env.EMATE_EVIDENCE_APP_BUNDLE_SHA256
  if (!machine || machine.length > 128 || !SHA256.test(appBundle ?? '')) throw new Error('EMATE_EVIDENCE_MACHINE_NAME and EMATE_EVIDENCE_APP_BUNDLE_SHA256 are required')
  const measurementsBytes = readFileSync(measurementsPath)
  const measurements = JSON.parse(measurementsBytes)
  const runner = await import('../image-batch/project-release-evidence.mjs')
  if (typeof runner.installedGuiProvenance !== 'function') throw new Error('Merge the reviewed installed-provenance runner before collecting current GUI evidence')
  const installedProvenance = runner.installedGuiProvenance(measurementsBytes)
  if (!measurements || Object.keys(measurements).sort().join(',') !== 'latencies_ms,measured_at'
    || !Array.isArray(measurements.latencies_ms)) throw new Error('measurements require exactly measured_at and latencies_ms')
  const samples = measurements.latencies_ms.map((latency_ms, index) => ({ sample: index + 1, latency_ms }))
  const value = {
    schema_version: 1, ticket: TICKET, claim: 'macos-dev-cached-terminal-projection-first-visible-v1',
    protocol: { clock: 'performance.now monotonic', stimulus: 'cached-local-bytes', start: 'terminal-projection-handoff',
      end: 'first-visible-image', percentile: 'nearest-rank', minimum_samples: 100, p95_limit_ms: 500 },
    provenance: installedProvenance,
    environment: { class: 'macos-app-directory-dev', machine_sha256: createHash('sha256').update(machine).digest('hex'), app_bundle_sha256: appBundle },
    measured_at: measurements.measured_at, samples, p95_ms: nearestRank(measurements.latencies_ms, 0.95),
  }
  const raw = JSON.stringify(value) + '\n'
  const digest = sha256(raw)
  validateGuiEvidence(raw, { uri: `https://pre-upload.invalid/immutable/${digest}.json`, sha256: digest })
  writeNew(outputPath, raw)
  process.stdout.write(`${JSON.stringify({ ticket: TICKET, status: 'GUI_PASS_PENDING_UPLOAD', samples: samples.length, p95_ms: value.p95_ms, raw_sha256: digest })}\n`)
}

function project([sourceRawPath, sourceUri, guiRawPath, guiUri, openPath, outputPath]) {
  if (!outputPath) throw new Error('usage: project-evidence.mjs project SOURCE_RAW SOURCE_URI GUI_RAW GUI_URI OPEN_MANIFEST PASS_OUT')
  const openManifest = JSON.parse(readFileSync(openPath, 'utf8'))
  if (openManifest.status !== 'OPEN') throw new Error('OPEN_MANIFEST must be an exact OPEN manifest')
  validateManifest(openManifest)
  const sourceRaw = readFileSync(sourceRawPath)
  const guiRaw = readFileSync(guiRawPath)
  const aggregate = JSON.parse(sourceRaw.toString('utf8'))
  if (openManifest.ticket !== aggregate.ticket) throw new Error('OPEN manifest and raw evidence release identities differ')
  const manifest = createPassManifest(aggregate, sourceUri, sourceRaw, guiRaw, guiUri)
  writeNew(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ticket: manifest.ticket, status: 'PASS', source_sha256: sha256(sourceRaw), gui_sha256: sha256(guiRaw) })}\n`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'open' && args.length === 1) writeNew(args[0], JSON.stringify(createOpenManifest(), null, 2) + '\n')
    else if (command === 'gui') await gui(args)
    else if (command === 'project') project(args)
    else throw new Error('usage: project-evidence.mjs <open|gui|project> ...')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
