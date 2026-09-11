import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Storage from '../../../upstream/deepseek-harness/packages/storage/storage/lib/index.js'
import { DomainFacility } from '../../../upstream/deepseek-harness/packages/storage/storage-domain/lib/index.js'
import { JsonStorageBackend } from '../../../upstream/deepseek-harness/packages/storage/storage-json/lib/index.js'
import WorkspaceRegistry from '../../../upstream/deepseek-harness/packages/workspace/workspace/lib/index.js'
import { MemoryScopeError, resolveMemoryScope } from '../lib/scope.js'

const workspace = (id, path, sessionIds, status = 'ok') => ({
  id,
  path,
  sessionIds,
  status: async () => status,
})

const execution = (id, cwd) => ({
  agent: { id, session: { header: cwd === undefined ? {} : { cwd } } },
})

test('project keys are stable and never cross projects or ungrouped sessions', async () => {
  const projects = new Map([
    ['/work/a', workspace('project-a', '/canonical/a', ['a-1', 'a-2'])],
    ['/work/b', workspace('project-b', '/canonical/b', ['b-1'])],
    ['/work/general', workspace('general', '/canonical/general', ['general-1', 'general-2'])],
    ['/configured/general', workspace('general', '/canonical/general', ['general-1', 'general-2'])],
  ])
  const registry = { resolveByPath: async path => projects.get(path) }

  const a1 = await resolveMemoryScope(registry, execution('a-1', '/work/a'))
  const a2 = await resolveMemoryScope(registry, execution('a-2', '/work/a'))
  const b1 = await resolveMemoryScope(registry, execution('b-1', '/work/b'))
  const general1 = await resolveMemoryScope(
    registry,
    execution('general-1', '/work/general'),
    { sessionOnlyWorkspacePath: '/canonical/general' },
  )
  const general2 = await resolveMemoryScope(
    registry,
    execution('general-2', '/work/general'),
    { sessionOnlyWorkspacePath: '/configured/general' },
  )
  const ungrouped = await resolveMemoryScope(registry, execution('ungrouped'))

  assert.equal(a1.key, a2.key)
  assert.notEqual(a1.key, b1.key)
  assert.notEqual(general1.key, general2.key)
  assert.notEqual(general1.key, a1.key)
  assert.notEqual(ungrouped.key, general1.key)
  await assert.rejects(
    resolveMemoryScope(registry, execution('foreign', '/work/a')),
    error => error instanceof MemoryScopeError
      && error.code === 'scope-invalid'
      && /not bound to its owning project/u.test(error.message),
  )
  await assert.rejects(
    resolveMemoryScope(registry, execution('unknown', '/work/missing')),
    error => error instanceof MemoryScopeError
      && error.code === 'scope-invalid'
      && /cannot prove the session workspace binding/u.test(error.message),
  )
  await assert.rejects(
    resolveMemoryScope(
      { resolveByPath: async () => workspace('project-offline', '/offline', ['offline-1'], 'missing') },
      execution('offline-1', '/offline'),
    ),
    error => error instanceof MemoryScopeError
      && error.code === 'unavailable'
      && /directory is unavailable/u.test(error.message),
  )
})

test('the pinned Harness registry keeps general sessions isolated through a path alias', async () => {
  const base = await mkdtemp(join(tmpdir(), 'emate-memory-registry-'))
  const general = join(base, 'general')
  const generalAlias = join(base, 'general-link')
  const project = join(base, 'project')
  await mkdir(general)
  await mkdir(project)
  await symlink(general, generalAlias)

  const headers = [
    { version: 0, id: 'general-1', createdAt: 1, cwd: general },
    { version: 0, id: 'general-2', createdAt: 2, cwd: general },
    { version: 0, id: 'project-1', createdAt: 3, cwd: project },
    { version: 0, id: 'project-2', createdAt: 4, cwd: project },
  ]
  const ctx = new Context()
  let registryFiber
  let backend
  try {
    await ctx.plugin(Storage)
    backend = new JsonStorageBackend(join(base, 'storage'))
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('sessionPersistence', {
      // 0.1.5 lists snapshots ({ header, revision }), not bare headers.
      list: async () => headers.map(header => ({ header, revision: 'rev-1' })),
      load: () => { throw new Error('event bodies must not be loaded') },
      inspect: () => { throw new Error('event bodies must not be inspected') },
    })
    registryFiber = await ctx.plugin(WorkspaceRegistry)

    const general1 = await resolveMemoryScope(
      ctx.workspaceRegistry,
      execution('general-1', general),
      { sessionOnlyWorkspacePath: generalAlias },
    )
    const general2 = await resolveMemoryScope(
      ctx.workspaceRegistry,
      execution('general-2', general),
      { sessionOnlyWorkspacePath: generalAlias },
    )
    const project1 = await resolveMemoryScope(ctx.workspaceRegistry, execution('project-1', project))
    const project2 = await resolveMemoryScope(ctx.workspaceRegistry, execution('project-2', project))

    assert.equal(general1.kind, 'session')
    assert.notEqual(general1.key, general2.key)
    assert.equal(project1.kind, 'project')
    assert.equal(project1.key, project2.key)
    assert.notEqual(general1.key, project1.key)
  } finally {
    await registryFiber?.dispose()
    await backend?.close()
    await rm(base, { recursive: true, force: true })
  }
})
