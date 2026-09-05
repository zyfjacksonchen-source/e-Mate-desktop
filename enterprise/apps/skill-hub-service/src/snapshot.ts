import { DatabaseSync, constants } from 'node:sqlite'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSkillArchive, versionSort } from '../../skill-hub-worker/src/core.ts'
import type { PackageMetadata } from '../../skill-hub-worker/src/ports.ts'
import { readRegular, sha256 } from './packages.ts'
import { TABLES, type HubTable } from './postgres.ts'

export const COLUMNS: Record<HubTable, string[]> = {
  skill_hub_skills: ['slug', 'latest_version', 'created_at', 'updated_at'],
  skill_hub_versions: ['slug', 'version', 'version_sort', 'package_sha256', 'archive_sha256', 'package_size_bytes', 'title', 'summary', 'category', 'tags_json', 'uploader_nickname', 'author_ref', 'original_platform', 'original_url', 'published_at'],
  skill_hub_publication_tombstones: ['slug', 'version', 'package_sha256', 'author_ref', 'client_request_id', 'deleted_at'],
  skill_hub_mutation_requests: ['account_ref', 'client_request_id', 'action', 'slug', 'version', 'package_sha256', 'status', 'created_at'],
  skill_hub_install_intents: ['intent_id', 'account_ref', 'slug', 'version', 'package_sha256', 'client_request_id', 'install_token_sha256', 'completion_token_sha256', 'expires_at', 'status', 'claimed_at', 'completed_at', 'created_at'],
  skill_hub_install_logs: ['seq', 'intent_id', 'account_ref', 'slug', 'version', 'package_sha256', 'status', 'created_at'],
}
export type SnapshotRow = Record<string, string | number | null>
export type Snapshot = {
  directory: string
  manifestSha256: string
  authorKeySha256: string
  tables: Record<HubTable, SnapshotRow[]>
  objects: PackageMetadata[]
  summary: { tables: Record<HubTable, { count: number; sha256: string }>; objects: { count: number; bytes: number; sha256: string } }
}
const digestPattern = /^[a-f0-9]{64}$/
const authorPattern = /^author_[a-f0-9]{24}$/
const nullable = new Set(['original_platform', 'original_url', 'completion_token_sha256', 'claimed_at', 'completed_at'])

export function tableDigest(rows: SnapshotRow[]): string {
  return sha256(rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).sort().join('\n'))
}

async function readD1(bytes: Buffer): Promise<Record<HubTable, SnapshotRow[]>> {
  const temporary = await mkdtemp(join(tmpdir(), 'emate-skill-d1-'))
  let database: DatabaseSync | undefined
  try {
    const binary = bytes.subarray(0, 16).toString('binary') === 'SQLite format 3\0'
    const path = join(temporary, 'snapshot.sqlite')
    if (binary) await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    database = new DatabaseSync(binary ? path : ':memory:', { readOnly: binary, allowExtension: false })
    const allowed = new Set<string>([...TABLES, 'sqlite_master', 'sqlite_sequence'])
    let loading = !binary
    database.setAuthorizer((action, one, two, db) => {
      if (db && db !== 'main') return constants.SQLITE_DENY
      if (action === constants.SQLITE_SELECT) return loading ? constants.SQLITE_DENY : constants.SQLITE_OK
      if ([constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT].includes(action)) return constants.SQLITE_OK
      if ([constants.SQLITE_READ, constants.SQLITE_INSERT, constants.SQLITE_CREATE_TABLE].includes(action)) return allowed.has(one ?? '') ? constants.SQLITE_OK : constants.SQLITE_DENY
      if ([constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(action)) return ['sqlite_master', 'sqlite_sequence'].includes(one ?? '') ? constants.SQLITE_OK : constants.SQLITE_DENY
      if ([constants.SQLITE_CREATE_INDEX, constants.SQLITE_CREATE_TRIGGER].includes(action)) return TABLES.includes(two as HubTable) ? constants.SQLITE_OK : constants.SQLITE_DENY
      if (action === constants.SQLITE_REINDEX) return ['skill_hub_versions_slug_sort', 'skill_hub_versions_author'].includes(one ?? '') ? constants.SQLITE_OK : constants.SQLITE_DENY
      if (action === constants.SQLITE_PRAGMA) return ['foreign_keys', 'defer_foreign_keys'].includes(one ?? '') ? constants.SQLITE_OK : constants.SQLITE_DENY
      if (action === constants.SQLITE_FUNCTION) return ['raise', 'length'].includes(two ?? '') ? constants.SQLITE_OK : constants.SQLITE_DENY
      return constants.SQLITE_DENY
    })
    if (!binary) database.exec(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    loading = false
    const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name))
    if (TABLES.some((table) => !tableNames.includes(table)) || tableNames.some((name) => name !== 'sqlite_sequence' && !TABLES.includes(name as HubTable))) throw new Error('Unexpected D1 tables')
    const tables = {} as Record<HubTable, SnapshotRow[]>
    for (const table of TABLES) {
      const rows = database.prepare(`SELECT * FROM ${table}`).all()
      if (rows.length > 100_000) throw new Error('Snapshot table exceeds migration bound')
      tables[table] = rows.map((row) => {
        if (Object.keys(row).sort().join(',') !== [...COLUMNS[table]].sort().join(',')) throw new Error('Snapshot columns differ from wire storage')
        for (const [key, value] of Object.entries(row)) {
          if (value === null && nullable.has(key)) continue
          if (['seq', 'package_size_bytes'].includes(key)) {
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid snapshot number')
          } else if (typeof value !== 'string' || Buffer.byteLength(value) > 65536) throw new Error('Invalid snapshot scalar')
        }
        return { ...row } as SnapshotRow
      })
    }
    return tables
  } finally { database?.close(); await rm(temporary, { recursive: true, force: true }) }
}

