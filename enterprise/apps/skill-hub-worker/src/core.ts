import type { HubBindings } from './ports.ts'
export const BASE_PATH = '/ecorex-agent/client/skill-hub/v1'
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
export const MAX_BODY_BYTES = 14 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 256
const MAX_PATH_BYTES = 512
const MAX_PATH_DEPTH = 8
const MAX_EXPANSION_RATIO = 100
const SKILL_NAME = /^(?=.{2,96}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const SHA256 = /^[0-9a-f]{64}$/u
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SEARCH_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const BEARER = /^Bearer ([^\s]{32,8192})$/u
const FRONTMATTER_KEY = /^[a-z][a-z0-9_-]{0,63}$/u
const FRONTMATTER_KEYS = new Set(['name', 'description', 'version', 'license', 'compatibility', 'tags'])
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u
const RANGE_PART = /^(?:>=|<=|>|<|=)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const CATEGORIES = new Set(['third_party', 'content_creation', 'office_productivity'])
const BLOCKED_SUFFIXES = new Set([
  '.7z', '.bat', '.class', '.cmd', '.com', '.dll', '.dylib', '.exe', '.hta', '.jar', '.msi', '.rar', '.so', '.wasm', '.zip',
])
const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules'])
const CAS_PREFIX = new TextEncoder().encode('ecorex-local-skill-bundle-v1\0')
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1)
  CRC_TABLE[index] = value >>> 0
}

class HttpError extends Error {
  status: number
  code: string
  constructor(status, message, code = status === 401 || status === 403 ? 'auth' : status === 409 ? 'conflict' : status >= 500 ? 'network' : 'bad-request') {
    super(message)
    this.status = status
    this.code = code
  }
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

function exact(value, required: string[], optional: string[] = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function hex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(payload) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', payload)))
}

function base64urlJson(segment) {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment) || segment.length > 5_500) return undefined
  try {
    const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - segment.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function modelPrincipal(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const header = base64urlJson(parts[0])
  const claims = base64urlJson(parts[1])
  if (header?.alg !== 'EdDSA' || header.typ !== 'e-mate-model-session+jwt' || !IDENTIFIER.test(String(header.kid ?? ''))
    || claims?.schemaVersion !== 1 || !IDENTIFIER.test(String(claims.tenantId ?? ''))
    || !IDENTIFIER.test(String(claims.sub ?? '')) || !IDENTIFIER.test(String(claims.sid ?? ''))
    || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1_000)) return undefined
  return { tenantId: claims.tenantId, userId: claims.sub, sessionId: claims.sid }
}

function configured(env) {
  const validation = new URL(env.MODEL_SESSION_VALIDATION_URL)
  const internal = env.INTERNAL_VALIDATION === true && validation.protocol === 'http:'
    && ['model-gateway', 'localhost', '127.0.0.1', '[::1]'].includes(validation.hostname)
  if ((validation.protocol !== 'https:' && !internal) || validation.username || validation.password
    || validation.search || validation.hash
    || (internal ? validation.pathname !== '/v1/consents/current' :
      !validation.pathname.endsWith('/e-mate/model-api/v1/consents/current'))
    || typeof env.AUTHOR_KEY !== 'string' || env.AUTHOR_KEY.length < 32
    || typeof env.DB?.prepare !== 'function' || typeof env.DB?.batch !== 'function'
    || typeof env.PACKAGES?.put !== 'function' || typeof env.PACKAGES?.get !== 'function'
    || typeof env.PACKAGES?.head !== 'function') {
    throw new Error('invalid Skill Hub Worker configuration')
  }
  return { validationUrl: validation.toString() }
}

async function authorRef(env, principal) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.AUTHOR_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${principal.tenantId}\0${principal.userId}`),
  )
  return `author_${hex(new Uint8Array(signature)).slice(0, 24)}`
}

async function sessionRef(env, principal) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.AUTHOR_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${principal.tenantId}\0${principal.userId}\0${principal.sessionId}`),
  )
  return `session_${hex(new Uint8Array(signature)).slice(0, 24)}`
}

async function authenticate(request, env, config, fetchImplementation) {
  const match = BEARER.exec(request.headers.get('authorization') ?? '')
  if (match === null) throw new HttpError(401, 'e-Mate login is required')
  const token = match[1]
  let validation
  try {
    validation = await fetchImplementation(config.validationUrl, {
      method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HttpError(503, 'e-Mate identity service is temporarily unavailable')
  }
  if (validation.body !== null) await validation.body.cancel()
  if (!validation.ok) {
    throw new HttpError(
      validation.status === 401 || validation.status === 403 ? 401 : 503,
      validation.status === 401 || validation.status === 403
        ? 'e-Mate login is required'
        : 'e-Mate identity service is temporarily unavailable',
    )
  }
  const principal = modelPrincipal(token)
  if (principal === undefined) throw new HttpError(401, 'e-Mate login is required')
  return { principal, author: await authorRef(env, principal), session: await sessionRef(env, principal) }
}

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'JSON request body is required')
  }
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'Skill Hub request is too large')
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader) try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new HttpError(413, 'Skill Hub request is too large')
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new HttpError(400, 'Skill Hub request is not valid JSON')
  }
}

function u16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true)
}

function u32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function archiveError(message) {
  return new HttpError(422, `Skill archive rejected: ${message}`, 'integrity')
}

