import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inventory, prepareTarget, verifyArchive } from './prepare-calc-runtime.mjs'

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
