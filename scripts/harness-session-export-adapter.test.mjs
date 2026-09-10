import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { adaptHarnessSessionExportSource, emateExportContent, emateExportFileRefs, emateExportMediaPath } from './harness-session-export-adapter.mjs'

const nativeRoot = process.env.EMATE_TEST_NATIVE_ROOT ?? resolve(import.meta.dirname, '..')
const native = await readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/session-query/session-log-export/lib/index.js'), 'utf8')
const adapted = adaptHarnessSessionExportSource(native)
const require = createRequire(join(nativeRoot, 'upstream/deepseek-harness/packages/session-query/session-log-export/package.json'))
const { Zip, ZipDeflate, unzipSync } = require('fflate')
// 0.1.5 names the root log entry by its format version (session.v3.jsonl).
const SESSION_LOG_ENTRY = require('@deepseek-ai/dsh-session-format')
  .sessionFormatLogFilename(require('@deepseek-ai/dsh-session').SESSION_FORMAT_VERSION)
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { LocalFileSystem } = await import(pathToFileURL(join(nativeRoot, 'upstream/deepseek-harness/packages/fs/fs-local/lib/index.js')))
function owner(source) {
  const start = source.indexOf('//#region lib/types/archive.js')
  const end = source.indexOf('//#endregion', start)
  // The archive region consumes the log-filename helper, the format version,
  // and the persistence error class from imports outside the slice, so the
  // fixture supplies all three explicitly.
  const { sessionFormatLogFilename } = require('@deepseek-ai/dsh-session-format')
  const { SESSION_FORMAT_VERSION } = require('@deepseek-ai/dsh-session')
  const { SessionPersistenceNotFoundError } = require('@deepseek-ai/dsh-session-persistence')
  return new Function('Zip', 'ZipDeflate', 'sessionFormatLogFilename', 'SESSION_FORMAT_VERSION', 'SessionPersistenceNotFoundError', `${source.slice(start, end)}\nreturn { streamSessionLogZip, sessionLogExportDeps };`)(Zip, ZipDeflate, sessionFormatLogFilename, SESSION_FORMAT_VERSION, SessionPersistenceNotFoundError)
}
const zipOwner = owner(adapted)
const line = value => JSON.stringify(value) + '\n'
const file = (name = 'report.pdf') => ({ stored_name: name, display_name: name, media_type: 'application/pdf', relative_path: `.e-mate/imports/${name}` })
const user = (ref = file()) => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user', mentions: [{ source: 'e-mate/file-import', ref: JSON.stringify(ref) }] }, content: [{ type: 'text', text: `Read @${ref.relative_path}` }] } })
const image = id => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: `${id}.png` } })
const staged = id => ({ type: 'emate/image-draft-staged', ignorable: true, data: { content: [image(id)] } })
const sentImage = id => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [image(id)] } })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'emate-export-owner-'))
  const ctx = new Context()
  const mounted = await ctx.plugin(LocalFileSystem, { cwd: dir })
  t.after(async () => { await mounted.dispose(); await rm(dir, { recursive: true, force: true }) })
  for (const name of ['root', 'child']) await mkdir(join(dir, name, '.e-mate/imports'), { recursive: true })
  const deps = {
    emateExportFs: ctx.fs,
    emateExportWorkspaces: { list: () => ['root', 'child'].map(id => ({ path: join(dir, id), sessionIds: [id] })) },
    attachments: { readImage: async ref => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }) },
    sessionQuery: { traceSession: async () => ({ descendants: [] }) },
    sessionPersistence: { readRaw: async () => undefined },
  }
  return { dir, deps }
}
async function archive(deps, content, descendants = false, selected = zipOwner, signal = new AbortController().signal) {
  // 0.1.5 takes the already-serialized root log text, not a filename envelope.
  const raw = content
  const stream = selected.streamSessionLogZip(deps, raw, 'root', descendants, 6, signal)
  const files = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))
  assert.equal(raw, content, 'export must never mutate the stored artifact')
  return files
}

