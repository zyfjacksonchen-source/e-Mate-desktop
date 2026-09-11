import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SESSION_FORMAT_VERSION = 3
const RECEIPT_SCHEMA = 1
const RECEIPT_NAME = 'legacy-sessions-v1.json'
const COPY_BUFFER_BYTES = 1024 * 1024
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024
const MAX_SESSIONS = 100_000
const MAX_MESSAGE_ROWS = 2_000_000
const SOURCE_UNAVAILABLE_CODES = new Set(['EACCES', 'EBUSY', 'ENOENT', 'ENOTDIR', 'EPERM', 'ESTALE'])
const PROTECTED_ATTACHMENT_PARTS = new Set([
  '.env', '.git', '.ssh', 'browser', 'browser_profile', 'cache', 'cookies', 'credentials', 'keychain', 'profiles', 'secrets',
])
const CONVERSATION_CANDIDATES = [
  'sessions/conversations.db',
  'memory/long-term/index.db',
  'memory/conversations.db',
  'conversations.db',
]

type JsonRecord = Record<string, unknown>
type LegacyFamily = 'emate-runtime' | 'ecorex-runtime' | 'cowagent'

export interface LegacySource {
  family: LegacyFamily
  database: string
  root: string
}

interface SessionHandleLike {
  header: JsonRecord
  read(): Promise<{ events: readonly JsonRecord[] }>
  append(events: readonly JsonRecord[]): Promise<void>
  close(): Promise<void>
}

interface SessionPersistenceLike {
  create(header: JsonRecord): Promise<SessionHandleLike>
  open(id: string, access: 'read' | 'write'): Promise<SessionHandleLike>
  list(): Promise<readonly { header: JsonRecord }[]>
}

async function readStoredSession(sessionPersistence: SessionPersistenceLike, id: string) {
  const handle = await sessionPersistence.open(id, 'read')
  try {
    const { events } = await handle.read()
    return { meta: handle.header, events: [...events] }
  } finally {
    await handle.close()
  }
}

export interface LegacyMigrationOptions {
  sessionPersistence: SessionPersistenceLike
  dshHome: string
  home?: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  sources?: LegacySource[]
  skipUnavailableSources?: boolean
}

export interface LegacyMigrationResult {
  source_found: boolean
  unavailable_sources?: number
  imported_sessions: number
  reused_sessions: number
  receipt_path: string
  source_fingerprints: string[]
}

interface SourceSnapshot {
  source: LegacySource
  fingerprint: string
  snapshot: string
}

interface PlannedSession {
  id: string
  canonicalKey: string
  sourceFamily: LegacyFamily
  sourceDatabase: string
  legacyId: string
  header: JsonRecord
  events: JsonRecord[]
  evidence: JsonRecord
  attachments: PlannedAttachment[]
}

