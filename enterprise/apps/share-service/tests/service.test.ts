import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, utimes, symlink, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { Pool } from 'pg'
import { ArchiveFiles, ArchiveTooLarge, digest } from '../src/files.ts'
import { ShareStore } from '../src/store.ts'
import { environment, incomingBody, createService, PUBLIC_BASE } from '../src/server.ts'
import { migrate, readSnapshot } from '../src/migrate.ts'

async function volume(t: test.TestContext, limit = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'emate-share-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = new ArchiveFiles(root, limit)
  await files.ready()
  return files
}
const bytes = new Uint8Array([80, 75, 3, 4])
const stream = () => new Blob([bytes]).stream()

test('streams exact archive bytes to an immutable digest and detects existing corruption', async t => {
  const files = await volume(t)
  const staged = await files.stage(stream(), new AbortController().signal)
  assert.equal(staged.sha256, digest(bytes))
  await files.publish(staged)
  await files.publish(staged)
  assert.deepEqual(new Uint8Array(await readFile(files.path(staged.sha256))), bytes)
  await writeFile(files.path(staged.sha256), new Uint8Array([0, 0, 0, 0]))
  await assert.rejects(files.publish(staged), /integrity/)
  assert.throws(() => files.path('../secret'), /digest/)
})

test('oversized, empty and stalled cancelled uploads leave no temporary files', async t => {
  const files = await volume(t, 3)
  await assert.rejects(files.stage(stream(), new AbortController().signal), ArchiveTooLarge)
  await assert.rejects(files.stage(new Blob([]).stream(), new AbortController().signal), ArchiveTooLarge)
  const controller = new AbortController()
  let cancelled = false
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const pending = files.stage(stalled, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(join(files.root, 'tmp')), [])
  assert.deepEqual(await files.candidates(), [])
})

test('maintenance collects only stale regular upload files and preserves active, recent and unrelated paths', async t => {
  const files = await volume(t)
  const directory = join(files.root, 'tmp')
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>()
  const active = files.stage(body, controller.signal)
  // A locked body means stage has opened and registered its file. There are
  // no chunks to update its deliberately old mtime during this test.
  while (!body.locked) await setImmediate()
  const activeName = (await readdir(directory))[0]
  const old = new Date(Date.now() - 20 * 60 * 1000)
  await utimes(join(directory, activeName), old, old)
  const stale = `${randomUUID()}.zip`
  const recent = `${randomUUID()}.zip`
  const link = `${randomUUID()}.zip`
  const childDirectory = `${randomUUID()}.zip`
  for (const name of [stale, recent, 'notes.zip', 'not-a-uuid.zip']) await writeFile(join(directory, name), bytes)
  for (const name of [stale, 'notes.zip', 'not-a-uuid.zip']) await utimes(join(directory, name), old, old)
  const target = join(files.root, 'unrelated-original.zip')
  await writeFile(target, bytes)
  await utimes(target, old, old)
  await symlink(target, join(directory, link))
  await mkdir(join(directory, childDirectory))
  await utimes(join(directory, childDirectory), old, old)
  const store = new ShareStore(new FaultPool() as unknown as Pool, new ArchiveFiles(files.root))
  assert.deepEqual(await store.collect(), { removed: 0, temporary_removed: 1 })
  assert.deepEqual((await readdir(directory)).sort(), [activeName, recent, link, childDirectory, 'notes.zip', 'not-a-uuid.zip'].sort())
  assert.equal((await lstat(join(directory, link))).isSymbolicLink(), true)
  assert.deepEqual(new Uint8Array(await readFile(target)), bytes)
  controller.abort()
  await assert.rejects(active, { name: 'AbortError' })
  assert.equal((await readdir(directory)).includes(activeName), false)
  assert.equal(await files.collectTemporary(), 0)
})

test('a retried upload can cancel an unread stalled HTTP body without waiting on sender', async () => {
  const incoming = new PassThrough()
  const body = incomingBody(incoming as unknown as IncomingMessage)
  await Promise.resolve() // allow pull to start waiting on iterator.next
  await Promise.race([
    body.cancel(),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cancel blocked')), 200); timer.unref() }),
  ])
  assert.equal(incoming.destroyed, false)
  incoming.destroy()
})