function validatePath(raw, directory) {
  if (raw !== raw.normalize('NFC')) throw archiveError('paths must use NFC Unicode normalization')
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/u.test(raw) || /[\x00-\x1f\x7f]/u.test(raw)) {
    throw archiveError('an absolute, control, or non-POSIX path was found')
  }
  const value = directory ? raw.replace(/\/+$/u, '') : raw
  const parts = value.split('/')
  if (parts.length === 0 || parts.length > MAX_PATH_DEPTH || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw archiveError('a traversal, empty, or over-deep path was found')
  }
  if (new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES) throw archiveError('a path is too long')
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
  if (!(payload instanceof Uint8Array) || payload.byteLength < 22 || payload.byteLength > MAX_ARCHIVE_BYTES) {
    throw archiveError('input must be a ZIP no larger than 10 MiB')
  }
  let end = -1
  for (let offset = payload.byteLength - 22; offset >= Math.max(0, payload.byteLength - 65_557); offset -= 1) {
    if (u32(payload, offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw archiveError('ZIP end record is missing')
  const entries = u16(payload, end + 10)
  const centralSize = u32(payload, end + 12)
  const centralOffset = u32(payload, end + 16)
  if (u16(payload, end + 4) !== 0 || u16(payload, end + 6) !== 0 || entries === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError('multi-disk and ZIP64 archives are unsupported')
  }
  if (entries === 0 || entries > MAX_FILES * 2 || centralOffset + centralSize > end) {
    throw archiveError('central directory bounds are invalid')
  }
  const records: Array<{ path: string; method: number; crc: number; compressed: number; expanded: number; dataStart: number }> = []
  const seen = new Set()
  let offset = centralOffset
  let expandedTotal = 0
  let compressedTotal = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || u32(payload, offset) !== 0x02014b50) throw archiveError('central directory entry is invalid')
    const flags = u16(payload, offset + 8)
    const method = u16(payload, offset + 10)
    const crc = u32(payload, offset + 16)
    const compressed = u32(payload, offset + 20)
    const expanded = u32(payload, offset + 24)
    const nameLength = u16(payload, offset + 28)
    const extraLength = u16(payload, offset + 30)
    const commentLength = u16(payload, offset + 32)
    const externalAttributes = u32(payload, offset + 38)
    const localOffset = u32(payload, offset + 42)
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength
    if (nameLength === 0 || recordEnd > end) throw archiveError('central directory name is invalid')
    const nameBytes = payload.slice(offset + 46, offset + 46 + nameLength)
    if ((flags & 0x800) === 0 && nameBytes.some(byte => byte > 0x7f)) throw archiveError('non-ASCII paths must carry the ZIP UTF-8 flag')
    let raw
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) } catch { throw archiveError('a ZIP path is not valid UTF-8') }
    const directory = raw.endsWith('/')
    const path = validatePath(raw, directory)
    if (seen.has(path.toLowerCase())) throw archiveError('duplicate or case-colliding paths were found')
    seen.add(path.toLowerCase())
    if ((flags & 1) !== 0) throw archiveError('encrypted entries are forbidden')
    if (method !== 0 && method !== 8) throw archiveError('only stored or deflated entries are supported')
    if (localOffset + 30 > centralOffset || u32(payload, localOffset) !== 0x04034b50) throw archiveError('a local file header is invalid')
    const localNameLength = u16(payload, localOffset + 26)
    const localExtraLength = u16(payload, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const localName = payload.slice(localOffset + 30, localOffset + 30 + localNameLength)
    if (u16(payload, localOffset + 6) !== flags || u16(payload, localOffset + 8) !== method
      || localNameLength !== nameLength || dataStart + compressed > centralOffset
      || localName.some((byte, position) => byte !== nameBytes[position])) {
      throw archiveError('local and central ZIP records do not match')
    }
    const mode = (externalAttributes >>> 16) & 0xffff
    const fileType = mode & 0xf000
    if (directory) {
      if (fileType !== 0 && fileType !== 0x4000) throw archiveError('a directory has a special file mode')
    } else {
      if (fileType !== 0 && fileType !== 0x8000) throw archiveError('links, devices, and special files are forbidden')
      if ((mode & 0o111) !== 0) throw archiveError('executable file modes are forbidden')
      if (expanded > MAX_FILE_BYTES || (compressed > 0 && expanded > compressed * MAX_EXPANSION_RATIO)) {
        throw archiveError('a file expansion budget is unsafe')
      }
      records.push({ path, method, crc, compressed, expanded, dataStart })
      expandedTotal += expanded
      compressedTotal += compressed
    }
    offset = recordEnd
  }
  if (offset !== centralOffset + centralSize || records.length === 0 || records.length > MAX_FILES
    || expandedTotal > MAX_ARCHIVE_BYTES
    || (compressedTotal > 0 && expandedTotal > compressedTotal * MAX_EXPANSION_RATIO)) {
    throw archiveError('file inventory or expanded size is invalid')
  }
  return records
}

async function inflate(payload, record) {
  const compressed = payload.slice(record.dataStart, record.dataStart + record.compressed)
  let content
  if (record.method === 0) {
    content = compressed
  } else {
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > record.expanded || total > MAX_FILE_BYTES) {
            await reader.cancel()
            throw archiveError('a deflated file exceeded its declared expansion budget')
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      content = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength }
    } catch {
      throw archiveError('a deflated file cannot be decompressed')
    }
  }
  if (content.byteLength !== record.expanded || crc32(content) !== record.crc) {
    throw archiveError('decompressed inventory does not match the ZIP directory')
  }
  return content
}

function scalar(raw, label) {
  if (raw === '' || '|>&*!{}[]@`'.includes(raw[0]) || raw.includes('\t')) throw archiveError(`SKILL.md ${label} must be a bounded scalar`)
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
    || new TextEncoder().encode(value).byteLength > maximum || CONTROL.test(value)) {
    throw archiveError(`SKILL.md ${label} is invalid`)
  }
  return value
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

