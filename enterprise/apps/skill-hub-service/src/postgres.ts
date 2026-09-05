import { readFileSync } from 'node:fs'
import type { Pool, PoolClient } from 'pg'
import type { HubDatabase, HubStatement } from '../../skill-hub-worker/src/ports.ts'

export const TABLES = ['skill_hub_skills', 'skill_hub_versions', 'skill_hub_publication_tombstones',
  'skill_hub_mutation_requests', 'skill_hub_install_intents', 'skill_hub_install_logs'] as const
export type HubTable = typeof TABLES[number]

export function schemaName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(value) || value === 'public' || value.startsWith('pg_')) throw new Error('Invalid Skill Hub schema')
  return value
}

const timestamp = "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')"
export function postgresSchema(): string {
  const original = readFileSync(new URL('../../skill-hub-worker/schema.sql', import.meta.url), 'utf8')
    .replace(/PRAGMA foreign_keys = ON;/u, '')
    .replace(/CREATE TRIGGER IF NOT EXISTS[\s\S]*?\bEND;/gu, '')
    .replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGSERIAL PRIMARY KEY')
    .replace(/\bTEXT\b/gu, 'TEXT COLLATE "C"')
    .replace(/DEFAULT CURRENT_TIMESTAMP/gu, `DEFAULT (${timestamp})`)
  const immutable = ['skill_hub_versions', 'skill_hub_publication_tombstones', 'skill_hub_mutation_requests', 'skill_hub_install_logs']
  return `${original}
    CREATE OR REPLACE FUNCTION reject_skill_hub_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Skill Hub history is immutable'; END $$;
    ${immutable.map((table) => `CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_skill_hub_rewrite();`).join('\n')}
    CREATE TABLE skill_hub_control (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      author_key_sha256 text NOT NULL, generation text NOT NULL, migration_sha256 text NOT NULL,
      receipt_json text NOT NULL);
  `
}

/** Only the six-table SQL vocabulary in the shared core is adapted, not a D1 emulator. */
export function postgresQuery(sql: string, previousChanges = 0): string {
  let result = sql.replace(/\bCURRENT_TIMESTAMP\b/gu, timestamp)
    .replace(/instr\((v\.tags_json),\?\)/gu, 'strpos($1,?)')
    .replace(/\bLIKE\b/gu, 'ILIKE')
    .replace(/\? IS NULL/gu, 'CAST(? AS TEXT) IS NULL')
    .replace(/changes\(\)/gu, String(previousChanges))
  const ignore = result.startsWith('INSERT OR IGNORE INTO ')
  if (ignore) result = result.replace('INSERT OR IGNORE INTO ', 'INSERT INTO ')
  let position = 0
  let quoted = false
  result = [...result].map((character) => {
    if (character === "'") quoted = !quoted
    return character === '?' && !quoted ? `$${++position}` : character
  }).join('')
  return ignore ? `${result} ON CONFLICT DO NOTHING` : result
}

class Statement implements HubStatement {
  readonly owner: PostgresDatabase
  readonly sql: string
  readonly values: unknown[]
  constructor(owner: PostgresDatabase, sql: string, values: unknown[] = []) { this.owner = owner; this.sql = sql; this.values = values }
  bind(...values: unknown[]): Statement { return new Statement(this.owner, this.sql, values) }
  async first() { return (await this.owner.query(this.sql, this.values)).rows[0] ?? null }
  async all() { return { results: (await this.owner.query(this.sql, this.values)).rows } }
  async run() { return { meta: { changes: (await this.owner.query(this.sql, this.values)).rowCount ?? 0 } } }
}

export class PostgresDatabase implements HubDatabase {
  readonly client: PoolClient
  constructor(client: PoolClient) { this.client = client }
  prepare(sql: string): Statement { return new Statement(this, sql) }
  query(sql: string, values: unknown[] = [], changes = 0) { return this.client.query(postgresQuery(sql, changes), values) }
  async batch(statements: HubStatement[]) {
    await this.client.query('SAVEPOINT skill_hub_batch')
    const results: Array<{ meta: { changes: number } }> = []
    try {
      for (const statement of statements) {
        if (!(statement instanceof Statement) || statement.owner !== this) throw new Error('Invalid Skill Hub statement owner')
        const result = await this.query(statement.sql, statement.values, results.at(-1)?.meta.changes ?? 0)
        results.push({ meta: { changes: result.rowCount ?? 0 } })
      }
      await this.client.query('RELEASE SAVEPOINT skill_hub_batch')
      return results
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT skill_hub_batch')
      await this.client.query('RELEASE SAVEPOINT skill_hub_batch')
      throw error
    }
  }
}

export async function beginHubTransaction(pool: Pool, schema: string, write: boolean): Promise<PoolClient> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL search_path TO "${schemaName(schema)}", pg_catalog`)
    await client.query("SET LOCAL statement_timeout = '30s'")
    await client.query("SET LOCAL lock_timeout = '10s'")
    // ponytail: serialize metadata mutations per schema; measured write pressure can justify per-target locks later.
    await client.query(`SELECT ${write ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`, [`e-mate-skill-hub:${schema}`])
    return client
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); client.release(); throw error }
}
