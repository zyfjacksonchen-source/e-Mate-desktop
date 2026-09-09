import {
  lstatSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { skillHubError } from './result.js'
export { parseSkillHubRpcResult, skillHubFailureResult, skillHubSuccess } from './result.js'

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 256
const MAX_PATH_BYTES = 512
const MAX_PATH_DEPTH = 8
const MAX_EXPANSION_RATIO = 100
const SKILL_NAME = /^(?=.{2,96}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256 = /^[0-9a-f]{64}$/
const FRONTMATTER_KEY = /^[a-z][a-z0-9_-]{0,63}$/
const FRONTMATTER_KEYS = new Set(['name', 'description', 'version', 'license', 'compatibility', 'tags'])
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u
const RANGE_PART = /^(?:>=|<=|>|<|=)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const CAS_PREFIX = Buffer.from('ecorex-local-skill-bundle-v1\0')
const BLOCKED_SUFFIXES = new Set([
  '.7z', '.bat', '.class', '.cmd', '.com', '.dll', '.dylib', '.exe', '.hta', '.jar', '.msi', '.rar', '.so', '.wasm', '.zip',
])
const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules'])

function digest(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

function atomicWrite(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function atomicJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

function archiveError(message) {
  return new SkillHubOperationError('integrity', `Skill archive rejected: ${message}`)
}

function findEndOfCentralDirectory(payload) {
  const minimum = Math.max(0, payload.byteLength - 65_557)
  for (let offset = payload.byteLength - 22; offset >= minimum; offset -= 1) {
    if (payload.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw archiveError('ZIP end record is missing')
}

function validatePath(raw, directory) {
  if (raw !== raw.normalize('NFC')) throw archiveError('paths must use NFC Unicode normalization')
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) {
    throw archiveError('an absolute, control, or non-POSIX path was found')
  }
  const value = directory ? raw.replace(/\/+$/, '') : raw
  const parts = value.split('/')
  if (parts.length === 0 || parts.length > MAX_PATH_DEPTH || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw archiveError('a traversal, empty, or over-deep path was found')
  }
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) throw archiveError('a path is too long')
  if (parts.some(part => BLOCKED_SEGMENTS.has(part.toLowerCase()))) throw archiveError('repository or dependency trees are not Skill resources')
  if (!directory) {
    const lower = parts.at(-1).toLowerCase()
    const dot = lower.lastIndexOf('.')
    if (BLOCKED_SUFFIXES.has(dot < 0 ? '' : lower.slice(dot))) throw archiveError('an executable or nested archive was found')
    if (lower === 'package.json') throw archiveError('npm packages are not Skill Hub archives')
  }
  return value
}

function centralDirectory(payload) {
  if (!Buffer.isBuffer(payload) || payload.byteLength < 22 || payload.byteLength > MAX_ARCHIVE_BYTES) {
    throw archiveError('input must be a ZIP no larger than 10 MiB')
  }
  const end = findEndOfCentralDirectory(payload)
  const disk = payload.readUInt16LE(end + 4)
  const centralDisk = payload.readUInt16LE(end + 6)
  const entries = payload.readUInt16LE(end + 10)
  const centralSize = payload.readUInt32LE(end + 12)
  const centralOffset = payload.readUInt32LE(end + 16)
  if (disk !== 0 || centralDisk !== 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError('multi-disk and ZIP64 archives are unsupported')
  }
  if (entries === 0 || entries > MAX_FILES * 2 || centralOffset + centralSize > end) {
    throw archiveError('central directory bounds are invalid')
  }
  const records = []
  const seen = new Set()
  let offset = centralOffset
  let total = 0
  let compressedTotal = 0
  let files = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || payload.readUInt32LE(offset) !== 0x02014b50) throw archiveError('central directory entry is invalid')
    const flags = payload.readUInt16LE(offset + 8)
    const method = payload.readUInt16LE(offset + 10)
    const compressed = payload.readUInt32LE(offset + 20)
    const expanded = payload.readUInt32LE(offset + 24)
    const nameLength = payload.readUInt16LE(offset + 28)
    const extraLength = payload.readUInt16LE(offset + 30)
    const commentLength = payload.readUInt16LE(offset + 32)
    const externalAttributes = payload.readUInt32LE(offset + 38)
    const localOffset = payload.readUInt32LE(offset + 42)
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength
    if (nameLength === 0 || recordEnd > end) throw archiveError('central directory name is invalid')
    const nameBytes = payload.subarray(offset + 46, offset + 46 + nameLength)
    if ((flags & 0x800) === 0 && nameBytes.some(byte => byte > 0x7f)) {
      throw archiveError('non-ASCII paths must carry the ZIP UTF-8 flag')
    }
    const raw = nameBytes.toString('utf8')
    const directory = raw.endsWith('/')
    const path = validatePath(raw, directory)
    const folded = path.toLowerCase()
    if (seen.has(folded)) throw archiveError('duplicate or case-colliding paths were found')
    seen.add(folded)
    if ((flags & 0x1) !== 0) throw archiveError('encrypted entries are forbidden')
    if (method !== 0 && method !== 8) throw archiveError('only stored or deflated entries are supported')
    if (localOffset + 30 > centralOffset || payload.readUInt32LE(localOffset) !== 0x04034b50) {
      throw archiveError('a local file header is invalid')
    }
    const localFlags = payload.readUInt16LE(localOffset + 6)
    const localMethod = payload.readUInt16LE(localOffset + 8)
    const localNameLength = payload.readUInt16LE(localOffset + 26)
    const localExtraLength = payload.readUInt16LE(localOffset + 28)
    const localNameStart = localOffset + 30
    const localDataStart = localNameStart + localNameLength + localExtraLength
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength
      || localDataStart + compressed > centralOffset
      || !payload.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes)) {
      throw archiveError('local and central ZIP records do not match')
    }
    const mode = (externalAttributes >>> 16) & 0xffff
    const fileType = mode & 0xf000
    if (directory) {
      if (fileType !== 0 && fileType !== 0x4000) throw archiveError('a directory has a special file mode')
    } else {
      if (fileType !== 0 && fileType !== 0x8000) throw archiveError('links, devices, and special files are forbidden')
      if ((mode & 0o111) !== 0) throw archiveError('executable file modes are forbidden')
      if (expanded > MAX_FILE_BYTES) throw archiveError('a file exceeds 2 MiB')
      if (compressed > 0 && expanded > compressed * MAX_EXPANSION_RATIO) throw archiveError('an entry expansion ratio is unsafe')
      files += 1
      total += expanded
      compressedTotal += compressed
      records.push({ path, expanded })
    }
    offset = recordEnd
  }
  if (offset !== centralOffset + centralSize || files === 0 || files > MAX_FILES || total > MAX_ARCHIVE_BYTES) {
    throw archiveError('file inventory or expanded size is invalid')
  }
  if (compressedTotal > 0 && total > compressedTotal * MAX_EXPANSION_RATIO) throw archiveError('aggregate expansion ratio is unsafe')
  return records
}

function scalar(raw, label) {
  if (raw === '' || '|>&*!{}[]@`'.includes(raw[0]) || raw.includes('\t')) {
    throw archiveError(`SKILL.md ${label} must be a bounded scalar`)
  }
  if (raw.startsWith('"')) {
    let value
    try { value = JSON.parse(raw) } catch { throw archiveError(`SKILL.md ${label} quoted scalar is invalid`) }
    if (typeof value !== 'string') throw archiveError(`SKILL.md ${label} must be a string`)
    return value
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) throw archiveError(`SKILL.md ${label} quoted scalar is invalid`)
    return raw.slice(1, -1).replaceAll("''", "'")
  }
  return raw.includes(' #') ? raw.slice(0, raw.indexOf(' #')).trimEnd() : raw
}

function bounded(value, label, maximum) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()
    || Buffer.byteLength(value) > maximum || CONTROL.test(value)) {
    throw archiveError(`SKILL.md ${label} is invalid`)
  }
  return value
}

function validVersion(value) {
  const match = VERSION.exec(value)
  return match !== null && (match[4] === undefined || match[4].split('.').every(part => !/^\d+$/u.test(part) || part === '0' || !part.startsWith('0')))
}