interface PlannedAttachment {
  source: string
  identity: ReturnType<typeof fileIdentity>
  descriptor: JsonRecord
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function stableId(prefix: string, ...parts: unknown[]) {
  return `${prefix}-${sha256(parts.map(String).join('\u001f')).slice(0, 32)}`
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnavailableSource(error: unknown, source: LegacySource) {
  if (!isRecord(error) || typeof error.code !== 'string' || !SOURCE_UNAVAILABLE_CODES.has(error.code)) return false
  if (typeof error.path !== 'string' || error.path.includes('\u0000')) return false
  const root = resolve(source.root)
  const path = resolve(error.path)
  return path === root || path.startsWith(`${root}${sep}`)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function atomicWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function assertSafeRegularFile(path: string, root: string, label: string) {
  const absoluteRoot = resolve(root)
  const absolute = resolve(path)
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`${label} escapes its source root`)
  }
  const rootMetadata = lstatSync(absoluteRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error(`${label} source root is unsafe`)
  let cursor = absoluteRoot
  for (const part of relative(absoluteRoot, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    const metadata = lstatSync(cursor)
    if (metadata.isSymbolicLink()) throw new Error(`${label} crosses a symbolic link`)
  }
  const metadata = lstatSync(absolute)
  if (!metadata.isFile()) throw new Error(`${label} is not a safe regular file`)
  return absolute
}

function fileIdentity(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    return descriptorIdentity(descriptor, path)
  } finally {
    closeSync(descriptor)
  }
}

function descriptorIdentity(descriptor: number, path: string) {
  const metadata = fstatSync(descriptor)
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`)
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
  let position = 0
  while (position < metadata.size) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, metadata.size - position), position)
    if (count === 0) throw new Error(`${path} changed while it was read`)
    hash.update(buffer.subarray(0, count))
    position += count
  }
  const after = fstatSync(descriptor)
  if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size
    || after.mtimeMs !== metadata.mtimeMs) throw new Error(`${path} changed while it was read`)
  return { size: metadata.size, sha256: hash.digest('hex'), dev: metadata.dev, ino: metadata.ino, mtimeMs: metadata.mtimeMs }
}

export function openLegacyArtifactObject(dshHome: string, digest: string) {
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error('invalid legacy artifact id')
  const root = join(resolve(dshHome), 'e-mate', 'attachments', 'legacy-v1', 'objects')
  const path = assertSafeRegularFile(join(root, digest.slice(0, 2), digest.slice(2, 4), digest), root, 'legacy attachment object')
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const identity = descriptorIdentity(descriptor, path)
    if (identity.sha256 !== digest || identity.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('legacy attachment object failed its content identity check')
    }
    return { descriptor, size: identity.size }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function stableCopy(source: string, target: string, expected: ReturnType<typeof fileIdentity>) {
  const input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    const before = fstatSync(input)
    if (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size
      || before.mtimeMs !== expected.mtimeMs) throw new Error(`${source} changed before it was copied`)
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let position = 0
    while (position < expected.size) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, expected.size - position), position)
      if (count === 0) throw new Error(`${source} changed while it was copied`)
      let written = 0
      while (written < count) written += writeSync(output, buffer, written, count - written)
      position += count
    }
    fsyncSync(output)
    const after = fstatSync(input)
    if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size
      || after.mtimeMs !== expected.mtimeMs) throw new Error(`${source} changed while it was copied`)
  } finally {
    closeSync(output)
    closeSync(input)
  }
  const copied = fileIdentity(target)
  if (copied.size !== expected.size || copied.sha256 !== expected.sha256) {
    throw new Error(`${source} copy failed its SHA256 check`)
  }
}

function snapshotSource(source: LegacySource, scratch: string): SourceSnapshot {
  const database = assertSafeRegularFile(source.database, source.root, 'legacy database')
  const sidecar = `${database}-wal`
  const state = () => {
    const items = [{ label: 'database', path: database, identity: fileIdentity(database) }]
    if (existsSync(sidecar)) {
      items.push({ label: 'wal', path: assertSafeRegularFile(sidecar, source.root, 'legacy WAL'), identity: fileIdentity(sidecar) })
    }
    return items
  }
  const before = state()
  const base = join(scratch, `${sha256(database).slice(0, 16)}.sqlite3`)
  stableCopy(database, base, before[0].identity)
  const wal = before.find(item => item.label === 'wal')
  if (wal !== undefined) stableCopy(wal.path, `${base}-wal`, wal.identity)
  const after = state()
  if (canonicalJson(after) !== canonicalJson(before)) throw new Error(`${database} changed during migration snapshot`)
  const fingerprint = sha256(canonicalJson({
    family: source.family,
    database,
    files: before.map(item => ({ label: item.label, size: item.identity.size, sha256: item.identity.sha256 })),
  }))
  return { source: { ...source, database }, fingerprint, snapshot: base }
}

function tableColumns(database: DatabaseSync, table: string) {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as JsonRecord[]).map(row => String(row.name)))
}

function tableNames(database: DatabaseSync) {
  return new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as JsonRecord[]).map(row => String(row.name)))
}

function requireTable(database: DatabaseSync, table: string, columns: string[], subject: string) {
  const names = tableNames(database)
  if (!names.has(table)) throw new Error(`${subject} is missing table ${table}`)
  const actual = tableColumns(database, table)
  const missing = columns.filter(column => !actual.has(column))
  if (missing.length > 0) throw new Error(`${subject} is missing ${table} columns: ${missing.join(', ')}`)
  return actual
}

function requireBoundedRows(database: DatabaseSync, table: string, maximum: number, subject: string) {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as JsonRecord
  const count = Number(row.count)
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new Error(`${subject} exceeds the supported row boundary`)
  }
}

function openSnapshot(path: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  database.exec('PRAGMA query_only = ON')
  const integrity = database.prepare('PRAGMA integrity_check').all() as JsonRecord[]
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    database.close()
    throw new Error('legacy database failed SQLite integrity_check')
  }
  return database
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.trim() === '') return ''
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function displayText(value: unknown): string {
  const parsed = parseJson(value)
  if (typeof parsed === 'string') return parsed.trim()
  if (Array.isArray(parsed)) return parsed.map(displayText).filter(Boolean).join('\n').trim()
  if (isRecord(parsed)) {
    if (typeof parsed.text === 'string') return parsed.text.trim()
    if ('content' in parsed) return displayText(parsed.content)
  }
  return ''
}

function epochMilliseconds(value: unknown) {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  const milliseconds = Math.abs(numeric) > 10_000_000_000 ? numeric : numeric * 1000
  const result = Math.trunc(milliseconds)
  return Number.isSafeInteger(result) && result >= 0 ? result : 0
}

function normalizeTitle(value: unknown) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (Buffer.byteLength(normalized) <= 80) return normalized
  let result = ''
  for (const character of normalized) {
    if (Buffer.byteLength(result + character) > 80) break
    result += character
  }
  return result.trim()
}

function safeAttachmentName(value: unknown, fallback: string) {
  const candidate = typeof value === 'string' ? basename(value).replace(/[\u0000-\u001f\u007f]/gu, '').trim() : ''
  return (candidate || fallback).slice(0, 240)
}

function attachmentPath(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) return undefined
  const raw = value.trim()
  if (raw.startsWith('file://')) {
    try {
      const url = new URL(raw)
      if (url.hostname !== '' && url.hostname !== 'localhost') return undefined
      return fileURLToPath(url)
    } catch {
      return undefined
    }
  }
  if (/^https?:\/\//iu.test(raw)) return undefined
  return raw
}

function unavailableAttachment(
  raw: JsonRecord,
  messageSequence: unknown,
  kind: 'artifact' | 'attachment',
  reason: string,
) {
  const requestedPath = raw.path ?? raw.relativePath ?? raw.file_path ?? raw.filePath
  return {
    status: 'unavailable',
    reason,
    kind,
    message_seq: String(messageSequence),
    name: safeAttachmentName(raw.title ?? raw.file_name ?? requestedPath, kind === 'artifact' ? '历史产物' : '历史附件'),
  }
}

function planReferencedFile(
  raw: JsonRecord,
  sourceRoot: string,
  messageSequence: unknown,
  kind: 'artifact' | 'attachment',
): { plan?: PlannedAttachment; descriptor: JsonRecord } {
  const role = String(raw.role ?? '').toLowerCase()
  if (['rendition', 'source', 'intermediate', 'diagnostic'].includes(role)) {
    return { descriptor: unavailableAttachment(raw, messageSequence, kind, 'internal-history') }
  }
  const status = String(raw.status ?? 'ready').toLowerCase()
  if (['failed', 'error', 'pending', 'queued', 'running', 'retrying', 'deleted'].includes(status)) {
    return { descriptor: unavailableAttachment(raw, messageSequence, kind, `source-${status}`) }
  }
  const rawPath = raw.path ?? raw.relativePath ?? raw.file_path ?? raw.filePath
  const parsed = attachmentPath(rawPath)
  if (parsed === undefined) return { descriptor: unavailableAttachment(raw, messageSequence, kind, 'missing-or-remote') }
  const candidate = isAbsolute(parsed) ? parsed : join(sourceRoot, parsed)
  let source: string
  try {
    source = assertSafeRegularFile(candidate, sourceRoot, `legacy ${kind}`)
  } catch {
    return { descriptor: unavailableAttachment(raw, messageSequence, kind, 'missing-or-unsafe') }
  }
  const sourceParts = relative(resolve(sourceRoot), source).split(sep).map(part => part.toLowerCase())
  if (sourceParts.some(part => PROTECTED_ATTACHMENT_PARTS.has(part) || part.startsWith('.env.'))) {
    return { descriptor: unavailableAttachment(raw, messageSequence, kind, 'protected-path') }
  }
  const metadata = lstatSync(source)
  if (metadata.size > MAX_ATTACHMENT_BYTES) {
    return { descriptor: unavailableAttachment(raw, messageSequence, kind, 'oversized') }
  }
  const identity = fileIdentity(source)
  const declaredMediaType = typeof raw.mime_type === 'string'
    ? raw.mime_type
    : typeof raw.mimeType === 'string' ? raw.mimeType : ''
  const mediaType = declaredMediaType.length <= 128 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(declaredMediaType)
    ? declaredMediaType.toLowerCase()
    : 'application/octet-stream'
  const descriptor = {
    artifact_id: `legacy-sha256:${identity.sha256}`,
    status: 'available',
    kind,
    message_seq: String(messageSequence),
    name: safeAttachmentName(raw.title ?? raw.display_name ?? raw.file_name ?? source, basename(source)),
    media_type: mediaType,
    size_bytes: identity.size,
    sha256: identity.sha256,
  }
  return { descriptor, plan: { source, identity, descriptor } }
}

function messageAttachments(row: JsonRecord, sourceRoot: string) {
  const extras = parseJson(row.extras)
  const plans: PlannedAttachment[] = []
  const descriptors: JsonRecord[] = []
  if (!isRecord(extras)) return { plans, descriptors }
  for (const [field, kind] of [['attachments', 'attachment'], ['artifacts', 'artifact']] as const) {
    const items = extras[field]
    if (!Array.isArray(items)) continue
    for (const raw of items) {
      if (!isRecord(raw)) continue
      const planned = planReferencedFile(raw, sourceRoot, row.seq, kind)
      descriptors.push(planned.descriptor)
      if (planned.plan !== undefined) plans.push(planned.plan)
    }
  }
  return { plans, descriptors }
}

function runtimeArtifact(content: unknown, item: JsonRecord, snapshot: SourceSnapshot) {
  if (!isRecord(content) || !isRecord(content.artifact)) return undefined
  const artifact = content.artifact
  const digest = typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(artifact.sha256)
    ? artifact.sha256
    : undefined
  const base = {
    role: artifact.role,
    status: artifact.status,
    title: artifact.display_name,
    mime_type: artifact.mime_type,
  }
  if (digest === undefined) return { descriptor: unavailableAttachment(base, item.item_id, 'artifact', 'invalid-identity') }
  const path = join(dirname(snapshot.source.database), 'artifacts', 'blobs', digest.slice(0, 2), digest.slice(2, 4), digest)
  const planned = planReferencedFile({ ...base, path }, snapshot.source.root, item.item_id, 'artifact')
  if (planned.plan !== undefined && planned.plan.identity.sha256 !== digest) {
    throw new Error(`legacy Runtime artifact ${String(item.item_id)} failed its declared SHA256`)
  }
  return planned
}

function addAttachmentEvent(builder: ReturnType<typeof eventBuilder>, descriptors: JsonRecord[], time: number) {
  if (descriptors.length === 0) return
  builder.push('emate/legacy-artifacts', { items: descriptors }, time)
  builder.events.at(-1)!.ignorable = true
}

function publishAttachmentObjects(plans: PlannedSession[], dshHome: string) {
  const unique = new Map<string, PlannedAttachment>()
  for (const plan of plans) {
    for (const attachment of plan.attachments) unique.set(String(attachment.descriptor.sha256), attachment)
  }
  for (const [digest, attachment] of unique) {
    const directory = join(dshHome, 'e-mate', 'attachments', 'legacy-v1', 'objects', digest.slice(0, 2), digest.slice(2, 4))
    const target = join(directory, digest)
    mkdirSync(directory, { recursive: true })
    if (existsSync(target)) {
      const existing = fileIdentity(assertSafeRegularFile(target, join(dshHome, 'e-mate', 'attachments'), 'legacy attachment object'))
      if (existing.sha256 !== digest || existing.size !== attachment.identity.size) {
        throw new Error(`legacy attachment object ${digest} conflicts with its content identity`)
      }
      continue
    }
    const temporary = join(directory, `.${digest}.${process.pid}.${randomUUID()}.tmp`)
    try {
      stableCopy(attachment.source, temporary, attachment.identity)
      try {
        linkSync(temporary, target)
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error
      }
      const published = fileIdentity(assertSafeRegularFile(target, join(dshHome, 'e-mate', 'attachments'), 'legacy attachment object'))
      if (published.sha256 !== digest || published.size !== attachment.identity.size) {
        throw new Error(`legacy attachment object ${digest} failed publication verification`)
      }
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

function canonicalSessionId(key: string) {
  return stableId('legacy', 'e-Mate legacy session v1', key)
}

function eventBuilder() {
  const events: JsonRecord[] = []
  let lastTime = 0
  const push = (type: string, data: JsonRecord, time: number, surface = false) => {
    lastTime = Math.max(lastTime, Number.isSafeInteger(time) ? time : 0)
    events.push({ type, seq: events.length, time: lastTime, data, ...(surface ? { surfaceOp: 'append' } : {}) })
  }
  return { events, push }
}

function message(role: 'user' | 'assistant', id: string, text: string, source: JsonRecord) {
  return { id, role, content: [{ type: 'text', text }], source }
}

function addTitle(builder: ReturnType<typeof eventBuilder>, title: string, time: number) {
  if (title === '') return
  builder.push('session/title', { title, messageSeqs: [], source: { kind: 'user' } }, time)
}

function runtimeLegacyId(threadId: string, metadata: unknown) {
  const value = parseJson(metadata)
  if (!isRecord(value) || !isRecord(value.migration)) return { key: `ecorex:${threadId}`, legacyId: threadId }
  const legacyId = value.migration.legacy_session_id
  return typeof legacyId === 'string' && legacyId.trim() !== ''
    ? { key: `legacy:${legacyId.trim()}`, legacyId: legacyId.trim() }
    : { key: `ecorex:${threadId}`, legacyId: threadId }
}

function runtimeProjectPaths(database: DatabaseSync) {
  const result = new Map<string, string>()
  const names = tableNames(database)
  if (!names.has('project_thread_bindings') || !names.has('projects')) return result
  const binding = tableColumns(database, 'project_thread_bindings')
  const projects = tableColumns(database, 'projects')
  if (!binding.has('thread_id') || !binding.has('project_id') || !projects.has('project_id') || !projects.has('project_path')) return result
  const rows = database.prepare(
    'SELECT b.thread_id, p.project_path FROM project_thread_bindings b JOIN projects p ON p.project_id = b.project_id',
  ).all() as JsonRecord[]
  for (const row of rows) {
    const path = typeof row.project_path === 'string' ? row.project_path.trim() : ''
    if (isAbsolute(path)) result.set(String(row.thread_id), resolve(path))
  }
  return result
}

function planRuntime(snapshot: SourceSnapshot, generalWorkspace: string): PlannedSession[] {
  const database = openSnapshot(snapshot.snapshot)
  try {
    requireTable(database, 'threads', ['thread_id', 'status', 'title', 'metadata_json', 'created_at', 'updated_at'], 'legacy ECoreX Runtime database')
    requireTable(database, 'turns', ['turn_id', 'thread_id', 'status', 'input_text', 'agent_model_id', 'created_at', 'updated_at'], 'legacy ECoreX Runtime database')
    requireTable(database, 'items', ['item_id', 'thread_id', 'turn_id', 'kind', 'content_json', 'created_at'], 'legacy ECoreX Runtime database')
    requireBoundedRows(database, 'threads', MAX_SESSIONS, 'legacy Runtime threads')
    requireBoundedRows(database, 'turns', MAX_MESSAGE_ROWS, 'legacy Runtime turns')
    requireBoundedRows(database, 'items', MAX_MESSAGE_ROWS, 'legacy Runtime items')
    const projects = runtimeProjectPaths(database)
    const threads = database.prepare("SELECT * FROM threads WHERE lower(status) <> 'deleted' ORDER BY created_at, thread_id").all() as JsonRecord[]
    return threads.map((thread) => {
      const threadId = String(thread.thread_id ?? '').trim()
      if (threadId === '') throw new Error('legacy Runtime thread_id must not be empty')
      const identity = runtimeLegacyId(threadId, thread.metadata_json)
      const id = canonicalSessionId(identity.key)
      const createdAt = epochMilliseconds(thread.created_at)
      const builder = eventBuilder()
      const omitted: JsonRecord[] = []
      const attachments: PlannedAttachment[] = []
      const attachmentDescriptors: JsonRecord[] = []
      const turns = database.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at, turn_id').all(threadId) as JsonRecord[]
      let turnNumber = 0
      for (const turn of turns) {
        turnNumber += 1
        const turnId = String(turn.turn_id ?? '').trim()
        if (turnId === '') throw new Error(`legacy Runtime thread ${threadId} has an empty turn_id`)
        const started = epochMilliseconds(turn.created_at)
        builder.push('turn/start', { turn: turnNumber }, started)
        const input = typeof turn.input_text === 'string' ? turn.input_text : ''
        if (input !== '') {
          builder.push('user/message', message('user', stableId('msg', id, turnId, 'user'), input, { kind: 'user' }), started, true)
        }
        const items = database.prepare('SELECT * FROM items WHERE turn_id = ? ORDER BY created_at, item_id').all(turnId) as JsonRecord[]
        let step = 0
        for (const item of items) {
          const content = parseJson(item.content_json)
          const role = isRecord(content) && typeof content.role === 'string' ? content.role.toLowerCase() : ''
          if (String(item.kind).toLowerCase() !== 'message' || role !== 'assistant') {
            if (String(item.kind).toLowerCase() === 'artifact') {
              const artifact = runtimeArtifact(content, item, snapshot)
              if (artifact !== undefined) {
                attachmentDescriptors.push(artifact.descriptor)
                if (artifact.plan !== undefined) attachments.push(artifact.plan)
              }
            }
            if (!(String(item.kind).toLowerCase() === 'message' && role === 'user')) omitted.push({
              item_id: String(item.item_id), kind: String(item.kind), status: String(item.status ?? ''), content,
            })
            continue
          }
          step += 1
          const itemTime = epochMilliseconds(item.created_at)
          builder.push('step/start', { turn: turnNumber, step }, itemTime)
          builder.push('assistant/message', {
            turn: turnNumber,
            step,
            message: message('assistant', stableId('msg', id, String(item.item_id)), displayText(content), {
              kind: 'model', provider: 'legacy-ecorex', model: String(turn.agent_model_id || 'ecorex-chat'),
            }),
          }, itemTime, true)
          builder.push('step/end', { turn: turnNumber, step }, itemTime)
        }
        const completed = String(turn.status).toLowerCase() === 'completed'
        builder.push('turn/end', { turn: turnNumber, reason: completed ? { kind: 'completed' } : { kind: 'interrupted' } }, epochMilliseconds(turn.updated_at))
      }
      addAttachmentEvent(builder, attachmentDescriptors, epochMilliseconds(thread.updated_at))
      addTitle(builder, normalizeTitle(thread.title), epochMilliseconds(thread.updated_at))
      if (builder.events.length === 0) {
        builder.events.push({
          type: 'emate/legacy-import', seq: 0, time: createdAt,
          data: { source_family: snapshot.source.family, legacy_id_sha256: sha256(identity.legacyId) }, ignorable: true,
        })
      }
      const cwd = projects.get(threadId) ?? generalWorkspace
      return {
        id,
        canonicalKey: identity.key,
        sourceFamily: snapshot.source.family,
        sourceDatabase: snapshot.source.database,
        legacyId: identity.legacyId,
        header: { version: SESSION_FORMAT_VERSION, id, createdAt, isSeeded: false, delegationDepth: 0, cwd },
        events: builder.events,
        evidence: {
          schema_version: 1,
          source_family: snapshot.source.family,
          source_thread_id: threadId,
          attachments: attachmentDescriptors,
          omitted_items: omitted,
        },
        attachments,
      }
    })
  } finally {
    database.close()
  }
}

function planCowAgent(snapshot: SourceSnapshot, generalWorkspace: string): PlannedSession[] {
  const database = openSnapshot(snapshot.snapshot)
  try {
    const sessionColumns = requireTable(database, 'sessions', ['session_id', 'created_at', 'last_active'], 'legacy CowAgent conversation database')
    const messageColumns = requireTable(database, 'messages', ['session_id', 'seq', 'role', 'content', 'created_at'], 'legacy CowAgent conversation database')
    requireBoundedRows(database, 'sessions', MAX_SESSIONS, 'legacy CowAgent sessions')
    requireBoundedRows(database, 'messages', MAX_MESSAGE_ROWS, 'legacy CowAgent messages')
    const sessions = database.prepare('SELECT * FROM sessions ORDER BY created_at, session_id').all() as JsonRecord[]
    const seenSessions = new Map<string, string>()
    const seenMessages = new Map<string, string>()
    const plans: PlannedSession[] = []
    for (const session of sessions) {
      const legacyId = String(session.session_id ?? '').trim()
      if (legacyId === '') throw new Error('legacy CowAgent session_id must not be empty')
      const sessionDigest = canonicalJson(session)
      const previousSession = seenSessions.get(legacyId)
      if (previousSession !== undefined) {
        if (previousSession !== sessionDigest) throw new Error(`legacy CowAgent session ${legacyId} has conflicting rows`)
        continue
      }
      seenSessions.set(legacyId, sessionDigest)
      const rows = database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq, created_at').all(legacyId) as JsonRecord[]
      const messages: JsonRecord[] = []
      for (const row of rows) {
        const sequence = Number(row.seq)
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`legacy CowAgent session ${legacyId} has an invalid message seq`)
        const key = `${legacyId}\u0000${sequence}`
        const digest = canonicalJson(row)
        const previous = seenMessages.get(key)
        if (previous !== undefined) {
          if (previous !== digest) throw new Error(`legacy CowAgent message ${legacyId}:${sequence} has conflicting rows`)
          continue
        }
        seenMessages.set(key, digest)
        messages.push(row)
      }
      const groups: JsonRecord[][] = []
      let current: JsonRecord[] = []
      for (const row of messages) {
        if (String(row.role).toLowerCase() === 'user' && current.length > 0) {
          groups.push(current)
          current = []
        }
        current.push(row)
      }
      if (current.length > 0) groups.push(current)
      const canonicalKey = `legacy:${legacyId}`
      const id = canonicalSessionId(canonicalKey)
      const builder = eventBuilder()
      const omitted: JsonRecord[] = []
      const attachments: PlannedAttachment[] = []
      const attachmentDescriptors: JsonRecord[] = []
      for (let index = 0; index < groups.length; index += 1) {
        const turn = index + 1
        const group = groups[index]
        const started = epochMilliseconds(group[0]?.created_at)
        builder.push('turn/start', { turn }, started)
        let step = 0
        for (const row of group) {
          const referenced = messageAttachments(row, snapshot.source.root)
          attachments.push(...referenced.plans)
          attachmentDescriptors.push(...referenced.descriptors)
          const role = String(row.role ?? '').toLowerCase()
          const time = epochMilliseconds(row.created_at)
          const text = displayText(row.content)
          const sequence = String(row.seq)
          if (role === 'user') {
            builder.push('user/message', message('user', stableId('msg', id, sequence, 'user'), text, { kind: 'user' }), time, true)
          } else if (role === 'assistant') {
            step += 1
            builder.push('step/start', { turn, step }, time)
            builder.push('assistant/message', {
              turn,
              step,
              message: message('assistant', stableId('msg', id, sequence, 'assistant'), text, {
                kind: 'model', provider: 'legacy-cowagent', model: 'ecorex-chat',
              }),
            }, time, true)
            builder.push('step/end', { turn, step }, time)
          } else {
            omitted.push({ seq: row.seq, role: row.role, content: parseJson(row.content), extras: parseJson(row.extras) })
          }
        }
        builder.push('turn/end', { turn, reason: { kind: 'completed' } }, epochMilliseconds(group.at(-1)?.created_at))
      }
      addAttachmentEvent(builder, attachmentDescriptors, epochMilliseconds(session.last_active))
      addTitle(builder, sessionColumns.has('title') ? normalizeTitle(session.title) : '', epochMilliseconds(session.last_active))
      if (builder.events.length === 0) {
        builder.events.push({
          type: 'emate/legacy-import',
          seq: 0,
          time: epochMilliseconds(session.created_at),
          data: { source_family: 'cowagent', legacy_id_sha256: sha256(legacyId) },
          ignorable: true,
        })
      }
      const projectPath = sessionColumns.has('project_path') && typeof session.project_path === 'string' && isAbsolute(session.project_path)
        ? resolve(session.project_path)
        : undefined
      plans.push({
        id,
        canonicalKey,
        sourceFamily: 'cowagent',
        sourceDatabase: snapshot.source.database,
        legacyId,
        header: {
          version: SESSION_FORMAT_VERSION,
          id,
          createdAt: epochMilliseconds(session.created_at),
          isSeeded: false,
          delegationDepth: 0,
          cwd: projectPath ?? generalWorkspace,
        },
        events: builder.events,
        evidence: {
          schema_version: 1,
          source_family: 'cowagent',
          source_session_id: legacyId,
          attachments: attachmentDescriptors,
          omitted_messages: omitted,
          optional_columns: {
            sessions: [...sessionColumns].sort(),
            messages: [...messageColumns].sort(),
          },
        },
        attachments,
      })
    }
    const knownSessions = new Set(sessions.map(row => String(row.session_id ?? '').trim()))
    const orphan = (database.prepare('SELECT session_id, seq FROM messages').all() as JsonRecord[])
      .find(row => !knownSessions.has(String(row.session_id ?? '').trim()))
    if (orphan !== undefined) throw new Error(`legacy CowAgent message ${String(orphan.session_id)}:${String(orphan.seq)} has no parent session`)
    return plans
  } finally {
    database.close()
  }
}

export function defaultLegacySources(options: Pick<LegacyMigrationOptions, 'dshHome' | 'home' | 'environment' | 'platform'>): LegacySource[] {
  const home = resolve(options.home || homedir())
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const roots: LegacySource[] = []
  const ecorexRoots = platform === 'darwin'
    ? [join(home, 'Library', 'Application Support', 'ECoreX')]
    : platform === 'win32'
      ? [environment.APPDATA, environment.LOCALAPPDATA, join(home, 'AppData', 'Roaming')]
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .map(value => join(value, 'ECoreX'))
      : []
  const emateRoot = join(home, '.emate')
  const emateDatabase = join(emateRoot, 'state', 'runtime.sqlite3')
  if (existsSync(emateDatabase)) roots.push({ family: 'emate-runtime', database: emateDatabase, root: emateRoot })
  for (const root of ecorexRoots) {
    const database = join(root, 'state', 'runtime.sqlite3')
    if (existsSync(database) && resolve(database) !== resolve(options.dshHome, 'sessions')) {
      roots.push({ family: 'ecorex-runtime', database, root })
    }
  }
  const cowRoots = [join(home, '.cow')]
  if (platform === 'win32') {
    if (environment.APPDATA) cowRoots.push(join(environment.APPDATA, 'CowAgent'))
    if (environment.LOCALAPPDATA) cowRoots.push(join(environment.LOCALAPPDATA, 'CowAgent'))
  }
  cowRoots.push(join(home, 'cow'))
  for (const root of [...new Set(cowRoots.map(value => resolve(value)))]) {
    const database = CONVERSATION_CANDIDATES.map(relative => join(root, relative)).find(existsSync)
    if (database !== undefined) roots.push({ family: 'cowagent', database, root })
  }
  return roots
}

function sourcePrecedence(value: PlannedSession) {
  return value.sourceFamily === 'emate-runtime' ? 0 : value.sourceFamily === 'ecorex-runtime' ? 1 : 2
}

function mergePlans(plans: PlannedSession[]) {
  const selected = new Map<string, PlannedSession>()
  for (const plan of plans.sort((left, right) => {
    return sourcePrecedence(left) - sourcePrecedence(right) || left.sourceDatabase.localeCompare(right.sourceDatabase)
  })) {
    const existing = selected.get(plan.canonicalKey)
    if (existing === undefined) {
      selected.set(plan.canonicalKey, plan)
      continue
    }
    if (sourcePrecedence(existing) < sourcePrecedence(plan)) continue
    if (canonicalJson({ header: existing.header, events: existing.events }) !== canonicalJson({ header: plan.header, events: plan.events })) {
      throw new Error(`legacy session identity ${plan.legacyId} is ambiguous across authoritative sources`)
    }
  }
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export async function migrateLegacySessions(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const dshHome = resolve(options.dshHome)
  const sources = options.sources ?? defaultLegacySources(options)
  const receiptPath = join(dshHome, 'e-mate', 'migrations', RECEIPT_NAME)
  if (sources.length === 0) {
    return { source_found: false, imported_sessions: 0, reused_sessions: 0, receipt_path: receiptPath, source_fingerprints: [] }
  }
  for (const source of sources) {
    const root = resolve(source.root)
    if (root === dshHome || root.startsWith(`${dshHome}${sep}`) || dshHome.startsWith(`${root}${sep}`)) {
      throw new Error('legacy source roots and DSH_HOME must be disjoint')
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'e-mate-legacy-sessions-'))
  try {
    const snapshots: SourceSnapshot[] = []
    let unavailable = 0
    for (const source of sources) {
      try {
        snapshots.push(snapshotSource({ ...source, root: resolve(source.root), database: resolve(source.database) }, scratch))
      } catch (error: unknown) {
        if (!options.skipUnavailableSources || !isUnavailableSource(error, source)) throw error
        unavailable += 1
      }
    }
    if (snapshots.length === 0) {
      return {
        source_found: false,
        unavailable_sources: unavailable,
        imported_sessions: 0,
        reused_sessions: 0,
        receipt_path: receiptPath,
        source_fingerprints: [],
      }
    }
    const generalWorkspace = join(dshHome, 'e-mate', 'general')
    const plans = mergePlans(snapshots.flatMap(snapshot => snapshot.source.family !== 'cowagent'
      ? planRuntime(snapshot, generalWorkspace)
      : planCowAgent(snapshot, generalWorkspace)))
    const listed = await options.sessionPersistence.list()
    const existing = new Set(listed.map(snapshot => String(snapshot.header.id)))
    const absent: PlannedSession[] = []
    let reused = 0
    for (const plan of plans) {
      if (existing.has(plan.id)) {
        const loaded = await readStoredSession(options.sessionPersistence, plan.id)
        const actualHeader = sha256(canonicalJson(loaded.meta))
        const expectedHeader = sha256(canonicalJson(plan.header))
        const actualEvents = sha256(canonicalJson(loaded.events))
        const expectedEvents = sha256(canonicalJson(plan.events))
        if (actualHeader !== expectedHeader || actualEvents !== expectedEvents) {
          throw new Error(
            `target e-Mate session ${plan.id} conflicts with its stable legacy identity `
            + `(header ${actualHeader}/${expectedHeader}, events ${actualEvents}/${expectedEvents})`,
          )
        }
        reused += 1
        continue
      }
      absent.push(plan)
    }
    publishAttachmentObjects(plans, dshHome)
    for (const plan of absent) {
      const handle = await options.sessionPersistence.create(plan.header)
      try {
        await handle.append(plan.events)
      } finally {
        await handle.close()
      }
    }
    const evidenceRoot = join(dshHome, 'e-mate', 'migrations', 'legacy-evidence-v1')
    for (const plan of plans) atomicWrite(join(evidenceRoot, `${plan.id}.json`), plan.evidence)
    const fingerprints = snapshots.map(snapshot => snapshot.fingerprint).sort()
    atomicWrite(receiptPath, {
      schema_version: RECEIPT_SCHEMA,
      completed_at: new Date().toISOString(),
      source_fingerprints: fingerprints,
      sessions: plans.map(plan => ({
        target_session_id: plan.id,
        source_family: plan.sourceFamily,
        source_database_path_sha256: sha256(plan.sourceDatabase),
        legacy_id_sha256: sha256(plan.legacyId),
        header_sha256: sha256(canonicalJson(plan.header)),
        events_sha256: sha256(canonicalJson(plan.events)),
      })),
    })
    return {
      source_found: true,
      ...(unavailable > 0 ? { unavailable_sources: unavailable } : {}),
      imported_sessions: absent.length,
      reused_sessions: reused,
      receipt_path: receiptPath,
      source_fingerprints: fingerprints,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
