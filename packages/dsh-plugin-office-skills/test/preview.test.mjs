import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { createOfficePreview } from '../lib/preview.js'

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
  const session = { header: { id: 'session-1', cwd: root } }
  const ctx = {
    emateIdentity: { localAccountPrincipal: () => principal }, sessions: { get: () => session },
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
  return { root, project, opened, ctx, host, call, temporaryPaths, renders: () => renders, reads: () => reads,
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
  await assert.rejects(f.call('roster'), /账号已变化/)
  assert.equal(f.renders(), 2)
})

test('rejects escaping assets, symlink resources and foreign sessions without render', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.project, 'svg_output')); await mkdir(join(f.project, 'images'))
  await writeFile(join(f.root, 'outside.png'), 'outside')
  await symlink(join(f.root, 'outside.png'), join(f.project, 'images', 'escape.png'))
  await writeFile(join(f.project, 'svg_output', '01.svg'), svg.replace('</svg>', '<image href="../images/escape.png"/></svg>'))
  await assert.rejects(f.call('page', { page: '01.svg' }), /outside the project/)
  await assert.rejects(f.host.call('roster', { preview_id: f.opened.preview_id, session_id: 'foreign' }), /失效/)
  assert.equal(f.renders(), 0)
})

test('keeps unopened views alive, supports Chinese basenames and invalidates real asset edits without hot helper starts', { skip: !python && 'EMATE_TEST_PYTHON required' }, async t => {
  const f = await fixture(t)
  await f.host.open('deck', { agent: { session: { header: { id: 'session-1', cwd: f.root } } }, signal: new AbortController().signal })
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