function validVersionRange(value) {
  return value === '*' || (typeof value === 'string' && value.length <= 256
    && !CONTROL.test(value) && value.split(',').every(part => part !== '' && part === part.trim() && RANGE_PART.test(part)))
}

function frontmatter(markdown) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(markdown)
  if (text.startsWith('\ufeff') || CONTROL.test(text)) throw archiveError('SKILL.md contains a BOM or control character')
  const lines = text.split(/\r\n|[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/u)
  if (lines[0] !== '---') throw archiveError('SKILL.md must begin with YAML frontmatter')
  const closing = lines.indexOf('---', 1)
  if (closing < 0 || Buffer.byteLength(lines.slice(0, closing + 1).join('\n')) > 16 * 1024) {
    throw archiveError('SKILL.md frontmatter is invalid')
  }
  const values = {}
  for (let index = 1; index < closing;) {
    const line = lines[index]
    if (line === '' || /^[ \t-]/u.test(line) || !line.includes(':')) {
      throw archiveError('SKILL.md frontmatter must use flat product fields')
    }
    const separator = line.indexOf(':')
    const key = line.slice(0, separator)
    const raw = line.slice(separator + 1).trim()
    if (!FRONTMATTER_KEY.test(key) || !FRONTMATTER_KEYS.has(key)) throw archiveError('SKILL.md frontmatter contains an unknown field')
    if (Object.hasOwn(values, key)) throw archiveError('SKILL.md frontmatter contains a duplicate field')
    index += 1
    if (key === 'tags' && raw === '') {
      const tags = []
      while (index < closing && lines[index].startsWith('  - ')) {
        tags.push(scalar(lines[index].slice(4).trim(), 'tag'))
        index += 1
      }
      values.tags = tags
      continue
    }
    if (key === 'tags') {
      let tags
      try { tags = JSON.parse(raw) } catch { throw archiveError('SKILL.md tags must be a JSON string array') }
      if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw archiveError('SKILL.md tags must be a string array')
      values.tags = tags
      continue
    }
    values[key] = scalar(raw, key)
  }
  if (!Object.hasOwn(values, 'name') || !Object.hasOwn(values, 'description')) {
    throw archiveError('SKILL.md frontmatter is missing name or description')
  }
  const name = bounded(values.name, 'name', 128)
  const description = bounded(values.description, 'description', 2048)
  const version = bounded(values.version ?? '0.0.0', 'version', 128)
  if (!SKILL_NAME.test(name) || !validVersion(version)) throw archiveError('SKILL.md name or version is invalid')
  const license = values.license === undefined ? null : bounded(values.license, 'license', 128)
  const compatibility = bounded(values.compatibility ?? '*', 'compatibility', 256)
  if (!validVersionRange(compatibility)) throw archiveError('SKILL.md compatibility is invalid')
  const rawTags = values.tags ?? []
  if (rawTags.length > 32 || rawTags.some(tag => !TAG.test(tag)) || new Set(rawTags).size !== rawTags.length) {
    throw archiveError('SKILL.md tags must be unique bounded identifiers')
  }
  return { name, description, version, license, compatibility, tags: [...rawTags].sort(compareCodePoints) }
}

function compareCodePoints(left, right) {
  const one = [...left]
  const two = [...right]
  for (let index = 0; index < Math.min(one.length, two.length); index += 1) {
    const difference = one[index].codePointAt(0) - two[index].codePointAt(0)
    if (difference !== 0) return difference
  }
  return one.length - two.length
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareCodePoints).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw archiveError('canonical Skill content is invalid')
  return encoded
}

function contentDigest(metadata, files) {
  const records = [...files].sort(([left], [right]) => compareCodePoints(left, right)).map(([path, content]) => ({
    path,
    size_bytes: content.byteLength,
    sha256: digest(content),
  }))
  const manifest = {
    schema_version: 1,
    kind: 'declarative_skill',
    metadata,
    files: records,
    total_size_bytes: records.reduce((total, record) => total + record.size_bytes, 0),
  }
  return digest(Buffer.concat([CAS_PREFIX, Buffer.from(canonicalJson(manifest))]))
}

export function inspectSkillArchive(payload, expected = {}) {
  const records = centralDirectory(payload)
  const entries = unzipSync(payload)
  const files = new Map()
  for (const record of records) {
    const content = entries[record.path]
    if (!(content instanceof Uint8Array) || content.byteLength !== record.expanded) {
      throw archiveError('decompressed inventory does not match the ZIP directory')
    }
    files.set(record.path, Buffer.from(content))
  }
  if (!files.has('SKILL.md')) throw archiveError('one root SKILL.md is required')
  const metadata = frontmatter(files.get('SKILL.md'))
  if (expected.slug !== undefined && metadata.name !== expected.slug) throw archiveError('SKILL.md name does not match the selected slug')
  if (expected.version !== undefined && metadata.version !== expected.version) throw archiveError('SKILL.md version does not match the selected version')
  const packageSha256 = contentDigest(metadata, files)
  const archiveSha256 = digest(payload)
  if (expected.packageSha256 !== undefined && (!SHA256.test(expected.packageSha256) || packageSha256 !== expected.packageSha256)) {
    throw archiveError('package content SHA-256 does not match the catalog')
  }
  if (expected.archiveSha256 !== undefined && (!SHA256.test(expected.archiveSha256) || archiveSha256 !== expected.archiveSha256)) {
    throw archiveError('package archive SHA-256 changed after confirmation')
  }
  return { ...metadata, packageSha256, archiveSha256, files }
}

function realDirectory(path, label) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
}

const RECEIPT_STATUSES = new Set(['installed', 'disabled', 'uninstalled'])
const TRANSACTION_PHASES = new Set(['prepared', 'claimed', 'switched', 'completion-pending', 'committed'])

export class SkillHubRecoveryPendingError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'SkillHubRecoveryPendingError'
  }
}

export class SkillHubOperationError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'SkillHubOperationError'
    this.code = code
  }
}

export function skillHubFailure(error) {
  if (error instanceof SkillHubRecoveryPendingError) return skillHubError({ code: 'recovery' })
  if (error instanceof SkillHubOperationError) return skillHubError(error)
  if (error?.name === 'AbortError') return skillHubError({ code: 'cancelled' })
  return skillHubError(error)
}

function skillPaths(dshHome, slug) {
  const state = join(dshHome, 'e-mate', 'skill-hub')
  const transactions = join(state, 'transactions')
  const transaction = join(transactions, slug)
  const candidateRoot = join(transaction, 'candidate')
  return {
    state,
    transactions,
    transaction,
    wal: join(transaction, 'wal.json'),
    candidateRoot,
    candidate: join(candidateRoot, slug),
    backup: join(transaction, 'backup'),
    quarantine: join(transaction, 'quarantine'),
    disabledRoot: join(state, 'disabled'),
    disabled: join(state, 'disabled', slug),
    activeRoot: join(dshHome, 'skills'),
    active: join(dshHome, 'skills', slug),
    receipt: join(dshHome, 'e-mate', 'migrations', `skill-${slug}.json`),
  }
}

function ensureRealDirectory(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  realDirectory(path, label)
}

function receiptOf(value, slug) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schema_version !== 1 || value.slug !== slug
    || !VERSION.test(value.version) || !SHA256.test(value.package_sha256)
    || !RECEIPT_STATUSES.has(value.status)
    || (value.uploader !== undefined && (typeof value.uploader !== 'object' || value.uploader === null
      || typeof value.uploader.nickname !== 'string' || !/^author_[0-9a-f]{24}$/u.test(value.uploader.author_ref)))) {
    throw new Error(`Skill Hub receipt for ${slug} is invalid`)
  }
  return value
}

function readReceipt(paths, slug) {
  if (!existsSync(paths.receipt)) return undefined
  let value
  try {
    value = JSON.parse(readFileSync(paths.receipt, 'utf8'))
  } catch (error) {
    throw new Error(`Skill Hub receipt for ${slug} is unreadable`, { cause: error })
  }
  return receiptOf(value, slug)
}

function restoreReceipt(paths, receipt) {
  if (receipt === undefined || receipt === null) rmSync(paths.receipt, { force: true })
  else atomicJson(paths.receipt, receipt)
}