function frontmatter(payload) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload) } catch { throw archiveError('SKILL.md is not valid UTF-8') }
  if (text.startsWith('\ufeff') || CONTROL.test(text)) throw archiveError('SKILL.md contains a BOM or control character')
  const lines = text.split(/\r\n|[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/u)
  if (lines[0] !== '---') throw archiveError('SKILL.md must begin with YAML frontmatter')
  const closing = lines.indexOf('---', 1)
  if (closing < 0 || new TextEncoder().encode(lines.slice(0, closing + 1).join('\n')).byteLength > 16 * 1024) {
    throw archiveError('SKILL.md frontmatter is invalid')
  }
  const values: { [key: string]: string | string[] | undefined; tags?: string[] } = {}
  for (let index = 1; index < closing;) {
    const line = lines[index]
    if (line === '' || /^[ \t-]/u.test(line) || !line.includes(':')) throw archiveError('SKILL.md frontmatter must use flat product fields')
    const separator = line.indexOf(':')
    const key = line.slice(0, separator)
    const raw = line.slice(separator + 1).trim()
    if (!FRONTMATTER_KEY.test(key) || !FRONTMATTER_KEYS.has(key)) throw archiveError('SKILL.md frontmatter contains an unknown field')
    if (Object.hasOwn(values, key)) throw archiveError('SKILL.md frontmatter contains a duplicate field')
    index += 1
    if (key === 'tags' && raw === '') {
      const tags: string[] = []
      while (index < closing && lines[index].startsWith('  - ')) {
        tags.push(scalar(lines[index].slice(4).trim(), 'tag'))
        index += 1
      }
      values.tags = tags
    } else if (key === 'tags') {
      try { values.tags = JSON.parse(raw) } catch { throw archiveError('SKILL.md tags must be a JSON string array') }
      if (!Array.isArray(values.tags) || values.tags.some(tag => typeof tag !== 'string')) throw archiveError('SKILL.md tags must be a string array')
    } else {
      values[key] = scalar(raw, key)
    }
  }
  const name = bounded(values.name, 'name', 128)
  const description = bounded(values.description, 'description', 2048)
  const version = bounded(values.version ?? '0.0.0', 'version', 128)
  const match = VERSION.exec(version)
  if (!SKILL_NAME.test(name) || match === null
    || (match[4] !== undefined && match[4].split('.').some(part => /^\d+$/u.test(part) && part !== '0' && part.startsWith('0')))) {
    throw archiveError('SKILL.md name or version is invalid')
  }
  const license = values.license === undefined ? null : bounded(values.license, 'license', 128)
  const compatibility = bounded(values.compatibility ?? '*', 'compatibility', 256)
  if (compatibility !== '*' && !compatibility.split(',').every(part => part !== '' && part === part.trim() && RANGE_PART.test(part))) {
    throw archiveError('SKILL.md compatibility is invalid')
  }
  const tags = values.tags ?? []
  if (tags.length > 32 || tags.some(tag => !TAG.test(tag)) || new Set(tags).size !== tags.length) {
    throw archiveError('SKILL.md tags must be unique bounded identifiers')
  }
  const heading = lines.slice(closing + 1).find(line => line.startsWith('# '))
  return {
    metadata: { name, description, version, license, compatibility, tags: [...tags].sort(compareCodePoints) },
    title: heading === undefined ? name : bounded(heading.slice(2), 'title', 160),
  }
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

function concat(left, right) {
  const value = new Uint8Array(left.byteLength + right.byteLength)
  value.set(left, 0)
  value.set(right, left.byteLength)
  return value
}

export async function inspectSkillArchive(payload) {
  const records = centralDirectory(payload)
  const files = new Map()
  for (const record of records) files.set(record.path, await inflate(payload, record))
  if (!files.has('SKILL.md')) throw archiveError('one root SKILL.md is required')
  const { metadata, title } = frontmatter(files.get('SKILL.md'))
  const manifestFiles: Array<{ path: string; size_bytes: number; sha256: string }> = []
  let total = 0
  for (const [path, content] of [...files].sort(([left], [right]) => compareCodePoints(left, right))) {
    manifestFiles.push({ path, size_bytes: content.byteLength, sha256: await sha256(content) })
    total += content.byteLength
  }
  const manifest = {
    schema_version: 1,
    kind: 'declarative_skill',
    metadata,
    files: manifestFiles,
    total_size_bytes: total,
  }
  return {
    ...metadata,
    title,
    packageSha256: await sha256(concat(CAS_PREFIX, new TextEncoder().encode(canonicalJson(manifest)))),
    archiveSha256: await sha256(payload),
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new HttpError(422, 'Skill package is not canonical base64')
  let binary: string
  try { binary = atob(value) } catch { throw new HttpError(422, 'Skill package is not canonical base64') }
  const payload = Uint8Array.from(binary, character => character.charCodeAt(0))
  let canonical = ''
  for (let offset = 0; offset < payload.length; offset += 0x8000) {
    canonical += String.fromCharCode(...payload.subarray(offset, offset + 0x8000))
  }
  if (btoa(canonical) !== value) throw new HttpError(422, 'Skill package is not canonical base64')
  return payload
}

export function versionSort(version) {
  const match = VERSION.exec(version)
  if (match === null) throw new HttpError(422, 'Skill version is invalid')
  const numeric = value => `${String(value.length).padStart(8, '0')}${value}`
  const lexical = value => `${[...value].map(character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('')}00`
  const core = `${numeric(match[1])}.${numeric(match[2])}.${numeric(match[3])}`
  if (match[4] === undefined) return `${core}~`
  return `${core}${match[4].split('.').map(part => /^\d+$/u.test(part) ? `.0${numeric(part)}` : `.1${lexical(part)}`).join('')}!`
}

function card(row) {
  return {
    slug: row.slug,
    version: row.version,
    package_sha256: row.package_sha256,
    title: row.title,
    summary: row.summary,
    package_size_bytes: Number(row.package_size_bytes),
    category: row.category,
    tags: JSON.parse(row.tags_json),
    uploader: { nickname: row.uploader_nickname, author_ref: row.author_ref },
    provenance: {
      brand: 'e-Mate',
      original_platform: row.original_platform ?? null,
      original_url: row.original_url ?? null,
    },
    installation_status: 'not_installed',
    readiness: 'ready',
  }
}

function statement(env, sql, values: unknown[] = []) {
  return env.DB.prepare(sql).bind(...values)
}

async function first(env, sql, values: unknown[] = []) {
  return statement(env, sql, values).first()
}

async function all(env, sql, values: unknown[] = []) {
  const result = await statement(env, sql, values).all()
  return result.results ?? []
}

function decodeSegment(value, pattern, label) {
  let decoded
  try { decoded = decodeURIComponent(value) } catch { throw new HttpError(400, `${label} is invalid`) }
  if (!pattern.test(decoded)) throw new HttpError(400, `${label} is invalid`)
  return decoded
}

function randomToken() {
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function credentialHash(token, session) {
  return sha256(new TextEncoder().encode(`${token}\0${session}`))
}

function base64urlBytes(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64urlBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new HttpError(422, 'Skill Hub cursor is invalid')
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new HttpError(422, 'Skill Hub cursor is invalid')
  }
}

async function cursorKey(env, usage) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.AUTHOR_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, [usage],
  )
}

