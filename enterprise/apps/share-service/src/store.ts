import { AsyncLocalStorage } from 'node:async_hooks'
import { unlink } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import { ArchiveFiles, SHA256 } from './files.ts'

const KEY = /^(?:shares\/[A-Za-z0-9_-]{32}\.zip|owners\/[a-f0-9]{64}\/[a-f0-9]{64}\/[A-Za-z0-9_-]{32})$/u
export const SCHEMA = 'emate_share'
type Row = { key: string; size: string | number; sha256: string | null; custom_metadata: Record<string, string>; http_metadata: Record<string, string> }
export async function initialize(pool: Pool) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS emate_share;
    CREATE TABLE IF NOT EXISTS emate_share.objects (
      key text PRIMARY KEY, size bigint NOT NULL CHECK(size >= 0 AND size <= 104857600),
      sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
      custom_metadata jsonb NOT NULL, http_metadata jsonb NOT NULL,
      CHECK((size = 0 AND sha256 IS NULL) OR (size > 0 AND sha256 IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS objects_key_prefix ON emate_share.objects (key text_pattern_ops);
    CREATE INDEX IF NOT EXISTS objects_archive_digest ON emate_share.objects (sha256);
    CREATE TABLE IF NOT EXISTS emate_share.service_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
      imported_object_count bigint NOT NULL CHECK(imported_object_count >= 0),
      activated_at timestamptz NOT NULL DEFAULT now()
    )`)
}

export class ShareStore {
  pool: Pool
  files: ArchiveFiles
  signal: AbortSignal
  context = new AsyncLocalStorage<{ client: PoolClient; published: Set<string> }>()
  constructor(pool: Pool, files: ArchiveFiles, signal = AbortSignal.timeout(300_000)) {
    this.pool = pool; this.files = files; this.signal = signal
  }
  db() { return this.context.getStore()?.client ?? this.pool }
  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const existing = this.context.getStore()
    if (existing) return operation(existing.client)
    const client = await this.pool.connect()
    const published = new Set<string>()
    let failed = false
    let discard = false
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '20s'; SET LOCAL idle_in_transaction_session_timeout = '310s'")
      const result = await this.context.run({ client, published }, () => operation(client))
      this.signal.throwIfAborted()
      await client.query('COMMIT')
      return result
    } catch (error) {
      failed = true
      await client.query('ROLLBACK').catch(() => { discard = true })
      throw error
    } finally {
      client.release(discard)
      if (failed) await this.collectPublished(published)
    }
  }
  async collectPublished(digests: Iterable<string>) {
    // A failed COMMIT response is ambiguous. A fresh connection, digest lock
    // and committed-row readback decide whether bytes can be deleted. If the
    // database is unavailable, retain them for maintenance rather than risk loss.
    for (const sha of digests) {
      let client: PoolClient | undefined
      let discard = false
      try {
        client = await this.pool.connect()
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '5s'")
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`emate-share-blob:${sha}`])
        if (!(await client.query('SELECT 1 FROM emate_share.objects WHERE sha256=$1 LIMIT 1', [sha])).rowCount) {
          await unlink(this.files.path(sha)).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
        await client.query('COMMIT')
      } catch {
        if (client) await client.query('ROLLBACK').catch(() => { discard = true })
      } finally { client?.release(discard) }
    }
  }
  async withSessionLock<T>(owner: string, session: string, operation: () => Promise<T>) {
    if (!SHA256.test(owner) || !SHA256.test(session)) throw new Error('Invalid share owner')
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`emate-share:${owner}:${session}`])
      return operation()
    })
  }
  view(row: Row) {
    return { key: row.key, size: Number(row.size), customMetadata: row.custom_metadata, httpMetadata: row.http_metadata }
  }
  async head(key: string) {
    if (!KEY.test(key)) return null
    const row = (await this.db().query<Row>('SELECT * FROM emate_share.objects WHERE key=$1', [key])).rows[0]
    return row ? this.view(row) : null
  }
  async get(key: string) {
    if (!KEY.test(key)) return null
    const row = (await this.db().query<Row>('SELECT * FROM emate_share.objects WHERE key=$1', [key])).rows[0]
    if (!row) return null
    return { ...this.view(row), body: row.sha256 ? await this.files.read(row.sha256, Number(row.size)) : new Blob([]).stream() }
  }
  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> } = {}) {
    if (!KEY.test(key)) throw new Error('Invalid share key')
    if (key.startsWith('owners/')) {
      if (!(body instanceof Uint8Array) || body.byteLength !== 0) throw new Error('Invalid share index')
      await this.db().query('INSERT INTO emate_share.objects(key,size,sha256,custom_metadata,http_metadata) VALUES($1,0,NULL,$2,$3) ON CONFLICT(key) DO NOTHING', [key, options.customMetadata ?? {}, options.httpMetadata ?? {}])
      return { key, size: 0 }
    }
    const staged = await this.files.stage(body instanceof Uint8Array ? new Blob([new Uint8Array(body)]).stream() : body, this.signal)
    try {
      return await this.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`emate-share-blob:${staged.sha256}`])
        this.context.getStore()!.published.add(staged.sha256)
        await this.files.publish(staged)
        // Immutable public ID. In particular, migration/replay cannot replace
        // a shared archive or change its owner, session or expiry.
        await client.query('INSERT INTO emate_share.objects(key,size,sha256,custom_metadata,http_metadata) VALUES($1,$2,$3,$4,$5)',
          [key, staged.size, staged.sha256, options.customMetadata ?? {}, options.httpMetadata ?? {}])
        return { key, size: staged.size }
      })
    } finally { await unlink(staged.temporary).catch(() => {}) }
  }
  async delete(key: string) { await this.db().query('DELETE FROM emate_share.objects WHERE key=$1', [key]) }
  async list({ prefix = '', limit = 100, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
    if (!/^owners\/[a-f0-9]{64}\/[a-f0-9]{64}\/$/u.test(prefix) || !Number.isInteger(limit) || limit < 1 || limit > 1000 || (cursor && !KEY.test(cursor))) throw new Error('Invalid share list')
    const rows = (await this.db().query<Row>('SELECT * FROM emate_share.objects WHERE starts_with(key,$1) AND key > $2 ORDER BY key LIMIT $3', [prefix, cursor ?? '', limit + 1])).rows
    const truncated = rows.length > limit
    const page = rows.slice(0, limit)
    return { objects: page.map(row => this.view(row)), truncated, ...(truncated ? { cursor: page.at(-1)!.key } : {}) }
  }
  async collect() {
    // Maintenance runs against the same DB and digest lock as publication.
    // No directory is served publicly; unreferenced bytes are never accessible.
    await this.db().query("DELETE FROM emate_share.objects WHERE custom_metadata->>'expires_at' <= $1", [new Date().toISOString()])
    let removed = 0
    for (const sha of await this.files.candidates()) {
      await this.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`emate-share-blob:${sha}`])
        if (!(await client.query('SELECT 1 FROM emate_share.objects WHERE sha256=$1 LIMIT 1', [sha])).rowCount) {
          await unlink(this.files.path(sha)).catch(error => { if (error.code !== 'ENOENT') throw error })
          removed++
        }
      })
    }
    return { removed }
  }
}
