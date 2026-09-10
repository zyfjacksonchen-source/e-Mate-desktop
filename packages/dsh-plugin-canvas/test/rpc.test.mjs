import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { zipSync, unzipSync, strToU8 } from 'fflate'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import { LocalFileSystem } from '../../../upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'
import { handleCanvas } from '../src/index.ts'
import { emptyProject, intentMarker } from '../src/contract.ts'
import { insertAsset } from '../src/client/model.ts'
import { saveProject, canvasDirectory } from '../src/project-files.ts'
import { nativeImageOutputs, requestCalls } from '../src/native-artifacts.ts'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const hash = createHash('sha256').update(png).digest('hex')
const ref = { attachmentId: `sha256:${hash}`, mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: 'image.png' }
const asset = { ownerSessionId: 'parent', ref }
const intent = { id: 'request', kind: 'image', pageId: 'page-1', sessionId: 'parent', sourceIds: [], imported: [] }
const event = (seq, type, data) => ({ seq, type, data })
function nativeEvents(status = 'completed') {
  return [event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `${intentMarker('request')}\ndraw a tree` }] }),
    event(2, 'tool/call', { turn: 1, callId: 'image-call', name: 'imagegen' }),
    event(3, 'emate/image-output', { schema_version: 2, status, call_id: 'image-call', revision: 2, parent_session_id: 'parent', output: ref, content: [{ type: 'image', attachment: ref }] })]
}
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'canvas-rpc-')))
  const native = new Context(); const fiber = await native.plugin(LocalFileSystem, { cwd: root })
  t.after(async () => { await fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const session = { header: { id: 'parent' }, events: nativeEvents() }
  let reads = 0
  const ctx = { fs: native.fs, workspaceRegistry: { archivedSessionIds: [], list: () => [{ path: root, sessionIds: ['parent'] }] },
    sessions: { get: id => id === 'parent' ? session : undefined }, sessionPersistence: { async load() { throw new Error('not found') } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    attachments: { async readImage() { reads++; return { ref, data: png } }, async saveImage() { return ref } } }
  return { root, ctx, session, reads: () => reads, call: async (endpoint, value = {}) => JSON.parse(JSON.stringify(await handleCanvas(ctx, endpoint, { session_id: 'parent', ...value }))) }
}
test('native completed attachment can be inserted once and immutable existing assets avoid repeated CAS reads on drawing saves', async t => {
  const h = await setup(t)
  const resolved = await h.call('resolve-image', { owner_session_id: 'parent', attachment_id: ref.attachmentId })
  assert.equal(resolved.ok, true)
  let document = insertAsset(emptyProject('main'), 'page-1', resolved.value)
  document = insertAsset(document, 'page-1', resolved.value)
  assert.equal(document.assets.length, 1); assert.equal(document.pages[0].elements.length, 1)
  const saved = await h.call('save', { project_id: 'main', project: document, expected_revision: null })
  assert.equal(saved.ok, true)
  const reads = h.reads()
  const next = await h.call('save', { project_id: 'main', project: { ...document, title: 'drawing changed' }, expected_revision: saved.value.revision })
  assert.equal(next.ok, true); assert.equal(h.reads(), reads)
  const loaded = await h.call('image', { project_id: 'main', attachment_id: ref.attachmentId })
  assert.deepEqual(Buffer.from(loaded.value.bytes_base64, 'base64'), png)
})
test('portable project export includes real bytes and import validates paths and every hash', async t => {
  const h = await setup(t)
  const project = insertAsset(emptyProject('main'), 'page-1', asset)
  await h.call('save', { project_id: 'main', project, expected_revision: null })
  const exported = await h.call('export', { project_id: 'main' })
  assert.equal(exported.ok, true)
  const entries = unzipSync(Buffer.from(exported.value.archive_base64, 'base64'))
  assert.deepEqual(Buffer.from(entries[`assets/${hash}.png`]), png)
  const imported = await h.call('import', { project_id: 'copy', archive_base64: exported.value.archive_base64 })
  assert.equal(imported.ok, true); assert.equal(imported.value.project.assets[0].ref.attachmentId, ref.attachmentId)
  assert.equal((await h.call('load', { project_id: 'copy' })).value.project.pages[0].elements.length, 1)
  entries[`assets/${hash}.png`] = strToU8('bad')
  assert.equal((await h.call('import', { project_id: 'bad-hash', archive_base64: Buffer.from(zipSync(entries)).toString('base64') })).ok, false)
  entries['../escape'] = strToU8('escape')
  assert.equal((await h.call('import', { project_id: 'escape', archive_base64: Buffer.from(zipSync(entries)).toString('base64') })).ok, false)
})
test('RPC rejects unknown ownership, archived sessions, readonly writes and caller-controlled paths', async t => {
  const h = await setup(t)
  assert.equal((await h.call('resolve-image', { owner_session_id: 'foreign', attachment_id: ref.attachmentId })).ok, false)
  assert.equal((await h.call('save', { project_id: 'main', project: emptyProject('main'), expected_revision: null, path: '/tmp/escape' })).ok, false)
  h.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only' })
  assert.equal((await h.call('save', { project_id: 'main', project: emptyProject('main'), expected_revision: null })).error.code, 'read-only')
  h.ctx.workspaceRegistry.archivedSessionIds.push('parent')
  assert.equal((await h.call('list')).ok, false)
})
test('only exact native request turns and completed receipts return image artifacts; unknown/replayed/ambiguous scopes do not', async t => {
  const h = await setup(t)
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [asset])
  h.session.events = nativeEvents('unknown'); assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
  h.session.events = nativeEvents(); h.session.events[3].data.call_id = 'foreign'; assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
  h.session.events = nativeEvents(); h.session.events.push(event(4, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `${intentMarker('second')}\nother request` }] }))
  assert.equal(requestCalls(h.session.events, intent), null)
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
})

