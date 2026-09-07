import assert from 'node:assert/strict'
import test from 'node:test'
import { createKnowledgeUiRead } from '../src/ui-read.ts'

const key = 'a'.repeat(64), hash = 'b'.repeat(64), parse = 'c'.repeat(64)
const id = 'a1234567-1234-1234-1234-123456789012', revision = 'b1234567-1234-1234-1234-123456789012'
const privateScope = { kind: 'uploader-private' }, project = { kind: 'project', project_id: 17 }
const exec = { agent: {} }
const original = (extra = {}) => ({ id, file_hash: hash, parse_revision: parse, project_id: 17, kind: 'knowledge', status: 'ready', ...extra })
const library = (scope = project) => ({ schema_version: 1, scope, corpus_revision: hash, truncated: false, items: [{ topic_key: 'source/' + id, title: '真实资料标题', revision_id: revision, source_versions: [{ source_id: id, source_version: hash, parse_revision: parse }] }] })
const imported = (scope = privateScope) => ({ schema_version: 1, scope, import_id: id, operation_id: 'original_operation_01', request_hash: hash, status: 'ready', source: original({ project_id: null }) })
function setup() {
  const calls = [], state = { owner: key, epoch: 1, response: undefined, wait: undefined, authorized: 0 }
  const read = createKnowledgeUiRead({
    workflow: { async authorize() { state.authorized++; return state.owner } },
    host: { async call(endpoint, payload) { calls.push(['host', endpoint, payload]); const owner = state.owner; await state.wait; return { scope_key: owner, result: state.response } } },
    xinCapture() {
      const owner = state.owner, epoch = state.epoch
      return { scope_key: owner, async call(name, args, signal) {
        calls.push(['xin', name, args]); await state.wait; signal?.throwIfAborted()
        if (owner !== state.owner || epoch !== state.epoch) throw Object.assign(Error('changed'), { code: 'scope-changed' })
        return state.response
      } }
    },
  })
  return { read, calls, state }
}
test('private/public scope objects route through existing Host; import lookup forwards only exact operation ID', async () => {
  const { read, calls, state } = setup()
  for (const scope of [privateScope, { kind: 'public' }]) {
    state.response = { source: original() }
    await read({ endpoint: 'source', payload: { scope, source_id: id, version: hash }, exec })
    assert.deepEqual(calls.at(-1), ['host', 'source', { source_id: id, version: hash, scope: scope.kind }])
    state.response = library(scope)
    await read({ endpoint: 'revisions', payload: { scope, limit: 100 }, exec })
    assert.deepEqual(calls.at(-1), ['host', 'revisions', { limit: 100, scope: scope.kind }])
    state.response = imported(scope)
    const reply = await read({ endpoint: 'import', payload: { scope, operation_id: 'original_operation_01' }, exec })
    assert.equal(reply.result.status, 'ready')
    assert.deepEqual(calls.at(-1), ['host', 'import', { operation_id: 'original_operation_01' }])
  }
  assert.ok(state.authorized >= 12)
})
test('A import accepts real awaiting-content shape without corpus_revision and rejects another operation/scope', async () => {
  const { read, state } = setup(), request = { endpoint: 'import', payload: { scope: privateScope, operation_id: 'original_operation_01' }, exec }
  state.response = { ...imported(), source: null, status: 'awaiting_content' }
  assert.equal((await read(request)).result.source, null)
  for (const patch of [{ operation_id: 'another_operation_01' }, { scope: { kind: 'public' } }, { status: 'complete' }, { import_id: null }]) {
    state.response = { ...imported(), source: null, status: 'awaiting_content', ...patch }
    await assert.rejects(read(request))
  }
})
test('project reads use exact B methods and preserve legacy inspect_source text JSON', async () => {
  const { read, state, calls } = setup()
  state.response = { content: [{ type: 'text', text: JSON.stringify({ source: original(), rows: [], row_count: 0, truncated: false }) }] }
  assert.equal((await read({ endpoint: 'source', payload: { scope: project, source_id: id, version: hash }, exec })).result.source.id, id)
  assert.deepEqual(calls.at(-1), ['xin', 'inspect_source', { source_id: id }])
  state.response = { structuredContent: { schema_version: 1, source: original() } }
  await read({ endpoint: 'import', payload: { scope: project, sha256: hash }, exec })
  assert.deepEqual(calls.at(-1), ['xin', 'find_imported_source', { project_id: 17, sha256: hash, kind: 'knowledge' }])
  state.response = { value: { structuredContent: library() } }
  await read({ endpoint: 'revisions', payload: { scope: project, question: '资料', limit: 20, corpus_revision: hash }, exec })
  assert.deepEqual(calls.at(-1), ['xin', 'list_knowledge_revisions', { project_id: 17, question: '资料', limit: 20, corpus_revision: hash }])
})
test('project source identity, hash, kind and actual project scope must match', async () => {
  const { read, state } = setup()
  for (const patch of [{ id: revision }, { file_hash: parse }, { project_id: 18 }, { kind: 'benchmark' }, { status: 'complete' }, { parse_revision: 'unknown' }]) {
    state.response = { structuredContent: { source: original(patch) } }
    await assert.rejects(read({ endpoint: 'source', payload: { scope: project, source_id: id, version: hash }, exec }))
  }
})
test('project directory is minimal, preserves read-only targets and derives completeness from actual envelope', async () => {
  const { read, state, calls } = setup()
  for (const status of ['complete', 'partial']) {
    state.response = { structuredContent: { schema_version: 1, status, source: 'xin-assistant', created_at: '2026-09-07T12:00:00+08:00', data: [{ id: 17, project_name: '知识专属项目', can_import: false, hidden: 'omit' }] } }
    assert.deepEqual(await read({ endpoint: 'projects', payload: {} }), { scope_key: key, result: { items: [{ id: 17, title: '知识专属项目', can_import: false }], complete: status === 'complete' } })
    assert.deepEqual(calls.at(-1), ['xin', 'query_knowledge_projects', { keyword: '' }])
  }
  assert.equal(state.authorized, 0)
})
test('directory unknown status, duplicate IDs, absent upload permission and foreign envelope fail closed', async () => {
  const { read, state } = setup(), item = { id: 17, project_name: '项目', can_import: true }
  for (const patch of [{ status: 'unknown' }, { source: 'other' }, { data: [item, item] }, { data: [{ id: 17, project_name: '项目' }] }]) {
    state.response = { structuredContent: { schema_version: 1, status: 'complete', source: 'xin-assistant', data: [item], ...patch } }
    await assert.rejects(read({ endpoint: 'projects', payload: {} }), { code: 'invalid-response' })
  }
})
test('MCP failed/ambiguous replies are errors, never an empty successful collection', async () => {
  const { read, state } = setup()
  for (const error of ['NOT_FOUND', 'AMBIGUOUS_SOURCE', 'FORBIDDEN']) {
    state.response = { structuredContent: { schema_version: 1, status: 'failed', error } }
    await assert.rejects(read({ endpoint: 'import', payload: { scope: project, sha256: hash }, exec }))
  }
})
test('revision snapshots retain truncation and reject mismatched scope, missing version and duplicate topic', async () => {
  const { read, state } = setup(), request = { endpoint: 'revisions', payload: { scope: project }, exec }
  state.response = { ...library(), truncated: true }
  assert.equal((await read(request)).result.truncated, true)
  for (const patch of [{ scope: { ...project, project_id: 18 } }, { corpus_revision: null }, { truncated: undefined }, { items: [library().items[0], library().items[0]] }, { items: [{ ...library().items[0], source_versions: [{ source_id: id, source_version: hash }] }] }]) {
    state.response = { ...library(), ...patch }; await assert.rejects(read(request))
  }
})
test('arbitrary fields/transports, missing native Agent and invalid IDs do not issue reads', async () => {
  const { read, calls } = setup()
  for (const request of [
    { endpoint: 'source', payload: { scope: project, source_id: id, version: hash } },
    { endpoint: 'projects', payload: { tenant: 'x' } },
    { endpoint: 'prepare_source_upload', payload: {} },
    { endpoint: 'import', payload: { scope: project, sha256: hash, operation_id: 'model_chosen_operation' }, exec },
    { endpoint: 'source', payload: { scope: { ...privateScope, tenant: 'x' }, source_id: id, version: hash }, exec },
    { endpoint: 'source', payload: { scope: project, source_id: '../source', version: hash }, exec },
    { endpoint: 'revisions', payload: { scope: project, limit: 101 }, exec },
  ]) await assert.rejects(read(request))
  assert.deepEqual(calls, [])
})
test('late Host and no-Agent Xin responses never cross account changes or disconnected epochs', async () => {
  for (const endpoint of ['source', 'projects']) {
    const { read, state } = setup()
    let finish; state.wait = new Promise(resolve => { finish = resolve })
    state.response = endpoint === 'source' ? { source: original() } : { schema_version: 1, source: 'xin-assistant', status: 'complete', data: [] }
    const pending = read(endpoint === 'source' ? { endpoint, payload: { scope: privateScope, source_id: id, version: hash }, exec } : { endpoint, payload: {} })
    await new Promise(resolve => setImmediate(resolve))
    state.owner = 'd'.repeat(64); state.epoch++; finish()
    await assert.rejects(pending, { code: 'scope-changed' })
  }
})
test('cancellation is checked before transport and after a delayed response', async () => {
  const { read, state, calls } = setup(), controller = new AbortController()
  controller.abort()
  await assert.rejects(read({ endpoint: 'projects', payload: {}, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls.length, 0)
  const late = new AbortController(); let finish
  state.wait = new Promise(resolve => { finish = resolve }); state.response = { source: original() }
  const pending = read({ endpoint: 'source', payload: { scope: privateScope, source_id: id, version: hash }, exec, signal: late.signal })
  await new Promise(resolve => setImmediate(resolve)); late.abort(); finish()
  await assert.rejects(pending, { name: 'AbortError' })
})