// Fault injection tests exercise the real store/files boundary. PostgreSQL's
// transaction/isolation semantics are separately checked by postgres.test.ts.
class FaultPool {
  committed = new Map<string, any>()
  failure: 'insert' | 'commit-lost' | 'unavailable' | undefined
  async connect() {
    if (this.failure === 'unavailable') throw new Error('unavailable')
    let pending = new Map(this.committed)
    return {
      release() {},
      query: async (sql: string, args: any[] = []) => {
        if (sql === 'ROLLBACK') pending = new Map(this.committed)
        if (sql === 'COMMIT') {
          this.committed = new Map(pending)
          if (this.failure === 'commit-lost') { this.failure = undefined; throw new Error('response lost') }
        }
        if (sql.startsWith('INSERT INTO')) {
          if (this.failure === 'insert') throw new Error('metadata unavailable')
          pending.set(args[0], { key: args[0], size: args[1], sha256: args[2], custom_metadata: args[3], http_metadata: args[4] })
        }
        if (sql.startsWith('SELECT 1 FROM')) return { rowCount: [...pending.values()].some(row => row.sha256 === args[0]) ? 1 : 0, rows: [] }
        if (sql.startsWith('SELECT * FROM')) return { rows: pending.has(args[0]) ? [pending.get(args[0])] : [], rowCount: pending.has(args[0]) ? 1 : 0 }
        return { rows: [], rowCount: 0 }
      },
    }
  }
  async query(sql: string, args?: any[]) { return (await this.connect()).query(sql, args) }
}

test('failed metadata rolls back and removes only unreferenced published bytes', async t => {
  const files = await volume(t)
  const pool = new FaultPool()
  pool.failure = 'insert'
  const store = new ShareStore(pool as unknown as Pool, files)
  await assert.rejects(store.put(`shares/${'a'.repeat(32)}.zip`, bytes), /metadata unavailable/)
  assert.deepEqual(await files.candidates(), [])
  assert.deepEqual(await readdir(join(files.root, 'tmp')), [])
  assert.equal(pool.committed.size, 0)
})

test('lost COMMIT response keeps committed bytes after fresh readback and never replays insert', async t => {
  const files = await volume(t)
  const pool = new FaultPool()
  pool.failure = 'commit-lost'
  const store = new ShareStore(pool as unknown as Pool, files)
  const key = `shares/${'b'.repeat(32)}.zip`
  await assert.rejects(store.put(key, bytes), /response lost/)
  assert.equal(pool.committed.size, 1)
  assert.equal((await store.head(key))?.size, bytes.length)
  await files.verify(digest(bytes), bytes.length)
  pool.failure = 'unavailable'
  await store.collectPublished([digest(bytes)])
  await files.verify(digest(bytes), bytes.length)
})

test('migration verifies all bytes even on dry-run; failed metadata leaves no published archive', async t => {
  const files = await volume(t)
  const directory = join(files.root, 'snapshot')
  await mkdir(join(directory, 'objects'), { recursive: true })
  const sha256 = digest(bytes)
  const object = { key: `shares/${'c'.repeat(32)}.zip`, size: bytes.length, sha256,
    customMetadata: { owner_sha256: 'a'.repeat(64), session_sha256: 'b'.repeat(64),
      created_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-09-08T00:00:00.000Z' }, httpMetadata: { contentType: 'application/zip' } }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, source_bucket: 'emate-session-shares', objects: [object] }))
  await writeFile(join(directory, 'objects', `${sha256}.bin`), bytes)
  const pool = new FaultPool()
  assert.equal((await migrate({ pool: pool as unknown as Pool, directory, volume: files.root, apply: false })).applied, false)
  assert.equal(pool.committed.size, 0)
  assert.deepEqual(await files.candidates(), [])
  pool.failure = 'insert'
  await assert.rejects(migrate({ pool: pool as unknown as Pool, directory, volume: files.root, apply: true }))
  assert.deepEqual(await files.candidates(), [])
  await writeFile(join(directory, 'objects', `${sha256}.bin`), new Uint8Array([1, 2, 3, 4]))
  await assert.rejects(migrate({ pool: pool as unknown as Pool, directory, volume: files.root, apply: false }), /digest/)
  assert.deepEqual(await readdir(join(files.root, 'tmp')), [])
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, source_bucket: 'emate-session-shares', objects: [{ ...object, key: '../escape' }] }))
  await assert.rejects(readSnapshot(directory), /snapshot object/)
})

