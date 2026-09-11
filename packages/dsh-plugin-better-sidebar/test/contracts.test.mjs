import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

test('host registers on the trusted API transport and validates paths once there', async () => {
  const host = await readFile(resolve(root, 'src/index.ts'), 'utf8')
  // 0.1.5 registers a Host RPC channel as (channel, handler): the retired
  // per-channel `authority` option is the transport's trust decision now, so a
  // call site carrying one again would re-claim a policy nothing enforces.
  assert.match(host, /ctx\.connection\.rpc\.handle\(\s*\n\s*CHANNEL,/u)
  assert.doesNotMatch(host, /authority:/u)
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

test('client half occupies the native seats instead of owning a container', async () => {
  const client = await readFile(resolve(root, 'src/client/index.tsx'), 'utf8')
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  // The pinned frame's sidebar/rightbar tracks belong to their occupants, so a
  // plugin contributes a seat and renders inside it: a body-portal host, a
  // React root, or a layout CSS variable of its own would be that second owner.
  assert.doesNotMatch(client, /document\.body\.appendChild|createPortal|createRoot|data-dsh-better-sidebar/u)
  assert.doesNotMatch(client, /--dsh-sidebar-width|--dsh-sidebar-height/u)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  // Every declared client edge resolves to a package the pinned Harness ships:
  // 0.1.5 removed @deepseek-ai/dsh-client-runtime, and a stale name here is how
  // the retired container half kept looking mountable.
  const harness = process.env.EMATE_HARNESS_ROOT ?? resolve(root, '../../upstream/deepseek-harness')
  const shipped = new Set()
  for (const entry of await readdir(resolve(harness, 'packages/client'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      shipped.add(JSON.parse(await readFile(resolve(harness, 'packages/client', entry.name, 'package.json'), 'utf8')).name)
    } catch {
      // A directory without a readable manifest is not a package (docs, fixtures).
    }
  }
  for (const name of manifest.dsh.client.inject) {
    assert.ok(shipped.has(name), `${name} is not a pinned Harness client package`)
  }
})