test('pinned native owner reproduces staged-image disclosure and ordinary-file omission; adapted ZIP closes both', async t => {
  const { dir, deps } = await fixture(t)
  const bytes = new Uint8Array([80, 68, 70, 0, 255])
  await writeFile(join(dir, 'root', file().relative_path), bytes)
  const content = line({ type: 'session', id: 'root' }) + line(staged('never-sent-secret')) + line(user()) + line(sentImage('sent'))
  const old = await archive(deps, content, false, owner(native))
  assert.ok(old['media/never-sent-secret.png'])
  assert.equal(old[file().relative_path], undefined)
  const result = await archive(deps, content)
  assert.equal(result['media/never-sent-secret.png'], undefined)
  assert.deepEqual(result['media/sent.png'], new Uint8Array([1, 2, 3, 4]))
  assert.deepEqual(result['files/' + file().stored_name], bytes)
  assert.equal(new TextDecoder().decode(result[SESSION_LOG_ENTRY]), content.replace(line(staged('never-sent-secret')), ''))
})

test('draft filtering preserves non-draft bytes/line endings, handles escaped type, and fails closed on invalid JSON', () => {
  const ordinary = ' { "type": "user/message", "data": { "content": [] } }\r\n'
  assert.equal(emateExportContent(ordinary + '{"type":"emate/image-draft-\\u0073taged","data":{"private":"x"}}\n\n'), ordinary + '\n')
  assert.throws(() => emateExportContent('{"type":"emate/image-draft-staged",broken'), /unreadable event/)
  assert.throws(() => emateExportContent('unparseable artifact'), /unreadable event/)
})

test('descendant export uses its own workspace and filters drafts before native media deduplication', async t => {
  const { dir, deps } = await fixture(t)
  await writeFile(join(dir, 'root', file().relative_path), new Uint8Array([1]))
  await writeFile(join(dir, 'child', file().relative_path), new Uint8Array([2]))
  deps.sessionQuery.traceSession = async () => ({ descendants: [{ session: { header: { id: 'child' } }, descendants: [] }] })
  // 0.1.5 reads descendants through the persistence handle contract.
  deps.sessionPersistence.open = async () => ({
    header: { version: require('@deepseek-ai/dsh-session').SESSION_FORMAT_VERSION, id: 'child', createdAt: '2026-01-01T00:00:00.000Z', isSeeded: false },
    read: async () => ({ events: [staged('removed'), user(), sentImage('shared')] }),
    close: async () => {},
  })
  const result = await archive(deps, line(user()) + line(sentImage('shared')), true)
  assert.deepEqual(result['files/' + file().stored_name], new Uint8Array([1]))
  assert.deepEqual(result[`subagents/child/files/${file().stored_name}`], new Uint8Array([2]))
  assert.equal(result['media/removed.png'], undefined)
  assert.equal(new TextDecoder().decode(result[`subagents/child/${SESSION_LOG_ENTRY}`]).includes('removed'), false)
  assert.deepEqual(Object.keys(result).filter(path => path.startsWith('media/')), ['media/shared.png'])
})

test('only submitted native user identities authorize files; text, tool, assistant and non-user source do not', () => {
  const valid = user()
  assert.equal(emateExportFileRefs(line(valid) + line(valid)).length, 1)
  assert.equal(emateExportFileRefs(line({ type: 'agent/inbox/spliced', data: { inserted: [valid.data] } })).length, 1)
  for (const event of [
    { ...valid, type: 'assistant/message' }, { ...valid, type: 'tool/result' },
    { ...valid, data: { ...valid.data, role: 'assistant' } },
    { ...valid, data: { ...valid.data, source: { ...valid.data.source, kind: 'agent' } } },
    { ...valid, data: { ...valid.data, source: { kind: 'user', mentions: [{ source: 'workspace', ref: JSON.stringify(file()) }] } } },
    { ...valid, data: { ...valid.data, source: undefined } },
  ]) assert.deepEqual(emateExportFileRefs(line(event)), [])
  assert.throws(() => emateExportFileRefs(line({ ...valid, data: { ...valid.data, content: [] } })), /not submitted/)
  for (const unsafe of [
    { ...file(), relative_path: '/etc/passwd' }, { ...file(), stored_name: '../report.pdf', relative_path: '.e-mate/imports/../report.pdf' },
    { ...file(), media_type: 'text/plain' }, { ...file(), extra: 'value' },
  ]) assert.throws(() => emateExportFileRefs(line(user(unsafe))), /Invalid imported/)
})

test('missing and symlinked files/managed directories fail the entire native stream', async t => {
  const { dir, deps } = await fixture(t)
  await assert.rejects(archive(deps, line(user())), /missing or unsafe/)
  const target = join(dir, 'outside.pdf')
  await writeFile(target, 'secret')
  const imported = join(dir, 'root', file().relative_path)
  await symlink(target, imported)
  await assert.rejects(archive(deps, line(user())), /missing or unsafe/)
  await rm(imported)
  await rm(join(dir, 'root/.e-mate/imports'), { recursive: true })
  await symlink(join(dir, 'child/.e-mate/imports'), join(dir, 'root/.e-mate/imports'))
  await assert.rejects(archive(deps, line(user())), /missing or unsafe/)
})