test('a completed child task is importable before the whole batch ends; foreign receipt correlations are rejected', async t => {
  const h = await setup(t)
  const taskId = `sha256:${'d'.repeat(64)}`
  const child = { header: { id: 'child', parentSession: 'parent' }, events: [event(1, 'emate/image-output', {
    schema_version: 2, status: 'completed', call_id: 'child-call', revision: 2, parent_session_id: 'child',
    client_request_id: `image-${'d'.repeat(64)}`, output: ref,
  })] }
  h.ctx.sessions.get = id => id === 'child' ? child : id === 'parent' ? h.session : undefined
  h.session.events = nativeEvents().slice(0, 3)
  h.session.events[2].data.name = 'image_batch'
  h.session.events.push(event(3, 'emate/image-batch', { kind: 'task-state', parent_call_id: 'image-call', task: {
    task_id: taskId, state: 'completed', child_session_id: 'child', receipt: { owner_session_id: 'child', status: 'completed', call_id: 'child-call', revision: 2, event_seq: 1 },
  } }))
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [{ ownerSessionId: 'child', ref }])
  child.events[0].data.client_request_id = 'foreign'
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
})


test('same-workspace sessions isolate projects and explicitly copy legacy files without deleting them', async t => {
  const h = await setup(t)
  h.ctx.workspaceRegistry.list = () => [{ path: h.root, sessionIds: ['parent', 'other'] }]
  h.ctx.sessions.get = id => ['parent', 'other'].includes(id) ? { header: { id }, events: [] } : undefined
  const call = (id, endpoint, value = {}) => handleCanvas(h.ctx, endpoint, { session_id: id, ...value })
  const old = { ...emptyProject('main'), title: '旧工作区海报' }
  await saveProject(h.ctx.fs, h.root, old, null)
  const oldPath = join(await canvasDirectory(h.root), 'main.json')
  const before = await readFile(oldPath)
  assert.deepEqual(await call('parent', 'list'), { ok: true, value: [] })
  assert.deepEqual(await call('parent', 'load', { project_id: 'main' }), { ok: true, value: null })
  for (const id of ['parent', 'other']) {
    const saved = await call(id, 'save', { project_id: 'main', project: { ...emptyProject('main'), title: id }, expected_revision: null })
    assert.equal(saved.ok, true)
  }
  assert.equal((await call('parent', 'load', { project_id: 'main' })).value.project.title, 'parent')
  assert.equal((await call('other', 'load', { project_id: 'main' })).value.project.title, 'other')
  assert.equal((await call('parent', 'legacy-list')).value[0].title, old.title)
  assert.equal((await call('parent', 'import-legacy', { legacy_project_id: 'main', project_id: 'copied' })).ok, true)
  assert.equal((await call('parent', 'load', { project_id: 'copied' })).value.project.title, old.title)
  assert.deepEqual(await call('other', 'load', { project_id: 'copied' }), { ok: true, value: null })
  assert.deepEqual(await readFile(oldPath), before)
  const forged = await call('parent', 'load', { project_id: 'main', owner: 'other' })
  assert.equal(forged.ok, false)
})


test('new direct and Code multi-image receipts keep original request scope and resolve through the existing native attachment route', async t => {
  const h = await setup(t)
  const second = { ...ref, attachmentId: 'sha256:' + 'b'.repeat(64) }
  for (const name of ['generate_image', 'edit_image', 'run_code']) {
    const rootCallId = 'root-image', callId = name === 'run_code' ? rootCallId + ':code:0' : rootCallId
    h.session.events = nativeEvents().slice(0, 2).concat([
      event(2, 'tool/call', { turn: 1, callId: rootCallId, name }),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(4, 'turn/start', { turn: 2 }),
      event(5, 'emate/image-output', { schema_version: 3, turn: 1, status: 'completed', revision: 2,
        call_id: callId, root_call_id: rootCallId, tool_name: name === 'edit_image' ? name : 'generate_image',
        parent_session_id: 'parent', content: [ref, second].map(attachment => ({ type: 'image', attachment })) }),
    ])
    for (const status of ['completed', 'failed', 'cancelled']) {
      h.session.events.at(-1).data.status = status
      assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [asset, { ownerSessionId: 'parent', ref: second }])
      assert.equal((await h.call('resolve-image', { owner_session_id: 'parent', attachment_id: ref.attachmentId })).ok, true)
    }
    h.session.events.at(-1).data.root_call_id = 'unrelated'
    assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
    h.session.events.at(-1).data.root_call_id = rootCallId
    h.session.events[2].data.turn = 2
    assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
  }
})

test('native typed result images confer exact request scope but prose and error results never do', async t => {
  const h = await setup(t)
  h.session.events = nativeEvents().slice(0, 3)
  const result = { type: 'tool-result', toolCallId: 'image-call', isError: false, content: [{ type: 'image', attachment: ref }] }
  h.session.events.push(event(3, 'tool/result', { turn: 1, message: { content: [result] } }))
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [asset])
  assert.equal((await h.call('resolve-image', { owner_session_id: 'parent', attachment_id: ref.attachmentId })).ok, true)
  result.isError = true
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
  assert.equal((await h.call('resolve-image', { owner_session_id: 'parent', attachment_id: ref.attachmentId })).ok, false)
  result.isError = false; result.content = [{ type: 'text', text: JSON.stringify(ref) }]
  assert.deepEqual(await nativeImageOutputs(h.ctx, 'parent', intent), [])
})
