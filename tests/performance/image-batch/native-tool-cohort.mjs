import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { nativeModules, NATIVE_EXECUTION, IMAGE_MODEL } from '../image-single/native-fixture.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const groups = count => count <= 4 ? [count] : [4, count - 4]
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u

async function writeNew(path, bytes) {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  assert.equal(sha256(await readFile(path)), sha256(bytes), 'private evidence readback mismatch')
}

// Caller supplies the already-authorized native host. This driver creates no
// login, provider transport, Tool registration, scheduler or replacement Agent.
// The main agent owns the live entry point and separately measured installed UI.
export async function runNativeToolCohort({ ctx, agent, cases, outputDirectory, provenance, signal,
  executionId = randomUUID() }) {
  assert.ok(ctx?.tools?.execute && ctx?.jobs?.wait && ctx?.attachments?.readImage && agent?.session?.append)
  assert.ok(ctx.tools.get('generate_image'), 'current native generate_image Tool is required')
  assert.equal(ctx.tools.get('image_batch'), undefined, 'retired batch Tool cannot drive this cohort')
  assert.ok(idPattern.test(executionId) && isAbsolute(outputDirectory))
  assert.match(provenance?.emate_commit ?? '', /^[0-9a-f]{40}$/u)
  assert.equal(provenance?.harness_commit, '78a2b98562185d6fe46f4071653cae61132bf1ea')
  assert.equal(provenance?.version, '2.0.18')
  assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 1000)
  const ids = new Set()
  for (const entry of cases) {
    assert.ok(idPattern.test(entry.id) && !ids.has(entry.id)); ids.add(entry.id)
    assert.ok([1, 2, 4, 5, 8].includes(entry.task_count))
    assert.ok(typeof entry.prompt === 'string' && entry.prompt.trim() && entry.prompt.length <= 20000)
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'prompt', 'task_count'])
  }
  signal?.throwIfAborted()
  const m = await nativeModules()
  const plan = cases.map(entry => ({ id: entry.id, requested_count: entry.task_count, prompt_sha256: sha256(entry.prompt),
    control_call_id: executionId + '-' + entry.id + '-control',
    tool_calls: groups(entry.task_count).map((count, index) => ({ call_id: executionId + '-' + entry.id + '-' + index, count })) }))
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 })
  await writeNew(join(outputDirectory, 'execution.json'), Buffer.from(JSON.stringify({ schema_version: 1,
    execution_id: executionId, execution_contract: NATIVE_EXECUTION, owner_session_id: String(agent.session.header.id),
    provenance, model: IMAGE_MODEL, calls: plan }) + '\n'))
  await writeNew(join(outputDirectory, 'started.json'), Buffer.from(JSON.stringify({ execution_id: executionId, started_at: new Date().toISOString() }) + '\n'))
  const report = { schema_version: 1, execution_contract: NATIVE_EXECUTION, execution_id: executionId, provenance,
    model: IMAGE_MODEL, claim: 'native-tools-provider-cohort-not-conversation-latency-not-installed-ui-not-release-pass',
    started_at: new Date().toISOString(), run_status: 'COMPLETE', cases: [],
    external_gates: { installed_same_source: 'OPEN', first_visible_actual_ui: 'OPEN', provider_billing_correlation: 'OPEN',
      quality: 'OPEN', hundred_round_fixed_set: 'OPEN', production_latency: 'OPEN' } }
  const position = agent.session.events.findLast(event => event.type === 'step/start')?.data
  assert.ok(Number.isSafeInteger(position?.turn) && Number.isSafeInteger(position?.step), 'caller must supply an entered native step')
  async function execute(entry, count, callId) {
    const began = performance.now(), { turn, step } = position
    signal?.throwIfAborted()
    // The benchmark explicitly creates a programmatic request, never a fake
    // model response receipt. Tool result publication uses the pinned Session DTO.
    const args = { prompt: entry.prompt, count }
    const call = agent.session.append('tool/call', { turn, step, callId, name: 'generate_image', arguments: JSON.stringify(args) })
    let result, failure
    try { result = await ctx.tools.execute({ name: 'generate_image', arguments: args, agent, callId, rootCallId: callId,
      signal: signal ?? new AbortController().signal }) }
    catch (error) { failure = error }
    if (result) agent.session.append('tool/result', { turn, step,
      message: m.createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    const receipts = agent.session.events.filter(event => event.type === 'emate/image-output'
      && event.data?.schema_version === 3 && event.data.call_id === callId && event.data.revision === 2)
    assert.ok(receipts.length <= 1, 'duplicate native terminal receipt')
    const receipt = receipts[0]?.data
    if (receipt) await ctx.jobs.wait(receipt.job_id, 1000, agent)
    const retained = []
    for (const [index, block] of (receipt?.content ?? []).entries()) {
      const stored = await ctx.attachments.readImage(block.attachment)
      const bytes = Buffer.from(stored.data), hash = sha256(bytes)
      assert.equal(block.attachment.attachmentId, 'sha256:' + hash)
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[block.attachment.mediaType]
      assert.ok(extension, 'actual output media type is unsupported')
      const file = callId + '-' + index + '.' + extension
      await writeNew(join(outputDirectory, file), bytes)
      retained.push({ file, sha256: hash, bytes: bytes.length, media_type: block.attachment.mediaType,
        width: block.attachment.width, height: block.attachment.height })
    }
    const row = { call_id: callId, requested_count: count, elapsed_ms: performance.now() - began,
      status: receipt?.status ?? 'unknown', returned_count: receipt?.returned_count ?? 0,
      failed_count: receipt?.failed_count ?? null, tool_error: failure !== undefined || result?.isError === true,
      job_id: receipt?.job_id ?? null, task_id: receipt?.task_id ?? null,
      client_request_ids: receipt?.client_request_ids ?? [], provider_request_ids: receipt?.provider_request_ids ?? [],
      request_receipts: (receipt?.request_receipts ?? []).map(item => ({ client_request_id: item.client_request_id,
        task_id: item.task_id, trace_id: item.trace_id, ...(item.provider_request_id ? { provider_request_id: item.provider_request_id } : {}),
        ...(item.image_sha256 ? { image_sha256: item.image_sha256 } : {}) })),
      retained_images: retained }
    if (!receipt || failure || result?.isError) report.run_status = 'INCOMPLETE'
    if (receipt) {
      assert.equal(retained.length, receipt.returned_count)
      assert.equal(new Set(row.client_request_ids).size, row.client_request_ids.length)
      assert.equal(row.request_receipts.length, row.client_request_ids.length)
      for (const request of row.request_receipts) {
        assert.equal(request.task_id, request.client_request_id); assert.equal(request.trace_id, request.client_request_id)
      }
      for (const image of retained) assert.ok(row.request_receipts.some(request => request.image_sha256 === image.sha256), 'CAS image requires its actual provider receipt')
    }
    await writeNew(join(outputDirectory, callId + '.json'), Buffer.from(JSON.stringify(row) + '\n'))
    return row
  }
  for (const [index, entry] of cases.entries()) {
    const planned = plan[index]
    const control = await execute(entry, 1, planned.control_call_id)
    // A failed/unknown control never starts a new provider group automatically.
    if (control.status !== 'completed' || control.returned_count !== 1 || control.tool_error) {
      report.run_status = 'INCOMPLETE'; report.cases.push({ id: entry.id, control, tools: [] }); break
    }
    const results = await Promise.allSettled(planned.tool_calls.map(call => execute(entry, call.count, call.call_id)))
    const tools = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    report.cases.push({ id: entry.id, requested_count: entry.task_count, tool_counts: groups(entry.task_count), control, tools })
    if (results.some(result => result.status === 'rejected') || tools.some(tool => tool.status !== 'completed'
      || tool.returned_count !== tool.requested_count || tool.tool_error)) { report.run_status = 'INCOMPLETE'; break }
  }
  report.finished_at = new Date().toISOString()
  await writeNew(join(outputDirectory, 'cohort.json'), Buffer.from(JSON.stringify(report, null, 2) + '\n'))
  return report
}
