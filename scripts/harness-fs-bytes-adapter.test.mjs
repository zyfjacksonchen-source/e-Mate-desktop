import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createReadStream, constants as emateReadConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { adaptHarnessFsBytesSource } from './harness-fs-bytes-adapter.mjs'

const nativeRoot = process.env.EMATE_TEST_NATIVE_ROOT ?? path.resolve(import.meta.dirname, '..')
const native = await fs.readFile(path.join(nativeRoot, 'upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'), 'utf8')
const adapted = adaptHarnessFsBytesSource(native)
const require = createRequire(path.join(nativeRoot, 'upstream/deepseek-harness/packages/fs/fs-local/package.json'))
const { FsError, FsVersion, FsTargetKey } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs')))

// Execute the actual transformed native FS owner with real filesystem calls.
// Only open/after-stat seams are wrapped to measure reads/closes and schedule
// deterministic replacements; no stand-in filesystem or binary reader.
function owner(source = adapted, overrides = {}) {
  const start = source.indexOf('//#region lib/types/fsio.js')
  const end = source.indexOf('//#endregion', start)
  const imports = { ...fs, ...path, createReadStream, FsError, FsVersion, FsTargetKey, emateReadConstants, ...overrides }
  delete imports.default
  return new Function(...Object.keys(imports), `${source.slice(start, end)}\nreturn { readWholeBytes, resolveLocalTarget };`)(...Object.values(imports))
}
async function fixture(t, data = Buffer.from('public')) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'emate-guarded-read-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'report.pdf')
  await fs.writeFile(filename, data)
  return { directory, filename, target: await owner().resolveLocalTarget(directory, filename) }
}
function measuredOpen(control = {}) {
  const counts = { opened: 0, read: 0, closed: 0, requested: [], flags: [] }
  return { counts, async open(...args) {
    counts.flags.push(args[1])
    const handle = await fs.open(...args)
    counts.opened++
    await control.opened?.(handle)
    return {
      stat: (...args) => handle.stat(...args),
      async read(...args) {
        counts.read++
        counts.requested.push(args[2])
        await control.beforeRead?.(counts.read)
        const result = await handle.read(...args)
        await control.afterRead?.(counts.read, result)
        return result
      },
      async close() { counts.closed++; await handle.close() },
    }
  } }
}

test('pre-existing outside hardlink is reproduced on native rc.7 and refused before any adapted content I/O', async t => {
  const { directory, filename, target } = await fixture(t)
  const outside = path.join(directory, 'outside-private.pdf')
  await fs.writeFile(outside, 'secret')
  await fs.unlink(filename)
  await fs.link(outside, filename)
  assert.equal((await owner(native).readWholeBytes(target, undefined, 100)).toString(), 'secret')
  const measured = measuredOpen()
  await assert.rejects(owner(adapted, { open: measured.open }).readWholeBytes(target, undefined, 100), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual([measured.counts.opened, measured.counts.read, measured.counts.closed], [1, 0, 1])
})

test('replacement between stat and open cannot read the outside target, even when the byte count matches', async t => {
  const { directory, filename, target } = await fixture(t)
  const outside = path.join(directory, 'outside.pdf')
  await fs.writeFile(outside, 'secret')
  const measured = measuredOpen()
  await assert.rejects(owner(adapted, { open: measured.open }).readWholeBytes(target, undefined, 100, {
    async inspectReadBytesAfterStat() {
      await fs.rename(filename, path.join(directory, 'old.pdf'))
      await fs.symlink(outside, filename)
    },
  }), error => error.code === (process.platform === 'win32' ? 'FS_STALE_VERSION' : 'ELOOP'))
  assert.deepEqual([measured.counts.opened, measured.counts.read, measured.counts.closed], process.platform === 'win32' ? [1, 0, 1] : [0, 0, 0])
  const flags = measured.counts.flags[0]
  if (process.platform !== 'win32') {
    assert.equal(flags & emateReadConstants.O_NOFOLLOW, emateReadConstants.O_NOFOLLOW)
    assert.equal(flags & emateReadConstants.O_NONBLOCK, emateReadConstants.O_NONBLOCK)
  }
})

test('same-size content mutation after an actual descriptor read is rejected and closes the handle', async t => {
  const { filename, target } = await fixture(t)
  const measured = measuredOpen({ async afterRead(number) { if (number === 1) await fs.writeFile(filename, 'secret') } })
  await assert.rejects(owner(adapted, { open: measured.open }).readWholeBytes(target, undefined, 100), { code: 'FS_STALE_VERSION' })
  assert.equal(measured.counts.closed, 1)
})

test('ordinary binary and empty files retain exact bytes through bounded native reads', async t => {
  const data = Buffer.from(Array.from({ length: 180_000 }, (_, index) => index % 256))
  const { filename, target } = await fixture(t, data)
  const measured = measuredOpen()
  assert.deepEqual(await owner(adapted, { open: measured.open }).readWholeBytes(target, undefined, data.length), data)
  assert.ok(Math.max(...measured.counts.requested) <= 65536)
  assert.equal(measured.counts.closed, 1)
  await fs.writeFile(filename, new Uint8Array())
  assert.deepEqual(await owner().readWholeBytes(target, undefined, 0), Buffer.alloc(0))
})

test('hardlinked images deliberately fail; an independent PNG copy still passes native image validation', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const { directory, filename, target } = await fixture(t, png)
  const { saveImageFile, readImageFile } = await import(pathToFileURL(path.join(nativeRoot, 'upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js')))
  const limits = { maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2048, maxImagePixels: 16, mediaTypes: ['image/png'] }
  const data = await owner().readWholeBytes(target, undefined, 1024)
  const store = path.join(directory, 'dsh-home/attachments/v1')
  const ref = await saveImageFile(store, { data, mediaType: 'image/png', name: 'pixel.png' }, limits)
  assert.deepEqual(Buffer.from((await readImageFile(store, ref)).data), png)
  await fs.link(filename, path.join(directory, 'alias.png'))
  await assert.rejects(owner().readWholeBytes(target, undefined, 1024), { code: 'FS_PERMISSION_DENIED' })
  const copy = path.join(directory, 'independent.png')
  await fs.copyFile(filename, copy)
  assert.deepEqual(await owner().readWholeBytes(await owner().resolveLocalTarget(directory, copy), undefined, 1024), png)
})

