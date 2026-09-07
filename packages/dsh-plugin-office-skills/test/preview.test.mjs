import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { createOfficePreview } from '../lib/preview.js'
import { apply } from '../lib/index.js'
import { Session } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import { createMessage, createToolResultMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import { serverResponseSchema } from '../../../upstream/deepseek-harness/packages/host/apiproxy/lib/types/api/rpc.schema.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const python = process.env.EMATE_TEST_PYTHON
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text x="20" y="40">季度 2026 收入 100</text><rect x="1" y="1" width="2" height="2"/></svg>'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'emate-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const temporaryPaths = []
  t.after(async () => { for (const path of temporaryPaths) await assert.rejects(lstat(path), { code: 'ENOENT' }) })
  const project = join(root, 'deck')
  await mkdir(project)
  let principal = { tenantId: 'tenant', userId: 'user' }, renders = 0, reads = 0, mode = 'full-access'
  let session = Session.create('session-1', undefined, { ...Session.create('session-1').header, cwd: root })
  const ctx = {
    emateIdentity: { localAccountPrincipal: () => principal }, sessions: { get: id => id === session.header.id ? session : undefined },
    emateAudit: { ownsTask: (id, turn) => id === session.header.id && turn === 1 && principal?.tenantId === 'tenant' && principal?.userId === 'user' },
    workspaceRegistry: { list: () => [{ path: root, sessionIds: ['session-1'] }], archivedSessionIds: [] },
    shellEnv: { collect: () => ({ DSH_EMATE_PYTHON: python }) },
    sandboxPolicy: { resolve: () => ({ mode }) },
    fs: { resolve: async path => path, stat: async path => ({ version: digest(await readFile(path)) }),
      writeText: async (path, text, expected) => { assert.equal(digest(await readFile(path)), expected.version); await writeFile(path, text) } },
    desktopRuntime: { async renderSvgPage({ svg, width, height, signal }) { signal.throwIfAborted(); renders++; assert.match(svg, /<svg/); return { png: Buffer.from('test-render-bytes'), width, height } } },
    subprocess: { spawn(spec) {
      reads++
      temporaryPaths.push(JSON.parse(spec.stdio.stdin.data).temporary)
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      const abort = () => child.kill()
      spec.signal.addEventListener('abort', abort, { once: true })
      child.stdin.end(spec.stdio.stdin.data)
      return { collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } },
        done: new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => { spec.signal.removeEventListener('abort', abort); resolve({ exitCode }) }) }) }
    } },
  }
  const host = createOfficePreview(ctx)
  t.after(() => host.dispose())
  const opened = await host.open('deck', { agent: { session }, signal: new AbortController().signal })
  const call = (action, body = {}) => host.call(action, { preview_id: opened.preview_id, session_id: 'session-1', ...body })
  return { root, project, opened, ctx, host, call, temporaryPaths, session: () => session, restoreSession: value => { session = value }, renders: () => renders, reads: () => reads,
    changeAccount: () => { principal = { tenantId: 'tenant', userId: 'other' } }, readonly: () => { mode = 'read-only' } }
}

test('opens an empty roster, follows real pages and reuses only matching source/asset hashes', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  assert.deepEqual(f.opened.pages, [])
  assert.deepEqual(await f.call('roster'), { pages: [] })
  await mkdir(join(f.project, 'svg_output'))
  await writeFile(join(f.project, 'svg_output', '01.svg'), svg)
  assert.deepEqual((await f.call('roster')).pages, ['01.svg'])
  const first = await f.call('page', { page: '01.svg' })
  assert.equal(first.width, 1280)
  assert.equal(first.elements[0].text, '季度 2026 收入 100')
  assert.ok(first.elements[0].id)
  assert.equal((await f.call('page', { page: '01.svg', known_revision: first.revision })).png, undefined)
  assert.equal(f.renders(), 1)
  await writeFile(join(f.project, 'svg_output', '01.svg'), svg.replace('100', '200'))
  const next = await f.call('page', { page: '01.svg' })
  assert.notEqual(next.revision, first.revision)
  assert.equal(f.renders(), 2)
  await f.call('close')
  await f.call('page', { page: '01.svg' })
  assert.equal(f.renders(), 3)
})

