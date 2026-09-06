import { readFile, open, lstat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import { ArchiveFiles, MAX_UPLOAD_BYTES, SHA256 } from './files.ts'
import { initialize, ShareStore } from './store.ts'

type SnapshotObject = { key: string; size: number; sha256: string; customMetadata: Record<string, string>; httpMetadata: Record<string, string> }
type Snapshot = { schema_version: 1; source_bucket: 'emate-session-shares'; objects: SnapshotObject[] }
const ARCHIVE = /^shares\/([A-Za-z0-9_-]{32})\.zip$/u
const INDEX = /^owners\/([a-f0-9]{64})\/([a-f0-9]{64})\/([A-Za-z0-9_-]{32})$/u
const metadata = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value).length <= 16 && Object.entries(value).every(([key, item]) => key.length < 100 && typeof item === 'string' && item.length < 4096)

export async function readSnapshot(directory: string) {
  const filename = join(directory, 'manifest.json')
  const info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Invalid share snapshot manifest')
  const bytes = await readFile(filename)
  const value: Snapshot = JSON.parse(bytes.toString('utf8'))
  if (value.schema_version !== 1 || value.source_bucket !== 'emate-session-shares' || !Array.isArray(value.objects) || value.objects.length > 100_000) throw new Error('Invalid share snapshot')
  const seen = new Set<string>()
  for (const item of value.objects) {
    const archive = ARCHIVE.exec(item.key)
    const index = INDEX.exec(item.key)
    if ((!archive && !index) || seen.has(item.key) || !SHA256.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_UPLOAD_BYTES ||
        (index && item.size !== 0) || (archive && item.size === 0) || !metadata(item.customMetadata) || !metadata(item.httpMetadata)) throw new Error('Invalid share snapshot object')
    for (const field of ['created_at', 'expires_at']) {
      const date = item.customMetadata[field]
      if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error('Invalid share snapshot dates')
    }
    if (archive && (!SHA256.test(item.customMetadata.owner_sha256) || !SHA256.test(item.customMetadata.session_sha256))) throw new Error('Invalid share snapshot owner')
    seen.add(item.key)
  }
  return { snapshot: value, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function sourceBody(directory: string, item: SnapshotObject) {
  const file = await open(join(directory, 'objects', `${item.sha256}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW)
  const info = await file.stat()
  if (!info.isFile() || info.size !== item.size) { await file.close(); throw new Error('Invalid share snapshot bytes') }
  return Readable.toWeb(file.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>
}

function sameMetadata(left: Record<string, string>, right: Record<string, string>) {
  const a = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const b = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function migrate(options: { pool: Pool; directory: string; volume: string; apply: boolean }) {
  const { snapshot, sha256 } = await readSnapshot(options.directory)
  const files = new ArchiveFiles(options.volume)
  await files.ready()
  // Validation touches no metadata. Every byte is streamed and hashed even on
  // replay, and every public ID is checked against any already committed row.
  await initialize(options.pool)
  const client = await options.pool.connect()
  const staged: { temporary: string; sha256: string; size: number }[] = []
  let reused = 0
  let failed = false
  let discard = false
  const published = new Set<string>()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='20s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('emate-share-migration', 0))")
    for (const item of snapshot.objects) {
      const body = await sourceBody(options.directory, item)
      let stage: { temporary: string; sha256: string; size: number } | undefined
      if (item.size === 0) {
        const bytes = await new Response(body).arrayBuffer()
        if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== item.sha256) throw new Error('Invalid share snapshot digest')
      } else {
        stage = await files.stage(body, AbortSignal.timeout(300_000))
        staged.push(stage)
        if (stage.sha256 !== item.sha256 || stage.size !== item.size) throw new Error('Invalid share snapshot digest')
      }
      const existing = (await client.query('SELECT * FROM emate_share.objects WHERE key=$1', [item.key])).rows[0]
      if (existing) {
        if (Number(existing.size) !== item.size || (existing.sha256 ?? item.sha256) !== item.sha256 ||
            !sameMetadata(existing.custom_metadata, item.customMetadata) || !sameMetadata(existing.http_metadata, item.httpMetadata)) throw new Error('Share migration identity conflict')
        if (item.size) await files.verify(item.sha256, item.size)
        reused++
        if (stage) { await unlink(stage.temporary); staged.pop() }
        continue
      }
      if (options.apply) {
        if (stage) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`emate-share-blob:${item.sha256}`])
          published.add(stage.sha256)
          await files.publish(stage)
        }
        await client.query('INSERT INTO emate_share.objects(key,size,sha256,custom_metadata,http_metadata) VALUES($1,$2,$3,$4,$5)',
          [item.key, item.size, item.size ? item.sha256 : null, item.customMetadata, item.httpMetadata])
      }
      if (stage) { await unlink(stage.temporary); staged.pop() }
    }
    if (options.apply) {
      // Verify exact readback before committing the entire metadata set.
      for (const item of snapshot.objects) {
        const row = (await client.query('SELECT * FROM emate_share.objects WHERE key=$1', [item.key])).rows[0]
        if (!row || Number(row.size) !== item.size || !sameMetadata(row.custom_metadata, item.customMetadata) || !sameMetadata(row.http_metadata, item.httpMetadata)) throw new Error('Share migration readback failed')
      }
    }
    if (options.apply) await client.query(`INSERT INTO emate_share.service_state(singleton,manifest_sha256,imported_object_count) VALUES(true,$1,$2)
      ON CONFLICT(singleton) DO UPDATE SET manifest_sha256=EXCLUDED.manifest_sha256,imported_object_count=EXCLUDED.imported_object_count,activated_at=now()`, [sha256, snapshot.objects.length])
    await client.query(options.apply ? 'COMMIT' : 'ROLLBACK')
    return { schema_version: 1, applied: options.apply, data_ready: options.apply, manifest_sha256: sha256, objects: snapshot.objects.length, reused }
  } catch (error) {
    failed = true
    await client.query('ROLLBACK').catch(() => { discard = true })
    throw error
  } finally {
    for (const stage of staged) await unlink(stage.temporary).catch(() => {})
    client.release(discard)
    if (failed) await new ShareStore(options.pool, files).collectPublished(published)
  }
}

export async function main(env = process.env, args = process.argv.slice(2)) {
  if (args.length !== 2 || !['--check', '--apply'].includes(args[0])) throw new Error('Use --check or --apply with a snapshot directory')
  if (!env.SHARE_DATABASE_URL_FILE || !env.SHARE_VOLUME) throw new Error('Migration secret and volume paths are required')
  const pool = new Pool({ connectionString: (await readFile(env.SHARE_DATABASE_URL_FILE, 'utf8')).trim(), max: 1, connectionTimeoutMillis: 5000 })
  try { return await migrate({ pool, directory: resolve(args[1]), volume: env.SHARE_VOLUME, apply: args[0] === '--apply' }) }
  finally { await pool.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(value => { console.log(JSON.stringify(value)) }).catch(() => {
    console.error(JSON.stringify({ event: 'share_migration_failed', active_state: 'verify_database_before_retry' }))
    process.exitCode = 1
  })
}
