import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import { LocalFileSystem } from '../../../upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'
import { emptyProject, validateProject, intentPrompt } from '../src/contract.ts'
import { loadProject, saveProject, listProjects, workspaceRoot } from '../src/project-files.ts'

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'emate-canvas-')))
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: root })
  t.after(async () => { await fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, fs: ctx.fs }
}
test('canvas edit preserves ordered original and annotation roles and refuses a missing original', () => {
  const project = emptyProject('main')
  const sourceIds = ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)]
  const intent = { id: 'edit-1', kind: 'edit', pageId: project.pages[0].id, sessionId: 'live', sourceIds, imported: [] }
  const prompt = intentPrompt(project, intent, '去掉海报上的文字')
  assert(prompt.includes(JSON.stringify(sourceIds)))
  assert.match(prompt, /imagegen 编辑原图/u)
  assert.match(prompt, /第一张是待修改原图/u)
  assert.match(prompt, /保留其余区域、人物身份/u)
  assert.throws(() => intentPrompt(project, { ...intent, sourceIds: [] }, '去掉文字'), /缺少原图/u)
  assert.match(intentPrompt(project, { ...intent, kind: 'image', sourceIds: [] }, '生成新海报'), /生成结果/u)
})
test('native fs atomically saves, checks exact content revision, and recovers on restart', async t => {
  const { root, fs } = await setup(t)
  const document = emptyProject('main')
  const first = await saveProject(fs, root, document, null)
  assert.match(first.revision, /^[0-9a-f]{64}$/u)
  assert.deepEqual((await loadProject(root, 'main')).project, document)
  const next = { ...document, title: 'edited' }
  const second = await saveProject(fs, root, next, first.revision)
  assert.notEqual(second.revision, first.revision)
  await assert.rejects(saveProject(fs, root, { ...next, title: 'stale' }, first.revision), error => error.code === 'conflict')
  assert.equal((await loadProject(root, 'main')).project.title, 'edited')
  const isolated = new Context(); const fiber = await isolated.plugin(LocalFileSystem, { cwd: root })
  try { assert.equal((await loadProject(root, 'main')).revision, second.revision); await saveProject(isolated.fs, root, { ...next, title: 'restart' }, second.revision) } finally { await fiber.dispose() }
  assert.equal((await loadProject(root, 'main')).project.title, 'restart')
})
test('concurrent native writes cannot silently overwrite another window', async t => {
  const { root, fs } = await setup(t)
  const document = emptyProject('main'); const first = await saveProject(fs, root, document, null)
  const results = await Promise.allSettled(['left', 'right'].map(title => saveProject(fs, root, { ...document, title }, first.revision)))
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(results.filter(value => value.status === 'rejected').length, 1)
  const loaded = await loadProject(root, 'main')
  assert(['left', 'right'].includes(loaded.project.title))
})
test('corrupt or absent primary restores previous complete bytes, preserving corrupt primary on save', async t => {
  const { root, fs } = await setup(t)
  const first = await saveProject(fs, root, emptyProject('main'), null)
  await saveProject(fs, root, { ...first.project, title: 'latest' }, first.revision)
  const path = join(root, '.e-mate/canvas/main.json')
  await writeFile(path, '{corrupt')
  const recovered = await loadProject(root, 'main')
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.project.title, first.project.title)
  await saveProject(fs, root, recovered.project, recovered.revision)
  assert((await readdir(join(root, '.e-mate/canvas'))).some(name => name.startsWith('main.corrupt-')))
  await rm(path)
  assert.equal((await loadProject(root, 'main')).recovered, true)
  await writeFile(join(root, '.e-mate/canvas/main.backup.json'), '{broken')
  await assert.rejects(loadProject(root, 'main'), error => error.code === 'corrupt')
  assert.match((await listProjects(root))[0].error, /损坏/u)
})
test('project id traversal and symlink directories/files cannot reach outside the canonical root', async t => {
  const { root, fs } = await setup(t)
  for (const id of ['../escape', '/absolute', 'a/b', 'a\\b', '.', '', 'x\0']) await assert.rejects(loadProject(root, id))
  const outside = join(root, 'outside'); await mkdir(outside); await mkdir(join(root, '.e-mate'))
  await symlink(outside, join(root, '.e-mate/canvas'))
  await assert.rejects(saveProject(fs, root, emptyProject('main'), null), error => error.code === 'scope')
  await rm(join(root, '.e-mate/canvas')); await mkdir(join(root, '.e-mate/canvas'))
  const victim = join(outside, 'victim'); await writeFile(victim, 'original')
  await symlink(victim, join(root, '.e-mate/canvas/main.json'))
  await assert.rejects(saveProject(fs, root, emptyProject('main'), null))
  assert.equal(await readFile(victim, 'utf8'), 'original')
})
test('workspace binding rejects archived or unknown sessions without accepting caller paths', async t => {
  const { root } = await setup(t)
  const ctx = { workspaceRegistry: { archivedSessionIds: ['archived'], list: () => [{ path: root, sessionIds: ['live', 'archived'] }] } }
  assert.equal(await workspaceRoot(ctx, 'live'), root)
  await assert.rejects(workspaceRoot(ctx, 'other'))
  await assert.rejects(workspaceRoot(ctx, 'archived'))
})
test('strict scene validation rejects remote embeds, prototype keys, unknown references and excessive data', () => {
  for (const mutate of [
    value => { value.pages[0].elements = [{ id: 'x', type: 'embeddable', link: 'https://example.test' }] },
    value => { value.pages[0].elements = [{ id: 'x', type: 'image', fileId: '0'.repeat(64) }] },
    value => { value.pages[0].elements = [JSON.parse('{"id":"x","type":"text","__proto__":{}}')] },
    value => { value.pages[0].view.zoom = NaN },
    value => { value.pages.push(value.pages[0]) },
    value => { value.pages[0].html = 'x'.repeat(512 * 1024 + 1) },
  ]) { const value = emptyProject('main'); mutate(value); assert.throws(() => validateProject(value)) }
})
