import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { beginHubTransaction, postgresSchema, schemaName, TABLES } from './postgres.ts'
import { FilePackages, readRegular, syncDirectory } from './packages.ts'
import { COLUMNS, inspectSnapshot, tableDigest, type Snapshot, type SnapshotRow } from './snapshot.ts'
import { environment } from './server.ts'

export type MigrationOptions = {
  snapshotDirectory: string
  authorKey: string
  pool: Pool
  schema: string
  volume: string
  apply: boolean
  serviceRole?: string
  minimumFreeBytes?: number
}
export type MigrationReceipt = {
  schema_version: 1
  status: 'validated' | 'applied'
  migration_sha256: string
  author_key_unchanged: true
  summary: Snapshot['summary']
}

export class MigrationFailure extends Error {
  readonly phase: string
  readonly activationUncertain: boolean
  constructor(phase: string, activationUncertain = false) {
    super(`Skill Hub migration failed during ${phase}`)
    this.phase = phase
    this.activationUncertain = activationUncertain
  }
}

async function copyTables(client: PoolClient, snapshot: Snapshot): Promise<void> {
  for (const table of TABLES) {
    const columns = COLUMNS[table]
    for (let offset = 0; offset < snapshot.tables[table].length; offset += 200) {
      const rows = snapshot.tables[table].slice(offset, offset + 200)
      const values = rows.flatMap((row) => columns.map((column) => row[column]))
      const placeholders = rows.map((_row, index) => `(${columns.map((_column, column) => `$${index * columns.length + column + 1}`).join(',')})`).join(',')
      await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, values)
    }
  }
  const maxSequence = snapshot.tables.skill_hub_install_logs.reduce((maximum, row) => Math.max(maximum, Number(row.seq)), 0)
  await client.query("SELECT setval(pg_get_serial_sequence('skill_hub_install_logs','seq')::regclass,$1,$2)", [Math.max(1, maxSequence), maxSequence > 0])
}

async function verifyTables(client: PoolClient, snapshot: Snapshot): Promise<void> {
  for (const table of TABLES) {
    const result = await client.query<SnapshotRow>(`SELECT * FROM ${table}`)
    const rows = result.rows.map((row) => ({ ...row, ...(table === 'skill_hub_install_logs' ? { seq: Number(row.seq) } : {}) }))
    if (result.rows.length !== snapshot.summary.tables[table].count || tableDigest(rows) !== snapshot.summary.tables[table].sha256) throw new Error('Migration table readback differs')
  }
}

async function existingReceipt(client: PoolClient, schema: string): Promise<MigrationReceipt | null> {
  const exists = (await client.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [`${schema}.skill_hub_control`])).rows[0]?.name
  if (!exists) return null
  const row = (await client.query<{ receipt_json: string }>(`SELECT receipt_json FROM "${schema}".skill_hub_control WHERE singleton`)).rows[0]
  if (!row) throw new Error('Existing Skill Hub target is not an empty schema')
  return JSON.parse(row.receipt_json) as MigrationReceipt
}