async function encodeCursor(env, value) {
  const payload = new TextEncoder().encode(JSON.stringify(value))
  const signature = await crypto.subtle.sign('HMAC', await cursorKey(env, 'sign'), payload)
  return `${base64urlBytes(payload)}.${base64urlBytes(new Uint8Array(signature))}`
}

async function decodeCursor(env, value) {
  const parts = value?.split('.') ?? []
  if (parts.length !== 2) throw new HttpError(422, 'Skill Hub cursor is invalid')
  const payload = decodeBase64urlBytes(parts[0])
  const signature = decodeBase64urlBytes(parts[1])
  if (!await crypto.subtle.verify('HMAC', await cursorKey(env, 'verify'), signature, payload)) {
    throw new HttpError(422, 'Skill Hub cursor is invalid')
  }
  try {
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid')
    return decoded
  } catch {
    throw new HttpError(422, 'Skill Hub cursor is invalid')
  }
}

function mutationMatches(row, action, slug, version, packageSha256) {
  return row !== null && row.action === action && row.slug === slug && row.version === version
    && row.package_sha256 === packageSha256 && row.status === (action === 'publish' ? 'published' : 'deleted')
}

async function publish(request, env, config, fetchImplementation) {
  const auth = await authenticate(request, env, config, fetchImplementation)
  const value = await readJson(request)
  if (!exact(value, ['slug', 'category', 'bundle_base64', 'client_request_id'])
    || !SKILL_NAME.test(value.slug) || !CATEGORIES.has(value.category)
    || !CLIENT_REQUEST_ID.test(value.client_request_id)) throw new HttpError(422, 'Skill Hub publication metadata is invalid')
  const payload = decodeBase64(value.bundle_base64)
  const inspected = await inspectSkillArchive(payload)
  if (inspected.name !== value.slug) throw new HttpError(422, 'Skill package name does not match the requested slug')
  const tombstone = await first(env, 'SELECT 1 AS deleted FROM skill_hub_publication_tombstones WHERE slug=? AND version=?', [inspected.name, inspected.version])
  if (tombstone !== null) throw new HttpError(409, 'Skill Hub publication version is permanently deleted')
  const replay = await first(env,
    'SELECT action,slug,version,package_sha256,status FROM skill_hub_mutation_requests WHERE account_ref=? AND client_request_id=?',
    [auth.author, value.client_request_id],
  )
  if (replay !== null) {
    if (!mutationMatches(replay, 'publish', inspected.name, inspected.version, inspected.packageSha256)) {
      throw new HttpError(409, 'Skill Hub client request identity was reused')
    }
    const existing = await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [inspected.name, inspected.version])
    if (existing === null) throw new HttpError(409, 'Skill Hub publication receipt is unavailable')
    return json(card(existing), 201)
  }
  const owner = await first(env, 'SELECT author_ref FROM skill_hub_versions WHERE slug=? LIMIT 1', [inspected.name])
  if (owner !== null && owner.author_ref !== auth.author) throw new HttpError(409, 'Skill Hub slug is owned by another account')
  const existing = await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [inspected.name, inspected.version])
  if (existing !== null) {
    if (existing.author_ref !== auth.author || existing.package_sha256 !== inspected.packageSha256
      || existing.category !== value.category) throw new HttpError(409, 'Skill Hub slug/version already exists')
    await statement(env,
      'INSERT INTO skill_hub_mutation_requests(account_ref,client_request_id,action,slug,version,package_sha256,status) VALUES (?,?,?,?,?,?,?)',
      [auth.author, value.client_request_id, 'publish', inspected.name, inspected.version, inspected.packageSha256, 'published'],
    ).run()
    return json(card(existing), 201)
  }
  const digestOwner = await first(env, 'SELECT slug,version FROM skill_hub_versions WHERE package_sha256=?', [inspected.packageSha256])
  if (digestOwner !== null) throw new HttpError(409, 'Skill Hub package digest already exists')
  const objectKey = `packages/${inspected.packageSha256}.zip`
  const stored = await env.PACKAGES.head(objectKey)
  if (stored === null) {
    await env.PACKAGES.put(objectKey, payload, {
      httpMetadata: { contentType: 'application/zip', cacheControl: 'private, no-store' },
      customMetadata: {
        package_sha256: inspected.packageSha256,
        archive_sha256: inspected.archiveSha256,
      },
    })
  } else if (stored.size !== payload.byteLength || stored.customMetadata?.package_sha256 !== inspected.packageSha256
    || stored.customMetadata?.archive_sha256 !== inspected.archiveSha256) {
    throw new HttpError(409, 'Skill Hub package storage identity conflicts')
  }
  try {
    await env.DB.batch([
      statement(env, 'INSERT OR IGNORE INTO skill_hub_skills(slug,latest_version) VALUES (?,?)', [inspected.name, inspected.version]),
      statement(env,
        'INSERT INTO skill_hub_versions(slug,version,version_sort,package_sha256,archive_sha256,package_size_bytes,title,summary,category,tags_json,uploader_nickname,author_ref,original_platform,original_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [inspected.name, inspected.version, versionSort(inspected.version), inspected.packageSha256, inspected.archiveSha256,
          payload.byteLength, inspected.title, inspected.description, value.category, JSON.stringify(inspected.tags),
          'e-Mate 用户', auth.author, null, null],
      ),
      statement(env,
        'INSERT INTO skill_hub_mutation_requests(account_ref,client_request_id,action,slug,version,package_sha256,status) VALUES (?,?,?,?,?,?,?)',
        [auth.author, value.client_request_id, 'publish', inspected.name, inspected.version, inspected.packageSha256, 'published'],
      ),
      statement(env,
        "UPDATE skill_hub_skills SET latest_version=(SELECT v.version FROM skill_hub_versions v WHERE v.slug=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version) ORDER BY v.version_sort DESC,v.version DESC LIMIT 1),updated_at=CURRENT_TIMESTAMP WHERE slug=?",
        [inspected.name, inspected.name],
      ),
    ])
  } catch {
    const raced = await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [inspected.name, inspected.version])
    const receipt = await first(env,
      'SELECT action,slug,version,package_sha256,status FROM skill_hub_mutation_requests WHERE account_ref=? AND client_request_id=?',
      [auth.author, value.client_request_id],
    )
    if (raced === null || raced.author_ref !== auth.author || raced.package_sha256 !== inspected.packageSha256
      || !mutationMatches(receipt, 'publish', inspected.name, inspected.version, inspected.packageSha256)) {
      throw new HttpError(409, 'Skill Hub publication conflicts with existing state')
    }
  }
  const published = await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [inspected.name, inspected.version])
  return json(card(published), 201)
}

