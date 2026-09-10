import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('uses target Connection RPC and conversation view without terminal transport', async () => {
  const host = await readFile(resolve(root, 'src/index.ts'), 'utf8')
  const client = await readFile(resolve(root, 'src/client/index.tsx'), 'utf8')
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.match(host, /connection\.rpc\.handle\(/)
  assert.match(client, /connection\.rpc\.call\(/)
  assert.match(client, /name:\s*'conversation\.view'/)
  assert.equal(manifest.eMate.harnessVersion, '0.1.5-rc.1')
  assert.equal(manifest.dependencies, undefined)
  assert.doesNotMatch(`${host}\n${client}`, /node-pty|new WebSocket|\/sidebar\/api|\/sidebar\/ws/)
  assert.deepEqual(manifest.eMate.excludedUpstreamFeatures, ['terminal', 'node-pty', 'standalone-websocket', 'standalone-http-api'])
})

test('host validates paths once at the loopback boundary', async () => {
  const host = await readFile(resolve(root, 'src/index.ts'), 'utf8')
  assert.match(host, /authority:\s*'loopback'/)
  assert.match(host, /realpath\(resolve\(root, \.\.\.parts\)\)/)
  assert.match(host, /MAX_FILE_BYTES = 512 \* 1024/)
  assert.match(host, /!entry\.isSymbolicLink\(\)/)
})

test('projects remain session-scoped across workspaces, archive, restart, and traversal failure', async t => {
  const base = await mkdtemp(join(tmpdir(), 'emate-better-sidebar-'))
  t.after(async () => await rm(base, { recursive: true, force: true }))
  const alpha = join(base, 'alpha')
  const beta = join(base, 'beta')
  await mkdir(alpha)
  await mkdir(beta)
  await writeFile(join(alpha, 'alpha.txt'), 'alpha')
  await writeFile(join(beta, 'beta.txt'), 'beta')
  await symlink(join(beta, 'beta.txt'), join(alpha, 'escape.txt'))
  const workspaces = [
    { path: alpha, sessionIds: ['alpha-1', 'alpha-2'] },
    { path: beta, sessionIds: ['beta-1'] },
  ]
  const mount = archivedSessionIds => {
    let handler
    apply({
      effect(register) { register() },
      connection: { rpc: { handle(_channel, next) { handler = next; return () => {} } } },
      workspaceRegistry: { archivedSessionIds, list: () => workspaces },
    })
    return handler
  }
  const first = mount(['alpha-2'])
  assert.deepEqual((await first('list', { path: '', session_id: 'alpha-1' })).value.entries, [{ name: 'alpha.txt', kind: 'file' }])
  assert.deepEqual((await first('list', { path: '', session_id: 'beta-1' })).value.entries, [{ name: 'beta.txt', kind: 'file' }])
  assert.equal((await first('list', { path: '', session_id: 'alpha-2' })).ok, false)
  assert.equal((await first('list', { path: '', session_id: 'subagent-hidden' })).ok, false)
  assert.equal((await first('read', { path: '../beta/beta.txt', session_id: 'alpha-1' })).ok, false)
  assert.equal((await first('read', { path: 'escape.txt', session_id: 'alpha-1' })).ok, false)

  const restarted = mount([])
  assert.equal((await restarted('read', { path: 'alpha.txt', session_id: 'alpha-1' })).value.content, 'alpha')
})