function relations(tables: Record<HubTable, SnapshotRow[]>): void {
  const versions = new Map(tables.skill_hub_versions.map((row) => [`${row.slug}\0${row.version}`, row]))
  const skills = new Set(tables.skill_hub_skills.map((row) => row.slug))
  const owners = new Map<string, string>()
  const packages = new Set<string>()
  for (const row of versions.values()) {
    if (!skills.has(row.slug) || !authorPattern.test(String(row.author_ref)) || versionSort(row.version) !== row.version_sort ||
        !digestPattern.test(String(row.package_sha256)) || !digestPattern.test(String(row.archive_sha256)) ||
        packages.has(String(row.package_sha256))) throw new Error('Invalid version ownership or identity')
    const owner = owners.get(String(row.slug))
    if (owner !== undefined && owner !== row.author_ref) throw new Error('Ambiguous slug ownership')
    owners.set(String(row.slug), String(row.author_ref))
    packages.add(String(row.package_sha256))
  }
  const tombstones = new Map(tables.skill_hub_publication_tombstones.map((row) => [`${row.slug}\0${row.version}`, row]))
  for (const row of tables.skill_hub_skills) {
    if (!versions.has(`${row.slug}\0${row.latest_version}`)) throw new Error('Dangling latest version')
    const active = [...versions.values()].filter((version) => version.slug === row.slug && !tombstones.has(`${version.slug}\0${version.version}`))
      .sort((a, b) => String(a.version_sort) < String(b.version_sort) ? 1 : String(a.version_sort) > String(b.version_sort) ? -1 : String(a.version) < String(b.version) ? 1 : -1)
    if (active.length && active[0]!.version !== row.latest_version) throw new Error('Latest version does not match SemVer ordering')
  }
  for (const row of [...tombstones.values(), ...tables.skill_hub_mutation_requests]) {
    const version = versions.get(`${row.slug}\0${row.version}`)
    if (!version || version.package_sha256 !== row.package_sha256 || version.author_ref !== (row.author_ref ?? row.account_ref)) throw new Error('Invalid publication reference')
    if (row.action && (row.status !== (row.action === 'publish' ? 'published' : 'deleted') ||
        (row.action === 'delete' && !tombstones.has(`${row.slug}\0${row.version}`)))) throw new Error('Invalid mutation receipt')
  }
  const intents = new Map(tables.skill_hub_install_intents.map((row) => [row.intent_id, row]))
  for (const row of intents.values()) {
    const version = versions.get(`${row.slug}\0${row.version}`)
    if (!version || version.package_sha256 !== row.package_sha256 || !authorPattern.test(String(row.account_ref)) ||
        !digestPattern.test(String(row.install_token_sha256)) ||
        (row.completion_token_sha256 !== null && !digestPattern.test(String(row.completion_token_sha256))) ||
        !Number.isFinite(Date.parse(String(row.expires_at)))) throw new Error('Invalid install intent reference')
  }
  for (const row of tables.skill_hub_install_logs) {
    const intent = intents.get(row.intent_id)
    if (!intent || ['account_ref', 'slug', 'version', 'package_sha256'].some((key) => intent[key] !== row[key])) throw new Error('Invalid install receipt reference')
  }
}