async function catalog(request, env, config, fetchImplementation, url) {
  await authenticate(request, env, config, fetchImplementation)
  for (const key of url.searchParams.keys()) if (!['query', 'category', 'tag', 'source', 'cursor', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) {
    throw new HttpError(422, 'Skill Hub search filters are invalid')
  }
  const query = url.searchParams.get('query') ?? ''
  const category = url.searchParams.get('category')
  const tag = url.searchParams.get('tag')
  const source = url.searchParams.get('source')
  const cursor = url.searchParams.get('cursor')
  const limit = Number(url.searchParams.get('limit') ?? 24)
  if (query.length > 128 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (category !== null && !CATEGORIES.has(category))
    || (tag !== null && !SEARCH_TAG.test(tag)) || (source !== null && !SOURCE.test(source))
    || (cursor !== null && (cursor.length > 1024 || CONTROL.test(cursor)))) throw new HttpError(422, 'Skill Hub search filters are invalid')
  const scope = { purpose: 'catalog', query: query.trim(), category, tag, source }
  const decoded = cursor === null ? null : await decodeCursor(env, cursor)
  if (decoded !== null && (!exact(decoded, ['purpose', 'query', 'category', 'tag', 'source', 'after'])
    || Object.entries(scope).some(([key, value]) => decoded[key] !== value)
    || !SKILL_NAME.test(decoded.after))) throw new HttpError(422, 'Skill Hub search filters are invalid')
  const clauses = [
    's.slug > ?',
    "(? = '' OR s.slug LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\' OR v.summary LIKE ? ESCAPE '\\')",
  ]
  const escaped = query.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  const pattern = `%${escaped}%`
  const values = [decoded?.after ?? '', query.trim(), pattern, pattern, pattern]
  if (category !== null) { clauses.push('v.category=?'); values.push(category) }
  if (tag !== null) { clauses.push('instr(v.tags_json,?)>0'); values.push(JSON.stringify(tag)) }
  if (source !== null) { clauses.push('v.original_platform=?'); values.push(source) }
  values.push(limit + 1)
  const rows = await all(env,
    `SELECT v.* FROM skill_hub_skills s JOIN skill_hub_versions v ON v.slug=s.slug AND v.version=s.latest_version WHERE NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version) AND ${clauses.join(' AND ')} ORDER BY s.slug LIMIT ?`,
    values,
  )
  const page = rows.slice(0, limit)
  return json({
    schema_version: 1,
    items: page.map(card),
    next_cursor: rows.length > limit ? await encodeCursor(env, { ...scope, after: page.at(-1).slug }) : null,
  })
}

async function detail(request, env, config, fetchImplementation, slug, url) {
  await authenticate(request, env, config, fetchImplementation)
  for (const key of url.searchParams.keys()) if (!['cursor', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) {
    throw new HttpError(422, 'Skill Hub version filters are invalid')
  }
  const limit = Number(url.searchParams.get('limit') ?? 24)
  const cursor = url.searchParams.get('cursor')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (cursor !== null && (cursor.length > 1024 || CONTROL.test(cursor)))) throw new HttpError(422, 'Skill Hub version filters are invalid')
  const decoded = cursor === null ? null : await decodeCursor(env, cursor)
  if (decoded !== null && (!exact(decoded, ['purpose', 'slug', 'version_sort', 'version'])
    || decoded.purpose !== 'versions' || decoded.slug !== slug
    || typeof decoded.version_sort !== 'string' || !VERSION.test(decoded.version))) {
    throw new HttpError(422, 'Skill Hub version filters are invalid')
  }
  const latest = await first(env,
    'SELECT v.* FROM skill_hub_skills s JOIN skill_hub_versions v ON v.slug=s.slug AND v.version=s.latest_version WHERE s.slug=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version)',
    [slug],
  )
  if (latest === null) throw new HttpError(404, 'Skill was not found')
  const rows = await all(env,
    `SELECT v.* FROM skill_hub_versions v WHERE v.slug=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version)
      AND (? IS NULL OR v.version_sort < ? OR (v.version_sort = ? AND v.version < ?)) ORDER BY v.version_sort DESC,v.version DESC LIMIT ?`,
    [slug, decoded?.version_sort ?? null, decoded?.version_sort ?? null, decoded?.version_sort ?? null, decoded?.version ?? '', limit + 1],
  )
  const page = rows.slice(0, limit)
  return json({
    schema_version: 1,
    skill: card(latest),
    versions: page.map(card),
    next_cursor: rows.length > limit ? await encodeCursor(env, {
      purpose: 'versions', slug, version_sort: page.at(-1).version_sort, version: page.at(-1).version,
    }) : null,
  })
}

async function exactVersion(request, env, config, fetchImplementation, slug, version) {
  await authenticate(request, env, config, fetchImplementation)
  const row = await first(env,
    'SELECT v.* FROM skill_hub_versions v WHERE v.slug=? AND v.version=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version)',
    [slug, version],
  )
  if (row === null) throw new HttpError(404, 'Skill version was not found')
  return json(card(row))
}

async function owned(request, env, config, fetchImplementation, url) {
  const auth = await authenticate(request, env, config, fetchImplementation)
  for (const key of url.searchParams.keys()) if (!['slug', 'version'].includes(key) || url.searchParams.getAll(key).length !== 1) {
    throw new HttpError(422, 'Skill Hub publication target is invalid')
  }
  const slug = url.searchParams.get('slug')
  const version = url.searchParams.get('version')
  if ((slug === null) !== (version === null) || (slug !== null && (!SKILL_NAME.test(slug) || VERSION.exec(version) === null))) {
    throw new HttpError(422, 'Skill Hub publication target is invalid')
  }
  const rows = slug === null
    ? await all(env,
      'SELECT v.* FROM skill_hub_versions v WHERE v.author_ref=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version) ORDER BY v.slug,v.version_sort DESC LIMIT 100',
      [auth.author],
    )
    : await all(env,
      'SELECT v.* FROM skill_hub_versions v WHERE v.author_ref=? AND v.slug=? AND v.version=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version) LIMIT 1',
      [auth.author, slug, version],
    )
  return json({ schema_version: 1, items: rows.map(card) })
}

async function download(request, env, config, fetchImplementation, slug, version) {
  await authenticate(request, env, config, fetchImplementation)
  const row = await first(env,
    'SELECT v.* FROM skill_hub_versions v WHERE v.slug=? AND v.version=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version)',
    [slug, version],
  )
  if (row === null) throw new HttpError(404, 'Skill package was not found')
  const object = await env.PACKAGES.get(`packages/${row.package_sha256}.zip`)
  if (object === null || object.size !== Number(row.package_size_bytes)
    || object.customMetadata?.package_sha256 !== row.package_sha256
    || object.customMetadata?.archive_sha256 !== row.archive_sha256) throw new HttpError(404, 'Skill package was not found')
  return new Response(object.body, {
    headers: {
      'cache-control': 'private, no-store',
      'content-length': String(object.size),
      'content-type': 'application/zip',
      'x-content-type-options': 'nosniff',
      'x-skill-content-sha256': row.package_sha256,
    },
  })
}

async function deletePublication(request, env, config, fetchImplementation, slug, version) {
  const auth = await authenticate(request, env, config, fetchImplementation)
  const value = await readJson(request)
  if (!exact(value, ['package_sha256', 'client_request_id']) || !SHA256.test(value.package_sha256)
    || !CLIENT_REQUEST_ID.test(value.client_request_id)) throw new HttpError(422, 'Skill Hub publication deletion target is invalid')
  const replay = await first(env,
    'SELECT action,slug,version,package_sha256,status FROM skill_hub_mutation_requests WHERE account_ref=? AND client_request_id=?',
    [auth.author, value.client_request_id],
  )
  if (replay !== null && !mutationMatches(replay, 'delete', slug, version, value.package_sha256)) {
    throw new HttpError(409, 'Skill Hub client request identity was reused')
  }
  const row = await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [slug, version])
  if (row === null || row.author_ref !== auth.author || row.package_sha256 !== value.package_sha256) {
    throw new HttpError(409, 'Skill Hub publication is not owned by this account')
  }
  const tombstone = await first(env, 'SELECT * FROM skill_hub_publication_tombstones WHERE slug=? AND version=?', [slug, version])
  if (tombstone !== null) {
    if (replay !== null || (tombstone.author_ref === auth.author && tombstone.client_request_id === value.client_request_id
      && tombstone.package_sha256 === value.package_sha256)) {
      return json({ schema_version: 1, status: 'deleted', slug, version, package_sha256: value.package_sha256, uploader: card(row).uploader })
    }
    throw new HttpError(409, 'Skill Hub publication is already deleted')
  }
  try {
    await env.DB.batch([
      statement(env,
        'INSERT INTO skill_hub_publication_tombstones(slug,version,package_sha256,author_ref,client_request_id) VALUES (?,?,?,?,?)',
        [slug, version, value.package_sha256, auth.author, value.client_request_id],
      ),
      statement(env,
        'INSERT INTO skill_hub_mutation_requests(account_ref,client_request_id,action,slug,version,package_sha256,status) VALUES (?,?,?,?,?,?,?)',
        [auth.author, value.client_request_id, 'delete', slug, version, value.package_sha256, 'deleted'],
      ),
      statement(env,
        "UPDATE skill_hub_skills SET latest_version=COALESCE((SELECT v.version FROM skill_hub_versions v WHERE v.slug=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version) ORDER BY v.version_sort DESC,v.version DESC LIMIT 1),latest_version),updated_at=CURRENT_TIMESTAMP WHERE slug=?",
        [slug, slug],
      ),
    ])
  } catch {
    const accepted = await first(env, 'SELECT * FROM skill_hub_publication_tombstones WHERE slug=? AND version=?', [slug, version])
    const receipt = await first(env,
      'SELECT action,slug,version,package_sha256,status FROM skill_hub_mutation_requests WHERE account_ref=? AND client_request_id=?',
      [auth.author, value.client_request_id],
    )
    if (accepted === null || accepted.author_ref !== auth.author || accepted.package_sha256 !== value.package_sha256
      || !mutationMatches(receipt, 'delete', slug, version, value.package_sha256)) {
      throw new HttpError(409, 'Skill Hub publication deletion conflicts with existing state')
    }
  }
  return json({ schema_version: 1, status: 'deleted', slug, version, package_sha256: value.package_sha256, uploader: card(row).uploader })
}