test('a same-size mutation during native read fails instead of sharing changed bytes; cancellation reaches native read', async t => {
  const { dir, deps } = await fixture(t)
  const target = join(dir, 'root', file().relative_path)
  await writeFile(target, 'before')
  const nativeRead = deps.emateExportFs.readBytes.bind(deps.emateExportFs)
  deps.emateExportFs.readBytes = async (...args) => {
    const data = await nativeRead(...args)
    await writeFile(target, 'after!')
    return data
  }
  await assert.rejects(archive(deps, line(user())), /changed while reading/)
  const control = new AbortController()
  deps.emateExportFs.readBytes = async (_target, signal) => {
    assert.equal(signal.aborted, false)
    control.abort()
    signal.throwIfAborted()
  }
  await assert.rejects(archive(deps, line(user()), false, zipOwner, control.signal), { name: 'AbortError' })
})

test('a missing workspace/native fs or oversize file cannot silently omit a typed attachment', async t => {
  const { dir, deps } = await fixture(t)
  await writeFile(join(dir, 'root', file().relative_path), new Uint8Array(16 * 1024 * 1024 + 1))
  await assert.rejects(archive(deps, line(user())), /too large/)
  await assert.rejects(archive({ ...deps, emateExportFs: undefined }, line(user())), /workspace is unavailable/)
  await assert.rejects(archive({ ...deps, emateExportWorkspaces: { list: () => [] } }, line(user())), /workspace is unavailable/)
})

test('all patch seams fail closed when pinned source drifts or is applied twice', () => {
  assert.throws(() => adaptHarnessSessionExportSource('future'), /expected one 0.1.5/)
  assert.throws(() => adaptHarnessSessionExportSource(native + native), /found 2/)
  assert.throws(() => adaptHarnessSessionExportSource(adapted), /expected one 0.1.5/)
})


test('real attachment-store digest IDs produce safe, reversible ZIP media basenames', async t => {
  const { dir, deps } = await fixture(t)
  const { saveImageFile, readImageFile } = await import(pathToFileURL(join(nativeRoot, 'upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js')))
  // 0.1.5 passes a source through only as single-frame 8-bit sRGB, so the
  // byte-identity fixture is RGBA, and normalization takes its own policy.
  const data = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const limits = { maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2048, maxImagePixels: 16, mediaTypes: ['image/png'] }
  const policy = { maxPixels: 16, maxDimension: 16, maxBytes: 1024 }
  const root = join(dir, 'dsh-home', 'attachments', 'v1')
  const ref = await saveImageFile(root, { data, mediaType: 'image/png', name: 'pixel.png' }, limits, policy)
  assert.match(ref.attachmentId, /^sha256:[a-f0-9]{64}$/u)
  deps.attachments.readImage = (reference, signal) => readImageFile(root, reference, signal)
  const content = line({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] } })
  const result = await archive(deps, content)
  const entry = `media/${ref.attachmentId.replace(':', '-')}.png`
  assert.deepEqual(result[entry], data)
  assert.equal(new TextDecoder().decode(result[SESSION_LOG_ENTRY]), content)
  assert.equal(Object.keys(result).some(name => name.includes(':')), false)
})

test('media names reject traversal, Windows reserved names, and digest mapping collisions', () => {
  for (const id of ['../file', 'a/b', 'a\\b', 'a:b', '.', '..', 'CON', 'con.txt', 'NUL', 'COM1', 'LPT9.foo', 'a.', 'a ', 'a?b', 'a*b', 'sha256-' + 'a'.repeat(64)]) {
    assert.throws(() => emateExportMediaPath({ attachmentId: id, mediaType: 'image/png' }), /Unsafe/)
  }
  for (const id of ['plain-1', 'plain_1', 'plain.1']) assert.equal(emateExportMediaPath({ attachmentId: id, mediaType: 'image/png' }), `media/${id}.png`)
  assert.equal(emateExportMediaPath({ attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' }), 'media/sha256-' + 'a'.repeat(64) + '.png')
  assert.throws(() => emateExportMediaPath({ attachmentId: 'plain-1', mediaType: 'text/html' }), /Unsupported/)
})