test('edits exact element versions after export and preserves scope, numbers and source on conflict', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output'))
  const path = join(f.project, 'svg_output', '01.svg')
  await writeFile(path, svg)
  const first = await f.call('page', { page: '01.svg' })
  const body = { page: '01.svg', expected_revision: first.revision, change: { kind: 'text', element_id: first.elements[0].id, value: '中文 2027 额度 0' } }
  await assert.rejects(f.call('save', body), /先完成一次/)
  await mkdir(join(f.project, 'exports')); const zip = new JSZip().file('ppt/presentation.xml', '<presentation/>').file('[Content_Types].xml', '<Types/>'); await writeFile(join(f.project, 'exports', 'first.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
  const saved = await f.call('save', body)
  assert.equal(saved.saved, true); assert.match(saved.instruction, /canonical final/)
  assert.match(await readFile(path, 'utf8'), /中文 2027 额度 0/)
  await assert.rejects(f.call('save', body), /页面或素材已被修改/)
  const fresh = await f.call('page', { page: '01.svg' })
  await f.call('save', { ...body, expected_revision: fresh.revision, change: { kind: 'annotation', element_id: fresh.elements[1].id, value: '移到右侧 30px' } })
  assert.match(await readFile(path, 'utf8'), /data-edit-annotation="移到右侧 30px"/)
  f.readonly()
  await assert.rejects(f.call('save', body), /只读/)
  f.changeAccount()
  await assert.rejects(f.call('roster'), { code: 'preview-unauthorized' })
  assert.equal(f.renders(), 2)
})

test('rejects escaping assets, symlink resources and foreign sessions without render', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output')); await mkdir(join(f.project, 'images'))
  await writeFile(join(f.root, 'outside.png'), 'outside')
  await symlink(join(f.root, 'outside.png'), join(f.project, 'images', 'escape.png'))
  await writeFile(join(f.project, 'svg_output', '01.svg'), svg.replace('</svg>', '<image href="../images/escape.png"/></svg>'))
  await assert.rejects(f.call('page', { page: '01.svg' }), /outside the project/)
  await assert.rejects(f.host.call('roster', { preview_id: f.opened.preview_id, session_id: 'foreign' }), { code: 'preview-expired' })
  assert.equal(f.renders(), 0)
})

test('keeps unopened views alive, supports Chinese basenames and invalidates real asset edits without hot helper starts', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await f.host.open('deck', { agent: { session: f.session() }, signal: new AbortController().signal })
  await mkdir(join(f.project, 'svg_output')); await mkdir(join(f.project, 'images'))
  const image = join(f.project, 'images', 'photo.png')
  await writeFile(image, 'asset-one')
  await writeFile(join(f.project, 'svg_output', '第1页.svg'), svg.replace('</svg>', '<image href="../images/photo.png"/></svg>'))
  assert.deepEqual((await f.call('roster')).pages, ['第1页.svg'])
  const started = performance.now()
  const first = await f.call('page', { page: '第1页.svg' })
  const cold = performance.now() - started, reads = f.reads(), hot = []
  for (let i = 0; i < 10; i++) {
    const started = performance.now()
    await f.call('page', { page: '第1页.svg', known_revision: first.revision })
    hot.push(performance.now() - started)
  }
  assert.equal(f.reads(), reads)
  assert.equal(f.renders(), 1)
  await writeFile(image, 'asset-two')
  const changed = await f.call('page', { page: '第1页.svg' })
  assert.notEqual(changed.revision, first.revision)
  assert.equal(f.reads(), reads + 1); assert.equal(f.renders(), 2)
  t.diagnostic(JSON.stringify({ cold_ms: cold, hot_ms: hot, cold_helper_starts: reads, hot_helper_starts: 0, asset_change_helper_starts: 1, renderer: 'mock; pure Python helper and file IO are real' }))
})

