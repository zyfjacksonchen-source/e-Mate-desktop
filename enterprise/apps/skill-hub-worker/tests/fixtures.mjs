import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import worker, { handleRequest, inspectSkillArchive, versionSort } from '../src/index.js'

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database
    this.sql = sql
    this.values = values
  }

  bind(...values) {
    return new D1Statement(this.database, this.sql, values)
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) }
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values)
    return { meta: { changes: Number(result.changes) } }
  }
}

class MemoryD1 {
  database = new DatabaseSync(':memory:')
  queue = Promise.resolve()

  constructor() {
    this.database.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  }

  prepare(sql) {
    return new D1Statement(this.database, sql)
  }

  batch(statements) {
    const result = this.queue.then(() => this.transaction(statements))
    this.queue = result.catch(() => {})
    return result
  }

  async transaction(statements) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

class MemoryR2 {
  objects = new Map()

  async put(key, value, options = {}) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer())
    const object = {
      key,
      size: bytes.byteLength,
      bytes,
      customMetadata: { ...options.customMetadata },
      httpMetadata: { ...options.httpMetadata },
    }
    this.objects.set(key, object)
    return this.view(object)
  }

  async head(key) {
    const object = this.objects.get(key)
    return object === undefined ? null : this.view(object)
  }

  async get(key) {
    const object = this.objects.get(key)
    return object === undefined ? null : { ...this.view(object), body: new Blob([object.bytes]).stream() }
  }

  async list() {
    return { objects: [...this.objects.values()].map(value => this.view(value)), truncated: false }
  }

  view(object) {
    return {
      key: object.key,
      size: object.size,
      customMetadata: { ...object.customMetadata },
      httpMetadata: { ...object.httpMetadata },
    }
  }
}

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1)
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [path, value] of Object.entries(files)) {
    const name = Buffer.from(path, 'utf8')
    const content = Buffer.from(value)
    const compressed = deflateRawSync(content)
    const crc = crc32(content)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(0x0314, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(content.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function skill(slug, version, tags = []) {
  return zip({
    'SKILL.md': [
      '---',
      `name: ${slug}`,
      `description: ${slug} shared behavior`,
      `version: ${version}`,
      `tags: ${JSON.stringify(tags)}`,
      '---',
      '',
      `Run ${slug}.`,
      '',
    ].join('\n'),
  })
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function modelToken(userId = 'user-1', sessionId = '01234567-89ab-4def-8123-456789abcdef') {
  return [
    base64url({ alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: 'auth-key-1' }),
    base64url({
      schemaVersion: 1,
      tenantId: 'tenant-1',
      sub: userId,
      sid: sessionId,
      exp: Math.floor(Date.now() / 1_000) + 900,
    }),
    'x'.repeat(86),
  ].join('.')
}

function environment() {
  return {
    MODEL_SESSION_VALIDATION_URL: 'https://model.example/e-mate/model-api/v1/consents/current',
    AUTHOR_KEY: 'test-author-key-that-is-longer-than-thirty-two-bytes',
    DB: new MemoryD1(),
    PACKAGES: new MemoryR2(),
  }
}

function request(path, options = {}, userId = 'user-1', sessionId) {
  return new Request(`https://hub.example${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${modelToken(userId, sessionId)}`,
      ...options.headers,
    },
  })
}

const activeSession = async (url, init) => {
  assert.equal(url, 'https://model.example/e-mate/model-api/v1/consents/current')
  assert.match(init.headers.authorization, /^Bearer /u)
  return new Response(null, { status: 200 })
}

async function direct(env, path, options, userId, sessionId) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = activeSession
  try { return await worker.fetch(request(path, options, userId, sessionId), env) } finally { globalThis.fetch = originalFetch }
}

function publicationBody(payload, slug, category = 'third_party', requestId = 'publish:request-0001') {
  return JSON.stringify({
    slug,
    category,
    bundle_base64: payload.toString('base64'),
    client_request_id: requestId,
  })
}

export { MemoryD1, MemoryR2, zip, skill, modelToken, environment, request, activeSession, direct, publicationBody }