test('configuration keeps one secret source and the Model Gateway as sole session authority', async () => {
  const valid = { SHARE_DATABASE_URL: 'postgresql://local/test', SHARE_MODEL_VALIDATION_URL: 'http://model-gateway/v1/consents/current' }
  assert.equal((await environment(valid)).host, '127.0.0.1')
  await assert.rejects(environment({ ...valid, SHARE_DATABASE_URL_FILE: '/secret' }), /exactly one/)
  for (const url of ['http://example.net/v1/consents/current', 'http://model-gateway/admin', 'https://example.net/auth', 'http://model-gateway/v1/consents/current?token=x']) {
    await assert.rejects(environment({ ...valid, SHARE_MODEL_VALIDATION_URL: url }), /endpoint/)
  }
})

test('migration lost COMMIT response preserves original public identity and supports verified replay', async t => {
  const files = await volume(t)
  const directory = join(files.root, 'snapshot')
  await mkdir(join(directory, 'objects'), { recursive: true })
  const sha256 = digest(bytes)
  const object = { key: `shares/${'d'.repeat(32)}.zip`, size: bytes.length, sha256,
    customMetadata: { owner_sha256: 'a'.repeat(64), session_sha256: 'b'.repeat(64),
      created_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-09-08T00:00:00.000Z' }, httpMetadata: { contentType: 'application/zip' } }
  const snapshot = { schema_version: 1, source_bucket: 'emate-session-shares', objects: [object] }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(snapshot))
  await writeFile(join(directory, 'objects', `${sha256}.bin`), bytes)
  const pool = new FaultPool()
  pool.failure = 'commit-lost'
  await assert.rejects(migrate({ pool: pool as unknown as Pool, directory, volume: files.root, apply: true }), /response lost/)
  await files.verify(sha256, bytes.length)
  const result = await migrate({ pool: pool as unknown as Pool, directory, volume: files.root, apply: true })
  assert.equal(result.data_ready, true)
  assert.equal(result.reused, 1)
  assert.deepEqual(pool.committed.get(object.key).custom_metadata, object.customMetadata)
  snapshot.objects[0].customMetadata.owner_sha256 = 'f'.repeat(64)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(snapshot))
  await assert.rejects(migrate({ pool: pool as unknown as Pool, directory, volume: files.root, apply: true }), /identity conflict/)
  assert.equal(pool.committed.get(object.key).custom_metadata.owner_sha256, 'a'.repeat(64))
  await files.verify(sha256, bytes.length)
})

test('readiness requires activated data, readable schema and accessible capacity-checked volume', async t => {
  const files = await volume(t)
  let activated = false
  let readable = true
  const pool = { async query(sql: string) {
    if (!readable) throw new Error('permission denied')
    assert.ok(sql.startsWith('SELECT manifest_sha256') || sql === 'SELECT key FROM emate_share.objects LIMIT 0')
    return { rowCount: activated ? 1 : 0, rows: [] }
  } } as unknown as Pool
  const service = createService({ pool, volume: files.root, validationUrl: 'http://model-gateway/v1/consents/current' })
  const health = () => service.fetch(new Request(`${PUBLIC_BASE}/v2/healthz`))
  assert.equal((await health()).status, 503)
  assert.equal((await service.fetch(new Request(`${PUBLIC_BASE}/s/${'a'.repeat(32)}`))).status, 503)
  activated = true
  assert.deepEqual(await (await health()).json(), { schema_version: 1, service: 'emate-share', version: 1, ready: true })
  assert.deepEqual(await (await service.fetch(new Request('http://local/readyz'))).json(), { schema_version: 1, ready: true, data_ready: true })
  readable = false
  assert.equal((await health()).status, 503)
  readable = true
  await rm(join(files.root, 'archives'), { recursive: true })
  assert.equal((await health()).status, 503)
  await mkdir(join(files.root, 'archives'))
  service.files.health = async () => { throw new Error('Share volume is full') }
  assert.equal((await health()).status, 503)
})