function nativeReceipt(slug, version, packageSha256, status, native, timestamp = new Date().toISOString(), uploader) {
  return {
    schema_version: 1,
    source: 'e-mate-skill-hub',
    slug,
    version,
    package_sha256: packageSha256,
    status,
    description: typeof native?.description === 'string' ? native.description : '',
    invocation: {
      model_invocable: native?.invocation?.modelInvocable === true,
      user_invocable: native?.invocation?.userInvocable === true,
    },
    ...(uploader === undefined ? {} : { uploader }),
    updated_at: timestamp,
  }
}

function readWal(paths, slug) {
  let value
  try {
    value = JSON.parse(readFileSync(paths.wal, 'utf8'))
  } catch (error) {
    throw new Error(`Skill Hub transaction for ${slug} is unreadable`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schema_version !== 1 || value.slug !== slug
    || !['install', 'update', 'disable', 'enable', 'uninstall'].includes(value.action)
    || !TRANSACTION_PHASES.has(value.phase)
    || !Number.isSafeInteger(value.owner_pid) || value.owner_pid < 1) {
    throw new Error(`Skill Hub transaction for ${slug} is invalid`)
  }
  if (value.previous_receipt !== null && value.previous_receipt !== undefined) receiptOf(value.previous_receipt, slug)
  if (value.next_receipt !== null && value.next_receipt !== undefined) receiptOf(value.next_receipt, slug)
  return value
}

function writeWal(paths, value) {
  atomicJson(paths.wal, value)
  return value
}

function pidAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function openTransaction(paths, value) {
  ensureRealDirectory(paths.transactions, 'Skill Hub transaction root')
  try {
    mkdirSync(paths.transaction, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new SkillHubRecoveryPendingError(`Skill ${value.slug} has a pending transaction`)
    throw error
  }
  realDirectory(paths.transaction, 'Skill Hub transaction')
  return writeWal(paths, { schema_version: 1, owner_pid: process.pid, phase: 'prepared', ...value })
}

function extractCandidate(bundle, paths) {
  mkdirSync(paths.candidate, { recursive: true, mode: 0o700 })
  realDirectory(paths.candidateRoot, 'Skill Hub candidate root')
  realDirectory(paths.candidate, 'Skill Hub candidate')
  for (const [path, content] of bundle.files) {
    const destination = join(paths.candidate, ...path.split('/'))
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    writeFileSync(destination, content, { mode: 0o600, flag: 'wx' })
  }
}

function cleanupTransaction(paths) {
  rmSync(paths.transaction, { recursive: true, force: true })
}

function moveBackInstall(paths, previousReceipt) {
  ensureRealDirectory(paths.candidateRoot, 'Skill Hub candidate root')
  if (existsReal(paths.active)) {
    if (existsReal(paths.candidate)) throw new Error('Skill Hub candidate collision during recovery')
    renameSync(paths.active, paths.candidate)
  }
  if (existsReal(paths.backup)) {
    if (existsReal(paths.active)) throw new Error('Skill Hub active path collision during recovery')
    renameSync(paths.backup, paths.active)
  }
  restoreReceipt(paths, previousReceipt)
}

function stageInstallRecovery(paths, previousReceipt) {
  ensureRealDirectory(paths.candidateRoot, 'Skill Hub candidate root')
  let active = existsReal(paths.active)
  let candidate = existsReal(paths.candidate)
  const backup = existsReal(paths.backup)
  if (!candidate) {
    if (!active) throw new Error('Skill Hub candidate is missing during recovery')
    renameSync(paths.active, paths.candidate)
    active = false
    candidate = true
  }
  if (backup) {
    if (active) throw new Error('Skill Hub active and backup paths collide during recovery')
    renameSync(paths.backup, paths.active)
    active = true
  }
  if (previousReceipt?.status === 'installed' ? !active : active || !candidate) {
    throw new Error('Skill Hub previous installation state is inconsistent during recovery')
  }
  restoreReceipt(paths, previousReceipt)
}

export function compareSkillVersions(left, right) {
  const parseVersion = (value) => {
    const match = VERSION.exec(value)
    if (match === null) throw new Error('Skill version is invalid')
    return { numbers: match.slice(1, 4), prerelease: match[4]?.split('.') }
  }
  const compareNumeric = (one, two) => one.length === two.length
    ? one === two ? 0 : one < two ? -1 : 1
    : one.length < two.length ? -1 : 1
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumeric(a.numbers[index], b.numbers[index])
    if (compared !== 0) return compared
  }
  if (a.prerelease === undefined || b.prerelease === undefined) {
    return a.prerelease === b.prerelease ? 0 : a.prerelease === undefined ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index]
    const two = b.prerelease[index]
    if (one === two) continue
    if (one === undefined || two === undefined) return one === undefined ? -1 : 1
    const oneNumeric = /^\d+$/u.test(one)
    const twoNumeric = /^\d+$/u.test(two)
    if (oneNumeric && twoNumeric) return compareNumeric(one, two)
    if (oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1
    return one < two ? -1 : 1
  }
  return 0
}

function operationResult(receipt, extra = {}) {
  return {
    slug: receipt.slug,
    version: receipt.version,
    package_sha256: receipt.package_sha256,
    status: receipt.status,
    ...(receipt.uploader === undefined ? {} : { uploader: receipt.uploader }),
    ...extra,
  }
}

export function createSkillHubStore({ dshHome, validateCandidate, validateActive, validateAbsent, invalidate }) {
  if (typeof validateCandidate !== 'function' || typeof validateActive !== 'function'
    || typeof validateAbsent !== 'function' || typeof invalidate !== 'function') {
    throw new Error('Skill Hub store requires the native DSH Skill provider boundary')
  }
  const tails = new Map()
  const serial = async (slug, operation) => {
    const previous = tails.get(slug) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    tails.set(slug, current)
    try {
      return await current
    } finally {
      if (tails.get(slug) === current) tails.delete(slug)
    }
  }

  const install = async ({ payload, card, signal, allowDowngrade = false, requireExisting = false, claim, complete }) => serial(card.slug, async () => {
    signal?.throwIfAborted()
    const paths = skillPaths(dshHome, card.slug)
    ensureRealDirectory(paths.activeRoot, 'Skill root')
    ensureRealDirectory(paths.disabledRoot, 'Skill Hub disabled root')
    const previousReceipt = readReceipt(paths, card.slug)
    const hasActive = existsReal(paths.active)
    if (existsSync(paths.transaction)) throw new SkillHubRecoveryPendingError(`Skill ${card.slug} has a pending transaction`)
    if (previousReceipt?.status === 'disabled') throw new Error(`Skill ${card.slug} is disabled; enable it before updating`)
    if (hasActive !== (previousReceipt?.status === 'installed')) {
      throw new Error(`Skill ${card.slug} is not an intact Skill Hub-owned installation`)
    }
    if (requireExisting && previousReceipt?.status !== 'installed') throw new Error(`Skill ${card.slug} is not installed from Skill Hub`)
    if (previousReceipt?.status === 'installed'
      && previousReceipt.version === card.version
      && previousReceipt.package_sha256 === card.package_sha256) {
      const native = await validateActive(paths.active, card.slug, signal)
      return operationResult(nativeReceipt(
        card.slug, card.version, card.package_sha256, 'installed', native, undefined, previousReceipt.uploader ?? card.uploader,
      ), { unchanged: true })
    }
    if (!requireExisting && previousReceipt?.status === 'installed') {
      throw new Error(`Skill ${card.slug} is already installed; use the explicit update action`)
    }
    if (previousReceipt?.status === 'installed' && compareSkillVersions(card.version, previousReceipt.version) < 0 && allowDowngrade !== true) {
      throw new Error(`Skill ${card.slug}@${card.version} is a downgrade; an explicit downgrade choice is required`)
    }
    const bundle = inspectSkillArchive(payload, {
      slug: card.slug, version: card.version, packageSha256: card.package_sha256,
    })
    const action = previousReceipt?.status === 'installed' ? 'update' : 'install'
    let wal = openTransaction(paths, {
      slug: card.slug,
      action,
      previous_receipt: previousReceipt ?? null,
      next_receipt: null,
      desired_completion: null,
      completion_receipt: null,
    })
    let claimed = false
    let switched = false
    try {
      extractCandidate(bundle, paths)
      const candidateNative = await validateCandidate(paths.candidateRoot, card.slug, signal)
      const nextReceipt = nativeReceipt(card.slug, card.version, card.package_sha256, 'installed', candidateNative, undefined, card.uploader)
      const completionReceipt = await claim()
      claimed = true
      wal = writeWal(paths, {
        ...wal,
        phase: 'claimed',
        completion_receipt: completionReceipt,
        desired_completion: 'installed',
        next_receipt: nextReceipt,
      })
      if (hasActive) renameSync(paths.active, paths.backup)
      renameSync(paths.candidate, paths.active)
      switched = true
      wal = writeWal(paths, { ...wal, phase: 'switched' })
      invalidate()
      const activeNative = await validateActive(paths.active, card.slug, signal)
      wal = writeWal(paths, {
        ...wal,
        next_receipt: nativeReceipt(card.slug, card.version, card.package_sha256, 'installed', activeNative, undefined, card.uploader),
      })
      const completion = await complete(completionReceipt, 'installed', signal)
      if (completion.state === 'unknown') {
        moveBackInstall(paths, previousReceipt)
        invalidate()
        writeWal(paths, { ...wal, phase: 'completion-pending' })
        throw new SkillHubRecoveryPendingError(
          `Skill ${card.slug}@${card.version} completion is pending reconciliation; the previous local state remains active`,
          { cause: completion.error },
        )
      }
      if (completion.state !== 'accepted') throw completion.error ?? new Error('Skill install completion was rejected')
      atomicJson(paths.receipt, wal.next_receipt)
      wal = writeWal(paths, { ...wal, phase: 'committed' })
      rmSync(paths.backup, { recursive: true, force: true })
      cleanupTransaction(paths)
      return operationResult(wal.next_receipt, { action })
    } catch (error) {
      if (error instanceof SkillHubRecoveryPendingError) throw error
      try {
        if (switched) {
          moveBackInstall(paths, previousReceipt)
        } else restoreReceipt(paths, previousReceipt)
        invalidate()
      } catch (rollbackError) {
        writeWal(paths, { ...wal, phase: 'completion-pending', desired_completion: claimed ? 'failed' : null })
        throw new SkillHubRecoveryPendingError(`Skill ${card.slug} rollback requires recovery`, { cause: rollbackError })
      }
      if (claimed) {
        const failed = await complete(wal.completion_receipt, 'failed').catch(failure => ({ state: 'unknown', error: failure }))
        if (failed.state === 'unknown') {
          writeWal(paths, { ...wal, phase: 'completion-pending', desired_completion: 'failed' })
          throw new SkillHubRecoveryPendingError(`Skill ${card.slug} failure receipt requires reconciliation`, { cause: failed.error ?? error })
        }
      }
      cleanupTransaction(paths)
      throw error
    }
  })

  const disable = async (slug, signal) => serial(slug, async () => {
    const paths = skillPaths(dshHome, slug)
    ensureRealDirectory(paths.disabledRoot, 'Skill Hub disabled root')
    if (existsSync(paths.transaction)) throw new SkillHubRecoveryPendingError(`Skill ${slug} has a pending transaction`)
    const previousReceipt = readReceipt(paths, slug)
    if (previousReceipt?.status !== 'installed' || !existsReal(paths.active)) throw new Error(`Skill ${slug} is not enabled by Skill Hub`)
    if (existsReal(paths.disabled)) throw new Error(`Skill ${slug} disabled path already exists`)
    const native = await validateActive(paths.active, slug, signal)
    const nextReceipt = nativeReceipt(slug, previousReceipt.version, previousReceipt.package_sha256, 'disabled', native, undefined, previousReceipt.uploader)
    let wal = openTransaction(paths, { slug, action: 'disable', previous_receipt: previousReceipt, next_receipt: nextReceipt })
    try {
      renameSync(paths.active, paths.disabled)
      wal = writeWal(paths, { ...wal, phase: 'switched' })
      invalidate()
      await validateAbsent(paths.active, slug, signal)
      atomicJson(paths.receipt, nextReceipt)
      writeWal(paths, { ...wal, phase: 'committed' })
      cleanupTransaction(paths)
      return operationResult(nextReceipt)
    } catch (error) {
      if (!existsReal(paths.active) && existsReal(paths.disabled)) renameSync(paths.disabled, paths.active)
      restoreReceipt(paths, previousReceipt)
      invalidate()
      cleanupTransaction(paths)
      throw error
    }
  })

  const enable = async (slug, signal) => serial(slug, async () => {
    const paths = skillPaths(dshHome, slug)
    ensureRealDirectory(paths.activeRoot, 'Skill root')
    ensureRealDirectory(paths.disabledRoot, 'Skill Hub disabled root')
    if (existsSync(paths.transaction)) throw new SkillHubRecoveryPendingError(`Skill ${slug} has a pending transaction`)
    const previousReceipt = readReceipt(paths, slug)
    if (previousReceipt?.status !== 'disabled' || !existsReal(paths.disabled)) throw new Error(`Skill ${slug} is not disabled by Skill Hub`)
    if (existsReal(paths.active)) throw new Error(`Skill ${slug} active path is already occupied`)
    const native = await validateCandidate(paths.disabledRoot, slug, signal)
    const nextReceipt = nativeReceipt(slug, previousReceipt.version, previousReceipt.package_sha256, 'installed', native, undefined, previousReceipt.uploader)
    let wal = openTransaction(paths, { slug, action: 'enable', previous_receipt: previousReceipt, next_receipt: nextReceipt })
    try {
      renameSync(paths.disabled, paths.active)
      wal = writeWal(paths, { ...wal, phase: 'switched' })
      invalidate()
      const activeNative = await validateActive(paths.active, slug, signal)
      const accepted = nativeReceipt(slug, previousReceipt.version, previousReceipt.package_sha256, 'installed', activeNative, undefined, previousReceipt.uploader)
      atomicJson(paths.receipt, accepted)
      writeWal(paths, { ...wal, phase: 'committed', next_receipt: accepted })
      cleanupTransaction(paths)
      return operationResult(accepted)
    } catch (error) {
      if (!existsReal(paths.disabled) && existsReal(paths.active)) renameSync(paths.active, paths.disabled)
      restoreReceipt(paths, previousReceipt)
      invalidate()
      cleanupTransaction(paths)
      throw error
    }
  })

  const uninstall = async (slug, signal) => serial(slug, async () => {
    const paths = skillPaths(dshHome, slug)
    ensureRealDirectory(paths.activeRoot, 'Skill root')
    ensureRealDirectory(paths.disabledRoot, 'Skill Hub disabled root')
    if (existsSync(paths.transaction)) throw new SkillHubRecoveryPendingError(`Skill ${slug} has a pending transaction`)
    const previousReceipt = readReceipt(paths, slug)
    if (!['installed', 'disabled'].includes(previousReceipt?.status)) throw new Error(`Skill ${slug} is not owned by Skill Hub`)
    const source = previousReceipt.status === 'installed' ? paths.active : paths.disabled
    if (!existsReal(source)) throw new Error(`Skill ${slug} content is missing`)
    const nextReceipt = { ...previousReceipt, status: 'uninstalled', updated_at: new Date().toISOString() }
    let wal = openTransaction(paths, { slug, action: 'uninstall', previous_receipt: previousReceipt, next_receipt: nextReceipt })
    try {
      renameSync(source, paths.quarantine)
      wal = writeWal(paths, { ...wal, phase: 'switched' })
      invalidate()
      await validateAbsent(paths.active, slug, signal)
      atomicJson(paths.receipt, nextReceipt)
      writeWal(paths, { ...wal, phase: 'committed' })
      rmSync(paths.quarantine, { recursive: true, force: true })
      cleanupTransaction(paths)
      return operationResult(nextReceipt)
    } catch (error) {
      if (!existsReal(source) && existsReal(paths.quarantine)) renameSync(paths.quarantine, source)
      restoreReceipt(paths, previousReceipt)
      invalidate()
      cleanupTransaction(paths)
      throw error
    }
  })

  const inventory = async (signal) => {
    const receiptsRoot = join(dshHome, 'e-mate', 'migrations')
    if (!existsSync(receiptsRoot)) return []
    realDirectory(receiptsRoot, 'Skill Hub receipt root')
    const items = []
    for (const entry of readdirSync(receiptsRoot, { withFileTypes: true })) {
      const match = /^skill-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/u.exec(entry.name)
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) continue
      const slug = match[1]
      const paths = skillPaths(dshHome, slug)
      const receipt = readReceipt(paths, slug)
      if (receipt.status === 'uninstalled') continue
      let ready = false
      let native
      let error
      try {
        native = receipt.status === 'installed'
          ? await validateActive(paths.active, slug, signal)
          : await validateCandidate(paths.disabledRoot, slug, signal)
        ready = receipt.status === 'installed'
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      items.push({
        ...operationResult(receipt),
        description: native?.description ?? receipt.description ?? '',
        invocation: native?.invocation ?? {
          modelInvocable: receipt.invocation?.model_invocable === true,
          userInvocable: receipt.invocation?.user_invocable === true,
        },
        ready,
        ...(error === undefined ? {} : { error }),
        ...(error === undefined ? {} : { error_code: 'native-provider' }),
        recovery_pending: existsSync(paths.transaction),
      })
    }
    return items.sort((left, right) => left.slug.localeCompare(right.slug))
  }

  const validatePublication = async (payload, signal) => {
    signal?.throwIfAborted()
    const bundle = inspectSkillArchive(payload)
    const candidateRoot = join(dshHome, 'e-mate', 'skill-hub', 'publication-validation', randomUUID())
    const paths = { candidateRoot, candidate: join(candidateRoot, bundle.name) }
    try {
      extractCandidate(bundle, paths)
      await validateCandidate(candidateRoot, bundle.name, signal)
      return bundle
    } finally {
      rmSync(candidateRoot, { recursive: true, force: true })
    }
  }

  const recover = async ({ reconcile, complete, signal } = {}) => {
    const root = join(dshHome, 'e-mate', 'skill-hub', 'transactions')
    if (!existsSync(root)) return []
    realDirectory(root, 'Skill Hub transaction root')
    const results = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SKILL_NAME.test(entry.name)) continue
      const slug = entry.name
      const paths = skillPaths(dshHome, slug)
      const wal = readWal(paths, slug)
      if (wal.owner_pid !== process.pid && pidAlive(wal.owner_pid)) {
        results.push({ slug, status: 'busy' })
        continue
      }
      try {
        if (wal.phase === 'committed') {
          cleanupTransaction(paths)
          results.push({ slug, status: 'recovered' })
          continue
        }
        if (wal.action === 'disable') {
          if (!existsReal(paths.disabled) && existsReal(paths.active)) renameSync(paths.active, paths.disabled)
          invalidate()
          await validateAbsent(paths.active, slug, signal)
          atomicJson(paths.receipt, wal.next_receipt)
          cleanupTransaction(paths)
          results.push({ slug, status: 'recovered' })
          continue
        }
        if (wal.action === 'enable') {
          if (!existsReal(paths.active) && existsReal(paths.disabled)) renameSync(paths.disabled, paths.active)
          invalidate()
          await validateActive(paths.active, slug, signal)
          atomicJson(paths.receipt, wal.next_receipt)
          cleanupTransaction(paths)
          results.push({ slug, status: 'recovered' })
          continue
        }
        if (wal.action === 'uninstall') {
          const source = wal.previous_receipt?.status === 'disabled' ? paths.disabled : paths.active
          if (existsReal(source)) renameSync(source, paths.quarantine)
          invalidate()
          await validateAbsent(paths.active, slug, signal)
          atomicJson(paths.receipt, wal.next_receipt)
          rmSync(paths.quarantine, { recursive: true, force: true })
          cleanupTransaction(paths)
          results.push({ slug, status: 'recovered' })
          continue
        }
        if (wal.phase === 'prepared' && wal.completion_receipt === null) {
          cleanupTransaction(paths)
          results.push({ slug, status: 'rolled-back' })
          continue
        }
        if (['claimed', 'switched', 'completion-pending'].includes(wal.phase)) {
          stageInstallRecovery(paths, wal.previous_receipt ?? undefined)
          invalidate()
          writeWal(paths, { ...wal, phase: 'completion-pending' })
        }
        const pending = readWal(paths, slug)
        if (typeof pending.completion_receipt !== 'string' || typeof reconcile !== 'function') {
          results.push({ slug, status: 'recovery-pending' })
          continue
        }
        let remote = await reconcile(pending.completion_receipt, pending.next_receipt, signal)
        if (remote === 'claimed' && typeof complete === 'function') {
          const completion = await complete(
            pending.completion_receipt, pending.desired_completion ?? 'installed', signal, pending.next_receipt,
          )
          remote = completion.state === 'accepted' ? pending.desired_completion : 'unknown'
        }
        if (remote === 'failed') {
          cleanupTransaction(paths)
          results.push({ slug, status: 'rolled-back' })
          continue
        }
        if (pending.desired_completion === 'failed') {
          results.push({ slug, status: 'recovery-pending', error: `server reports ${remote} for a failed local transaction` })
          continue
        }
        if (remote !== 'installed') {
          results.push({ slug, status: 'recovery-pending' })
          continue
        }
        if (existsReal(paths.active)) renameSync(paths.active, paths.backup)
        renameSync(paths.candidate, paths.active)
        invalidate()
        await validateActive(paths.active, slug, signal)
        atomicJson(paths.receipt, pending.next_receipt)
        writeWal(paths, { ...pending, phase: 'committed' })
        rmSync(paths.backup, { recursive: true, force: true })
        cleanupTransaction(paths)
        results.push({ slug, status: 'recovered' })
      } catch (error) {
        results.push({ slug, status: 'recovery-pending', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  return {
    install,
    update: options => install({ ...options, requireExisting: true }),
    disable,
    enable,
    uninstall,
    inventory,
    recover,
    validatePublication,
  }
}

function skillCard(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Skill Hub card is invalid')
  const card = value
  if (!SKILL_NAME.test(card.slug) || !VERSION.test(card.version) || !SHA256.test(card.package_sha256)
    || typeof card.title !== 'string' || card.title.length < 1 || card.title.length > 128
    || typeof card.summary !== 'string' || card.summary.length < 1 || card.summary.length > 2048
    || !Number.isSafeInteger(card.package_size_bytes) || card.package_size_bytes < 1 || card.package_size_bytes > 64 * 1024 * 1024
    || !['third_party', 'content_creation', 'office_productivity'].includes(card.category)
    || !Array.isArray(card.tags) || card.tags.length > 32
    || card.tags.some(tag => typeof tag !== 'string' || tag.length > 64)
    || typeof card.uploader !== 'object' || card.uploader === null || Array.isArray(card.uploader)
    || typeof card.uploader.nickname !== 'string' || card.uploader.nickname.length < 1 || card.uploader.nickname.length > 64
    || !/^author_[0-9a-f]{24}$/u.test(card.uploader.author_ref)
    || typeof card.provenance !== 'object' || card.provenance === null || Array.isArray(card.provenance)
    || card.provenance.brand !== 'e-Mate'
    || !['not_installed', 'installed_enabled', 'installed_disabled', 'uninstalled'].includes(card.installation_status)
    || !['ready', 'needs_configuration', 'missing_runtime', 'unsupported'].includes(card.readiness)) {
    throw new Error('Skill Hub card identity is invalid')
  }
  return {
    slug: card.slug,
    version: card.version,
    package_sha256: card.package_sha256,
    title: card.title,
    summary: card.summary,
    package_size_bytes: card.package_size_bytes,
    category: card.category,
    tags: [...card.tags],
    uploader: { nickname: card.uploader.nickname, author_ref: card.uploader.author_ref },
    provenance: {
      brand: 'e-Mate',
      original_platform: typeof card.provenance.original_platform === 'string' ? card.provenance.original_platform : null,
      original_url: typeof card.provenance.original_url === 'string' ? card.provenance.original_url : null,
    },
    installation_status: card.installation_status,
    readiness: card.readiness,
  }
}

function hubBase(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== '/ecorex-agent/client/skill-hub/v1') {
    throw new Error('Skill Hub must use the configured HTTPS product endpoint')
  }
  return url
}

async function readBounded(response, maximum, label) {
  const header = response.headers.get('content-length')
  if (header !== null) {
    const length = Number(header)
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${label} content length is invalid`)
    if (length > maximum) throw new Error(`${label} response is too large`)
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        await reader.cancel()
        throw new Error(`${label} response is too large`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function responseJson(response, label) {
  const payload = await readBounded(response, 2 * 1024 * 1024, label)
  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
  } catch {
    throw new Error(`${label} response is not JSON`)
  }
  if (!response.ok) {
    const detail = typeof value?.detail === 'string' ? value.detail : `${label} failed with HTTP ${response.status}`
    const code = ['auth', 'network', 'conflict', 'integrity', 'recovery', 'native-provider', 'bad-request'].includes(value?.error?.code)
      ? value.error.code
      : response.status === 401 || response.status === 403 ? 'auth'
        : response.status === 409 ? 'conflict' : response.status === 422 ? 'integrity'
          : response.status >= 500 ? 'network' : 'bad-request'
    throw new SkillHubOperationError(code, detail)
  }
  return value
}

function encodeSegment(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`${label} is invalid`)
  return encodeURIComponent(value)
}

async function packageBytes(response, expectedSha256) {
  if (!response.ok) throw new SkillHubOperationError(
    response.status === 401 || response.status === 403 ? 'auth' : response.status === 409 ? 'conflict' : response.status >= 500 ? 'network' : 'bad-request',
    `Skill package download failed with HTTP ${response.status}`,
  )
  const declared = response.headers.get('x-skill-content-sha256')
  if (declared !== expectedSha256) throw new SkillHubOperationError('integrity', 'Skill package response digest is invalid')
  return readBounded(response, MAX_ARCHIVE_BYTES, 'Skill package')
}

function requestId(prefix) {
  return `${prefix}:${randomUUID()}`
}

function mutationRequestId(action, ...identity) {
  return `${action}:${digest(Buffer.from(identity.join('\0'), 'utf8'))}`
}

function remoteMutationPaths(dshHome, requestId) {
  const root = join(dshHome, 'e-mate', 'skill-hub', 'remote-mutations')
  const transaction = join(root, digest(Buffer.from(requestId, 'utf8')))
  return {
    root,
    transaction,
    wal: join(transaction, 'wal.json'),
    payload: join(transaction, 'payload.zip'),
  }
}

function remoteMutationWal(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schema_version !== 1
    || !['publish', 'delete'].includes(value.action)
    || !SKILL_NAME.test(value.slug) || !VERSION.test(value.version)
    || !SHA256.test(value.package_sha256)
    || typeof value.request_id !== 'string'
    || value.request_id !== mutationRequestId(
      value.action, value.slug, value.version, value.package_sha256,
      ...(value.action === 'publish' ? [value.category] : []),
    )
    || (value.action === 'publish' && (
      !['third_party', 'content_creation', 'office_productivity'].includes(value.category)
      || !SHA256.test(value.archive_sha256)
    ))
    || (value.action === 'delete' && (typeof value.uploader !== 'object' || value.uploader === null
      || typeof value.uploader.nickname !== 'string' || !/^author_[0-9a-f]{24}$/u.test(value.uploader.author_ref)))) {
    throw new Error('Skill Hub remote mutation receipt is invalid')
  }
  return value
}

function readRemotePayload(paths, expectedSha256) {
  const before = lstatSync(paths.payload)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 22 || before.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Skill Hub pending publication payload is invalid')
  }
  const payload = readFileSync(paths.payload)
  const after = lstatSync(paths.payload)
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
    || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || digest(payload) !== expectedSha256) {
    throw new Error('Skill Hub pending publication payload changed')
  }
  return payload
}

function readRemoteMutation(paths) {
  realDirectory(paths.transaction, 'Skill Hub remote mutation')
  let value
  try {
    value = JSON.parse(readFileSync(paths.wal, 'utf8'))
  } catch (error) {
    throw new Error('Skill Hub remote mutation receipt is unreadable', { cause: error })
  }
  const wal = remoteMutationWal(value)
  return {
    wal,
    payload: wal.action === 'publish' ? readRemotePayload(paths, wal.archive_sha256) : undefined,
  }
}

function prepareRemoteMutation(dshHome, wal, payload) {
  const accepted = remoteMutationWal(wal)
  const paths = remoteMutationPaths(dshHome, accepted.request_id)
  ensureRealDirectory(paths.root, 'Skill Hub remote mutation root')
  if (existsSync(paths.transaction)) {
    const pending = readRemoteMutation(paths)
    for (const key of Object.keys(accepted)) {
      if (pending.wal[key] !== accepted[key]) throw new Error('Skill Hub remote mutation identity conflicts with pending recovery')
    }
    return { paths, ...pending }
  }
  const temporary = `${paths.transaction}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(temporary, { mode: 0o700 })
    if (accepted.action === 'publish') {
      if (!Buffer.isBuffer(payload) || digest(payload) !== accepted.archive_sha256) {
        throw new Error('Skill Hub publication payload does not match its recovery receipt')
      }
      writeFileSync(join(temporary, 'payload.zip'), payload, { mode: 0o600, flag: 'wx' })
    }
    atomicJson(join(temporary, 'wal.json'), accepted)
    renameSync(temporary, paths.transaction)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return { paths, wal: accepted, payload }
}

function cleanupRemoteMutation(paths) {
  rmSync(paths.transaction, { recursive: true, force: true })
}

function decodeArchiveBase64(value) {
  if (typeof value !== 'string'
    || value.length < 4
    || value.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw archiveError('base64 upload is invalid or too large')
  }
  const payload = Buffer.from(value, 'base64')
  if (payload.toString('base64') !== value) throw archiveError('base64 upload is not canonical')
  return payload
}

function installedSkillArchive(dshHome, slug) {
  if (!SKILL_NAME.test(slug)) throw new Error('installed Skill name is invalid')
  const root = join(dshHome, 'skills', slug)
  realDirectory(root, 'installed Skill')
  const files = {}
  let count = 0
  let total = 0
  const walk = (directory, relative = '') => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCodePoints(left.name, right.name))
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      const target = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('installed Skill contains a symbolic link')
      if (entry.isDirectory()) {
        walk(target, path)
        continue
      }
      const info = lstatSync(target)
      if (!entry.isFile() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o111) !== 0) {
        throw new Error('installed Skill contains a linked, special, or executable file')
      }
      validatePath(path, false)
      if (info.size > MAX_FILE_BYTES || ++count > MAX_FILES || (total += info.size) > MAX_ARCHIVE_BYTES) {
        throw new Error('installed Skill exceeds publication limits')
      }
      const content = readFileSync(target)
      const after = lstatSync(target)
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        throw new Error('installed Skill changed while it was being packaged')
      }
      files[path] = new Uint8Array(content)
    }
  }
  walk(root)
  const payload = Buffer.from(zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) }))
  inspectSkillArchive(payload, { slug })
  return payload
}

