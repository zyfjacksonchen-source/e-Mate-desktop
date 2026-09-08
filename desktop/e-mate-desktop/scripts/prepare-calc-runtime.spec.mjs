import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import test from 'node:test'
import { copyDir } from 'builder-util'
import { inventory, prepareTarget, verifyArchive, verifyPreparedTarget, verifyLinkTarget, verifyInventory, verifyReceiptInventory } from './prepare-calc-runtime.mjs'

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

test('inventory detects altered file bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calc-tree-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'LICENSE'), 'original')
  const first = await inventory(root)
  await writeFile(join(root, 'LICENSE'), 'modified')
  assert.notDeepEqual(await inventory(root), first)
})

test('packaged inventory permits only pruned empty directories', () => {
  const expected = [
    { path: 'empty', mode: 0o755, kind: 'directory' },
    { path: 'empty/nested', mode: 0o755, kind: 'directory' },
    { path: 'full', mode: 0o755, kind: 'directory' },
    { path: 'full/file', mode: 0o644, kind: 'file', bytes: 5, sha256: 'fixed' },
  ]
  const packaged = expected.slice(2)
  assert.doesNotThrow(() => verifyReceiptInventory(packaged, expected, { allowPrunedEmptyDirectories: true }))
  assert.throws(() => verifyReceiptInventory(packaged, expected), /contents changed/)
  assert.throws(() => verifyReceiptInventory([expected[3]], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
  assert.throws(() => verifyReceiptInventory([...packaged, { path: 'extra', mode: 0o644, kind: 'file', bytes: 1, sha256: 'extra' }], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
  assert.throws(() => verifyReceiptInventory([packaged[0], { ...packaged[1], sha256: 'changed' }], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
  for (const change of [{ mode: 0o600 }, { bytes: 6 }, { kind: 'directory' }]) {
    assert.throws(() => verifyReceiptInventory([packaged[0], { ...packaged[1], ...change }], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
  }
  assert.throws(() => verifyReceiptInventory([{ ...packaged[0], mode: 0o700 }, packaged[1]], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
  assert.throws(() => verifyReceiptInventory([packaged[0]], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
  const link = { path: 'full/link', kind: 'link', target: 'file', mode: 0o777 }
  assert.throws(() => verifyReceiptInventory([...packaged, { ...link, target: 'other' }], [...expected, link], { allowPrunedEmptyDirectories: true }), /contents changed/)
  assert.throws(() => verifyReceiptInventory(packaged, [...expected, link], { allowPrunedEmptyDirectories: true }), /contents changed/)
  assert.throws(() => verifyReceiptInventory([...packaged, { path: 'extra', kind: 'directory', mode: 0o755 }], expected, { allowPrunedEmptyDirectories: true }), /contents changed/)

})

test('native Builder copyDir prunes empty directories but receipt verification retains every file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calc-native-copy-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), packaged = join(root, 'packaged')
  await mkdir(join(source, 'empty', 'nested'), { recursive: true })
  await mkdir(join(source, 'full'), { recursive: true })
  await writeFile(join(source, 'full', 'file'), 'original')
  await writeFile(join(source, 'full', 'zero-byte'), '')
  const expected = await inventory(source)
  await copyDir(source, packaged)
  const actual = await inventory(packaged)
  assert.equal(actual.some(item => item.path === 'empty'), false)
  assert.equal(actual.some(item => item.path === 'full/zero-byte'), true)
  assert.throws(() => verifyReceiptInventory(actual, expected), /contents changed/)
  assert.doesNotThrow(() => verifyReceiptInventory(actual, expected, { allowPrunedEmptyDirectories: true }))
  await rm(join(packaged, 'full', 'zero-byte'))
  const missingFile = await inventory(packaged)
  assert.throws(() => verifyReceiptInventory(missingFile, expected, { allowPrunedEmptyDirectories: true }), /contents changed/)
})

test('inventory preserves internal links while rejecting escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'calc-link-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Resources')); await writeFile(join(root, 'Resources', 'LICENSE'), 'original')
  try {
    await symlink('Resources/LICENSE', join(root, 'license'))
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    t.skip('Windows account lacks permission to create symbolic links')
    return
  }
  const first = await inventory(root)
  assert.equal(first.find(item => item.path === 'license').target.split('\\').join('/'), 'Resources/LICENSE')
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
  await assert.rejects(verifyPreparedTarget(target, root, { packaged: true }), /Incomplete/)
})


test('Windows inventory requires the complete payload and native notices', () => {
  const paths = ['LICENSE.html', 'license.txt', 'NOTICE', 'readmes/readme_en-US.txt', 'program/soffice.exe']
  const entries = paths.map(path => ({ path, kind: 'file', bytes: 1 }))
  const expected = { executable: 'LibreOffice/program/soffice.exe', fileCount: entries.length, logicalBytes: entries.length, symlinkCount: 0 }
  assert.doesNotThrow(() => verifyInventory(entries, expected))
  assert.throws(() => verifyInventory(entries.slice(1), expected), /Incomplete/)
  for (const missing of paths) {
    const replaced = entries.map(item => item.path === missing ? { ...item, path: 'unrelated' } : item)
    assert.throws(() => verifyInventory(replaced, expected), /required asset missing/)
  }
})