async function createIntent(request, env, config, fetchImplementation, slug, version) {
  const auth = await authenticate(request, env, config, fetchImplementation)
  const value = await readJson(request)
  if (!exact(value, ['package_sha256', 'client_request_id']) || !SHA256.test(value.package_sha256)
    || !CLIENT_REQUEST_ID.test(value.client_request_id)) throw new HttpError(422, 'Skill Hub install intent is invalid')
  const skill = await first(env,
    'SELECT v.* FROM skill_hub_versions v WHERE v.slug=? AND v.version=? AND NOT EXISTS (SELECT 1 FROM skill_hub_publication_tombstones t WHERE t.slug=v.slug AND t.version=v.version)',
    [slug, version],
  )
  if (skill === null) throw new HttpError(404, 'Skill was not found')
  if (skill.package_sha256 !== value.package_sha256) throw new HttpError(422, 'Skill Hub install intent is invalid')
  const duplicate = await first(env,
    'SELECT intent_id FROM skill_hub_install_intents WHERE account_ref=? AND client_request_id=?',
    [auth.author, value.client_request_id],
  )
  if (duplicate !== null) throw new HttpError(409, 'Skill Hub install request identity was already used')
  const token = randomToken()
  const tokenHash = await credentialHash(token, auth.session)
  const intentId = `intent_${crypto.randomUUID().replaceAll('-', '')}`
  const expiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString()
  try {
    const results = await env.DB.batch([
      statement(env,
        'INSERT INTO skill_hub_install_intents(intent_id,account_ref,slug,version,package_sha256,client_request_id,install_token_sha256,completion_token_sha256,expires_at,status) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM skill_hub_install_intents WHERE account_ref=? AND client_request_id=?)',
        [intentId, auth.author, slug, version, value.package_sha256, value.client_request_id, tokenHash, null, expiresAt, 'created', auth.author, value.client_request_id],
      ),
      statement(env,
        'INSERT INTO skill_hub_install_logs(intent_id,account_ref,slug,version,package_sha256,status) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM skill_hub_install_intents WHERE intent_id=?)',
        [intentId, auth.author, slug, version, value.package_sha256, 'created', intentId],
      ),
    ])
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw new HttpError(409, 'Skill Hub install request identity conflicts')
  } catch {
    throw new HttpError(409, 'Skill Hub install request identity conflicts')
  }
  return json({
    schema_version: 1,
    install_intent: token,
    intent_id: intentId,
    slug,
    version,
    package_sha256: value.package_sha256,
    uploader: card(skill).uploader,
    expires_at: expiresAt,
  })
}

