import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import test from 'node:test'
import { inventory, prepareTarget, verifyArchive, verifyPreparedTarget, verifyLinkTarget } from './prepare-calc-runtime.mjs'

test('link containment uses Windows and POSIX path semantics', () => {
  for (const [paths, root] of [[win32, 'C:\\assets\\LibreOffice'], [posix, '/assets/LibreOffice']]) {
    const link = paths.join(root, 'program', 'link')
    for (const target of [paths.join('..', '..', 'outside'), '../..', paths.join(root, 'LICENSE')]) {
      assert.throws(() => verifyLinkTarget(root, link, target, paths), /escapes/)
    }
    for (const target of [paths.join('..', 'LICENSE'), paths.join('..', '..cache', 'LICENSE'), '..']) {
      assert.doesNotThrow(() => verifyLinkTarget(root, link, target, paths))
    }
  }
  assert.throws(() => verifyLinkTarget('C:\\assets\\LibreOffice', 'C:\\assets\\LibreOffice\\link', 'D:\\outside', win32), /escapes/)
  assert.throws(() => verifyLinkTarget('C:\\assets\\LibreOffice', 'C:\\assets\\LibreOffice\\link', '\\\\server\\share\\outside', win32), /escapes/)
})

test('archive validation checks size and full digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calc-archive-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'asset.dmg'), bytes = Buffer.from('fixed bytes')
  await writeFile(path, bytes)
  const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  await verifyArchive(path, expected)
  await assert.rejects(verifyArchive(path, { ...expected, bytes: bytes.length + 1 }), /integrity/)
  await writeFile(path, 'wrong bytes')
  await assert.rejects(verifyArchive(path, expected), /integrity/)
})

test('inventory detects altered bytes and preserves internal links while rejecting escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calc-tree-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Resources')); await writeFile(join(root, 'Resources', 'LICENSE'), 'original')
  await symlink('Resources/LICENSE', join(root, 'license'))
  const first = await inventory(root)
  assert.equal(first.find(item => item.path === 'license').target, 'Resources/LICENSE')
  await writeFile(join(root, 'Resources', 'LICENSE'), 'modified')
  assert.notDeepEqual(await inventory(root), first)
  await symlink('../outside', join(root, 'escape'))
  await assert.rejects(inventory(root), /escapes/)
})

test('unknown native target is rejected before downloading or extracting', async () => {
  await assert.rejects(prepareTarget('unknown', '/unused', '/unused'), /not verified/)
})

test('package verification never prepares missing assets and rejects an incomplete matching receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calc-package-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = 'darwin-arm64', destination = join(root, target)
  await assert.rejects(verifyPreparedTarget(target, root), { code: 'ENOENT' })
  await assert.rejects(lstat(destination), { code: 'ENOENT' })
  const manifest = JSON.parse(await readFile(new URL('./calc-runtime/manifest.json', import.meta.url), 'utf8'))
  await mkdir(join(destination, 'LibreOffice.app'), { recursive: true })
  await writeFile(join(destination, 'receipt.json'), JSON.stringify({ schema: 1, target, version: manifest.version, archiveSha256: manifest.targets[target].archive.sha256, entries: [] }))
  await assert.rejects(verifyPreparedTarget(target, root), /Incomplete/)
})