export function createSkillHubClient({ request, dshHome, store, baseUrl = 'https://mvdcm.ecoremedia.net/ecorex-agent/client/skill-hub/v1' }) {
  if (typeof request !== 'function') throw new Error('Skill Hub requires the authenticated identity transport')
  if (store === undefined) throw new Error('Skill Hub requires its native DSH lifecycle store')
  const base = hubBase(baseUrl)
  const call = async (path, init = {}) => {
    try {
      return await request(new URL(`${base.pathname}${path}`, base.origin), {
        ...init,
        headers: { accept: 'application/json', ...init.headers },
        redirect: 'error',
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (error?.code === 'auth') throw new SkillHubOperationError('auth', 'e-Mate login is required', { cause: error })
      throw new SkillHubOperationError('network', 'Skill Hub network request failed', { cause: error })
    }
  }
  const remoteTails = new Map()
  const serialRemote = async (requestId, operation) => {
    const previous = remoteTails.get(requestId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    remoteTails.set(requestId, current)
    try {
      return await current
    } finally {
      if (remoteTails.get(requestId) === current) remoteTails.delete(requestId)
    }
  }

  const pendingRemote = (wal, error) => new SkillHubRecoveryPendingError(
    `Skill ${wal.slug}@${wal.version} ${wal.action} is pending authenticated server reconciliation`,
    { cause: error },
  )

  const executeRemoteMutation = async ({ paths, wal, payload }, signal) => {
    try {
      signal?.throwIfAborted()
    } catch (error) {
      cleanupRemoteMutation(paths)
      throw error
    }
    let response
    try {
      response = wal.action === 'publish'
        ? await call('/skills', {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: wal.slug,
            category: wal.category,
            bundle_base64: payload.toString('base64'),
            client_request_id: wal.request_id,
          }),
        })
        : await call(`/skills/${encodeSegment(wal.slug, SKILL_NAME, 'Skill slug')}/versions/${encodeSegment(wal.version, VERSION, 'Skill version')}`, {
          method: 'DELETE',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            package_sha256: wal.package_sha256,
            client_request_id: wal.request_id,
          }),
        })
    } catch (error) {
      throw pendingRemote(wal, error)
    }
    const label = wal.action === 'publish' ? 'Skill publication' : 'Skill publication deletion'
    if (!response.ok) {
      let failure
      try { await responseJson(response, label) } catch (error) { failure = error }
      if (response.status >= 500 || [408, 425, 429].includes(response.status)) {
        throw pendingRemote(wal, failure ?? new Error(`${label} status is uncertain`))
      }
      cleanupRemoteMutation(paths)
      throw failure ?? new Error(`${label} failed with HTTP ${response.status}`)
    }
    try {
      const value = await responseJson(response, label)
      if (wal.action === 'publish') {
        const card = skillCard(value)
        if (card.slug !== wal.slug || card.version !== wal.version
          || card.package_sha256 !== wal.package_sha256) {
          throw new Error('Skill publication receipt does not match the uploaded archive')
        }
        cleanupRemoteMutation(paths)
        return card
      }
      if (value.schema_version !== 1 || value.status !== 'deleted'
        || value.slug !== wal.slug || value.version !== wal.version
        || value.package_sha256 !== wal.package_sha256
        || value.uploader?.author_ref !== wal.uploader.author_ref) {
        throw new Error('Skill publication deletion receipt is invalid')
      }
      cleanupRemoteMutation(paths)
      return value
    } catch (error) {
      throw pendingRemote(wal, error)
    }
  }

  const runRemoteMutation = (wal, payload, signal) => serialRemote(wal.request_id, async () => {
    const prepared = prepareRemoteMutation(dshHome, wal, payload)
    return executeRemoteMutation(prepared, signal)
  })

  const recoverRemoteMutations = async signal => {
    const root = join(dshHome, 'e-mate', 'skill-hub', 'remote-mutations')
    if (!existsSync(root)) return []
    realDirectory(root, 'Skill Hub remote mutation root')
    const results = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SHA256.test(entry.name)) continue
      const paths = {
        root,
        transaction: join(root, entry.name),
        wal: join(root, entry.name, 'wal.json'),
        payload: join(root, entry.name, 'payload.zip'),
      }
      try {
        const pending = readRemoteMutation(paths)
        if (remoteMutationPaths(dshHome, pending.wal.request_id).transaction !== paths.transaction) {
          throw new Error('Skill Hub remote mutation path is invalid')
        }
        await serialRemote(pending.wal.request_id, () => executeRemoteMutation({ paths, ...pending }, signal))
        results.push({ slug: pending.wal.slug, action: pending.wal.action, status: 'recovered' })
      } catch (error) {
        results.push({
          slug: 'remote-publication',
          status: error instanceof SkillHubRecoveryPendingError ? 'recovery-pending' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return results
  }

  const detail = async (slug, options = {}, signal) => {
    if (typeof options?.throwIfAborted === 'function') { signal = options; options = {} }
    if (typeof options !== 'object' || options === null || Array.isArray(options)
      || Object.keys(options).some(key => !['cursor', 'limit'].includes(key))
      || (options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor.length < 1 || Buffer.byteLength(options.cursor) > 512))
      || (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100))) {
      throw new Error('Skill detail filters are invalid')
    }
    const parameters = new URLSearchParams()
    if (options.cursor !== undefined) parameters.set('cursor', options.cursor)
    if (options.limit !== undefined) parameters.set('limit', String(options.limit))
    const suffix = parameters.size === 0 ? '' : `?${parameters}`
    const response = await call(`/skills/${encodeSegment(slug, SKILL_NAME, 'Skill slug')}${suffix}`, { signal })
    const value = await responseJson(response, 'Skill detail')
    if (value.schema_version !== 1 || !Array.isArray(value.versions)
      || value.versions.length > (options.limit ?? 24)
      || (value.next_cursor != null && typeof value.next_cursor !== 'string')) throw new Error('Skill detail versions are invalid')
    const skill = skillCard(value.skill)
    const versions = value.versions.map(skillCard)
    if (skill.slug !== slug || versions.some(card => card.slug !== slug)) throw new Error('Skill detail slug is inconsistent')
    return { schema_version: 1, skill, versions, next_cursor: value.next_cursor ?? null }
  }

  const versionCard = async (slug, version, signal) => {
    const response = await call(
      `/skills/${encodeSegment(slug, SKILL_NAME, 'Skill slug')}/versions/${encodeSegment(version, VERSION, 'Skill version')}`,
      { signal },
    )
    const selected = skillCard(await responseJson(response, 'Skill version'))
    if (selected.slug !== slug || selected.version !== version) throw new Error('Skill version identity is inconsistent')
    return selected
  }

  const select = async (slug, version, signal) => {
    return version === undefined ? (await detail(slug, {}, signal)).skill : versionCard(slug, version, signal)
  }

  const download = async (slug, version, signal) => {
    const card = await select(slug, version, signal)
    signal?.throwIfAborted()
    const response = await call(`/skills/${encodeSegment(card.slug, SKILL_NAME, 'Skill slug')}/versions/${encodeSegment(card.version, VERSION, 'Skill version')}/package`, { signal })
    const payload = await packageBytes(response, card.package_sha256)
    const inspected = inspectSkillArchive(payload, {
      slug: card.slug,
      version: card.version,
      packageSha256: card.package_sha256,
    })
    return { card, payload, archiveSha256: inspected.archiveSha256 }
  }

  const complete = async (completionReceipt, status, signal, expected) => {
    let response
    try {
      response = await call('/install-intents/complete', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completion_receipt: completionReceipt, status }),
      })
    } catch (error) {
      return { state: 'unknown', error }
    }
    try {
      const value = await responseJson(response, 'Skill install completion')
      if (value.schema_version !== 1 || value.status !== status
        || (expected !== undefined && (value.slug !== expected.slug || value.version !== expected.version
          || value.package_sha256 !== expected.package_sha256
          || (expected.uploader !== undefined && value.uploader?.author_ref !== expected.uploader.author_ref)))) {
        throw new SkillHubOperationError('integrity', 'Skill install completion receipt is invalid')
      }
      return { state: 'accepted', value }
    } catch (error) {
      return { state: response.ok ? 'unknown' : 'rejected', error }
    }
  }

  const reconcile = async (completionReceipt, expected, signal) => {
    let response
    try {
      response = await call('/install-intents/reconcile', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completion_receipt: completionReceipt }),
      })
    } catch {
      return 'unknown'
    }
    if (!response.ok) {
      await readBounded(response, 2 * 1024 * 1024, 'Skill install reconciliation').catch(() => {})
      return 'unknown'
    }
    const value = await responseJson(response, 'Skill install reconciliation')
    if (!['claimed', 'installed', 'failed'].includes(value.status)
      || !SKILL_NAME.test(value.slug) || !VERSION.test(value.version) || !SHA256.test(value.package_sha256)
      || typeof value.uploader !== 'object' || !/^author_[0-9a-f]{24}$/u.test(value.uploader.author_ref)
      || value.slug !== expected?.slug || value.version !== expected?.version || value.package_sha256 !== expected?.package_sha256
      || (expected?.uploader !== undefined && value.uploader.author_ref !== expected.uploader.author_ref)) return 'unknown'
    return value.status
  }

  const claim = async (card, signal) => {
    const intent = await responseJson(await call(`/skills/${encodeSegment(card.slug, SKILL_NAME, 'Skill slug')}/versions/${encodeSegment(card.version, VERSION, 'Skill version')}/install-intent`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: requestId('install') }),
    }), 'Skill install intent')
    if (typeof intent.install_intent !== 'string' || intent.slug !== card.slug || intent.version !== card.version
      || intent.package_sha256 !== card.package_sha256 || intent.uploader?.author_ref !== card.uploader.author_ref) {
      throw new SkillHubOperationError('integrity', 'Skill install intent response is invalid')
    }
    const claimed = await responseJson(await call('/install-intents/consume', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ install_intent: intent.install_intent }),
    }), 'Skill install claim')
    if (typeof claimed.completion_receipt !== 'string' || claimed.slug !== card.slug || claimed.version !== card.version
      || claimed.package_sha256 !== card.package_sha256 || claimed.uploader?.author_ref !== card.uploader.author_ref) {
      throw new SkillHubOperationError('integrity', 'Skill install claim response is invalid')
    }
    return claimed.completion_receipt
  }

  const installOperation = async (kind, slug, version, signal, options = {}) => {
    const downloaded = await download(slug, version, signal)
    if (['missing_runtime', 'unsupported'].includes(downloaded.card.readiness)) {
      throw new Error(`Skill ${downloaded.card.slug}@${downloaded.card.version} is not supported by this DSH runtime`)
    }
    return await store[kind]({
      payload: downloaded.payload,
      card: downloaded.card,
      signal,
      allowDowngrade: options.allowDowngrade === true,
      claim: () => claim(downloaded.card, signal),
      complete: (receipt, status, completionSignal) => complete(receipt, status, completionSignal, downloaded.card),
    })
  }

  const preparePublication = (slug) => {
    const payload = installedSkillArchive(dshHome, slug)
    const inspected = inspectSkillArchive(payload, { slug })
    return {
      slug: inspected.name,
      version: inspected.version,
      package_sha256: inspected.packageSha256,
      archive_sha256: inspected.archiveSha256,
      payload,
    }
  }

  const publishPayload = async (payload, category, signal, expected) => {
    if (!['third_party', 'content_creation', 'office_productivity'].includes(category)) throw new Error('Skill category is invalid')
    const inspected = inspectSkillArchive(payload)
    if (expected !== undefined && (inspected.name !== expected.slug
      || inspected.version !== expected.version
      || inspected.packageSha256 !== expected.package_sha256
      || inspected.archiveSha256 !== expected.archive_sha256)) {
      throw new Error('Skill publication changed after user confirmation')
    }
    await store.validatePublication(payload, signal)
    const requestId = mutationRequestId(
      'publish', inspected.name, inspected.version, inspected.packageSha256, category,
    )
    return runRemoteMutation({
      schema_version: 1,
      action: 'publish',
      request_id: requestId,
      slug: inspected.name,
      version: inspected.version,
      package_sha256: inspected.packageSha256,
      archive_sha256: inspected.archiveSha256,
      category,
    }, payload, signal)
  }

  const ownedPublication = async (slug, version, signal) => {
    if (!SKILL_NAME.test(slug)) throw new Error('Skill slug is invalid')
    if (!VERSION.test(version)) throw new Error('Skill version is invalid')
    const parameters = new URLSearchParams({
      slug,
      version,
    })
    const value = await responseJson(
      await call(`/publications/mine?${parameters}`, { signal }),
      'Owned Skill publication',
    )
    if (value.schema_version !== 1 || !Array.isArray(value.items) || value.items.length !== 1) {
      throw new Error(`Skill ${slug}@${version} is not an active publication owned by this account`)
    }
    const card = skillCard(value.items[0])
    if (card.slug !== slug || card.version !== version) throw new Error('Owned Skill publication identity is invalid')
    return card
  }

  return {
    async search(filters = {}, signal) {
      if (typeof filters === 'string') filters = { query: filters }
      if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) throw new Error('Skill search filters are invalid')
      filters = { ...filters }
      for (const key of ['category', 'tag', 'source', 'cursor']) {
        if (filters[key] === '') delete filters[key]
      }
      const query = filters.query ?? ''
      const limit = filters.limit ?? 24
      if (typeof query !== 'string' || query.length > 128
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || (filters.category !== undefined && !['third_party', 'content_creation', 'office_productivity'].includes(filters.category))
        || (filters.tag !== undefined && (typeof filters.tag !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(filters.tag)))
        || (filters.source !== undefined && (typeof filters.source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u.test(filters.source)))
        || (filters.cursor !== undefined && (typeof filters.cursor !== 'string' || filters.cursor.length < 1
          || Buffer.byteLength(filters.cursor) > 512 || /[\x00-\x1f\x7f]/u.test(filters.cursor)))) {
        throw new Error('Skill search filters are invalid')
      }
      const parameters = new URLSearchParams({ query, limit: String(limit) })
      for (const key of ['category', 'tag', 'source', 'cursor']) {
        if (filters[key] !== undefined) parameters.set(key, filters[key])
      }
      const value = await responseJson(await call(`/skills?${parameters}`, { signal }), 'Skill catalog')
      if (value.schema_version !== 1 || !Array.isArray(value.items) || value.items.length > limit
        || (value.next_cursor !== null && typeof value.next_cursor !== 'string')) throw new Error('Skill catalog response is invalid')
      return { items: value.items.map(skillCard), next_cursor: value.next_cursor }
    },
    detail,
    version: versionCard,
    async download(slug, version, signal) {
      const { card, payload, archiveSha256 } = await download(slug, version, signal)
      const id = randomUUID()
      const path = join(dshHome, 'e-mate', 'cache', 'skill-hub', 'downloads', `${id}.zip`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, payload, { flag: 'wx', mode: 0o600 })
      return { ...card, archive_sha256: archiveSha256, download_id: id, bytes: payload.byteLength }
    },
    install: (slug, version, signal, options) => installOperation('install', slug, version, signal, options),
    update: (slug, version, signal, options) => installOperation('update', slug, version, signal, options),
    enable: (slug, signal) => store.enable(slug, signal),
    disable: (slug, signal) => store.disable(slug, signal),
    uninstall: (slug, signal) => store.uninstall(slug, signal),
    inventory: signal => store.inventory(signal),
    async recover(signal) {
      const local = await store.recover({ reconcile, complete, signal })
      const remote = await recoverRemoteMutations(signal)
      return [...local, ...remote]
    },
    previewPublication(slug) {
      return preparePublication(slug)
    },
    previewArchive(payload) {
      const inspected = inspectSkillArchive(payload)
      return {
        slug: inspected.name,
        version: inspected.version,
        package_sha256: inspected.packageSha256,
        archive_sha256: inspected.archiveSha256,
        payload,
      }
    },
    validatePublication: (payload, signal) => store.validatePublication(payload, signal),
    async publish(slug, category, signal) {
      const publication = preparePublication(slug)
      return publishPayload(publication.payload, category, signal, publication)
    },
    async publishPrepared(publication, category, signal) {
      if (typeof publication !== 'object' || publication === null || !Buffer.isBuffer(publication.payload)
        || !SKILL_NAME.test(publication.slug) || !VERSION.test(publication.version)
        || !SHA256.test(publication.package_sha256)
        || !SHA256.test(publication.archive_sha256)) throw new Error('Skill publication preview is invalid')
      return publishPayload(publication.payload, category, signal, publication)
    },
    async publishArchive(bundleBase64, category, signal) {
      return publishPayload(decodeArchiveBase64(bundleBase64), category, signal)
    },
    ownedPublication,
    async deletePublication(publication, signal) {
      const card = skillCard(publication)
      const requestId = mutationRequestId('delete', card.slug, card.version, card.package_sha256)
      return runRemoteMutation({
        schema_version: 1,
        action: 'delete',
        request_id: requestId,
        slug: card.slug,
        version: card.version,
        package_sha256: card.package_sha256,
        uploader: card.uploader,
      }, undefined, signal)
    },
  }
}

function existsReal(path) {
  try {
    realDirectory(path, 'installed Skill')
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}