test('close aborts only the view renderer; ambiguous CAS completion never claims a saved result', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output')); await writeFile(join(f.project, 'svg_output', '01.svg'), svg)
  const first = await f.call('page', { page: '01.svg' })
  await mkdir(join(f.project, 'exports'))
  await writeFile(join(f.project, 'exports', 'first.pptx'), await new JSZip().file('ppt/presentation.xml', '<presentation/>').file('[Content_Types].xml', '<Types/>').generateAsync({ type: 'nodebuffer' }))
  const write = f.ctx.fs.writeText
  f.ctx.fs.writeText = async (...args) => { await write(...args); await f.call('close'); throw new Error('reply lost after replace') }
  await assert.rejects(f.call('save', { page: '01.svg', expected_revision: first.revision, change: { kind: 'text', element_id: first.elements[0].id, value: '真实写入 0' } }), /保存结果尚未确认/)
  assert.match(await readFile(join(f.project, 'svg_output', '01.svg'), 'utf8'), /真实写入 0/)
  const refreshed = await f.call('page', { page: '01.svg' })
  assert.equal(refreshed.elements[0].text, '真实写入 0')
  await f.call('close')
  let started
  const rendering = new Promise(resolve => { started = resolve })
  f.ctx.desktopRuntime.renderSvgPage = ({ signal }) => new Promise((resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const pending = f.call('page', { page: '01.svg' }); const rejected = assert.rejects(pending)
  await rendering; await f.call('close'); await rejected
  assert.equal(f.ctx.jobs, undefined) // This view owner has no Job cancel capability.
})

test('tracks the requested resource path when an in-project symlink changes target and rejects an old edit revision', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output')); await mkdir(join(f.project, 'images'))
  await writeFile(join(f.project, 'images', 'a.png'), 'asset-a'); await writeFile(join(f.project, 'images', 'b.png'), 'asset-b')
  const alias = join(f.project, 'images', 'photo.png')
  await symlink(join(f.project, 'images', 'a.png'), alias)
  await writeFile(join(f.project, 'svg_output', '01.svg'), svg.replace('</svg>', '<image href="../images/photo.png"/></svg>'))
  const first = await f.call('page', { page: '01.svg' })
  await rm(alias); await symlink(join(f.project, 'images', 'b.png'), alias)
  await assert.rejects(f.call('save', { page: '01.svg', expected_revision: first.revision, change: { kind: 'text', element_id: first.elements[0].id, value: 'old edit' } }), /页面或素材已被修改/)
  const next = await f.call('page', { page: '01.svg' })
  assert.notEqual(next.revision, first.revision); assert.equal(f.renders(), 2)
  assert.match(await readFile(join(f.project, 'svg_output', '01.svg'), 'utf8'), /季度 2026/)
})

test('cancelled helper cleans its Host-owned temporary directory and preserves the source', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output')); const path = join(f.project, 'svg_output', '01.svg'); await writeFile(path, svg)
  let started
  const running = new Promise(resolve => { started = resolve })
  f.ctx.subprocess.spawn = spec => {
    f.temporaryPaths.push(JSON.parse(spec.stdio.stdin.data).temporary)
    started()
    return { collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: 'cancelled' }) } },
      done: new Promise(resolve => spec.signal.addEventListener('abort', () => resolve({ exitCode: 130 }), { once: true })) }
  }
  const pending = f.call('page', { page: '01.svg' }); const rejected = assert.rejects(pending)
  await running; await f.call('close'); await rejected
  assert.equal(await readFile(path, 'utf8'), svg)
  for (const directory of f.temporaryPaths) await assert.rejects(lstat(directory), { code: 'ENOENT' })
})


function recordNativePreview(f, { project = f.opened.project_path, args = { operation: 'preview', path: 'deck' }, name = 'office_read', isError = false } = {}) {
  const session = f.session(), callId = 'office-preview-call'
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'PPT project preview prepared' }], isError }),
    meta: { operation: 'preview', preview: { ...f.opened, project_path: project } },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

async function restarted(f, t) {
  f.host.dispose()
  await assert.rejects(f.call('roster'), { code: 'preview-expired' })
  const stored = join(f.root, 'native-session-fixture.json')
  await writeFile(stored, JSON.stringify({ header: f.session().header, events: f.session().events }))
  const value = JSON.parse(await readFile(stored, 'utf8'))
  f.restoreSession(Session.fromRestore(value.header.id, value.events, value.header))
  const host = createOfficePreview(f.ctx); t.after(() => host.dispose())
  return { host, call: (action, payload = {}, signal) => host.call(action, { preview_id: f.opened.preview_id, session_id: f.opened.session_id, ...payload }, signal) }
}

test('restores the same unknown lease from replayed native Tool receipt, deduplicates recovery and ignores renderer paths', async t => {
  const f = await fixture(t); recordNativePreview(f)
  const recovered = await restarted(f, t)
  let proofs = 0; const owns = f.ctx.emateAudit.ownsTask
  f.ctx.emateAudit.ownsTask = (...args) => { proofs++; return owns(...args) }
  const concurrent = await Promise.allSettled([recovered.call('roster', { project_path: '../../private' }), recovered.call('roster')])
  assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(proofs, 2) // Before and after async filesystem verification, one reconstruction.
  assert.deepEqual(await recovered.call('roster'), { pages: [] }); assert.equal(proofs, 2)
  await recovered.call('close'); assert.deepEqual(await recovered.call('roster'), { pages: [] })
  assert.equal(f.ctx.jobs, undefined)
})