export async function inspectSnapshot(directory: string, authorKey: string): Promise<Snapshot> {
  const manifestBytes = await readRegular(join(directory, 'manifest.json'), 16 * 1024 * 1024)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
  if (manifest.schema_version !== 1 || manifest.author_key_sha256 !== sha256(authorKey) || !Array.isArray(manifest.objects) || manifest.objects.length > 100_000 ||
      typeof manifest.d1_sha256 !== 'string' || !digestPattern.test(manifest.d1_sha256) ||
      typeof manifest.table_counts !== 'object' || manifest.table_counts === null) throw new Error('Invalid migration manifest or owner key')
  const data = await readRegular(join(directory, 'd1.snapshot'), 256 * 1024 * 1024)
  if (sha256(data) !== manifest.d1_sha256) throw new Error('D1 snapshot checksum differs')
  const tables = await readD1(data)
  relations(tables)
  const counts = manifest.table_counts as Record<string, unknown>
  if (Object.keys(counts).sort().join(',') !== [...TABLES].sort().join(',')) throw new Error('Invalid snapshot table count set')
  const summaryTables = {} as Snapshot['summary']['tables']
  for (const table of TABLES) {
    if (counts[table] !== tables[table].length) throw new Error('Snapshot row count differs')
    summaryTables[table] = { count: tables[table].length, sha256: tableDigest(tables[table]) }
  }
  const objects: PackageMetadata[] = []
  const keys = new Set<string>()
  let bytes = 0
  const inspected = new Map<string, { name: string; version: string }>()
  for (const value of manifest.objects) {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid snapshot object')
    const object = value as PackageMetadata
    if (!/^packages\/[a-f0-9]{64}\.zip$/.test(object.key) || keys.has(object.key) || !Number.isSafeInteger(object.size) ||
        object.size < 1 || object.size > 10 * 1024 * 1024 ||
        object.customMetadata?.package_sha256 !== object.key.slice(9, -4) ||
        !digestPattern.test(object.customMetadata?.archive_sha256 ?? '')) throw new Error('Invalid snapshot object metadata')
    const payload = await readRegular(join(directory, object.key), 10 * 1024 * 1024)
    const skill = await inspectSkillArchive(payload)
    if (payload.length !== object.size || sha256(payload) !== object.customMetadata.archive_sha256 || skill.packageSha256 !== object.customMetadata.package_sha256) throw new Error('Snapshot package checksum differs')
    keys.add(object.key)
    bytes += payload.length
    inspected.set(skill.packageSha256, { name: skill.name, version: skill.version })
    objects.push(object)
  }
  const files = await readdir(join(directory, 'packages'))
  if (files.length !== objects.length || files.some((file) => !keys.has(`packages/${file}`))) throw new Error('Snapshot object count differs')
  for (const row of tables.skill_hub_versions) {
    const object = objects.find((candidate) => candidate.customMetadata?.package_sha256 === row.package_sha256)
    const skill = inspected.get(String(row.package_sha256))
    if (!object || object.size !== row.package_size_bytes || object.customMetadata?.archive_sha256 !== row.archive_sha256 ||
        skill?.name !== row.slug || skill.version !== row.version) throw new Error('Version has no exact package bytes')
  }
  return { directory, manifestSha256: sha256(manifestBytes), authorKeySha256: String(manifest.author_key_sha256), tables, objects,
    summary: { tables: summaryTables, objects: { count: objects.length, bytes, sha256: sha256(objects.map((object) => `${object.key}:${object.size}:${object.customMetadata!.archive_sha256}`).sort().join('\n')) } } }
}