async function consumeIntent(request, env, config, fetchImplementation) {
  const auth = await authenticate(request, env, config, fetchImplementation)
  const value = await readJson(request)
  if (!exact(value, ['install_intent']) || typeof value.install_intent !== 'string'
    || value.install_intent.length !== 64) throw new HttpError(409, 'Skill Hub install intent is invalid')
  const tokenHash = await credentialHash(value.install_intent, auth.session)
  const intent = await first(env, 'SELECT * FROM skill_hub_install_intents WHERE install_token_sha256=?', [tokenHash])
  if (intent === null || intent.account_ref !== auth.author || intent.status !== 'created'
    || Date.parse(intent.expires_at) <= Date.now()) throw new HttpError(409, 'Skill Hub install intent cannot be consumed')
  const completion = randomToken()
  const completionHash = await credentialHash(completion, auth.session)
  const results = await env.DB.batch([
    statement(env,
      "UPDATE skill_hub_install_intents SET status='claimed',claimed_at=CURRENT_TIMESTAMP,completion_token_sha256=? WHERE intent_id=? AND status='created'",
      [completionHash, intent.intent_id],
    ),
    statement(env,
      'INSERT INTO skill_hub_install_logs(intent_id,account_ref,slug,version,package_sha256,status) SELECT ?,?,?,?,?,? WHERE changes()=1',
      [intent.intent_id, auth.author, intent.slug, intent.version, intent.package_sha256, 'claimed'],
    ),
  ])
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw new HttpError(409, 'Skill Hub install intent was already consumed')
  return json({
    schema_version: 1,
    intent_id: intent.intent_id,
    slug: intent.slug,
    version: intent.version,
    package_sha256: intent.package_sha256,
    uploader: card(await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [intent.slug, intent.version])).uploader,
    expires_at: intent.expires_at,
    completion_receipt: completion,
  })
}