test('recovery rejects a different account, missing audit proof, altered call/project, archived Session and text-only JSON', async t => {
  for (const kind of ['owner', 'proof', 'project', 'tool', 'error', 'archived', 'text']) {
    await t.test(kind, async t => {
      const f = await fixture(t)
      if (kind === 'text') f.session().append('assistant/message', { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ preview: f.opened }) }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
      else recordNativePreview(f, kind === 'project' ? { project: '.' } : kind === 'tool' ? { name: 'some_other_tool' } : kind === 'error' ? { isError: true } : {})
      const recovered = await restarted(f, t)
      if (kind === 'owner') f.changeAccount()
      if (kind === 'proof') f.ctx.emateAudit.ownsTask = () => false
      if (kind === 'archived') f.ctx.workspaceRegistry.archivedSessionIds.push('session-1')
      await assert.rejects(recovered.call('roster'), { code: ['owner', 'proof'].includes(kind) ? 'preview-unauthorized' : 'preview-expired' })
      assert.equal(f.renders(), 0); assert.equal(f.reads(), 0)
    })
  }
})

test('closing a pending restoration aborts only that view and a subsequent open can recover afresh', async t => {
  const f = await fixture(t); recordNativePreview(f)
  const recovered = await restarted(f, t)
  const pending = recovered.call('roster'); const rejected = assert.rejects(pending)
  await recovered.call('close'); await rejected
  assert.deepEqual(await recovered.call('roster'), { pages: [] })
  f.changeAccount(); recovered.host.changed()
  await assert.rejects(recovered.call('roster'), { code: 'preview-unauthorized' })
})

test('a recovered preview reads saved source bytes and rejects the previous edit CAS revision', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output')); const path = join(f.project, 'svg_output', '01.svg'); await writeFile(path, svg)
  const before = await f.call('page', { page: '01.svg' })
  await mkdir(join(f.project, 'exports'))
  await writeFile(join(f.project, 'exports', 'first.pptx'), await new JSZip().file('ppt/presentation.xml', '<presentation/>').file('[Content_Types].xml', '<Types/>').generateAsync({ type: 'nodebuffer' }))
  const change = { kind: 'text', element_id: before.elements[0].id, value: '保存后的中文 0' }
  await f.call('save', { page: '01.svg', expected_revision: before.revision, change })
  recordNativePreview(f)
  const recovered = await restarted(f, t)
  const after = await recovered.call('page', { page: '01.svg' })
  assert.equal(after.elements[0].text, '保存后的中文 0')
  await assert.rejects(recovered.call('save', { page: '01.svg', expected_revision: before.revision, change }), /页面或素材已被修改/)
  assert.match(await readFile(path, 'utf8'), /保存后的中文 0/)
})

test('preview RPC business errors pass the pinned native response schema without unsupported error codes', async t => {
  const f = await fixture(t), handlers = new Map(), disposers = []
  const host = { ...f.ctx, connection: { rpc: { handle(channel, callback) { handlers.set(channel, callback); return () => handlers.delete(channel) } } },
    effect(callback) { disposers.push(callback()) }, on() {}, timeout() {} }
  apply({ inject(dependencies, callback) { if (dependencies.includes('connection')) { assert(dependencies.includes('emateAudit')); callback(host) } },
    skills: { registerProvider() {} }, tools: { register() { return () => {} } }, jobs: { attachController() { return () => {} } },
    sandboxPolicy: f.ctx.sandboxPolicy, emateCapabilities: { register() { return () => {} } }, effect(callback) { disposers.push(callback()) } })
  t.after(() => { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose() })
  const handler = handlers.get('/emate.officePreview')
  const result = await handler('roster', { preview_id: 'missing', session_id: 'session-1' }, new AbortController().signal)
  const parsed = serverResponseSchema.parse({ type: 'server-response', rpcId: 'preview-test', result })
  assert.equal(parsed.result.ok, true); assert.equal(parsed.result.value.error.code, 'preview-expired')
  assert(!JSON.stringify(parsed).includes('invalid_union'))
})


test('opening before any lease exists cannot adopt an account changed during filesystem resolution or revive after disposal', async t => {
  for (const kind of ['account', 'dispose']) await t.test(kind, async t => {
    const f = await fixture(t); f.host.dispose()
    const host = createOfficePreview(f.ctx); t.after(() => host.dispose())
    const pending = host.open('deck', { agent: { session: f.session() }, signal: new AbortController().signal })
    const rejected = assert.rejects(pending)
    if (kind === 'account') { f.changeAccount(); host.changed() } else host.dispose()
    await rejected
    assert.equal(f.reads(), 0); assert.equal(f.renders(), 0)
  })
})