export async function migrate(options: MigrationOptions): Promise<MigrationReceipt> {
  const schema = schemaName(options.schema)
  if (options.serviceRole) schemaName(options.serviceRole)
  let snapshot: Snapshot
  try { snapshot = await inspectSnapshot(options.snapshotDirectory, options.authorKey) } catch { throw new MigrationFailure('snapshot') }
  const receipt: MigrationReceipt = { schema_version: 1, status: options.apply ? 'applied' : 'validated',
    migration_sha256: snapshot.manifestSha256, author_key_unchanged: true, summary: snapshot.summary }
  const generation = randomUUID().replaceAll('-', '')
  const stagingSchema = `sh_stage_${generation}`
  const temporary = join(options.volume, '.staging', generation)
  const final = join(options.volume, 'generations', generation)
  const packages = new FilePackages(temporary, options.minimumFreeBytes)
  let stageCommitted = false
  let activationAttempted = false
  let phase = 'target-preflight'
  let connection: PoolClient | undefined
  try {
    connection = await beginHubTransaction(options.pool, schema, true)
    const previous = await existingReceipt(connection, schema)
    if (previous) {
      if (previous.migration_sha256 !== receipt.migration_sha256) throw new Error('A different Skill Hub migration is already active')
      await connection.query('COMMIT')
      return previous
    }
    await connection.query('COMMIT')
    connection.release(); connection = undefined
    phase = 'file-staging'
    await packages.initialize()
    await packages.ready(snapshot.summary.objects.bytes * 2 + snapshot.objects.length * 8192)
    for (const object of snapshot.objects) {
      const payload = await readRegular(join(snapshot.directory, object.key), 10 * 1024 * 1024)
      await packages.put(object.key, payload, { customMetadata: object.customMetadata, httpMetadata: object.httpMetadata })
    }
    phase = 'database-staging'
    connection = await options.pool.connect()
    await connection.query('BEGIN')
    await connection.query(`CREATE SCHEMA "${stagingSchema}"`)
    await connection.query(`SET LOCAL search_path TO "${stagingSchema}", pg_catalog`)
    await connection.query(postgresSchema())
    await copyTables(connection, snapshot)
    await connection.query('INSERT INTO skill_hub_control(author_key_sha256,generation,migration_sha256,receipt_json) VALUES ($1,$2,$3,$4)',
      [snapshot.authorKeySha256, generation, snapshot.manifestSha256, JSON.stringify({ ...receipt, status: 'applied' })])
    if (options.serviceRole) {
      await connection.query(`GRANT USAGE ON SCHEMA "${stagingSchema}" TO "${options.serviceRole}"`)
      await connection.query(`GRANT SELECT,INSERT ON ${TABLES.join(',')} TO "${options.serviceRole}"`)
      await connection.query(`GRANT UPDATE ON skill_hub_skills,skill_hub_install_intents TO "${options.serviceRole}"`)
      await connection.query(`GRANT SELECT ON skill_hub_control TO "${options.serviceRole}"`)
      await connection.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${stagingSchema}" TO "${options.serviceRole}"`)
    }
    await connection.query('COMMIT')
    stageCommitted = true
    connection.release(); connection = undefined
    // Independent connection and full-byte filesystem readback precede activation.
    phase = 'readback'
    connection = await options.pool.connect()
    await connection.query('BEGIN READ ONLY')
    await connection.query(`SET LOCAL search_path TO "${stagingSchema}", pg_catalog`)
    await verifyTables(connection, snapshot)
    await connection.query('COMMIT')
    connection.release(); connection = undefined
    const stored = await packages.list()
    if (stored.objects.length !== snapshot.objects.length) throw new Error('Migration object readback differs')
    for (const object of snapshot.objects) {
      const saved = stored.objects.find((value) => value.key === object.key)
      if (!saved || saved.size !== object.size || saved.customMetadata?.archive_sha256 !== object.customMetadata?.archive_sha256) throw new Error('Migration object identity differs')
    }
    if (!options.apply) return receipt
    phase = 'activation'
    await mkdir(join(options.volume, 'generations'), { recursive: true, mode: 0o700 })
    await syncDirectory(options.volume)
    await rename(temporary, final)
    await syncDirectory(join(options.volume, 'generations'))
    connection = await beginHubTransaction(options.pool, schema, true)
    const raced = await existingReceipt(connection, schema)
    if (raced) {
      if (raced.migration_sha256 !== receipt.migration_sha256) throw new Error('Migration target changed')
      await connection.query('COMMIT')
      return raced
    }
    const objects = await connection.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_class WHERE relnamespace=to_regnamespace($1)', [schema])
    if (objects.rows[0]?.count !== '0') throw new Error('Migration target contains existing data')
    activationAttempted = true
    await connection.query(`DROP SCHEMA IF EXISTS "${schema}"`)
    await connection.query(`ALTER SCHEMA "${stagingSchema}" RENAME TO "${schema}"`)
    await connection.query('COMMIT')
    return receipt
  } catch {
    throw new MigrationFailure(phase, activationAttempted)
  } finally {
    if (connection) { await connection.query('ROLLBACK').catch(() => {}); connection.release() }
    if (!activationAttempted) {
      if (stageCommitted) await options.pool.query(`DROP SCHEMA IF EXISTS "${stagingSchema}" CASCADE`)
      await rm(temporary, { recursive: true, force: true })
      await rm(final, { recursive: true, force: true })
    }
    // After COMMIT uncertainty, retain candidate bytes and let an identical retry read the durable receipt.
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 2 || !['--dry-run', '--apply'].includes(args[0]!)) throw new Error('Expected --dry-run or --apply and snapshot directory')
  const config = await environment(process.env)
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5000 })
  try {
    const receipt = await migrate({ ...config, pool, snapshotDirectory: args[1]!, apply: args[0] === '--apply', serviceRole: process.env.SKILL_HUB_SERVICE_ROLE })
    console.log(JSON.stringify(receipt))
  } finally { await pool.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ status: 'failed', phase: error instanceof MigrationFailure ? error.phase : 'configuration',
      active_state: error instanceof MigrationFailure && error.activationUncertain ? 'readback-required' : 'unchanged' }))
    process.exitCode = 1
  })
}