async function completionIntent(request, env, config, fetchImplementation, reconcileOnly) {
  const auth = await authenticate(request, env, config, fetchImplementation)
  const value = await readJson(request)
  if (!exact(value, ['completion_receipt'], reconcileOnly ? [] : ['status'])
    || typeof value.completion_receipt !== 'string' || value.completion_receipt.length !== 64
    || (!reconcileOnly && !['installed', 'failed'].includes(value.status))) {
    throw new HttpError(409, 'Skill Hub install completion is invalid')
  }
  const tokenHash = await credentialHash(value.completion_receipt, auth.session)
  const intent = await first(env, 'SELECT * FROM skill_hub_install_intents WHERE completion_token_sha256=?', [tokenHash])
  if (intent === null || intent.account_ref !== auth.author || !['claimed', 'installed', 'failed'].includes(intent.status)) {
    throw new HttpError(409, 'Skill Hub install completion is invalid')
  }
  const identity = {
    intent_id: intent.intent_id,
    slug: intent.slug,
    version: intent.version,
    package_sha256: intent.package_sha256,
    uploader: card(await first(env, 'SELECT * FROM skill_hub_versions WHERE slug=? AND version=?', [intent.slug, intent.version])).uploader,
  }
  if (reconcileOnly) return json({ schema_version: 1, status: intent.status, ...identity })
  if (intent.status !== value.status) {
    if (intent.status !== 'claimed') throw new HttpError(409, 'Skill Hub install completion is invalid')
    const results = await env.DB.batch([
      statement(env,
        'UPDATE skill_hub_install_intents SET status=?,completed_at=CURRENT_TIMESTAMP WHERE intent_id=? AND status=\'claimed\'',
        [value.status, intent.intent_id],
      ),
      statement(env,
        'INSERT INTO skill_hub_install_logs(intent_id,account_ref,slug,version,package_sha256,status) SELECT ?,?,?,?,?,? WHERE changes()=1',
        [intent.intent_id, auth.author, intent.slug, intent.version, intent.package_sha256, value.status],
      ),
    ])
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      const completed = await first(env, 'SELECT * FROM skill_hub_install_intents WHERE completion_token_sha256=?', [tokenHash])
      if (completed?.status !== value.status) throw new HttpError(409, 'Skill Hub install completion is invalid')
    }
  }
  return json({ schema_version: 1, status: value.status, ...identity })
}

export async function handleRequest(request: Request, env: HubBindings, fetchImplementation: typeof fetch = fetch) {
  const config = configured(env)
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/healthz' && url.search === '') {
    const row = await first(env, 'SELECT 1 AS ok')
    await env.PACKAGES.list({ limit: 1 })
    return json({ schema_version: 1, ready: row?.ok === 1 })
  }
  if (!url.pathname.startsWith(`${BASE_PATH}/`) && url.pathname !== BASE_PATH) throw new HttpError(404, 'Not found')
  if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) {
    throw new HttpError(403, 'Browser bearer transport is forbidden', 'auth')
  }
  if (request.method === 'GET' && url.pathname === `${BASE_PATH}/skills`) return catalog(request, env, config, fetchImplementation, url)
  if (request.method === 'GET' && url.pathname === `${BASE_PATH}/publications/mine`) return owned(request, env, config, fetchImplementation, url)
  if (request.method === 'POST' && url.pathname === `${BASE_PATH}/skills` && url.search === '') return publish(request, env, config, fetchImplementation)
  if (request.method === 'POST' && url.pathname === `${BASE_PATH}/install-intents/consume` && url.search === '') return consumeIntent(request, env, config, fetchImplementation)
  if (request.method === 'POST' && url.pathname === `${BASE_PATH}/install-intents/complete` && url.search === '') return completionIntent(request, env, config, fetchImplementation, false)
  if (request.method === 'POST' && url.pathname === `${BASE_PATH}/install-intents/reconcile` && url.search === '') return completionIntent(request, env, config, fetchImplementation, true)
  const packageMatch = new RegExp(`^${BASE_PATH}/skills/([^/]+)/versions/([^/]+)/package$`, 'u').exec(url.pathname)
  if (request.method === 'GET' && url.search === '' && packageMatch !== null) {
    return download(request, env, config, fetchImplementation,
      decodeSegment(packageMatch[1], SKILL_NAME, 'Skill slug'), decodeSegment(packageMatch[2], VERSION, 'Skill version'))
  }
  const intentMatch = new RegExp(`^${BASE_PATH}/skills/([^/]+)/versions/([^/]+)/install-intent$`, 'u').exec(url.pathname)
  if (request.method === 'POST' && url.search === '' && intentMatch !== null) {
    return createIntent(request, env, config, fetchImplementation,
      decodeSegment(intentMatch[1], SKILL_NAME, 'Skill slug'), decodeSegment(intentMatch[2], VERSION, 'Skill version'))
  }
  const versionMatch = new RegExp(`^${BASE_PATH}/skills/([^/]+)/versions/([^/]+)$`, 'u').exec(url.pathname)
  if (request.method === 'GET' && url.search === '' && versionMatch !== null) {
    return exactVersion(request, env, config, fetchImplementation,
      decodeSegment(versionMatch[1], SKILL_NAME, 'Skill slug'), decodeSegment(versionMatch[2], VERSION, 'Skill version'))
  }
  if (request.method === 'DELETE' && url.search === '' && versionMatch !== null) {
    return deletePublication(request, env, config, fetchImplementation,
      decodeSegment(versionMatch[1], SKILL_NAME, 'Skill slug'), decodeSegment(versionMatch[2], VERSION, 'Skill version'))
  }
  const detailMatch = new RegExp(`^${BASE_PATH}/skills/([^/]+)$`, 'u').exec(url.pathname)
  if (request.method === 'GET' && detailMatch !== null) {
    return detail(request, env, config, fetchImplementation, decodeSegment(detailMatch[1], SKILL_NAME, 'Skill slug'), url)
  }
  throw new HttpError(404, 'Not found')
}

export async function serveRequest(request: Request, env: HubBindings, fetchImplementation: typeof fetch = fetch) {
    try {
      return await handleRequest(request, env, fetchImplementation)
    } catch (error) {
      if (error instanceof HttpError) return json({ detail: error.message, error: { code: error.code, message: error.message } }, error.status)
      console.error(JSON.stringify({ message: 'Skill Hub request failed', method: request.method }))
      return json({ detail: 'Skill Hub service failed', error: { code: 'network', message: 'Skill Hub service failed' } }, 500)
    }
}

export default { fetch: serveRequest }
