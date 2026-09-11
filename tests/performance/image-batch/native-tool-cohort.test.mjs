import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNativeImageFixture } from '../image-single/native-fixture.mjs'
import { SMALL_PNG } from '../image-single/fixtures.mjs'
import { runNativeToolCohort } from './native-tool-cohort.mjs'

const provenance = { emate_commit: 'a'.repeat(40), harness_commit: 'bf7179bf3f62585d84b9b41b8cc1a0fffa1d7866', version: '2.0.18' }
const success = ordinal => new Response(JSON.stringify({ id: 'cohort-local-' + ordinal,
  data: [{ b64_json: SMALL_PNG.toString('base64') }] }), { headers: { 'content-type': 'application/json' } })

test('native cohort interface drives 1/2/4/[4,1]/[4,4], retains bytes and cannot reuse its execution directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emate-native-cohort-'))
  let active = 0, peak = 0
  const f = await createNativeImageFixture({ request: async (_url, _init, ordinal) => {
    active += 1; peak = Math.max(peak, active)
    await Promise.resolve(); active -= 1; return success(ordinal)
  } })
  try {
    const directory = join(root, 'first')
    const input = { ctx: f.ctx, agent: f.agent, outputDirectory: directory, provenance,
      cases: [1, 2, 4, 5, 8].map(count => ({ id: 'size-' + count, task_count: count, prompt: 'private fixture ' + count })) }
    const report = await runNativeToolCohort(input)
    assert.equal(f.calls.length, 25); assert.equal(active, 0); assert.ok(peak <= 4)
    assert.equal(report.run_status, 'COMPLETE')
    assert.deepEqual(report.cases.map(row => row.tool_counts), [[1], [2], [4], [4, 1], [4, 4]])
    const all = report.cases.flatMap(row => [row.control, ...row.tools])
    assert.equal(new Set(all.flatMap(row => row.client_request_ids)).size, 25)
    assert.equal(all.flatMap(row => row.request_receipts).length, 25)
    assert.equal(all.flatMap(row => row.retained_images).length, 25)
    for (const row of all) for (const retained of row.retained_images) assert.deepEqual(await readFile(join(directory, retained.file)), SMALL_PNG)
    for (const gate of Object.values(report.external_gates)) assert.equal(gate, 'OPEN')
    const execution = JSON.parse(await readFile(join(directory, 'execution.json')))
    assert.equal(execution.calls.length, 5)
    assert.equal(JSON.stringify(report).includes('private fixture'), false)
    assert.equal(JSON.stringify(execution).includes('private fixture'), false)
    await assert.rejects(runNativeToolCohort(input), /EEXIST/u)
    assert.equal(f.calls.length, 25)
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('partial native group settles siblings and retains every actual success before declaring incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emate-native-cohort-partial-'))
  const f = await createNativeImageFixture({ request: async (_url, _init, ordinal) => ordinal === 2
    ? new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    : success(ordinal) })
  try {
    const directory = join(root, 'partial')
    const report = await runNativeToolCohort({ ctx: f.ctx, agent: f.agent, outputDirectory: directory, provenance,
      cases: [{ id: 'eight', task_count: 8, prompt: 'local partial' }, { id: 'unstarted', task_count: 2, prompt: 'must remain unsubmitted' }] })
    assert.equal(report.run_status, 'INCOMPLETE'); assert.equal(f.calls.length, 9)
    assert.equal(report.cases.length, 1)
    assert.equal(report.cases[0].tools.reduce((sum, row) => sum + row.returned_count, 0), 7)
    assert.equal(report.cases[0].tools.flatMap(row => row.retained_images).length, 7)
    assert.equal(report.cases[0].tools.reduce((sum, row) => sum + row.failed_count, 0), 1)
    const persisted = JSON.parse(await readFile(join(directory, 'cohort.json')))
    assert.equal(persisted.run_status, 'INCOMPLETE')
    assert.equal(f.jobTerminals.length, 3)
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})