test('oversize admission and mid-read growth retain the hard byte cap', async t => {
  const { filename, target } = await fixture(t)
  const measured = measuredOpen()
  await assert.rejects(owner(adapted, { open: measured.open }).readWholeBytes(target, undefined, 5), { code: 'FS_TOO_LARGE' })
  assert.equal(measured.counts.opened, 0)
  const growth = measuredOpen({ async beforeRead(number) { if (number === 1) await fs.appendFile(filename, ' grows') } })
  await assert.rejects(owner(adapted, { open: growth.open }).readWholeBytes(target, undefined, 6), { code: 'FS_TOO_LARGE' })
  assert.equal(growth.counts.requested[0], 7)
  assert.equal(growth.counts.closed, 1)
})

test('abort before opening, after opening and during reading never returns bytes or leaks a handle', async t => {
  const { target } = await fixture(t)
  const already = new AbortController(); already.abort()
  const early = measuredOpen()
  await assert.rejects(owner(adapted, { open: early.open }).readWholeBytes(target, already.signal, 100), { code: 'FS_ABORTED' })
  assert.equal(early.counts.opened, 0)
  for (const phase of ['opened', 'afterRead']) {
    const control = new AbortController()
    const measured = measuredOpen({ [phase]: () => control.abort() })
    await assert.rejects(owner(adapted, { open: measured.open }).readWholeBytes(target, control.signal, 100), { code: 'FS_ABORTED' })
    assert.equal(measured.counts.closed, 1)
  }
})

test('missing/nonregular files and drift remain explicit errors', async t => {
  const { directory, filename, target } = await fixture(t)
  await fs.unlink(filename)
  await assert.rejects(owner().readWholeBytes(target, undefined, 100), { code: 'FS_NOT_FOUND' })
  await assert.rejects(owner().readWholeBytes(await owner().resolveLocalTarget(directory, directory), undefined, 100), { code: 'FS_NOT_REGULAR_FILE' })
  assert.throws(() => adaptHarnessFsBytesSource('future'), /expected one/)
  assert.throws(() => adaptHarnessFsBytesSource(native + native), /expected one/)
  assert.throws(() => adaptHarnessFsBytesSource(adapted), /expected one/)
})

test('the integrated native ZIP producer refuses an imported hardlink through the guarded native FS owner', async t => {
  const { directory } = await fixture(t)
  const { adaptHarnessSessionExportSource } = await import('./harness-session-export-adapter.mjs')
  const api = adaptHarnessSessionExportSource(await fs.readFile(path.join(nativeRoot, 'upstream/deepseek-harness/packages/host/apiproxy/lib/index.js'), 'utf8'))
  const apiRequire = createRequire(path.join(nativeRoot, 'upstream/deepseek-harness/packages/host/apiproxy/package.json'))
  const { Zip, ZipDeflate } = apiRequire('fflate')
  const start = api.indexOf('//#region lib/types/session-export.js')
  const streamZip = new Function('Zip', 'ZipDeflate', `${api.slice(start, api.indexOf('//#endregion', start))}\nreturn streamSessionLogZip;`)(Zip, ZipDeflate)
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
  const { LocalFileSystem } = await import(pathToFileURL(path.join(nativeRoot, 'upstream/deepseek-harness/packages/fs/fs-local/lib/index.js')))
  const ctx = new Context()
  const mounted = await ctx.plugin(LocalFileSystem, { cwd: directory })
  t.after(() => mounted.dispose())
  const measured = measuredOpen()
  ctx.fs.readBytes = owner(adapted, { open: measured.open }).readWholeBytes
  const refs = { stored_name: 'report.pdf', display_name: 'report.pdf', relative_path: '.e-mate/imports/report.pdf', media_type: 'application/pdf' }
  await fs.mkdir(path.join(directory, '.e-mate/imports'), { recursive: true })
  const outside = path.join(directory, 'private.pdf')
  await fs.writeFile(outside, 'private content must not be read')
  await fs.link(outside, path.join(directory, refs.relative_path))
  const content = JSON.stringify({ type: 'user/message', data: { role: 'user', source: { kind: 'user', mentions: [{ source: 'e-mate/file-import', ref: JSON.stringify(refs) }] }, content: [{ type: 'text', text: `Read @${refs.relative_path}` }] } }) + '\n'
  const deps = { emateExportFs: ctx.fs, emateExportWorkspaces: { list: () => [{ path: directory, sessionIds: ['root'] }] } }
  const stream = streamZip(deps, { filename: 'session.jsonl', content }, 'root', false, 6, new AbortController().signal)
  await assert.rejects(new Response(stream).arrayBuffer(), { code: 'FS_PERMISSION_DENIED' })
  assert.equal(measured.counts.read, 0)
  assert.equal(measured.counts.closed, 1)
})
